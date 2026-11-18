/** The uplink rules of the network route (mica-core 0.0.9), which a settings write over D-Bus does not apply: a
 * declared default route below metric 20 is refused, and a reachability check switched on with no targets stores
 * the two the device will contact. On eth1, a port this guest does not have, so the apply waits for nothing and
 * the device contacts nothing. */

import type { JsonValue } from '../report.ts'
import type { Phase, PhaseContext } from '../runner.ts'
import { CSRF_STATE } from './02-session.ts'

const IFACE = 'eth1'
const DEFAULT_TARGETS = [
  { address: '1.1.1.1', method: 'tcp', port: 53 },
  { address: '8.8.8.8', method: 'tcp', port: 53 },
]

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function parse(body: string): Record<string, JsonValue> | undefined {
  try {
    return record(JSON.parse(body) as JsonValue)
  }
  catch {
    return undefined
  }
}

/** The phase the task an accepted network write returned ends in, waited for up to a minute. */
async function finished(client: PhaseContext['client'], body: string): Promise<JsonValue | undefined> {
  const taskId = parse(body)?.['taskId']
  if (typeof taskId !== 'string') return undefined
  let phaseName: JsonValue | undefined
  for (let i = 0; i < 60; i++) {
    phaseName = parse((await client.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`)).body)?.['phase']
    if (phaseName === 'applied' || phaseName === 'failed') break
    await Bun.sleep(1000)
  }
  return phaseName
}

const phase: Phase = {
  id: '04b-uplink-check',
  title: 'a default route below metric 20 is refused; a reachability check with no targets stores two',
  assumes: '02 left an authenticated session and its CSRF token',

  async run({ client, report, state }: PhaseContext): Promise<void> {
    const csrf = state.get(CSRF_STATE)
    if (typeof csrf !== 'string') {
      report.fail('the uplink check phase received the browser credential from setup', `csrf=${typeof csrf}`)
      return
    }
    const reserved = await client.request('PUT', `/api/v1/network/${IFACE}`, {
      body: JSON.stringify({ dhcp: true, routes: [{ destination: '0.0.0.0/0', gateway: '10.0.2.2', metric: 5 }] }),
      contentType: 'application/json',
      headers: { 'X-CSRF-Token': csrf },
    })
    report.expectStatus(reserved, 422, `PUT /api/v1/network/${IFACE} with a default route at metric 5 is refused`)
    report.expectJson(
      reserved,
      { error: { code: 'route_metric_reserved', source: 'apid' } },
      'the refusal names the reserved metrics',
      { subset: true },
    )
    const write = await client.request('PUT', `/api/v1/network/${IFACE}`, {
      body: JSON.stringify({ dhcp: true, probe: { enabled: true } }),
      contentType: 'application/json',
      headers: { 'X-CSRF-Token': csrf },
    })
    report.expectStatus(write, 202, `PUT /api/v1/network/${IFACE} with the check on and no targets is accepted`)
    const applied = await finished(client, write.body)
    report.check(applied === 'applied', `the write's network apply finishes`, `phase=${String(applied)}`)
    const overview = await client.get('/api/v1/network')
    report.expectStatus(overview, 200, 'GET /api/v1/network reads the stored entry back')
    const entry = record(record(parse(overview.body)?.['configured'])?.[IFACE])
    const targets = record(entry?.['probe'])?.['targets']
    report.check(
      JSON.stringify(targets) === JSON.stringify(DEFAULT_TARGETS),
      `the stored ${IFACE} check names 1.1.1.1 and 8.8.8.8 by tcp on port 53`,
      `actual entry: ${JSON.stringify(entry)}`,
    )
    const removed = await client.request('DELETE', `/api/v1/network/${IFACE}`, { headers: { 'X-CSRF-Token': csrf } })
    report.expectStatus(removed, 204, `DELETE /api/v1/network/${IFACE} takes the entry away again`)
  },
}

export default phase
