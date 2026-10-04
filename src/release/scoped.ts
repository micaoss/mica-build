// A mica-build release (mica-build-tools:docs/spec/release-lock.md 1.2.2) is one product: <board>.<variant>.<YYYYMMDD-HHMM>, the product
// <board>.<variant> of boards/<board>/products/<variant>/. A dev product is never released.
//
// A RELEASE IS CUT BY release.yml, run with its product (gh workflow run release.yml -f product=<board>.<variant>):
// every product releases on its own, and no release waits on another's. Nothing lists every board: a fleet reads
// the board definitions and takes each product's latest release. The workflow stamps the tag and runs the steps below. Below, <scope> is the
// product.
//
//   bun src/cli.ts scoped-release plan <board>.<variant>.<YYYYMMDD-HHMM>   (MICA_RELEASE_GENERATIONS="<product>=<generation> ...")
//       the one line of the product: product, board, generation, previous release (or -), its kernel id and
//       rootfs id (or -); the generation is one above the previous release's product row, 2 for a first release.
//       The previous release is read from the product's own releases only
//   bun src/cli.ts scoped-release previous-archive <product> <board>.<variant>.<YYYYMMDD-HHMM> <file>
//       the full update archive of <product> in that earlier release, whole, into <file>: a core release
//       (product-build --reuse) takes its kernel and root out of it, authenticated by its signed descriptor
//   bun src/cli.ts scoped-release collect <product> <board>.<variant>.<YYYYMMDD-HHMM> <plan> <dir>
//       the built product (product-build <product> --release <YYYYMMDD-HHMM> --generation <g>) into <dir>: its
//       image and update files under <dir>/assets and its rows under <dir>/rows
//   bun src/cli.ts scoped-release publish <board>.<variant>.<YYYYMMDD-HHMM> <dir>
//       per product the OCI bundles image.<product>.<release> and update.<product>.<release>, read back
//       anonymously; then <dir>/mica-build.lock and <dir>/SHA256SUMS listing only it
//   bun src/cli.ts scoped-release attach <board>.<variant>.<YYYYMMDD-HHMM> <dir>
//       the GitHub Release, created as a draft at the commit the lock names; the assets, then the lock and
//       SHA256SUMS last; then published and every file read back anonymously. A release that exists is never
//       touched
//   bun src/cli.ts scoped-release res <board>.<variant>.<YYYYMMDD-HHMM>
//       the attached release posted to the resource service (src/release/res.ts), and read back
//
// WHICH UPDATE PACKAGES. full always. root only when the previous release's kernel id equals this one's, kernel
// only when its rootfs id does, core only when both do (a core release, product-build --reuse): a partial package
// installs on a device only when the components it omits are already there. A verity key rotation re-signs the
// root, so it moves the rootfs id and ships as full.
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
//   reads   boards/<board>/products/, locks/ and locks/pins/, _out/products/<product>/ (a release build; MICA_RELEASE_PRODUCTS),
//           meta or MICA_SIGNING_OUTPUT (the updates public key); previous releases from the GitHub Releases of
//           micaoss/mica-build, or MICA_RELEASE_HISTORY=<dir> of <board>.<variant>.<YYYYMMDD-HHMM>/{mica-build.lock,SHA256SUMS}
//   env     MICA_REGISTRY (<host>[:port]/<owner>, default ghcr.io/micaoss; MICA_REGISTRY_PLAIN_HTTP=1 for a local
//           registry; MICA_REGISTRY_USER and MICA_REGISTRY_TOKEN the push credential, never printed), GH_TOKEN for
//           attach, MICA_RELEASE_GENERATIONS (plan, a generation floor)
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolve as fromResolve } from '../locks/inputs.ts'
import { checkLock } from '@mica/build-tools'
import { inputs, Refused, ToolError } from '../locks/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { Oci, OCI_EMPTY_CONFIG_DIGEST, OCI_MANIFEST_TYPE, RegistryError, emptyConfig, manifestDigest, type Registry } from '../pool/registry.ts'
import { plainValue, productBoard, productDir, products } from '../product/product.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'

export class ScopedReleaseError extends Error {}

const CLI = join(REPO_ROOT, 'src/cli.ts')
const GITHUB = 'micaoss/mica-build'
const MAX_ASSET = 2 * 1024 * 1024 * 1024
const TAG = /^([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*)\.([0-9]{8}-[0-9]{4})$/
/** The product and the stamp of a release label. */
const labelScope = (label: string) => label.slice(0, label.lastIndexOf('.'))
const labelStamp = (label: string) => label.slice(label.lastIndexOf('.') + 1)
export const DOWNLOADS = () => process.env['MICA_RELEASE_DOWNLOADS'] || `https://github.com/${GITHUB}/releases/download`
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const shaFile = (p: string) => sha256(readFileSync(p))
const say = (l: string) => console.log(l)
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function die(message: string): never {
  throw new ScopedReleaseError(`release: error: ${message}`)
}

export type Tag = { scope: string, release: string }

/** <board>.<variant>.<YYYYMMDD-HHMM>. */
export function tagParts(tag: string): Tag {
  const m = TAG.exec(tag)
  if (m === null) die(`the release tag must be <board>.<variant>.<YYYYMMDD-HHMM>, not '${tag}'`)
  return { scope: m[1]!, release: m[2]! }
}

/** The release's product and its board; a product that does not exist, or a dev one, is refused. */
export function scopeProducts(scope: string): [string, string][] {
  if (!products().includes(scope)) die(`${scope} is no product; the products are: ${products().join(' ')}`)
  if (plainValue(join(productDir(scope), 'product.env'), 'PROFILE') === 'dev') die(`${scope} is a dev product, which is built locally and never released`)
  return [[scope, productBoard(scope)]]
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (process.env['GH_TOKEN']) h['Authorization'] = `Bearer ${process.env['GH_TOKEN']}`
  return h
}

export async function fetchBytes(url: string, init: RequestInit = {}, timeoutMs = 120000, retries = 0): Promise<{ status: number, body: Uint8Array, headers: Headers }> {
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
export type GithubRelease = { draft: boolean, tag_name: string, assets: unknown[] }

/** Whether a tag names a release of this repository, <board>.<variant>.<YYYYMMDD-HHMM>. */
export const isReleaseTag = (tag: string): boolean => TAG.test(tag)

/** Every GitHub Release of this repository, drafts included, as the API lists them. */
export async function listReleases(): Promise<GithubRelease[]> {
  const releases: GithubRelease[] = []
  for (let page = 1; ; page++) {
    const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases?per_page=100&page=${page}`, { headers: ghHeaders() }, 60000)
    if (r.status !== 200) die(`the GitHub Releases of ${GITHUB} could not be listed`)
    const items = JSON.parse(new TextDecoder().decode(r.body)) as GithubRelease[]
    if (items.length === 0) break
    releases.push(...items)
  }
  return releases
}

/** Every earlier release's lock, newest first. Each lock is the one its SHA256SUMS lists, and a valid lock. The
 * release being built and a release with no asset at all (one whose run failed before attaching, since the lock
 * is attached last) are not earlier releases; a release with assets and without both of these is refused,
 * never skipped. With scopes, only the releases of those scopes. */
export async function history(work: string, self: Tag, scopes: string[] = []): Promise<Hist[]> {
  mkdirSync(join(work, 'downloads'), { recursive: true })
  const list: Hist[] = []
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  if (historyDir) {
    for (const name of readdirSync(historyDir).sort()) {
      const dir = join(historyDir, name)
      if (!statSync(dir).isDirectory() || !name.includes('.')) continue
      if (name === `${self.scope}.${self.release}` || readdirSync(dir).length === 0) continue
      if (scopes.length > 0 && !scopes.includes(labelScope(name))) continue
      list.push({ label: name, lock: join(dir, 'mica-build.lock'), sums: join(dir, 'SHA256SUMS') })
    }
  }
  else {
    const releases = await listReleases()
    const wanted = releases.filter(r => !r.draft && r.tag_name !== `${self.scope}.${self.release}` && r.assets.length > 0).map(r => r.tag_name)
      .filter(t => TAG.test(t) && (scopes.length === 0 || scopes.includes(labelScope(t))))
    let n = 0
    for (const label of wanted) {
      n += 1
      const dir = join(work, 'downloads', String(n))
      mkdirSync(dir, { recursive: true })
      for (const asset of ['mica-build.lock', 'SHA256SUMS'])
        await download(`${DOWNLOADS()}/${label}/${asset}`, join(dir, asset), `release ${label} of ${GITHUB} has no readable ${asset}; an earlier release without its lock is refused`)
      list.push({ label, lock: join(dir, 'mica-build.lock'), sums: join(dir, 'SHA256SUMS') })
    }
  }
  for (const h of list) {
    // A release's SHA256SUMS lists its lock.
    const listed = `${existsSync(h.lock) ? shaFile(h.lock) : ''}  mica-build.lock`
    const sums = existsSync(h.sums) ? readFileSync(h.sums, 'utf8').replace(/\n$/, '') : ''
    if (sums !== listed) die(`release ${h.label}: SHA256SUMS does not list exactly its mica-build.lock`)
    let rows: string[][]
    try { rows = checkLock(h.lock).rows }
    catch (e) {
      if (!(e instanceof ToolError || e instanceof Refused)) throw e
      console.error(e.message)
      die(`release ${h.label}: its mica-build.lock breaks a rule (see above)`)
    }
    if (rows.find(r => r[0] === 'release')?.[2] !== h.label) die(`release ${h.label}: its lock names another release`)
  }
  return list.map(h => ({ key: `${labelStamp(h.label)}\t${h.label}`, h })).sort((a, b) => -cmp(a.key, b.key)).map(x => x.h)
}

const lockRows = (path: string) => readFileSync(path, 'utf8').split('\n').filter(l => l !== '').map(l => l.split('\t'))

/** The product's newest release label and that release's product row, or ['-', []]. */
function previousRelease(product: string, hist: Hist[]): { previous: string, row: string[] } {
  for (const h of hist) {
    const rows = lockRows(h.lock)
    const row = rows.find(r => r[0] === 'product' && r[1] === product)
    if (row === undefined) continue
    return { previous: h.label, row }
  }
  return { previous: '-', row: [] }
}

/** The product's previous release: the newest release of the product that carries its row. Every product releases
 * on its own, so no other product's releases are read. */
export async function plan(tag: Tag, work: string): Promise<string[]> {
  // MICA_RELEASE_GENERATIONS="<product>=<generation> ..." is a floor above what the readable releases imply; it
  // never lowers a generation: a floor below the planned one is refused.
  const floor = new Map<string, number>()
  for (const item of (process.env['MICA_RELEASE_GENERATIONS'] ?? '').split(/\s+/).filter(s => s !== '')) {
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*=[2-9][0-9]*$/.test(item)) die(`MICA_RELEASE_GENERATIONS holds '${item}'; each item is <product>=<generation>, a decimal of at least 2`)
    floor.set(item.slice(0, item.indexOf('=')), Number(item.slice(item.indexOf('=') + 1)))
  }
  const scope = scopeProducts(tag.scope)
  const hist = await history(work, tag, scope.map(([product]) => product))
  const lines: string[] = []
  for (const [product, board] of scope) {
    const { previous, row } = previousRelease(product, hist)
    let planned: number, kernel = '-', rootfs = '-'
    if (previous === '-') { planned = 2 }
    else {
      if (!(labelStamp(previous) < tag.release)) die(`${product} was last released in ${previous}, which is not earlier than ${tag.release}`)
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

/** The previous release's full update archive of <product>, whole. */
async function previousArchive(product: string, previous: string, out: string): Promise<void> {
  const name = `mica-${product}-${labelStamp(previous)}.micaupd`
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  if (historyDir) {
    if (!existsSync(join(historyDir, previous, name))) die(`release ${previous} has no ${name}`)
    copyFileSync(join(historyDir, previous, name), out)
  }
  else { await download(`${DOWNLOADS()}/${previous}/${name}`, out, `release ${previous} of ${GITHUB} has no readable ${name}`) }
  say(`release: ${name} of ${previous} into ${out}`)
}

/** The previous release's signed descriptor of <product>, from the head of its full update archive. */
export async function previousDescriptor(product: string, previous: string, out: string): Promise<void> {
  const name = `mica-${product}-${labelStamp(previous)}.micaupd`
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

/** Whether a release publishes the image kind `kind` of a product whose product.env names `declared` (IMAGE_KINDS).
 * Every kind derives from disk, so disk is always built; a product naming its kinds publishes those alone. */
export function publishedImage(declared: string, kind: string): boolean {
  const named = declared.split(/\s+/).filter(k => k !== '')
  return named.length === 0 || named.includes(kind)
}

export async function collect(product: string, tag: Tag, planFile: string, dir: string, work: string): Promise<void> {
  const out = join(process.env['MICA_RELEASE_PRODUCTS'] || join(REPO_ROOT, '_out/products'), product)
  const line = lockRows(planFile).find(r => r[0] === product)
  if (line === undefined) die(`the plan names no product ${product}`)
  const [, board = '', generation = '', previous = '-', prevKernel = '', prevRootfs = ''] = line
  const receipt = existsSync(join(out, 'receipt.txt')) ? readFileSync(join(out, 'receipt.txt'), 'utf8').split('\n') : []
  if (!receipt.includes(`release ${tag.release}`) || !receipt.includes(`generation ${generation}`))
    die(`${out} is not a build of release ${tag.release} at generation ${generation} (bun src/cli.ts product-build ${product} --release ${tag.release} --generation ${generation})`)
  const profile = plainValue(join(productDir(product), 'product.env'), 'PROFILE')
  const declaredImages = plainValue(join(productDir(product), 'product.env'), 'IMAGE_KINDS')
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
      if (type === 'image' && !publishedImage(declaredImages, kind)) { say(`release: ${product}: the ${kind} image is built and not published (IMAGE_KINDS="${declaredImages}")`); continue }
      if (type === 'update' && kind === 'root' && prevKernel !== kernel) { say(`release: ${product}: no root package, the kernel id differs from ${previous}`); continue }
      if (type === 'update' && kind === 'kernel' && prevRootfs !== rootfs) { say(`release: ${product}: no kernel package, the rootfs id differs from ${previous}`); continue }
      if (type === 'update' && kind === 'core' && (prevKernel !== kernel || prevRootfs !== rootfs)) { say(`release: ${product}: no core package, the kernel or rootfs id differs from ${previous}`); continue }
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
    if (!(e instanceof ToolError || e instanceof Refused)) throw e
    console.error(e.message)
    die('the written mica-build.lock breaks a rule (see above)')
  }
  writeFileSync(join(dir, 'SHA256SUMS'), `${shaFile(join(dir, 'mica-build.lock'))}  mica-build.lock\n`)
  process.stdout.write(lock)
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

/** A draft release of the tag at the commit, or a refusal when the tag's release exists. */
async function ghCreateDraft(label: string, commit: string): Promise<{ id: number }> {
  const existing = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases/tags/${label}`, { headers: ghHeaders() }, 60000)
  if (existing.status === 200) die(`release ${label} of ${GITHUB} exists; a release is never replaced`)
  const body = JSON.stringify({ tag_name: label, target_commitish: commit, name: label, draft: true, body: `${label}: built at ${commit} by release.yml.` })
  const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases`, { method: 'POST', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body }, 60000)
  if (r.status !== 201) die(`creating the draft release ${label} answered HTTP ${r.status}: ${new TextDecoder().decode(r.body.subarray(0, 200))}`)
  return JSON.parse(new TextDecoder().decode(r.body)) as { id: number }
}

async function ghPublish(id: number): Promise<void> {
  const r = await fetchBytes(`https://api.github.com/repos/${GITHUB}/releases/${id}`, { method: 'PATCH', headers: { ...ghHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) }, 60000)
  if (r.status !== 200) die(`publishing release ${id} of ${GITHUB} answered HTTP ${r.status}`)
}

export async function attach(tag: Tag, dir: string): Promise<void> {
  const label = `${tag.scope}.${tag.release}`
  if (!existsSync(join(dir, 'mica-build.lock')) || !existsSync(join(dir, 'SHA256SUMS'))) die(`${dir} holds no published lock (scoped-release publish)`)
  const commit = lockRows(join(dir, 'mica-build.lock')).find(r => r[0] === 'release')?.[3] ?? ''
  if (!/^[0-9a-f]{40}$/.test(commit)) die(`the lock of ${label} names no release commit`)
  // A draft at the lock's commit; the assets first, the lock and SHA256SUMS last; then published, so the tag and
  // every file appear together.
  const release = await ghCreateDraft(label, commit)
  const assets = readdirSync(join(dir, 'assets')).sort().map(f => join(dir, 'assets', f))
  for (const f of [...assets, join(dir, 'mica-build.lock'), join(dir, 'SHA256SUMS')]) await ghUpload(release.id, f)
  await ghPublish(release.id)
  for (const name of [...lockRows(join(dir, 'mica-build.lock')).filter(r => r[0] === 'asset').map(r => r[4]!), 'mica-build.lock', 'SHA256SUMS']) {
    const path = existsSync(join(dir, 'assets', name)) ? join(dir, 'assets', name) : join(dir, name)
    if (!await readsBackAs(`https://github.com/${GITHUB}/releases/download/${label}/${name}`, shaFile(path))) die(`${name} of release ${label} does not read back anonymously with its bytes`)
  }
  say(`release: ${label} published at ${commit.slice(0, 12)} and read back`)
}

export async function main(argv: string[]): Promise<number> {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.release.'))
  try {
    const [cmd, ...rest] = argv
    if (cmd === 'plan') { if (rest.length !== 1) die('usage: plan <board>.<variant>.<YYYYMMDD-HHMM>'); await Bun.write(Bun.stdout, (await plan(tagParts(rest[0]!), work)).map(l => `${l}\n`).join('')); return 0 }
    if (cmd === 'previous-archive') { if (rest.length !== 3) die('usage: previous-archive <product> <board>.<variant>.<YYYYMMDD-HHMM> <file>'); await previousArchive(rest[0]!, rest[1]!, rest[2]!); return 0 }
    if (cmd === 'collect') { if (rest.length !== 4) die('usage: collect <product> <board>.<variant>.<YYYYMMDD-HHMM> <plan> <dir>'); await collect(rest[0]!, tagParts(rest[1]!), rest[2]!, rest[3]!, work); return 0 }
    if (cmd === 'publish') { if (rest.length !== 2) die('usage: publish <board>.<variant>.<YYYYMMDD-HHMM> <dir>'); await publish(tagParts(rest[0]!), rest[1]!, work); return 0 }
    if (cmd === 'res') {
      const dryRun = rest.includes('--dry-run'), tags = rest.filter(a => a !== '--dry-run')
      if (tags.length > 1 || tags.some(t => t.startsWith('-'))) die('usage: res [--dry-run] [<board>.<variant>.<YYYYMMDD-HHMM>]')
      return (await (await import('./res.ts')).publishAllToRes(work, tags[0] ?? '', dryRun)) ? 0 : 1
    }
    if (cmd === 'attach') { if (rest.length !== 2) die('usage: attach <board>.<variant>.<YYYYMMDD-HHMM> <dir>'); await attach(tagParts(rest[0]!), rest[1]!); return 0 }
    die('usage: bun src/cli.ts scoped-release plan|previous-archive|collect|publish|attach|res ...')
  }
  catch (e) {
    if (e instanceof ScopedReleaseError) { console.error(e.message); return 1 }
    if (e instanceof RegistryError || e instanceof ToolError || e instanceof Refused || (e instanceof Error && ['ProductError'].includes(e.constructor.name))) { console.error(e.message); return 1 }
    throw e
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
