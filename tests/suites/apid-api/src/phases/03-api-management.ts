/** Cookie and bearer management through /api, with form routes outside it inert. */

import type { JsonValue } from '../report.ts'
import type { Phase, PhaseContext } from '../runner.ts'
import { CSRF_STATE } from './02-session.ts'

function parseObject(body: string): Record<string, JsonValue> | undefined {
  try {
    const value = JSON.parse(body) as JsonValue
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  }
  catch {
    return undefined
  }
}

/** Each switch the management checks write, and the `GET /api/v1/meta` feature that serves it. */
const FEATURE_SWITCHES = [['container.enabled', 'containers'], ['mqtt.enabled', 'mqtt'], ['access.ssh.enabled', 'ssh']] as const

function parseObjectArray(body: string): Record<string, JsonValue>[] | undefined {
  try {
    const value = JSON.parse(body) as JsonValue
    if (!Array.isArray(value)) return undefined
    const rows = value.map(item =>
      typeof item === 'object' && item !== null && !Array.isArray(item) ? item : undefined,
    )
    return rows.every(row => row !== undefined) ? rows : undefined
  }
  catch {
    return undefined
  }
}

const phase: Phase = {
  id: '03-api-management',
  title: 'all appliance reads and writes flow through the authenticated JSON API',
  assumes: '02 left an authenticated browser session and its CSRF token in phase state; setup mints no bearer, so this phase mints its own',

  async run({ client, report, config, state }: PhaseContext): Promise<void> {
    const csrf = state.get(CSRF_STATE)
    if (typeof csrf !== 'string') {
      report.fail('the management phase received the browser credential from setup', `csrf=${typeof csrf}`)
      return
    }

    const ui = await client.get('/api/v1/ui')
    report.expectStatus(ui, 200, 'GET /api/v1/ui reports UI selection through the API')
    report.expectJson(ui, { mode: 'builtIn' }, 'the factory image reports the built-in UI active', { subset: true })
    const uiStatus = parseObject(ui.body)
    report.check(
      uiStatus !== undefined && !('availableCustom' in uiStatus),
      'the factory UiStatus has no optional availableCustom candidate',
      `actual body: ${ui.body}`,
    )

    const uiWithoutCsrf = await client.request('PUT', '/api/v1/ui/active')
    report.expectStatus(uiWithoutCsrf, 403, 'PUT /api/v1/ui/active without CSRF is refused')
    report.expectJson(
      uiWithoutCsrf,
      { error: { code: 'csrf_invalid', source: 'apid' } },
      'the custom UI selector uses the common CSRF envelope',
      { subset: true },
    )

    // A BODY, because the route takes `Json<ActivateUiRequest>` and axum's
    // extractor answers 415 before the handler runs without one -- so a
    // bodyless request tests the extractor, not the "no retained bundle"
    // conflict this asserts. The generation is arbitrary: this device retains
    // no custom UI, so no generation resolves and every one of them is the
    // same 409.
    const unavailableUi = await client.request('PUT', '/api/v1/ui/active', {
      body: JSON.stringify({ generation: 1 }),
      contentType: 'application/json',
      headers: { 'X-CSRF-Token': csrf },
    })
    report.expectStatus(unavailableUi, 409, 'PUT /api/v1/ui/active reports no retained custom UI')
    report.expectJson(
      unavailableUi,
      { error: { code: 'custom_ui_unavailable', source: 'apid' } },
      'the absent custom UI has a named conflict response',
      { subset: true },
    )

    const hostname = await client.get('/api/v1/settings/hostname')
    report.expectStatus(hostname, 200, 'GET /api/v1/settings/hostname reads through the browser session')
    report.expectJson(hostname, config.hostnameTarget, 'the setup hostname reads back through the API')

    // THE SWITCHES WRITTEN BELOW ARE THE ONES THIS PRODUCT SERVES. A feature the product was not built with is
    // not served (404 settings_not_found), so a write to it would test the product's composition and not the API:
    // GET /api/v1/meta names the features, and a switch whose feature is absent is skipped, by name.
    const meta = await client.get('/api/v1/meta')
    report.expectStatus(meta, 200, 'GET /api/v1/meta names the features this product serves')
    const declared = parseObject(meta.body)?.['features']
    if (!Array.isArray(declared) || !declared.every(feature => typeof feature === 'string')) {
      report.fail('the meta response lists its "features" as strings', `actual body: ${meta.body}`)
      return
    }
    report.note(`features this product serves: ${declared.length > 0 ? declared.join(', ') : '(none)'}`)
    const parallelPaths: string[] = []
    for (const [path, feature] of FEATURE_SWITCHES) {
      if (declared.includes(feature)) parallelPaths.push(path)
      else report.skip(`settings writes to ${path}`, `the product does not serve the ${feature} feature`)
    }
    const switchPath = parallelPaths[0]
    if (switchPath === undefined) {
      report.skip('the CSRF and task checks of a settings write', 'the product serves none of the switched features')
      return
    }

    const current = await client.get(`/api/v1/settings/${switchPath}`)
    report.expectStatus(current, 200, `GET /api/v1/settings/${switchPath} reads the switch`)
    const enabled = JSON.parse(current.body) as JsonValue
    if (typeof enabled !== 'boolean') {
      report.fail(`the ${switchPath} setting is a boolean`, `actual body: ${current.body}`)
      return
    }

    const refused = await client.request('PUT', `/api/v1/settings/${switchPath}`, {
      body: JSON.stringify(enabled),
      contentType: 'application/json',
    })
    report.expectStatus(refused, 403, 'a cookie-authenticated settings PUT without CSRF is refused')
    report.expectJson(
      refused,
      { error: { code: 'csrf_invalid', source: 'apid' } },
      'the missing-CSRF refusal uses the API envelope',
      { subset: true },
    )

    const accepted = await client.request('PUT', `/api/v1/settings/${switchPath}`, {
      body: JSON.stringify(enabled),
      contentType: 'application/json',
      headers: { 'X-CSRF-Token': csrf },
    })
    report.expectStatus(accepted, 202, 'the same settings PUT with CSRF is accepted')
    const acceptedBody = parseObject(accepted.body)
    const taskId = acceptedBody?.['taskId']
    report.check(
      typeof taskId === 'string' && taskId.length > 0,
      'the accepted settings write returns its "taskId"',
      `actual body: ${accepted.body}`,
    )
    if (typeof taskId === 'string') {
      const task = await client.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
      report.expectStatus(task, 200, 'GET /api/v1/tasks/{id} exposes the accepted write')
    }

    const parallelWrites = await Promise.all(
      parallelPaths.map(path =>
        client.request('PUT', `/api/v1/settings/${path}`, {
          body: 'true',
          contentType: 'application/json',
          headers: { 'X-CSRF-Token': csrf },
        }),
      ),
    )
    const parallelTaskIds = new Map<string, string>()
    for (const [index, response] of parallelWrites.entries()) {
      const path = parallelPaths[index]
      if (path === undefined) continue
      report.expectStatus(response, 202, `parallel enable of ${path} is accepted`)
      const id = parseObject(response.body)?.['taskId']
      report.check(
        typeof id === 'string' && id.length > 0,
        `parallel enable of ${path} returns a task id`,
        `actual body: ${response.body}`,
      )
      if (typeof id === 'string') parallelTaskIds.set(path, id)
    }
    report.check(
      new Set(parallelTaskIds.values()).size === parallelPaths.length,
      `parallel enables of ${parallelPaths.length} independent settings create as many distinct tasks`,
      `tasks: ${JSON.stringify(Object.fromEntries(parallelTaskIds))}`,
    )

    let terminalTasks: Record<string, JsonValue>[] | undefined
    await report.expectEventually(
      'the task list retains every parallel enable through terminal state',
      async () => {
        const response = await client.get('/api/v1/tasks')
        if (response.status !== 200) return false
        const tasks = parseObjectArray(response.body)
        if (tasks === undefined) return false
        const byId = new Map(tasks.map(task => [task['id'], task]))
        const selected = [...parallelTaskIds.values()].map(id => byId.get(id))
        if (selected.some(task => task === undefined || task['status'] !== 'finished')) return false
        terminalTasks = selected as Record<string, JsonValue>[]
        return true
      },
      { timeoutMs: 120_000, intervalMs: 500 },
    )

    if (terminalTasks !== undefined) {
      for (const [path, id] of parallelTaskIds) {
        // A queued ancestor write can absorb this write and retain its path.
        // The admission's task ID still identifies the result to observe.
        const task = terminalTasks.find(row => row['id'] === id)
        report.check(
          task?.['outcome'] === 'succeeded',
          `task list reports the parallel ${path} enable as succeeded`,
          `actual task: ${JSON.stringify(task)}`,
        )
      }
    }
    for (const path of parallelPaths) {
      const setting = await client.get(`/api/v1/settings/${path}`)
      report.expectJson(setting, true, `parallel enable of ${path} persists true`)
    }

    // THE BEARER IS MINTED HERE BECAUSE SETUP DOES NOT HAND ONE OUT. The
    // capability under test -- a token reads the management API with no cookie
    // and no CSRF -- has one source: the route a caller asks on, authenticated
    // by the credential setup created.
    const minted = await client.request('POST', '/api/v1/tokens', {
      body: JSON.stringify({ name: 'apid-api-suite' }),
      contentType: 'application/json',
      headers: { 'X-CSRF-Token': csrf },
    })
    report.expectStatus(minted, 201, 'POST /api/v1/tokens mints an API token for the authenticated browser')
    const mintedBody = parseObject(minted.body)
    const bearer = mintedBody?.['token']
    report.check(
      typeof bearer === 'string' && bearer.startsWith('mica_'),
      'the mint response carries the plaintext member "token"',
      `actual body: ${minted.body}`,
    )
    if (typeof bearer !== 'string') return

    const bearerRead = await client.get('/api/v1/settings/hostname', {
      sendCookies: false,
      headers: { Authorization: `Bearer ${bearer}` },
    })
    report.expectStatus(bearerRead, 200, 'the minted bearer reads the same management API without CSRF')

    const anonymous = await client.get('/api/v1/ui', { sendCookies: false })
    report.expectStatus(anonymous, 401, 'an API management read with no credential is refused')

    for (const path of [
      '/containers/enable',
      '/mqtt/enable',
      '/hostname',
      '/network',
      '/ssh/enable',
      '/power/poweroff',
      '/builtin/deactivate',
    ] as const) {
      const response = await client.post(path, { enabled: 'on', hostname: 'must-not-apply' })
      report.expectStatus(response, 405, `POST ${path} remains outside the management surface after login`)
    }

    const unchanged = await client.get('/api/v1/settings/hostname')
    report.expectJson(unchanged, config.hostnameTarget, 'form routes outside the API did not mutate the hostname')
  },
}

export default phase
