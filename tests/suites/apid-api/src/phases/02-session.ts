/** First-run setup and the browser session/CSRF lifecycle. */

import type { JsonValue } from '../report.ts'
import type { Phase, PhaseContext } from '../runner.ts'

export const CSRF_STATE = 'csrf-token'

function parseObject(body: string): Record<string, JsonValue> | undefined {
  try {
    const value = JSON.parse(body) as JsonValue
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  }
  catch {
    return undefined
  }
}

function jsonBody(value: unknown): { body: string, contentType: string } {
  return { body: JSON.stringify(value), contentType: 'application/json' }
}

const phase: Phase = {
  id: '02-session',
  title: 'setup, login and logout use one JSON session contract with CSRF',
  assumes: '01 observed setup state and did not mutate the factory-fresh device',

  async run({ client, report, config, state }: PhaseContext): Promise<void> {
    const tooShort = await client.request('POST', '/api/v1/setup', {
      ...jsonBody({ password: 'short' }),
      sendCookies: false,
    })
    report.expectStatus(tooShort, 422, 'POST /api/v1/setup rejects a password below the API floor')

    const setup = await client.request('POST', '/api/v1/setup', {
      ...jsonBody({ password: config.adminPassword, hostname: config.hostnameTarget }),
      sendCookies: false,
    })
    report.expectStatus(setup, 201, 'POST /api/v1/setup configures the device through JSON')
    const setupBody = parseObject(setup.body)
    const csrfToken = setupBody?.['csrfToken']
    report.check(
      typeof csrfToken === 'string' && csrfToken.length >= 32,
      'the setup response carries the browser member "csrfToken"',
      `actual body: ${setup.body}`,
    )
    // SETUP MINTS NO API TOKEN, AND THE ABSENCE IS ASSERTED RATHER THAN MERELY
    // NOT CHECKED. A `token` member would hand every operator a long-lived
    // bearer credential they never asked for and could not decline. A caller
    // that wants one asks: POST /api/v1/tokens, which is where 03 gets its
    // bearer. Without this assertion an introduced token would be silently
    // accepted, which is the state this suite exists to notice.
    report.check(
      setupBody !== undefined && !('token' in setupBody),
      'the setup response carries NO bearer member "token"',
      `actual body: ${setup.body}`,
    )
    if (typeof csrfToken === 'string') state.set(CSRF_STATE, csrfToken)

    // Over plain HTTP the cookie cannot be Secure; 02b requires it Secure once HTTPS serves.
    const sessionCookie = setup.setCookie.find(line => line.startsWith('apid_session='))
    report.expectCookieAttributes(
      sessionCookie,
      'apid_session',
      ['HttpOnly', 'SameSite=Lax', 'Path=/'],
      'setup establishes an HttpOnly browser session cookie',
    )
    report.check(
      sessionCookie !== undefined && !/;\s*Secure(?:;|$)/i.test(sessionCookie),
      'a session cookie set over plain HTTP is not Secure',
      `actual: ${sessionCookie ?? 'none'}`,
    )

    const authenticated = await client.get('/api/v1/session')
    report.expectStatus(authenticated, 200, 'GET /api/v1/session recognizes the setup session')
    report.expectJson(
      authenticated,
      { state: 'authenticated', csrfToken: typeof csrfToken === 'string' ? csrfToken : '' },
      'the authenticated session response returns its in-memory CSRF token',
    )

    const refusedLogout = await client.request('DELETE', '/api/v1/session')
    report.expectStatus(refusedLogout, 403, 'DELETE /api/v1/session without CSRF is refused')

    const logout = await client.request('DELETE', '/api/v1/session', {
      headers: typeof csrfToken === 'string' ? { 'X-CSRF-Token': csrfToken } : {},
    })
    report.expectStatus(logout, 204, 'DELETE /api/v1/session with CSRF revokes the session')
    report.check(
      client.jar.get('apid_session') === undefined,
      'the logout response removes the browser session cookie',
      `cookies remaining: ${client.jar.names().join(', ') || 'none'}`,
    )

    const loggedOut = await client.get('/api/v1/session')
    report.expectJson(loggedOut, { state: 'unauthenticated' }, 'session status reports unauthenticated after logout')

    const login = await client.request('POST', '/api/v1/session', {
      ...jsonBody({ password: config.adminPassword }),
      sendCookies: false,
    })
    report.expectStatus(login, 201, 'POST /api/v1/session logs in with JSON')
    const loginBody = parseObject(login.body)
    const loginCsrf = loginBody?.['csrfToken']
    report.check(
      loginBody?.['state'] === 'authenticated' && typeof loginCsrf === 'string',
      'login returns authenticated state and a new "csrfToken"',
      `actual body: ${login.body}`,
    )
    if (typeof loginCsrf === 'string') state.set(CSRF_STATE, loginCsrf)
  },
}

export default phase
