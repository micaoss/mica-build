/** The console's listeners: HTTPS turned on through the API, plain HTTP then only redirecting to it. */

import type { Phase, PhaseContext } from '../runner.ts'
import { CSRF_STATE } from './02-session.ts'

const phase: Phase = {
  id: '02b-web-listeners',
  title: 'access.web turns HTTPS on, and the session moves to it',
  assumes: '02 left an authenticated session over plain HTTP with its CSRF token in state',

  async run({ client, report, config, state }: PhaseContext): Promise<void> {
    const csrf = state.get(CSRF_STATE)
    const headers: Record<string, string> = typeof csrf === 'string' ? { 'X-CSRF-Token': csrf } : {}
    const current = await client.get('/api/v1/web')
    report.expectStatus(current, 200, 'GET /api/v1/web reads the stored listeners')
    report.expectJson(current, { httpPort: 8080, httpsEnabled: false, httpsPort: 8443 }, 'a factory-fresh device listens on plain HTTP 8080 alone')

    const put = await client.request('PUT', '/api/v1/web', {
      headers, contentType: 'application/json', body: JSON.stringify({ httpPort: 8080, httpsEnabled: true, httpsPort: 8443 }),
    })
    report.expectStatus(put, 202, 'PUT /api/v1/web accepts HTTPS on 8443')

    // apid restarts on the new listeners.
    let status = 0
    for (let i = 0; i < 60 && status !== 200; i++) {
      await Bun.sleep(1000)
      try { status = (await client.get('/healthz', { scheme: 'https' })).status }
      catch { status = 0 }
    }
    report.check(status === 200, 'apid serves HTTPS after the change', `last HTTPS /healthz status ${status}`)
    client.useScheme('https')

    const redirected = await client.http('/_ui/network?source=http')
    report.expectStatus(redirected, 308, 'plain HTTP is redirected permanently to HTTPS')
    report.expectHeaderMatches(
      redirected,
      'location',
      /^https:\/\/[^/]+\/_ui\/network\?source=http$/,
      'the HTTP redirect preserves the SPA path and query',
    )

    // The restart ends the session; the login over HTTPS gets a Secure cookie.
    const login = await client.request('POST', '/api/v1/session', {
      contentType: 'application/json', body: JSON.stringify({ password: config.adminPassword }), sendCookies: false,
    })
    report.expectStatus(login, 201, 'POST /api/v1/session logs in over HTTPS')
    report.expectCookieAttributes(
      login.setCookie.find(line => line.startsWith('apid_session=')),
      'apid_session',
      ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'],
      'a login over HTTPS establishes a hardened browser session cookie',
    )
    try {
      const token = (JSON.parse(login.body) as { csrfToken?: unknown }).csrfToken
      if (typeof token === 'string') state.set(CSRF_STATE, token)
    }
    catch { report.fail('the HTTPS login answers JSON', login.body.slice(0, 200)) }
  },
}

export default phase
