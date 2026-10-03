// A published release, posted to the resource service (mica-res:docs/spec/release-publishing.md): its files
// pulled into res from the GitHub Release by digest, published in one batch under mica/<product>/<stamp>/, the
// release record posted with the full update archive res feeds the device plane from, and the result read back.
//
//   bun src/cli.ts scoped-release res [--dry-run] [<board>.<variant>.<YYYYMMDD-HHMM>]
//
// With no tag, every published (non-draft) GitHub Release of this repository that has assets and a release tag,
// oldest first; with a tag, that release alone. Each post is rebuilt from the release's own published assets, never
// from the tree. A release that fails is reported and the next one is posted; the run fails at the end if any did.
// --dry-run rebuilds each record and posts nothing.
//
//   reads   the release's mica-build.lock and the head of its full update archive (GitHub, or
//           MICA_RELEASE_DOWNLOADS), its image and update bundles (ghcr.io, anonymously): the sizes and the raw
//           image identities
//   env     MICA_RES_TOKEN (an API token with res:publish, a publisher of the mica namespace; never printed),
//           MICA_RES_BASE (default https://res.micaos.dev)
//   reads back  the device manifest /update/v2/manifest.json (mica/catalog/v2), whose line of the product names
//           this release as its latest, the release's index.json (mica/release/v1), the signed descriptor and one
//           object, each at its baseUrl + path
//
// Every step is idempotent: a release posted before answers unchanged, so a failed run is rerun whole. A release
// res refuses (IMMUTABLE, RELEASE_CONFLICT, UPDATE_MISMATCH, VALIDATION_ERROR) is reported, never worked around.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Oci } from '../pool/registry.ts'
import { DOWNLOADS, fetchBytes, isReleaseTag, listReleases, previousDescriptor, registryLoad, ScopedReleaseError, tagParts, type GithubRelease } from './scoped.ts'

const say = (l: string) => console.log(l)
function die(message: string): never {
  throw new ScopedReleaseError(`res: error: ${message}`)
}

type Asset = { kind: 'image' | 'update', form: string, name: string, sha256: string }
export type Layer = { digest: string, size: number, annotations?: Record<string, string> }

/** One call of the control plane; a refusal is reported with res's own code and message. */
async function call<T>(method: string, path: string, body: unknown, retries = 0): Promise<{ status: number, data: T }> {
  const base = `${process.env['MICA_RES_BASE'] || 'https://res.micaos.dev'}/admin/api`
  const token = process.env['MICA_RES_TOKEN'] ?? ''
  if (token === '') die('MICA_RES_TOKEN is not set: an API token with the res:publish scope, of a publisher of the mica namespace')
  for (let attempt = 0; ; attempt++) {
    let status = 0, text = ''
    try {
      const r = await fetch(`${base}${path}`, { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) })
      status = r.status
      text = await r.text()
    }
    catch (e) { text = String(e) }
    if ((status === 0 || status === 429 || status >= 500) && attempt < retries) {
      await Bun.sleep(Math.min(60000, 2000 * 2 ** attempt))
      continue
    }
    let answer: { success?: boolean, data?: T, error?: { code?: string, message?: string } } = {}
    try { answer = JSON.parse(text) }
    catch { /* not JSON: reported below */ }
    if (status < 200 || status >= 300 || answer.success !== true)
      die(`${method} ${path} answered HTTP ${status}${answer.error ? ` ${answer.error.code ?? ''}: ${answer.error.message ?? ''}` : `: ${text.slice(0, 300)}`}`)
    return { status, data: answer.data as T }
  }
}

/** The layers of a release's bundle, read anonymously by the digest its lock names. */
async function bundleLayers(ref: string): Promise<Layer[]> {
  const digest = ref.slice(ref.lastIndexOf('@') + 1)
  const reg = registryLoad()
  const oci = new Oci(reg, '')
  const m = await oci.manifestGet(oci.repo('mica-build'), digest)
  if (m.status !== 200) die(`the bundle ${ref} does not read anonymously (HTTP ${m.status})`)
  return (JSON.parse(new TextDecoder().decode(m.body)) as { layers: Layer[] }).layers
}

/** Poll for up to two minutes: res rewrites its documents on each post and the edge caches them briefly. */
async function eventually(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 24; i++) {
    if (await check().catch(() => false)) { say(`res: ${what}`); return }
    await Bun.sleep(5000)
  }
  die(`${what}: not so after two minutes`)
}

export type Descriptor = { version: string, generation: number, product: string, kernel: { boot: { artifact: { sha256: string } } } }

/** The release record of mica-res:docs/spec/release-publishing.md step 3, out of the release's lock rows, its
 * bundles' layers (by digest) and its signed descriptor; anything missing or disagreeing is refused. */
export function releaseRecord(label: string, rows: string[][], layers: Map<string, Layer>, descriptor: Descriptor) {
  const tag = tagParts(label)
  const product = tag.scope, stamp = tag.release
  const productRow = rows.find(r => r[0] === 'product' && r[1] === product)
  if (productRow === undefined) die(`the lock of ${label} has no product row for ${product}`)
  const board = productRow[2]!, generation = Number(productRow[4])
  if (!product.startsWith(`${board}.`)) die(`${product} is no product of the board ${board}`)
  if (descriptor.product !== product || descriptor.generation !== generation) die(`the descriptor of ${label} names ${descriptor.product} generation ${descriptor.generation}, not the lock's ${product} generation ${generation}`)
  const assets: Asset[] = rows.filter(r => r[0] === 'asset' && r[1] === product)
    .map(r => ({ kind: r[2] as 'image' | 'update', form: r[3]!, name: r[4]!, sha256: r[5]! }))
  const full = assets.find(a => a.kind === 'update' && a.form === 'full')
  if (full === undefined) die(`${label} has no full update archive`)
  const key = (name: string) => `mica/${product}/${stamp}/${name}`
  return {
    assets,
    record: {
      release: label, scope: product, stamp, product, board, variant: product.slice(board.length + 1),
      version: descriptor.version, generation,
      assets: assets.map((a) => {
        const l = layers.get(a.sha256)
        if (l === undefined) die(`${a.name} is in no bundle of ${label}`)
        const raw = a.kind === 'image'
          ? { uncompressedSha256: l.annotations?.['mica.uncompressed-sha256'] ?? '', uncompressedSize: Number(l.annotations?.['mica.uncompressed-size']) }
          : {}
        if (a.kind === 'image' && (!/^[0-9a-f]{64}$/.test(raw.uncompressedSha256 ?? '') || !Number.isSafeInteger(raw.uncompressedSize))) die(`the bundle layer of ${a.name} carries no raw image identity`)
        return { kind: a.kind, form: a.form, path: key(a.name), sha256: a.sha256, size: l.size, ...raw }
      }),
      update: { archive: key(full.name) },
    },
  }
}

/** Post one published release; with dryRun, rebuild its record from its published assets and post nothing.
 * Returns res's outcome for the release record (`created`, `unchanged`, ...) or `dry-run`. */
export async function publishToRes(label: string, work: string, dryRun = false): Promise<string> {
  const tag = tagParts(label)
  const product = tag.scope, stamp = tag.release
  const lockFile = join(work, 'mica-build.lock')
  const got = await fetchBytes(`${DOWNLOADS()}/${label}/mica-build.lock`, {}, 120000, 3)
  if (got.status !== 200) die(`release ${label} has no readable mica-build.lock (HTTP ${got.status}); a release is posted to res after it is attached`)
  await Bun.write(lockFile, got.body)
  const rows = readFileSync(lockFile, 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'))
  // The sizes, and each image's raw identity, out of the bundles the lock pins.
  const layers = new Map<string, Layer>()
  for (const r of rows.filter(r => r[0] === 'bundle' && r[1] === product))
    for (const l of await bundleLayers(r[3]!)) layers.set(l.digest.replace(/^sha256:/, ''), l)
  // The version, out of the signed descriptor at the head of the full archive.
  const envelopeFile = join(work, 'envelope.json')
  await previousDescriptor(product, label, envelopeFile)
  const descriptor = JSON.parse(Buffer.from((JSON.parse(readFileSync(envelopeFile, 'utf8')) as { payload: string }).payload, 'base64').toString()) as Descriptor
  const { assets, record } = releaseRecord(label, rows, layers, descriptor)
  const generation = record.generation
  if (dryRun) {
    say(`res: ${label}: would post ${product} generation ${generation} version ${record.version}, ${assets.length} file(s): ${assets.map(a => a.name).join(' ')}`)
    return 'dry-run'
  }

  const contentType = (name: string) => (name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream')
  const path = (name: string) => `${product}/${stamp}/${name}`

  // 1. Stage: res pulls each file from its public asset URL and refuses bytes of another digest.
  const uploads = new Map<string, string>()
  for (const a of assets) {
    const r = await call<{ id: string }>('POST', '/res/namespaces/mica/uploads/pull',
      { origin: `https://github.com/micaoss/mica-build/releases/download/${label}/${a.name}`, sha256: a.sha256, contentType: contentType(a.name) }, 6)
    uploads.set(a.name, r.data.id)
    say(`res: staged ${a.name}`)
  }
  // 2. Publish every file in one batch, one catalog snapshot.
  const batch = await call<{ objects: { outcome: string }[] }>('POST', '/res/namespaces/mica/batch',
    { objects: assets.map(a => ({ path: path(a.name), source: { uploadId: uploads.get(a.name)! }, contentType: contentType(a.name) })) }, 3)
  say(`res: published ${assets.length} file(s) under mica/${product}/${stamp}/ (${batch.data.objects.map(o => o.outcome).join(', ')})`)
  // 3. The record; res reads the full archive for the device plane.
  const posted = await call<{ outcome?: string }>('POST', '/res/releases', record, 3)
  const outcome = posted.data.outcome ?? (posted.status === 201 ? 'created' : 'unchanged')
  say(`res: release ${label} recorded (${outcome})`)

  // 4. Read back what consumers read.
  const base = process.env['MICA_RES_BASE'] || 'https://res.micaos.dev'
  const object = descriptor.kernel.boot.artifact.sha256
  const json = async (url: string) => (await fetch(url, { cache: 'no-store' })).json()
  let index: string | undefined
  await eventually(`the device manifest (mica/catalog/v2) names ${label} at generation ${generation}`, async () => {
    index = latestIndex(await json(`${base}/update/v2/manifest.json`), label, product, generation)
    return index !== undefined
  })
  let refs: ReleaseRefs | undefined
  await eventually(`the release document (mica/release/v1) names ${label}'s descriptor and ${object.slice(0, 12)}`, async () => {
    refs = releaseRefs(await json(index!), label, product, generation, object)
    return refs !== undefined
  })
  const hashed = async (url: string) => {
    const r = await fetch(url, { redirect: 'follow' })
    return r.ok ? createHash('sha256').update(new Uint8Array(await r.arrayBuffer())).digest('hex') : ''
  }
  await eventually('the signed descriptor reads back with its digest', async () => (await hashed(refs!.deployment.url)) === refs!.deployment.sha256)
  await eventually(`the object ${object.slice(0, 12)} reads back with its digest`, async () => (await hashed(refs!.object)) === object)
  return outcome
}

/** The releases to post, oldest first: the published (non-draft) releases of this repository with assets and a
 * release tag, or the one named by `only`, which must be among them. */
export function postableReleases(releases: GithubRelease[], only = ''): string[] {
  const tags = releases.filter(r => !r.draft && r.assets.length > 0 && isReleaseTag(r.tag_name)).map(r => r.tag_name)
    .sort((a, b) => {
      const sa = a.slice(a.lastIndexOf('.') + 1), sb = b.slice(b.lastIndexOf('.') + 1)
      return sa < sb ? -1 : sa > sb ? 1 : a < b ? -1 : a > b ? 1 : 0
    })
  if (only === '') return tags
  if (!tags.includes(only)) die(`${only} is not a published release of micaoss/mica-build with assets`)
  return [only]
}

/** The job summary of a run: one row per release and its outcome. */
export function outcomeTable(results: { release: string, outcome: string }[], dryRun: boolean): string {
  return [`### res: ${results.length} release(s)${dryRun ? ', dry run (nothing posted)' : ''}`, '', '| release | outcome |', '| --- | --- |',
    ...results.map(r => `| ${r.release} | ${r.outcome.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), ''].join('\n')
}

/** Post every published release (or `only`) to res, oldest first. One release failing is recorded and the next
 * one is posted; the outcomes go to stdout and to the job summary. True when none failed. */
export async function publishAllToRes(work: string, only: string, dryRun: boolean): Promise<boolean> {
  const labels = postableReleases(await listReleases(), only)
  say(`res: ${labels.length} published release(s) to ${dryRun ? 'check' : 'post'}: ${labels.join(' ')}`)
  const results: { release: string, outcome: string }[] = []
  for (const [i, label] of labels.entries()) {
    const dir = join(work, `res-${i + 1}`)
    mkdirSync(dir, { recursive: true })
    let outcome: string
    try { outcome = await publishToRes(label, dir, dryRun) }
    catch (e) {
      if (!(e instanceof Error)) throw e
      console.error(e.message)
      outcome = `failed: ${e.message}`
    }
    results.push({ release: label, outcome })
  }
  const table = outcomeTable(results, dryRun)
  console.log(table)
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) appendFileSync(summary, `${table}\n`)
  return results.every(r => !r.outcome.startsWith('failed'))
}

/** A URL a document names as its `baseUrl` (https, a host, ending in /) plus a relative `path`; undefined when either is malformed. */
function joined(baseUrl: unknown, path: unknown): string | undefined {
  if (typeof baseUrl !== 'string' || typeof path !== 'string' || !/^https:\/\/[^/@?#]+\/([^?#]*\/)?$/.test(baseUrl)) return undefined
  if (path === '' || path.startsWith('/') || /[?#\\]/.test(path) || path.split('/').some(s => s === '.' || s === '..')) return undefined
  return baseUrl + path
}

/** The URL of the release's document when the manifest's line of `product` names `label` at `generation` as its
 * latest. Undefined while the manifest does not say so yet. */
export function latestIndex(manifest: unknown, label: string, product: string, generation: number): string | undefined {
  const m = manifest as { schema?: unknown, baseUrl?: unknown, products?: { product?: unknown, latest?: { id?: unknown, generation?: unknown, path?: unknown } }[] }
  if (m?.schema !== 'mica/catalog/v2') return undefined
  const lines = (m.products ?? []).filter(p => p.product === product)
  if (lines.length !== 1 || lines[0]!.latest?.id !== label || lines[0]!.latest?.generation !== generation) return undefined
  return joined(m.baseUrl, lines[0]!.latest?.path)
}

export type ReleaseRefs = { deployment: { url: string, sha256: string, bytes: number }, object: string }

/** What the release's own document names: its signed descriptor and the URL of `object`. Undefined when the document
 * is not this release's, or does not name both. */
export function releaseRefs(index: unknown, label: string, product: string, generation: number, object: string): ReleaseRefs | undefined {
  const r = index as { schema?: unknown, baseUrl?: unknown, id?: unknown, product?: unknown, generation?: unknown,
    deployment?: { path?: unknown, sha256?: unknown, bytes?: unknown }, objects?: { sha256?: unknown, path?: unknown }[] }
  if (r?.schema !== 'mica/release/v1' || r.id !== label || r.product !== product || r.generation !== generation) return undefined
  const deployment = joined(r.baseUrl, r.deployment?.path)
  const entry = (r.objects ?? []).find(o => o.sha256 === object)
  const url = entry === undefined ? undefined : joined(r.baseUrl, entry.path)
  if (deployment === undefined || url === undefined || typeof r.deployment?.sha256 !== 'string' || typeof r.deployment.bytes !== 'number') return undefined
  return { deployment: { url: deployment, sha256: r.deployment.sha256, bytes: r.deployment.bytes }, object: url }
}
