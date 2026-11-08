/**
 * Phase 09 -- an owner certificate enrolled through apid, and the driver state it reads.
 *
 * `POST /api/v1/system/owner-certs` asks for the administrator password, as the factory reset does, and answers 202
 * with the `drivers.apply` task micad runs `mica-deploy owner-cert-add` as (mica-core:docs/mica-core.md 3.7, 6.3).
 * The certificate applies from the next boot, so what this one-boot harness can see is the task's outcome and the
 * certificate standing `pending-next-boot` in `GET /api/v1/system/owner-certs`; that a later boot loads it is the
 * lifecycle suite's (tests/suites/lifecycle-uefi/owner-enrolment.sh).
 *
 * After 08 for the same reason 08 is last: it leaves the guest changed for its next boot. The certificate is a
 * public, self-signed RSA-2048 CA made for this phase; its key was never kept, so it can sign nothing.
 */

import type { JsonValue } from '../report.ts'
import type { Phase, PhaseContext } from '../runner.ts'
import { CSRF_STATE } from './02-session.ts'

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIULWD2jvpyMiBcTclObcnTghIFUJEwDQYJKoZIhvcNAQEL
BQAwHzEdMBsGA1UEAwwUYXBpZC1hcGkgc3VpdGUgb3duZXIwHhcNMjYxMTA4MDMw
MzI1WhcNNDYxMTAzMDMwMzI1WjAfMR0wGwYDVQQDDBRhcGlkLWFwaSBzdWl0ZSBv
d25lcjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAL2dvQW2vOpQqQ3k
Xgw3EtgEs4IaBm5Vdc8jjhX6hT5QVxq/d5vPDXieHj2D89pbWZ0uvpEygGJXW225
8w0dbPtjrE5CO+BThTR5arwIWa7wlS0AaLZeDjbG2tR7Da82IshpijO+9vi93WgD
HrzZBgxxd3VkeSbXnBy/OVgSL9PKyWb+dZNWTnrKlfDEsDfw7xLULSjsdU8zoQ/S
QbkoUvi9pY6UGs7AJLwdnhF+VPDtUIsHo/y9jtp9NUI72bPTm4NyZwnb+yvu7nT7
0lSpEAP70EBSltrjzn34/ij19I6TPsScS9ML/iHCqN3xFVX/gblYlygUbJZ9lVD5
a6N4e5sCAwEAAaNjMGEwHQYDVR0OBBYEFHuwSW7g/k5nel5KGVdK/SN/gqE4MB8G
A1UdIwQYMBaAFHuwSW7g/k5nel5KGVdK/SN/gqE4MA8GA1UdEwEB/wQFMAMBAf8w
DgYDVR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4IBAQAFJoU2+UdeVjpYlBHw
Ffn2im3+9I4aySn4fKF2CoGdawz53m1OXQ7aGYFk4z1urEFjbC3p0ivDYS6ycuwC
1ahvzFeU57agAc4gBqChf56AxUtbau3qRKEnlWMCiobyUkW/N4rHuFtArAhqbxLr
OShy6h08bHlfGFWZ5ChaEpe4EBxxfP/Z4jMrKavF1GC8gXhsvrxPjtU0PdylSLqa
u9+Lgm45Yh57ixQ5NBMgTc4iw8Suu2iHoH5VgWSaMpHufUfRxRGvuaMxbTqnMw2t
K6h1wx4sMpGsvmCLI7Jxak/U1YBALai4XpcuE88wUC6b3WYfyktxX4DRkdv25k8U
PibG
-----END CERTIFICATE-----
`
const SHA256 = '62e60804e6de15fb6c66205fd8a91ab57ab220fcc6a11de74ff74573131a4c1e'

function parse(text: string): JsonValue | undefined {
  try { return JSON.parse(text) as JsonValue }
  catch { return undefined }
}

const phase: Phase = {
  id: '09-owner-certs',
  title: 'an owner certificate enrolled through apid stands pending the next boot',
  assumes: '02 left an authenticated browser session and its CSRF token, the device is claimed with the suite\'s '
    + 'administrator password, and no owner certificate is enrolled',

  async run({ client, config, report, state }: PhaseContext): Promise<void> {
    const csrf = state.get(CSRF_STATE)
    if (typeof csrf !== 'string') {
      report.fail('the owner certificate phase received the browser CSRF token', `csrf=${typeof csrf}`)
      return
    }
    const before = await client.get('/api/v1/system/owner-certs')
    report.expectStatus(before, 200, 'GET /api/v1/system/owner-certs answers micad\'s GetOwnerCerts')
    report.check(!before.body.includes(SHA256), 'the test certificate is not enrolled yet', `actual body: ${before.body}`)

    const added = await client.request('POST', '/api/v1/system/owner-certs', {
      body: JSON.stringify({ password: config.adminPassword, certificate: Buffer.from(CERTIFICATE).toString('base64') }),
      contentType: 'application/json',
      headers: { 'X-CSRF-Token': csrf },
    })
    report.expectStatus(added, 202, 'POST /api/v1/system/owner-certs with the administrator password is accepted')
    const accepted = parse(added.body)
    const taskId = typeof accepted === 'object' && accepted !== null && !Array.isArray(accepted) ? accepted['taskId'] : undefined
    report.check(typeof taskId === 'string' && taskId.length > 0, 'the enrolment answers its "taskId"', `actual body: ${added.body}`)
    if (typeof taskId !== 'string') return

    let outcome = ''
    let task = ''
    for (let attempt = 0; attempt < 60 && outcome === ''; attempt++) {
      const response = await client.get(`/api/v1/tasks/${encodeURIComponent(taskId)}`)
      task = response.body
      const doc = parse(task)
      const record = typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? doc : undefined
      if (record?.['status'] === 'finished') outcome = String(record['outcome'])
      else await Bun.sleep(1000)
    }
    report.check(outcome === 'succeeded', 'the drivers.apply task enrols the certificate', `last task body: ${task}`)

    const after = await client.get('/api/v1/system/owner-certs')
    report.expectStatus(after, 200, 'GET /api/v1/system/owner-certs reads the enrolment back')
    report.check(after.body.includes(SHA256) && after.body.includes('"pending-next-boot"'),
      'the certificate is listed by its SHA-256 and stands pending-next-boot', `actual body: ${after.body}`)

    const extensions = await client.get('/api/v1/system/extensions')
    report.expectStatus(extensions, 200, 'GET /api/v1/system/extensions answers micad\'s GetExtensions')
  },
}

export default phase
