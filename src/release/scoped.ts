// A scoped mica-build release (mica:docs/decisions/2026-09-15-mica-build-scoped-releases.md,
// mica:docs/design/release-lock.md 1.2.2): <scope>.<YYYYMMDD-HHMM>, a board (all its products) or one product.
// The scope and the stamp are separated by a dot (mica:docs/decisions/2026-09-16-scoped-tags-use-a-dot.md);
// the retired <scope>/<stamp> form is no release tag of this repository and nothing reads it.
//
// A SCOPED RELEASE IS CUT ON GITHUB, never with a local tag:
//
//   gh release create <scope>.<YYYYMMDD-HHMM> --target "$(git rev-parse origin/main)" --title <tag> --notes ...
//
// --target takes the FULL 40-hex commit. Publishing the release is what triggers release.yml, which runs the
// steps below and then the index.
//
//   bun src/cli.ts scoped-release plan <scope>.<YYYYMMDD-HHMM>   (MICA_RELEASE_GENERATIONS="<product>=<generation> ...")
//       one line per product of the scope: product, board, generation, previous release (or -), its kernel id and
//       rootfs id (or -); the generation is one above the previous release's product row, 2 for a first release
//   bun src/cli.ts scoped-release collect <product> <scope>.<YYYYMMDD-HHMM> <plan> <dir>
//       the built product (product-build <product> --release <YYYYMMDD-HHMM> --generation <g>) into <dir>: its
//       image and update files under <dir>/assets and its rows under <dir>/rows
//   bun src/cli.ts scoped-release publish <scope>.<YYYYMMDD-HHMM> <dir>
//       per product the OCI bundles image.<product>.<release> and update.<product>.<release>, read back
//       anonymously; then <dir>/mica-build.lock and <dir>/SHA256SUMS listing only it
//   bun src/cli.ts scoped-release attach <scope>.<YYYYMMDD-HHMM> <dir>
//       the assets, then the lock and SHA256SUMS last, to the GitHub Release, read back anonymously
//   bun src/cli.ts scoped-release index [--dry-run] [<scope>.<YYYYMMDD-HHMM>]
//       the Mica version index mica.<YYYYMMDD-HHMM> at this checkout's commit (release.yml's index job, after the
//       scoped release it names) as mica-build.lock and mica-index.json (src/release/index.ts) with SHA256SUMS
//       listing both; cut as a draft, checked, published as the latest release and read back anonymously. The
//       first index is built in full; every later one is incremental (the previous index carried, the named
//       release entering, products no longer published dropped); nothing entering or leaving cuts nothing.
//       --dry-run builds and checks, uploads nothing. mica.* is never cut by hand: plan, collect, publish and
//       attach refuse the scope mica. Each asset's mirrors are derived from the committed mirrors.list.
//   bun src/cli.ts scoped-release verify-index mica.<YYYYMMDD-HHMM> [--full]
//       at the index's commit, publishing nothing: its files read anonymously and the index rebuilt from its
//       previous index and the release that entered it; --full rebuilds every entry from the releases it references
//
// WHICH UPDATE PACKAGES. full always. root only when the previous release's kernel id equals this one's, kernel
// only when its rootfs id does: a partial package installs on a device only when the component it omits is
// already there. A verity key rotation re-signs the root, so it moves the rootfs id and ships as full.
//
// IMAGES ARE PUBLISHED GZIP-COMPRESSED. An image kind's asset and layer is <file>.gz, gzip -n -9 in the pinned
// build-env base image (stages/release/compress-image.sh): compressed twice to the same bytes, and decompressed
// to the sha256 and size of the raw signed image, which the layer records as mica.uncompressed-sha256 and
// mica.uncompressed-size (with mica.compression=gzip).
//
// THE REPRODUCIBILITY GUARD. A kernel component whose buildId, the hash of everything it is packed from, equals
// the previous release's while its id differs is refused: the same inputs packed to other bytes. The previous
// buildId is read out of the signed descriptor at the head of that release's full update archive (a range read),
// authenticated with the updates key, and tied to its product row by kernel id.
//
//   reads   products/, locks/ and locks/pins/, _out/products/<product>/ (a release build; MICA_RELEASE_PRODUCTS),
//           meta or MICA_SIGNING_OUTPUT (the updates public key); previous releases from the GitHub Releases of
//           micaoss/mica-build, or MICA_RELEASE_HISTORY=<dir> of <scope>.<YYYYMMDD-HHMM>/{mica-build.lock,SHA256SUMS}
//   env     MICA_REGISTRY (<host>[:port]/<owner>, default ghcr.io/micaoss; MICA_REGISTRY_PLAIN_HTTP=1 for a local
//           registry; MICA_REGISTRY_USER and MICA_REGISTRY_TOKEN the push credential, never printed), GH_TOKEN for
//           attach and index, MICA_RELEASE_GENERATIONS (plan, a generation floor)
//
// The port of tools/release.sh and tools/registry.sh (deleted 2026-09-23), step for step and message for message;
// the GitHub release operations the shell did with `gh` are the REST calls here, and the OCI manifests are the
// compact, key-sorted bytes the shell's jq wrote, so a bundle published by either carries one digest.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolve as fromResolve } from '../locks/from.ts'
import { checkLock, Exit, inputs, Refused } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { Oci, OCI_EMPTY_CONFIG_DIGEST, OCI_MANIFEST_TYPE, RegistryError, emptyConfig, manifestDigest, type Registry } from '../pool/registry.ts'
import { plainValue, products } from '../product/product.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'

export class ScopedReleaseError extends Error {}

const CLI = join(REPO_ROOT, 'src/cli.ts')
const GITHUB = 'micaoss/mica-build'
const MAX_ASSET = 2 * 1024 * 1024 * 1024
const TAG = /^([a-z0-9][a-z0-9-]*)\.([0-9]{8}-[0-9]{4})$/
const DOWNLOADS = () => process.env['MICA_RELEASE_DOWNLOADS'] || `https://github.com/${GITHUB}/releases/download`
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const shaFile = (p: string) => sha256(readFileSync(p))
const say = (l: string) => console.log(l)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function die(message: string): never {
  throw new ScopedReleaseError(`release: error: ${message}`)
}

export type Tag = { scope: string, release: string }

/** <scope>.<YYYYMMDD-HHMM>; mica.* is the index job's. */
export function tagParts(tag: string): Tag {
  const m = TAG.exec(tag)
  if (m === null) die(`the release tag must be <scope>.<YYYYMMDD-HHMM>, not '${tag}'`)
  if (m[1] === 'mica') die('mica.* releases are cut by the index job of a scoped release, never by hand')
  return { scope: m[1]!, release: m[2]! }
}

/** The products of the scope: a product's own name, or every product of a board. */
export function scopeProducts(scope: string): [string, string][] {
  const out: [string, string][] = []
  for (const p of products()) {
    const board = plainValue(join(REPO_ROOT, 'products', p, 'product.env'), 'BOARD')
    if (p !== scope && board !== scope) continue
    out.push([p, board])
  }
  if (out.length === 0) die(`the scope ${scope} is neither a product nor the board of a product`)
  return out
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (process.env['GH_TOKEN']) h['Authorization'] = `Bearer ${process.env['GH_TOKEN']}`
  return h
}

async function fetchBytes(url: string, init: RequestInit = {}, timeoutMs = 120000, retries = 0): Promise<{ status: number, body: Uint8Array, headers: Headers }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
      const body = new Uint8Array(await r.arrayBuffer())
      if (r.status >= 500 && attempt < retries) continue
      return { status: r.status, body, headers: r.headers }
    }
    catch (e) {
      if (attempt < retries) continue
      return { status: 0, body: new Uint8Array(), headers: new Headers() }
    }
  }
}

/** A file of a release's downloads: fetched (retried) or refused with `what`. */
async function download(url: string, out: string, what: string): Promise<void> {
  const r = await fetchBytes(url, {}, 300000, 3)
  if (r.status !== 200) die(what)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, r.body)
}

export type Hist = { label: string, lock: string, sums: string }

/** Every earlier release's lock, newest first. Each lock is the one its SHA256SUMS lists, and a valid lock. The
 * release being built and a release with no asset at all (one whose run failed before attaching, since the lock
 * is attached last) are not earlier releases; a release with assets and without both of these is refused,
 * never skipped. With labels, only the named ones. */
export async function history(work: string, self: Tag, labels: string[] = []): Promise<Hist[]> {
  mkdirSync(join(work, 'downloads'), { recursive: true })
  const list: Hist[] = []
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  if (historyDir) {
    for (const name of readdirSync(historyDir).sort()) {
      const dir = join(historyDir, name)
      if (!statSync(dir).isDirectory() || !name.includes('.')) continue
      if (name === `${self.scope}.${self.release}` || readdirSync(dir).length === 0) continue
      if (labels.length > 0 && !labels.includes(name)) continue
      list.push({ label: name, lock: join(dir, 'mica-build.lock'), sums: join(dir, 'SHA256SUMS') })
    }
    for (const label of labels) if (!list.some(h => h.label === label)) die(`release ${label} has no lock to read`)
  }
  else {
    let wanted = labels
    if (wanted.length === 0) {
      const releases: { draft: boolean, tag_name: string, assets: unknown[] }[] = []
      for (let page = 1; ; page++) {
        const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases?per_page=100&page=${page}`, { headers: ghHeaders() }, 60000)
        if (r.status !== 200) die(`the GitHub Releases of ${GITHUB} could not be listed`)
        const items = JSON.parse(new TextDecoder().decode(r.body)) as typeof releases
        if (items.length === 0) break
        releases.push(...items)
      }
      wanted = releases.filter(r => !r.draft && r.tag_name !== `${self.scope}.${self.release}` && r.assets.length > 0).map(r => r.tag_name).filter(t => TAG.test(t))
    }
    let n = 0
    for (const label of wanted) {
      n += 1
      const dir = join(work, 'downloads', String(n))
      mkdirSync(dir, { recursive: true })
      for (const asset of ['mica-build.lock', 'SHA256SUMS', ...(label.startsWith('mica.') ? ['mica-index.json'] : [])])
        await download(`${DOWNLOADS()}/${label}/${asset}`, join(dir, asset), `release ${label} of ${GITHUB} has no readable ${asset}; an earlier release without its lock is refused`)
      list.push({ label, lock: join(dir, 'mica-build.lock'), sums: join(dir, 'SHA256SUMS') })
    }
  }
  for (const h of list) {
    // A scoped release's SHA256SUMS lists its lock; an index's lists its lock and mica-index.json.
    const index = h.label.startsWith('mica.')
    let listed = `${existsSync(h.lock) ? shaFile(h.lock) : ''}  mica-build.lock`
    if (index) listed += `\n${existsSync(join(dirname(h.lock), 'mica-index.json')) ? shaFile(join(dirname(h.lock), 'mica-index.json')) : ''}  mica-index.json`
    const sums = existsSync(h.sums) ? readFileSync(h.sums, 'utf8').replace(/\n$/, '') : ''
    if (sums !== listed) die(`release ${h.label}: SHA256SUMS does not list exactly its mica-build.lock${index ? ' and mica-index.json' : ''}`)
    let rows: string[][]
    try { rows = checkLock(h.lock) }
    catch (e) {
      if (!(e instanceof Exit || e instanceof Refused)) throw e
      console.error(e.message)
      die(`release ${h.label}: its mica-build.lock breaks a rule (see above)`)
    }
    if (rows.find(r => r[0] === 'release')?.[2] !== h.label) die(`release ${h.label}: its lock names another release`)
  }
  return list.map(h => ({ key: `${h.label.slice(h.label.indexOf('.') + 1)}\t${h.label}`, h })).sort((a, b) => -cmp(a.key, b.key)).map(x => x.h)
}

/** The asset count of a published release (0 for a draft or none). */
async function ghReleaseAssets(label: string): Promise<number> {
  const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases/tags/${label}`, { headers: ghHeaders() }, 60000)
  if (r.status !== 200) die(`release ${label} of ${GITHUB} could not be read`)
  return (JSON.parse(new TextDecoder().decode(r.body)) as { assets: unknown[] }).assets.length
}

function lsRemoteTags(pattern: string): string[] {
  const r = Bun.spawnSync(['git', 'ls-remote', '--tags', `https://github.com/${GITHUB}`, pattern], { stdout: 'pipe', stderr: 'inherit' })
  return r.stdout.toString().split('\n').filter(l => l !== '').map(l => l.split('\t')[1]!.replace(/^refs\/tags\//, ''))
}

/** The scoped releases later than <stamp>, other than the release being built and a release with no asset. */
export async function releasesAfter(stamp: string, self: Tag): Promise<string[]> {
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  const candidates = historyDir
    ? readdirSync(historyDir).filter(n => n.includes('.') && !n.startsWith('mica.') && statSync(join(historyDir, n)).isDirectory() && readdirSync(join(historyDir, n)).length > 0)
    : lsRemoteTags('refs/tags/*').filter(t => TAG.test(t))
  const out: string[] = []
  for (const label of candidates) {
    if (label.startsWith('mica.') || !(label.slice(label.indexOf('.') + 1) > stamp) || label === `${self.scope}.${self.release}`) continue
    if (!historyDir && await ghReleaseAssets(label) === 0) continue
    out.push(label)
  }
  return out.sort(cmp)
}

const lockRows = (path: string) => readFileSync(path, 'utf8').split('\n').filter(l => l !== '').map(l => l.split('\t'))

/** The product's newest release label and that release's product row, or ['-', []]. */
function previousRelease(product: string, hist: Hist[]): { previous: string, row: string[] } {
  for (const h of hist) {
    const rows = lockRows(h.lock)
    const row = rows.find(r => r[0] === 'product' && r[1] === product)
    if (row === undefined) continue
    let previous = h.label
    if (h.label.startsWith('mica.')) {
      // An index entry: the scoped release its index row names.
      const input = rows.find(r => r[0] === 'index' && r[1] === product)?.[2] ?? ''
      const release = rows.find(r => r[0] === 'input' && r[1] === input)?.[2] ?? ''
      previous = `${input.replace(/^mica-build\./, '')}.${release}`
    }
    return { previous, row }
  }
  return { previous: '-', row: [] }
}

/** Each product's previous release: before any index exists, the newest of every earlier release; after, the
 * newest of the newest index's entries and every scoped release later than that index (an index job may still be
 * pending). A product in neither is looked up in every earlier release, so its generation stays above any it was
 * ever released at. */
export async function plan(tag: Tag, work: string): Promise<string[]> {
  // MICA_RELEASE_GENERATIONS="<product>=<generation> ..." is a floor for a history this repository can no longer
  // read; it never lowers a generation: a floor below the planned one is refused.
  const floor = new Map<string, number>()
  for (const item of (process.env['MICA_RELEASE_GENERATIONS'] ?? '').split(/\s+/).filter(s => s !== '')) {
    if (!/^[a-z0-9][a-z0-9-]*=[2-9][0-9]*$/.test(item)) die(`MICA_RELEASE_GENERATIONS holds '${item}'; each item is <product>=<generation>, a decimal of at least 2`)
    floor.set(item.slice(0, item.indexOf('=')), Number(item.slice(item.indexOf('=') + 1)))
  }
  const index = await newestIndex()
  const hist = index === '' ? await history(work, tag) : await history(work, tag, [index, ...await releasesAfter(index.slice('mica.'.length), tag)])
  let full: Hist[] | undefined
  const lines: string[] = []
  for (const [product, board] of scopeProducts(tag.scope)) {
    let { previous, row } = previousRelease(product, hist)
    if (previous === '-' && index !== '') {
      if (full === undefined) { mkdirSync(join(work, 'full'), { recursive: true }); full = await history(join(work, 'full'), tag) }
      ;({ previous, row } = previousRelease(product, full))
    }
    let planned: number, kernel = '-', rootfs = '-'
    if (previous === '-') { planned = 2 }
    else {
      if (!(previous.slice(previous.indexOf('.') + 1) < tag.release)) die(`${product} was last released in ${previous}, which is not earlier than ${tag.release}`)
      planned = Number(row[4]) + 1; kernel = row[6] ?? '-'; rootfs = row[7] ?? '-'
    }
    if (floor.has(product)) {
      if (floor.get(product)! < planned) die(`MICA_RELEASE_GENERATIONS gives ${product} generation ${floor.get(product)}, below the planned ${planned}; a generation never goes down`)
      planned = floor.get(product)!
    }
    lines.push(previous === '-' ? `${product}\t${board}\t${planned}\t-\t-\t-` : `${product}\t${board}\t${planned}\t${previous}\t${kernel}\t${rootfs}`)
  }
  return lines
}

/** The previous release's signed descriptor of <product>, from the head of its full update archive. */
async function previousDescriptor(product: string, previous: string, out: string): Promise<void> {
  const name = `mica-${product}-${previous.slice(previous.indexOf('.') + 1)}.micaupd`
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  let header: Uint8Array
  const source = historyDir ? join(historyDir, previous, name) : `${DOWNLOADS()}/${previous}/${name}`
  if (historyDir) {
    if (!existsSync(source)) die(`release ${previous} has no ${name}`)
    header = new Uint8Array(readFileSync(source)).subarray(0, 12)
  }
  else {
    const r = await fetchBytes(source, { headers: { Range: 'bytes=0-11' } }, 120000)
    if (r.status !== 206 && r.status !== 200) die(`the head of ${name} of release ${previous} could not be read`)
    header = r.body.subarray(0, 12)
  }
  const hex = Buffer.from(header).toString('hex')
  if (hex.slice(0, 16) !== '4d49434155504431') die(`${name} of release ${previous} is not a MICAUPD1 archive`)
  const length = parseInt(hex.slice(16, 24), 16)
  if (!(length > 0 && length <= 1048576)) die(`${name} of release ${previous} declares a descriptor of ${length} bytes`)
  if (historyDir) { writeFileSync(out, new Uint8Array(readFileSync(source)).subarray(12, 12 + length)) }
  else {
    const r = await fetchBytes(source, { headers: { Range: `bytes=12-${11 + length}` } }, 120000)
    if (r.status !== 206 && r.status !== 200) die(`the descriptor of ${name} of release ${previous} could not be read`)
    writeFileSync(out, r.status === 206 ? r.body : r.body.subarray(12, 12 + length))
  }
}

function identity(envelope: string, publicKey: string, out: string): string[] {
  rmSync(out, { force: true })
  const r = Bun.spawnSync([process.execPath, CLI, 'components', 'identity', '--input', envelope, '--public-key', publicKey, '--out', out], { stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) return []
  return readFileSync(out, 'utf8').replace(/\n$/, '').split('\t')
}

async function kernelGuard(product: string, previous: string, previousKernel: string, kernel: string, buildId: string, signing: string, work: string): Promise<void> {
  const envelope = join(work, 'previous-envelope.json')
  await previousDescriptor(product, previous, envelope)
  const id = identity(envelope, readFileSync(join(signing, 'updates/public.key'), 'utf8').replace(/\n/g, ''), join(work, 'previous-identity.tsv'))
  if (id.length === 0) die(`the descriptor of ${product} in release ${previous} does not authenticate with this release's updates key`)
  const [p, , , , k, , b] = id
  if (p !== product || k !== previousKernel) die(`the descriptor of ${product} in release ${previous} names ${p} kernel ${k}, not its product row's kernel ${previousKernel}`)
  if (b === buildId && k !== kernel) die(`${product}: the kernel buildId ${b} equals release ${previous}'s, and the kernel id ${kernel} differs from its ${previousKernel}; the same inputs packed to other bytes`)
}

/** The deterministic compression of a raw image, checked both ways. */
function compressImage(raw: string, sha: string, gz: string): void {
  const started = Date.now()
  const image = fromResolve('mica-build-env:base', inputs())
  const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none',
    '-v', `${hostPath(dirname(raw))}:/raw:ro`, '-v', `${hostPath(dirname(gz))}:/out`, '-v', `${hostPath(join(REPO_ROOT, 'stages/release/compress-image.sh'))}:/compress.sh:ro`,
    image, 'bash', '/compress.sh', basename(raw), basename(gz)], { stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) die(`compressing ${basename(raw)} failed`)
  const answer = r.stdout.toString().trim()
  if (answer === 'nondeterministic') die(`gzip compressed ${basename(raw)} to different bytes twice; the release fails`)
  const size = statSync(raw).size
  if (answer !== `${sha} ${size}`) die(`${basename(gz)} decompresses to ${answer}, not the raw image's ${sha} ${size}`)
  say(`release: ${basename(gz)}: ${size} bytes to ${statSync(gz).size}, compressed twice and checked in ${Math.round((Date.now() - started) / 1000)} s`)
}

export async function collect(product: string, tag: Tag, planFile: string, dir: string, work: string): Promise<void> {
  const out = join(process.env['MICA_RELEASE_PRODUCTS'] || join(REPO_ROOT, '_out/products'), product)
  const line = lockRows(planFile).find(r => r[0] === product)
  if (line === undefined) die(`the plan names no product ${product}`)
  const [, board = '', generation = '', previous = '-', prevKernel = '', prevRootfs = ''] = line
  const receipt = existsSync(join(out, 'receipt.txt')) ? readFileSync(join(out, 'receipt.txt'), 'utf8').split('\n') : []
  if (!receipt.includes(`release ${tag.release}`) || !receipt.includes(`generation ${generation}`))
    die(`${out} is not a build of release ${tag.release} at generation ${generation} (bun src/cli.ts product-build ${product} --release ${tag.release} --generation ${generation})`)
  const profile = plainValue(join(REPO_ROOT, 'products', product, 'product.env'), 'PROFILE')
  const signing = process.env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta')
  const id = identity(join(out, 'deployments', `${generation}.json`), readFileSync(join(signing, 'updates/public.key'), 'utf8').replace(/\n/g, ''), join(work, 'identity.tsv'))
  if (id.length === 0) die(`the signed deployment of ${out} does not authenticate`)
  const [p, b, g, deployment = '', kernel = '', rootfs = '', buildId = ''] = id
  if (p !== product || b !== board || g !== generation) die(`the signed deployment of ${out} names ${p} ${b} generation ${g}, not ${product} ${board} generation ${generation}`)
  if (previous !== '-') await kernelGuard(product, previous, prevKernel, kernel, buildId, signing, work)
  mkdirSync(join(dir, 'assets'), { recursive: true }); mkdirSync(join(dir, 'rows'), { recursive: true })
  const uncompressed: string[] = []
  const rows: string[] = [`product\t${product}\t${board}\t${profile}\t${generation}\t${deployment}\t${kernel}\t${rootfs}`]
  for (const type of ['image', 'update'] as const) {
    const table = join(out, type === 'image' ? 'kinds.tsv' : 'updates.tsv')
    if (!existsSync(table) || statSync(table).size === 0) die(`${table} is empty; the product built no ${type} files`)
    for (const [kind = '', file = '', sha = ''] of lockRows(table)) {
      let name = basename(file)
      let assetSha = sha
      if (type === 'update' && kind === 'root' && prevKernel !== kernel) { say(`release: ${product}: no root package, the kernel id differs from ${previous}`); continue }
      if (type === 'update' && kind === 'kernel' && prevRootfs !== rootfs) { say(`release: ${product}: no kernel package, the rootfs id differs from ${previous}`); continue }
      if (!name.startsWith(`mica-${product}-${tag.release}.`)) die(`${out}/${file} is not named mica-${product}-${tag.release}.<suffix>`)
      if (shaFile(join(out, file)) !== sha) die(`${out}/${file} does not hash to its ${basename(table)} row`)
      if (type === 'image') {
        compressImage(join(out, file), sha, join(dir, 'assets', `${name}.gz`))
        uncompressed.push(`${kind}\t${sha}\t${statSync(join(out, file)).size}`)
        name = `${name}.gz`; assetSha = shaFile(join(dir, 'assets', name))
      }
      else { copyFileSync(join(out, file), join(dir, 'assets', name)) }
      if (statSync(join(dir, 'assets', name)).size > MAX_ASSET) die(`${name} is over 2 GiB, a GitHub Release asset's limit; the product's release fails`)
      rows.push(`asset\t${product}\t${type}\t${kind}\t${name}\t${assetSha}`)
    }
  }
  writeFileSync(join(dir, 'rows', `${product}.uncompressed`), uncompressed.map(l => `${l}\n`).join(''))
  writeFileSync(join(dir, 'rows', `${product}.tsv`), rows.map(l => `${l}\n`).join(''))
  if (!rows.some(r => /^asset\t[^\t]*\tupdate\tfull\t/.test(r))) die(`${product} built no full update package`)
  say(`release: ${product} collected for ${tag.scope}.${tag.release} (generation ${generation})`)
}

/** The registry of MICA_REGISTRY (default ghcr.io/micaoss), as the OCI client reads it. */
export function registryLoad(): Registry {
  const registry = process.env['MICA_REGISTRY'] || 'ghcr.io/micaoss'
  const m = /^([A-Za-z0-9.-]+(:[0-9]+)?)\/([a-z0-9][a-z0-9-]*)$/.exec(registry)
  if (m === null) die(`MICA_REGISTRY='${registry}' is not <host>[:port]/<owner>`)
  const host = m[1]!, owner = m[3]!
  let url: string
  if (process.env['MICA_REGISTRY_PLAIN_HTTP'] === '1') {
    if (!/^(localhost|127\.0\.0\.1|[a-z0-9-]+)(:[0-9]+)?$/.test(host)) die(`MICA_REGISTRY_PLAIN_HTTP=1 is for a local test registry, not ${host}`)
    url = `http://${host}`
  }
  else { url = `https://${host}` }
  return { host, base: owner, url, user: process.env['MICA_REGISTRY_USER'] ?? '', tokenVar: 'MICA_REGISTRY_TOKEN', sourceUrl: '' }
}

const client = (reg: Registry) => new Oci(reg, process.env['MICA_REGISTRY_TOKEN'] ?? '')

/** jq -cS: compact JSON, keys sorted at every level. */
export function compactSorted(value: unknown): string {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v)
  return JSON.stringify(sorted(value))
}

type BundleLayer = { file: string, mediaType: string, annotations: Record<string, string> }

/** The bundle of <layers> under <tag>: the blobs and the compact manifest the shell's jq wrote, unless the tag
 * holds that manifest; a tag holding another digest is refused, never re-pointed. The digest. */
async function publishBundle(oci: Oci, repo: string, tag: string, artifactType: string, layers: BundleLayer[]): Promise<string> {
  await oci.blobPut(repo, emptyConfig(), OCI_EMPTY_CONFIG_DIGEST)
  const descriptors = []
  for (const l of layers) {
    const digest = `sha256:${shaFile(l.file)}`
    await oci.blobPut(repo, l.file, digest)
    descriptors.push({ mediaType: l.mediaType, digest, size: statSync(l.file).size, annotations: l.annotations })
  }
  const manifest = new TextEncoder().encode(compactSorted({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, artifactType, config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: OCI_EMPTY_CONFIG_DIGEST, size: 2 }, layers: descriptors }))
  const digest = manifestDigest(manifest)
  const existing = await oci.request('GET', repo, 'pull,push', `manifests/${tag}`, { headers: { Accept: OCI_MANIFEST_TYPE } })
  if (existing.status === 200) {
    const have = manifestDigest(existing.body)
    if (have !== digest) die(`${oci.reg.host}/${repo}:${tag} already holds ${have}, and this manifest is ${digest}; a published tag is never re-pointed`)
  }
  else if (existing.status === 404) {
    const put = await oci.request('PUT', repo, 'pull,push', `manifests/${tag}`, { headers: { 'Content-Type': OCI_MANIFEST_TYPE }, body: manifest })
    if (put.status !== 201) die(`putting ${tag} to ${oci.reg.host}/${repo} answered HTTP ${put.status}: ${new TextDecoder().decode(put.body.subarray(0, 200))}`)
  }
  else { die(`reading ${oci.reg.host}/${repo}:${tag} answered HTTP ${existing.status}`) }
  return digest
}

/** The manifest and every layer of <repo>@<digest>, read anonymously; the manifest's layer digests. */
async function readBack(reg: Registry, repo: string, digest: string, what: string, work: string): Promise<{ layers: string[], path: string }> {
  const anonymous = new Oci(reg, '')
  const m = await anonymous.manifestGet(repo, digest)
  if (m.status !== 200 || manifestDigest(m.body) !== digest) die(`${what} does not read back anonymously as ${digest} (HTTP ${m.status})`)
  const path = join(work, `${digest.slice('sha256:'.length)}.json`)
  writeFileSync(path, m.body)
  const layers = (JSON.parse(new TextDecoder().decode(m.body)) as { layers: { digest: string }[] }).layers.map(l => l.digest)
  for (const layer of layers) {
    const status = await anonymous.blobHead(repo, layer)
    if (status !== 200) die(`a layer of ${what} does not read back anonymously at ${layer} (HTTP ${status})`)
  }
  return { layers, path }
}

const ORDER = ['pool', 'package', 'board', 'input', 'product', 'bundle', 'asset']
const WIDTH: Record<string, number> = { pool: 1, package: 2, board: 2, input: 1, product: 1, bundle: 2, asset: 3 }

/** The rows of a scoped release's lock in their order: by kind, then by the key columns of each. */
export function sortRows(rows: string[][]): string[][] {
  return [...rows].sort((a, b) => {
    const d = ORDER.indexOf(a[0]!) - ORDER.indexOf(b[0]!)
    if (d !== 0) return d
    const w = WIDTH[a[0]!]!
    for (let i = 1; i <= w; i++) { const c = cmp(a[i] ?? '', b[i] ?? ''); if (c !== 0) return c }
    return 0
  })
}

export async function publish(tag: Tag, dir: string, work: string): Promise<void> {
  const reg = registryLoad()
  const oci = client(reg)
  const repo = oci.repo('mica-build')
  const commit = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
  const rows: string[][] = []
  const rowFiles = existsSync(join(dir, 'rows')) ? readdirSync(join(dir, 'rows')).filter(f => f.endsWith('.tsv')).sort() : []
  for (const f of rowFiles) {
    const product = f.slice(0, -'.tsv'.length)
    const productRows = lockRows(join(dir, 'rows', f))
    rows.push(...productRows)
    const productRow = productRows.find(r => r[0] === 'product')!
    const generation = productRow[4]!, deployment = productRow[5]!
    for (const type of ['image', 'update'] as const) {
      const layers: BundleLayer[] = []
      for (const [, , , kind = '', name = '', sha = ''] of productRows.filter(r => r[0] === 'asset' && r[1] === product && r[2] === type)) {
        let annotations: Record<string, string>
        if (type === 'image') {
          const raw = lockRows(join(dir, 'rows', `${product}.uncompressed`)).find(r => r[0] === kind)
          if (raw === undefined || (raw[1] ?? '') === '') die(`${product}: no uncompressed identity for its ${kind} image`)
          annotations = { 'org.opencontainers.image.title': name, 'mica.image-kind': kind, 'mica.compression': 'gzip', 'mica.uncompressed-sha256': raw[1]!, 'mica.uncompressed-size': raw[2]! }
        }
        else { annotations = { 'org.opencontainers.image.title': name, 'mica.update-kind': kind, 'mica.deployment-id': deployment, 'mica.generation': generation } }
        void sha
        layers.push({ file: join(dir, 'assets', name), mediaType: 'application/octet-stream', annotations })
      }
      const bundleTag = `${type}.${product}.${tag.release}`
      let digest: string
      try { digest = await publishBundle(oci, repo, bundleTag, `application/vnd.mica.${type}`, layers) }
      catch (e) {
        if (e instanceof RegistryError) { console.error(e.message); die(`publishing ${bundleTag} failed (see above)`) }
        throw e
      }
      // Read back anonymously: the manifest by digest, and every layer it names.
      let read: { layers: string[] }
      try { read = await readBack(reg, repo, digest, `${reg.host}/${repo}:${bundleTag}`, work) }
      catch (e) {
        if (e instanceof ScopedReleaseError && e.message.includes('does not read back anonymously as')) die(`${e.message.replace('release: error: ', '')}; a new package is private until it is made public in its package settings, then rerun`)
        throw e
      }
      for (const layer of read.layers)
        if (!productRows.some(r => r[0] === 'asset' && r[1] === product && r[2] === type && r[5] === layer.slice('sha256:'.length))) die(`the layer ${layer} of ${bundleTag} is no asset row`)

      rows.push(['bundle', product, type, `ghcr.io/micaoss/mica-build:${bundleTag}@${digest}`])
    }
  }
  if (rowFiles.length === 0) die(`${dir}/rows holds no collected product`)
  // The board's own outputs, published under this release's tag before the products were built
  // (src/pool/publish.ts, src/release/publish-components.ts; their rows under <dir>/board-rows).
  const boards = [...new Set(rows.filter(r => r[0] === 'product').map(r => r[2]!))].sort()
  if (boards.length !== 1) die(`the collected products name more than one board: ${boards.map(b => `${b} `).join('')}`)
  const board = boards[0]!
  const boardRows = join(dir, 'board-rows')
  for (const f of ['pool', 'package', 'board']) if (!existsSync(join(boardRows, `${f}.tsv`))) die(`${boardRows}/${f}.tsv does not exist; the ${board} pool and components are published before the products (src/cli.ts pool-publish, src/cli.ts publish-components)`)
  for (const r of lockRows(join(boardRows, 'pool.tsv'))) rows.push(['pool', r[0]!, `ghcr.io/micaoss/mica-build:${r[1]}@${r[2]}`])
  for (const r of lockRows(join(boardRows, 'package.tsv'))) rows.push(['package', r[0]!, r[1]!, r[2]!, r[3]!])
  let bad = false
  for (const r of lockRows(join(boardRows, 'board.tsv'))) { if (r[0] !== board) bad = true; rows.push(['board', r[0]!, r[1]!, r[2]!, `ghcr.io/micaoss/mica-build:${r[3]}@${r[4]}`]) }
  if (bad) die(`${boardRows}/board.tsv names a board other than ${board}`)
  // The inputs: every pin.
  for (const pin of readdirSync(join(REPO_ROOT, 'locks/pins')).filter(f => f.endsWith('.pin')).sort()) {
    const text = readFileSync(join(REPO_ROOT, 'locks/pins', pin), 'utf8')
    const value = (key: string) => (new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '')
    rows.push(['input', pin.slice(0, -'.pin'.length), value('RELEASE'), value('SHA256SUMS')])
  }
  const lock = ['# mica-lock v1', `release\tmica-build\t${tag.scope}.${tag.release}\t${commit}`, ...sortRows(rows).map(r => r.join('\t'))].map(l => `${l}\n`).join('')
  writeFileSync(join(dir, 'mica-build.lock'), lock)
  try { checkLock(join(dir, 'mica-build.lock')) }
  catch (e) {
    if (!(e instanceof Exit || e instanceof Refused)) throw e
    console.error(e.message)
    die('the written mica-build.lock breaks a rule (see above)')
  }
  writeFileSync(join(dir, 'SHA256SUMS'), `${shaFile(join(dir, 'mica-build.lock'))}  mica-build.lock\n`)
  process.stdout.write(lock)
}

/** The release of a tag on GitHub: its id and assets. */
async function ghRelease(tag: string): Promise<{ id: number, assets: { name: string, digest?: string }[] }> {
  const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases/tags/${tag}`, { headers: ghHeaders() }, 60000)
  if (r.status !== 200) die(`the release ${tag} of ${GITHUB} could not be read (HTTP ${r.status})`)
  return JSON.parse(new TextDecoder().decode(r.body)) as { id: number, assets: { name: string, digest?: string }[] }
}

/** Upload one asset to a release; an existing asset is never replaced. */
async function ghUpload(id: number, file: string): Promise<void> {
  const name = basename(file)
  const r = await fetchBytes(`https://uploads.github.com/repos/${GITHUB}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { ...ghHeaders(), 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(readFileSync(file)) }, 3600000)
  if (r.status !== 201) die(`uploading ${name} to release ${id} of ${GITHUB} answered HTTP ${r.status}: ${new TextDecoder().decode(r.body.subarray(0, 200))}`)
}

async function readsBackAs(url: string, sha: string): Promise<boolean> {
  const r = await fetchBytes(url, {}, 3600000)
  return r.status === 200 && sha256(r.body) === sha
}

export async function attach(tag: Tag, dir: string): Promise<void> {
  const label = `${tag.scope}.${tag.release}`
  if (!existsSync(join(dir, 'mica-build.lock')) || !existsSync(join(dir, 'SHA256SUMS'))) die(`${dir} holds no published lock (scoped-release publish)`)
  // Assets first, the lock and SHA256SUMS last; an existing asset is never replaced.
  const release = await ghRelease(label)
  const assets = readdirSync(join(dir, 'assets')).sort().map(f => join(dir, 'assets', f))
  for (const f of [...assets, join(dir, 'mica-build.lock'), join(dir, 'SHA256SUMS')]) {
    if (release.assets.some(a => a.name === basename(f))) die(`release ${label} already carries ${basename(f)}; an existing asset is never replaced`)
    await ghUpload(release.id, f)
  }
  for (const name of [...lockRows(join(dir, 'mica-build.lock')).filter(r => r[0] === 'asset').map(r => r[4]!), 'mica-build.lock', 'SHA256SUMS']) {
    const path = existsSync(join(dir, 'assets', name)) ? join(dir, 'assets', name) : join(dir, name)
    if (!await readsBackAs(`https://github.com/${GITHUB}/releases/download/${label}/${name}`, shaFile(path))) die(`${name} of release ${label} does not read back anonymously with its bytes`)
  }
  say(`release: ${label} attached and read back`)
}

/** The asset at <label>/<file>: its size from a HEAD of the download, or from MICA_RELEASE_ASSETS=<dir>. */
async function assetSize(label: string, file: string): Promise<number | undefined> {
  const assets = process.env['MICA_RELEASE_ASSETS']
  if (assets) {
    const p = join(assets, label, file)
    return existsSync(p) ? statSync(p).size : undefined
  }
  try {
    const r = await fetch(`https://github.com/${GITHUB}/releases/download/${label}/${file}`, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(120000) })
    const n = r.headers.get('content-length')
    return r.status === 200 && n !== null ? Number(n) : undefined
  }
  catch { return undefined }
}

/** The newest index release, or '': the mica.* tags of the repository, or the mica.* directories of the history. */
export async function newestIndex(): Promise<string> {
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  const names = historyDir
    ? readdirSync(historyDir).filter(n => n.startsWith('mica.') && statSync(join(historyDir, n)).isDirectory())
    : lsRemoteTags('refs/tags/mica.*').filter(t => /^mica\.[0-9]{8}-[0-9]{4}$/.test(t))
  return names.sort(cmp).at(-1) ?? ''
}

function cli(args: string[], stdout: 'inherit' | 'pipe' = 'inherit'): { code: number, out: string } {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { stdout, stderr: 'inherit' })
  return { code: r.exitCode, out: stdout === 'pipe' ? (r.stdout?.toString() ?? '') : '' }
}

function lockCheck(path: string, what: string): void {
  try { checkLock(path) }
  catch (e) {
    if (!(e instanceof Exit || e instanceof Refused)) throw e
    console.error(e.message)
    die(what)
  }
}

export async function index(dryRun: boolean, entering: string, work: string): Promise<void> {
  const started = Date.now()
  if (entering !== '') tagParts(entering)
  const commit = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
  if (Bun.spawnSync(['git', '-C', REPO_ROOT, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString() !== '') die('an index is cut from a clean checkout')
  const self: Tag = { scope: 'mica', release: '00000000-0000' }
  const previous = await newestIndex()
  let mode: 'full' | 'incremental'
  let hist: Hist[]
  if (previous === '' || process.env['MICA_INDEX_FULL']) { mode = 'full'; hist = await history(work, self) }
  else { mode = 'incremental'; hist = await history(work, self, [previous, ...(entering === '' ? [] : [entering])]) }
  writeFileSync(join(work, 'history.tsv'), hist.map(h => `${h.label}\t${h.lock}\t${h.sums}\n`).join(''))
  // The catalogue: every board of boards/boards.tsv, its release-target flag out of its board.env in this tree.
  const boardsList = cli(['boards', 'list'], 'pipe')
  if (boardsList.code !== 0) die('boards/boards.tsv could not be read (see above)')
  const boardsTsv: string[] = []
  for (const board of boardsList.out.split('\n').filter(b => b !== '')) {
    const env = process.env['MICA_INDEX_BOARD_ENV_DIR'] ? join(process.env['MICA_INDEX_BOARD_ENV_DIR'], board, 'board.env') : join(REPO_ROOT, 'boards', board, 'board.env')
    const arch = cli(['boards', 'arch', board], 'pipe')
    if (arch.code !== 0) die(`boards/boards.tsv names no architecture of ${board}`)
    const target = existsSync(env) && readFileSync(env, 'utf8').split('\n').includes('BOARD_RELEASE_TARGET=1') ? '1' : '0'
    boardsTsv.push(`${board}\t${arch.out.trim()}\t${target}`)
  }
  writeFileSync(join(work, 'boards.tsv'), boardsTsv.map(l => `${l}\n`).join(''))
  // A product is published when its board is a release target (mica:docs/design/mica-index.md 3.1).
  const productsTsv: string[] = []
  for (const product of products()) {
    const env = join(REPO_ROOT, 'products', product, 'product.env')
    const board = plainValue(env, 'BOARD')
    const target = boardsTsv.find(l => l.split('\t')[0] === board)?.split('\t')[2] ?? ''
    productsTsv.push(`${product}\t${board}\t${plainValue(env, 'PROFILE')}\t${plainValue(env, 'FEATURES')}\t${target}`)
  }
  writeFileSync(join(work, 'products.tsv'), productsTsv.map(l => `${l}\n`).join(''))
  const out = join(work, 'index')
  mkdirSync(out, { recursive: true })
  let stamp = '', code = 0
  for (let tries = 0; ; tries++) {
    stamp = process.env['MICA_INDEX_STAMP'] || new Date().toISOString().replace(/[-:]/g, '').replace(/^(\d{8})T(\d{4}).*$/, '$1-$2')
    code = cli(['release-index', 'lock', join(work, 'history.tsv'), join(work, 'products.tsv'), stamp, commit, mode, join(out, 'mica-build.lock'), join(work, 'entering.tsv')]).code
    if (!(code === 4 && !process.env['MICA_INDEX_STAMP'] && tries < 2)) break
    // The minute is not later than a reference or the previous index: wait for the next one.
    await Bun.sleep((61 - new Date().getUTCSeconds()) * 1000)
  }
  if (code === 5) { say('release: no index is cut (see above)'); return }
  if (code !== 0) die(`the index of ${stamp} was refused (see above)`)
  lockCheck(join(out, 'mica-build.lock'), 'the index lock breaks a rule (see above)')
  // The entering entries only: every bundle manifest, read anonymously by digest, and every asset's size.
  const reg = registryLoad()
  const repo = client(reg).repo('mica-build')
  const layersTsv: string[] = [], assetsTsv: string[] = []
  const lock = lockRows(join(out, 'mica-build.lock'))
  const enteringRows = existsSync(join(work, 'entering.tsv')) ? lockRows(join(work, 'entering.tsv')) : []
  for (const [product = '', label = ''] of enteringRows) {
    for (const ref of lock.filter(r => r[0] === 'bundle' && r[1] === product).map(r => r[3]!)) {
      const digest = ref.slice(ref.lastIndexOf('@') + 1)
      const read = await readBack(reg, repo, digest, `the bundle ${ref}`, work)
      layersTsv.push(`${ref}\t${read.path}`)
    }
    for (const file of lock.filter(r => r[0] === 'asset' && r[1] === product).map(r => r[4]!)) {
      const size = await assetSize(label, file)
      if (size === undefined) die(`the asset ${file} of release ${label} does not read back anonymously`)
      assetsTsv.push(`${label}\t${file}\t${size}`)
    }
  }
  writeFileSync(join(work, 'layers.tsv'), layersTsv.map(l => `${l}\n`).join(''))
  writeFileSync(join(work, 'assets.tsv'), assetsTsv.map(l => `${l}\n`).join(''))
  // mirrors.list is committed, so an index rebuilt from a clean checkout of this commit is the same bytes
  // anywhere (mica:docs/design/mica-index.md 3.1); a tree without it emits no mirrors member at all.
  if (cli(['release-index', 'json', join(out, 'mica-build.lock'), join(work, 'history.tsv'), join(work, 'entering.tsv'), join(work, 'products.tsv'), join(work, 'boards.tsv'),
    join(work, 'layers.tsv'), join(work, 'assets.tsv'), DOWNLOADS(), join(REPO_ROOT, 'mirrors.list'), join(out, 'mica-index.json')]).code !== 0) die('the index JSON was refused (see above)')
  writeFileSync(join(out, 'SHA256SUMS'), `${shaFile(join(out, 'mica-build.lock'))}  mica-build.lock\n${shaFile(join(out, 'mica-index.json'))}  mica-index.json\n`)
  const tag = `mica.${stamp}`
  const seconds = Math.round((Date.now() - started) / 1000)
  say(`release: ${tag}: ${mode}, ${lock.filter(r => r[0] === 'index').length} product(s) from ${lock.filter(r => r[0] === 'input').length} release(s), ${enteringRows.length} entering${mode === 'full' ? '' : `, the rest carried from ${previous}`} in ${seconds} s; SHA256SUMS ${shaFile(join(out, 'SHA256SUMS'))}`)
  process.stdout.write(readFileSync(join(out, 'mica-build.lock')))
  // The inputs travel with the outputs: a reader of an index can re-run src/release/index.ts over exactly what
  // produced it, which is how the emitter's own cases are written.
  const keep = process.env['MICA_INDEX_OUT']
  if (keep) {
    mkdirSync(join(keep, 'manifests'), { recursive: true })
    for (const f of readdirSync(out)) copyFileSync(join(out, f), join(keep, f))
    for (const f of ['history.tsv', 'entering.tsv', 'products.tsv', 'boards.tsv', 'assets.tsv']) copyFileSync(join(work, f), join(keep, f))
    // layers.tsv names manifest files of the work directory, which is removed on exit, so the copies travel
    // with it and the copied table names the copies.
    const copied: string[] = []
    for (const [ref = '', path = ''] of lockRows(join(work, 'layers.tsv'))) {
      copyFileSync(path, join(keep, 'manifests', basename(path)))
      copied.push(`${ref}\t${join(keep, 'manifests', basename(path))}`)
    }
    writeFileSync(join(keep, 'layers.tsv'), copied.map(l => `${l}\n`).join(''))
  }
  if (dryRun) { say(`release: ${tag}: dry run, nothing uploaded`); return }
  // A draft first, the three files, their digests checked, then published as the latest release and read back.
  const created = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ tag_name: tag, target_commitish: commit, name: tag, draft: true, body: `Mica version ${stamp}: the index of the scoped releases of every published product (mica-index.json, mica-build.lock).` }) }, 60000)
  if (created.status !== 201) die(`creating the draft ${tag} answered HTTP ${created.status}: ${new TextDecoder().decode(created.body.subarray(0, 200))}`)
  const id = (JSON.parse(new TextDecoder().decode(created.body)) as { id: number }).id
  for (const file of ['mica-build.lock', 'mica-index.json', 'SHA256SUMS']) await ghUpload(id, join(out, file))
  // GitHub computes an asset's digest after the upload returns, so this waits for it rather than reading once:
  // an absent digest is "not yet", a different one is a different file, and only the latter is a refusal.
  for (const file of ['mica-build.lock', 'mica-index.json', 'SHA256SUMS']) {
    const want = `sha256:${shaFile(join(out, file))}`
    let got = ''
    for (let i = 0; i < 20; i++) {
      const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases/${id}`, { headers: ghHeaders() }, 60000)
      got = r.status === 200 ? ((JSON.parse(new TextDecoder().decode(r.body)) as { assets: { name: string, digest?: string }[] }).assets.find(a => a.name === file)?.digest ?? '') : ''
      if (got !== '') break
      await Bun.sleep(5000)
    }
    if (got !== want) die(`${file} of the draft ${tag} carries ${got || 'no digest'}, not ${want}; the draft is left unpublished`)
  }
  const edited = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases/${id}`, { method: 'PATCH', headers: ghHeaders(), body: JSON.stringify({ draft: false, make_latest: 'true' }) }, 60000)
  if (edited.status !== 200) die(`publishing ${tag} answered HTTP ${edited.status}`)
  for (const file of ['mica-build.lock', 'mica-index.json', 'SHA256SUMS'])
    if (!await readsBackAs(`https://github.com/${GITHUB}/releases/download/${tag}/${file}`, shaFile(join(out, file)))) die(`${file} of release ${tag} does not read back anonymously with its bytes`)

  say(`release: ${tag} published as the latest release and read back in ${Math.round((Date.now() - started) / 1000)} s`)
  await verifyIndex(tag, false, work)
}

/** An index release, verified independently and anonymously, publishing nothing: its three files, then the
 * index rebuilt at its own commit and stamp, byte-identical to the published lock and mica-index.json. By default
 * the rebuild is the incremental one of its cut; --full rebuilds every entry from every release it references. */
export async function verifyIndex(tag: string, full: boolean, work: string): Promise<void> {
  if (!/^mica\.[0-9]{8}-[0-9]{4}$/.test(tag)) die(`verify-index takes mica.<YYYYMMDD-HHMM>, not '${tag}'`)
  const got = join(work, 'verify/got'), historyDir = join(work, 'verify/history'), rebuilt = join(work, 'verify/rebuilt')
  for (const d of [got, historyDir, rebuilt]) mkdirSync(d, { recursive: true })
  for (const file of ['mica-build.lock', 'mica-index.json', 'SHA256SUMS']) await download(`${DOWNLOADS()}/${tag}/${file}`, join(got, file), `${file} of ${tag} does not read back anonymously`)
  if (readFileSync(join(got, 'SHA256SUMS'), 'utf8').replace(/\n$/, '') !== `${shaFile(join(got, 'mica-build.lock'))}  mica-build.lock\n${shaFile(join(got, 'mica-index.json'))}  mica-index.json`) die(`SHA256SUMS of ${tag} does not list exactly its lock and mica-index.json`)
  lockCheck(join(got, 'mica-build.lock'), `the lock of ${tag} breaks a rule (see above)`)
  const lock = lockRows(join(got, 'mica-build.lock'))
  const indexCommit = lock.find(r => r[0] === 'release')?.[3] ?? ''
  const head = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
  if (indexCommit !== head || Bun.spawnSync(['git', '-C', REPO_ROOT, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString() !== '') die(`verify ${tag} from a clean checkout of its commit ${indexCommit}`)
  const fetchRelease = async (label: string, files: string[]) => {
    for (const file of files) await download(`${DOWNLOADS()}/${label}/${file}`, join(historyDir, label, file), `${file} of ${label}, referenced by ${tag}, does not read back anonymously`)
  }
  const json = JSON.parse(readFileSync(join(got, 'mica-index.json'), 'utf8')) as { previous?: { release?: string, trust?: string } }
  const previous = json.previous?.release ?? ''
  if (previous !== '') {
    await fetchRelease(previous, ['mica-build.lock', 'mica-index.json', 'SHA256SUMS'])
    if (shaFile(join(historyDir, previous, 'SHA256SUMS')) !== (json.previous?.trust ?? '')) die(`the previous index ${previous} of ${tag} no longer has the SHA256SUMS hash ${tag} names`)
  }
  const entering: string[] = []
  for (const [, input = '', release = ''] of lock.filter(r => r[0] === 'input')) {
    const scope = input.replace(/^mica-build\./, '')
    if (!full && previous !== '' && lockRows(join(historyDir, previous, 'mica-build.lock')).some(r => r[0] === 'input' && r[1] === input && r[2] === release)) continue
    await fetchRelease(`${scope}.${release}`, ['mica-build.lock', 'SHA256SUMS'])
    entering.push(`${scope}.${release}`)
  }
  const args = ['scoped-release', 'index', '--dry-run']
  if (!full && previous !== '') {
    if (entering.length > 1) die(`${tag} names ${entering.length} releases not in its previous index ${previous}; an index job enters one`)
    args.push(...entering)
  }
  const env: Record<string, string> = { ...process.env as Record<string, string>, MICA_RELEASE_HISTORY: historyDir, MICA_INDEX_STAMP: tag.slice('mica.'.length), MICA_INDEX_OUT: rebuilt }
  if (full) env['MICA_INDEX_FULL'] = '1'
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe', env })
  writeFileSync(join(work, 'verify/rebuild.log'), Buffer.concat([r.stdout, r.stderr]))
  if (r.exitCode !== 0) { process.stderr.write(readFileSync(join(work, 'verify/rebuild.log'))); die(`${tag} could not be rebuilt from the releases it references`) }
  for (const file of ['mica-build.lock', 'mica-index.json'])
    if (!existsSync(join(rebuilt, file)) || Buffer.compare(readFileSync(join(got, file)), readFileSync(join(rebuilt, file))) !== 0) die(`${file} of ${tag} differs from the index rebuilt from its references`)

  const references = lock.filter(r => r[0] === 'input').length
  say(`release: ${tag} verified${full ? ' in full' : ''}: SHA256SUMS ${shaFile(join(got, 'SHA256SUMS'))}, the lock and the JSON rebuilt byte-identically from ${full || previous === '' ? `its ${references} referenced release(s)` : `${previous} and ${entering.length} entering release(s)`}${previous === '' ? '' : `, previous ${previous}`}`)
}

export async function main(argv: string[]): Promise<number> {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.release.'))
  try {
    const [cmd, ...rest] = argv
    if (cmd === 'plan') { if (rest.length !== 1) die('usage: plan <scope>.<YYYYMMDD-HHMM>'); await Bun.write(Bun.stdout, (await plan(tagParts(rest[0]!), work)).map(l => `${l}\n`).join('')); return 0 }
    if (cmd === 'collect') { if (rest.length !== 4) die('usage: collect <product> <scope>.<YYYYMMDD-HHMM> <plan> <dir>'); await collect(rest[0]!, tagParts(rest[1]!), rest[2]!, rest[3]!, work); return 0 }
    if (cmd === 'publish') { if (rest.length !== 2) die('usage: publish <scope>.<YYYYMMDD-HHMM> <dir>'); await publish(tagParts(rest[0]!), rest[1]!, work); return 0 }
    if (cmd === 'attach') { if (rest.length !== 2) die('usage: attach <scope>.<YYYYMMDD-HHMM> <dir>'); await attach(tagParts(rest[0]!), rest[1]!); return 0 }
    if (cmd === 'index') {
      if (rest.length > 2) die('usage: index [--dry-run] [<scope>.<YYYYMMDD-HHMM>]')
      let dry = false, entering = ''
      const a = [...rest]
      if (a[0] === '--dry-run') { dry = true; a.shift() }
      if (a.length > 0) entering = a[0]!
      await index(dry, entering, work)
      return 0
    }
    if (cmd === 'verify-index') {
      if (!(rest.length === 1 || (rest.length === 2 && rest[1] === '--full'))) die('usage: verify-index mica.<YYYYMMDD-HHMM> [--full]')
      await verifyIndex(rest[0]!, rest.length === 2, work)
      return 0
    }
    die('usage: bun src/cli.ts scoped-release plan|collect|publish|attach|index|verify-index ...')
  }
  catch (e) {
    if (e instanceof ScopedReleaseError) { console.error(e.message); return 1 }
    if (e instanceof RegistryError || e instanceof Exit || e instanceof Refused || (e instanceof Error && ['ProductError', 'FromError'].includes(e.constructor.name))) { console.error(e.message); return 1 }
    throw e
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
