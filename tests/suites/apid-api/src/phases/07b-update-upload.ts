/**
 * The web upload of an update: the archive streamed to POST /api/v1/update/import, imported, installed, and the
 * reboot requested. The guest goes down at the end of this phase; run.sh boots the same disk again and phase 07c
 * reads the outcome.
 *
 * It runs on its own factory-fresh disk (run.sh's `upload` boots), not after 07 and 08: those stage a rollback
 * and a reset, and either would take the reboot this phase needs.
 */
import type { JsonValue } from '../report.ts'
import type { Client } from '../client.ts'
import type { Phase, PhaseContext } from '../runner.ts'
import { CSRF_STATE } from './02-session.ts'

export function object(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined
}
export function body(text: string): Record<string, JsonValue> | undefined {
  try { return object(JSON.parse(text)) }
  catch { return undefined }
}

/** The archive is ~80 MiB over a TCG guest's user-mode network: minutes, not the default request timeout. */
export const UPLOAD_TIMEOUT_MS = 600_000

/** GET /api/v1/update until `done` holds or `seconds` pass; the last document either way. */
export async function updateUntil(client: Client, seconds: number,
  done: (document: Record<string, JsonValue> | undefined) => boolean): Promise<Record<string, JsonValue> | undefined> {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const document = body((await client.get('/api/v1/update')).body)
    if (done(document) || Date.now() > end) return document
    await Bun.sleep(3000)
  }
}

const phase: Phase = {
  id: '07b-update-upload',
  title: 'a web upload of the next deployment is imported, installed and rebooted into',
  assumes: '02 left an authenticated browser session on a factory-fresh disk with no update staged; run.sh built '
    + 'APID_UPLOAD_ARCHIVE, this product signed one generation newer, whose deployment is APID_UPLOAD_DEPLOYMENT',
  async run({ client, report, config, state }: PhaseContext): Promise<void> {
    const csrf = state.get(CSRF_STATE)
    const archive = config.uploadArchive
    const id = config.uploadDeploymentId
    if (typeof csrf !== 'string' || archive === undefined || id === undefined || !(await Bun.file(archive).exists())) {
      report.fail('the upload phase has its CSRF token, the archive and its deployment ID',
        JSON.stringify({ csrf: typeof csrf, archive, id }))
      return
    }
    const headers = { 'X-CSRF-Token': csrf }
    const size = Bun.file(archive).size
    report.note(`uploading ${archive} (${size} bytes), deployment ${id}`)

    const started = Date.now()
    const upload = await client.request('POST', '/api/v1/update/import', {
      headers, contentType: 'application/octet-stream', body: Bun.file(archive), timeoutMs: UPLOAD_TIMEOUT_MS,
    })
    report.note(`import answered ${upload.status} after ${Math.round((Date.now() - started) / 1000)}s: ${upload.body.slice(0, 300)}`)
    if (!report.expectStatus(upload, 202, 'POST /api/v1/update/import takes the streamed archive')) return

    const staged = await updateUntil(client, 300, (d) => {
      const lifecycle = object(d?.lifecycle)
      return lifecycle?.state === 'failed' || (lifecycle?.state === 'ready' && lifecycle.deploymentId === id)
    })
    const lifecycle = object(staged?.lifecycle)
    if (!report.check(lifecycle?.state === 'ready' && lifecycle.deploymentId === id,
      'the update state names the imported deployment as staged and ready to install', JSON.stringify(lifecycle)))
      return

    const install = await client.request('POST', '/api/v1/update/install', {
      headers, contentType: 'application/json', body: JSON.stringify({ deploymentId: id }),
    })
    if (!report.expectStatus(install, 202, 'POST /api/v1/update/install accepts the imported deployment')) return
    const installed = await updateUntil(client, 600, (d) => {
      const s = object(d?.lifecycle)?.state
      return s === 'failed' || object(d?.state)?.candidate === id
    })
    if (!report.check(object(installed?.state)?.candidate === id,
      'the imported deployment is the candidate for the next boot',
      JSON.stringify({ lifecycle: installed?.lifecycle, state: installed?.state })))
      return

    // micad's safe-to-reboot gate refuses (409 power_refused) while the install still holds its in-flight flag
    // after the candidate is recorded -- the one transient refusal, retried once -- or while a health component
    // reports a blocking status, which is not retried: the refusal's body is the evidence either way.
    let reboot = await client.request('POST', '/api/v1/actions/reboot', { headers })
    if (reboot.status === 409) {
      report.note(`POST /api/v1/actions/reboot answered 409: ${reboot.body}`)
      if (/install is writing the other slot/.test(reboot.body)) {
        await new Promise(resolve => setTimeout(resolve, 15_000))
        reboot = await client.request('POST', '/api/v1/actions/reboot', { headers })
        report.note(`the one retry, 15s later, answered ${reboot.status}: ${reboot.body}`)
      }
    }
    report.expectStatus(reboot, 202, 'POST /api/v1/actions/reboot takes the guest into the candidate')
    if (reboot.status !== 202) report.note(`refusal body: ${reboot.body}`)
  },
}
export default phase
