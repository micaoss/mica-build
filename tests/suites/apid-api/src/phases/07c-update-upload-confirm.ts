/**
 * The boot after 07b: the uploaded deployment runs and health confirms it, as phase 07 reads a confirmation.
 * Then the refusal: guest/upload-negative.sh has removed /mica/updates/uploads and restarted apid on this boot,
 * so an upload must be answered 503 update_storage_unavailable -- the upload has nowhere to go (mica-core 3a71d88: a
 * missing or read-only DATA is 503, a full one 507 update_storage_full) -- not another 5xx, and not a hang.
 */
import { openConsole } from '../console.ts'
import type { Phase, PhaseContext } from '../runner.ts'
import { body, object, updateUntil, UPLOAD_TIMEOUT_MS } from './07b-update-upload.ts'

const NEGATIVE_READY = /UPLOAD_NEGATIVE READY/

const phase: Phase = {
  id: '07c-update-upload-confirm',
  title: 'the uploaded deployment boots and is confirmed; an upload with no upload directory is refused with 503',
  assumes: '07b installed APID_UPLOAD_DEPLOYMENT and rebooted; run.sh booted the same disk again, where the seeded '
    + 'guest/upload-negative.sh removes /mica/updates/uploads and restarts apid on this second boot',
  async run({ client, report, config }: PhaseContext): Promise<void> {
    const archive = config.uploadArchive
    const id = config.uploadDeploymentId
    if (archive === undefined || id === undefined) {
      report.fail('the confirm phase has the archive and its deployment ID', JSON.stringify({ archive, id }))
      return
    }
    // apid restarts under the helper; every request below waits until it has.
    const log = openConsole(config.consoleLog)
    const ready = await log.waitFor({ label: 'the second boot', offset: 0, takenAt: 0 }, NEGATIVE_READY, 300_000)
    if (!report.check(ready !== null, 'the helper removed /mica/updates/uploads and restarted apid',
      'no UPLOAD_NEGATIVE READY line on the console within 300s'))
      return

    const login = await client.request('POST', '/api/v1/session', {
      contentType: 'application/json', body: JSON.stringify({ password: config.adminPassword }), sendCookies: false,
    })
    if (!report.expectStatus(login, 201, 'POST /api/v1/session logs in on the second boot')) return
    const csrf = body(login.body)?.csrfToken
    const headers: Record<string, string> = typeof csrf === 'string' ? { 'X-CSRF-Token': csrf } : {}

    const confirmed = await updateUntil(client, 120, d =>
      object(d?.state)?.current === id && object(d?.state)?.candidate === null)
    const boot = object(confirmed?.boot)
    const native = object(confirmed?.state)
    report.check(boot?.deploymentId === id && boot?.contentVerified === true && boot?.secureBoot === true,
      'the guest booted the uploaded deployment, verified and under Secure Boot', JSON.stringify(boot))
    report.check(native?.current === id && native?.candidate === null && !((native?.failed ?? []) as unknown[]).includes(id),
      'health confirmed the uploaded deployment', JSON.stringify(native))

    // The first 64 KiB of the archive, not all of it: apid refuses before it reads a byte of the body (the upload
    // directory is created first), and closes the connection with its 503, so a client still streaming 120 MB into
    // it fails with EPIPE instead of reading the refusal (CI run 43138216110). A body this size is written whole.
    const started = Date.now()
    const refused = await client.request('POST', '/api/v1/update/import', {
      headers, contentType: 'application/octet-stream', body: Bun.file(archive).slice(0, 64 * 1024), timeoutMs: UPLOAD_TIMEOUT_MS,
    })
    report.note(`import without the upload directory answered ${refused.status} after ${Math.round((Date.now() - started) / 1000)}s: ${refused.body.slice(0, 300)}`)
    report.expectStatus(refused, 503, 'an upload with no upload directory is refused with 503')
    report.expectJson(refused, { error: { code: 'update_storage_unavailable', source: 'apid' } },
      'the refusal names update_storage_unavailable', { subset: true })
  },
}
export default phase
