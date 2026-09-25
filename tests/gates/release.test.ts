// src/release/scoped.ts without a GitHub Release: the plan over fixture release history, the collection over a
// fixture product carrying the contract's signed deployment, the publication into a local registry, the Mica version
// index over the published release, and the plan once an index exists; each refusal by name (make os-release-test;
// docker).
//
// The registry is registry:3.1.1 from locks/mica-build-env.lock, a sibling container on the traefik network. attach
// (gh release upload) is not run here. The tests run in file order over one scratch tree, each leaving the state
// the next one reads. The port of tests/gates/release-test.sh (deleted 2026-09-25) and its inline Python, check for
// check; the fixture envelopes are signed in-process with node's ed25519 rather than by openssl in a container.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { boards } from '../../src/boards/boards.ts'
import { canonicalJson } from '../../src/image/components.ts'
import { resolve as imageOf } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'
import { mirrorsOf } from '../../src/release/index.ts'
import { dockerBin } from '../../src/shared/docker.ts'

setDefaultTimeout(300_000)
const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp', 'release-test.'))
const REGISTRY_NAME = `ai-agent-mica-release-test-${process.pid}`
const docker = dockerBin()
afterAll(() => {
  Bun.spawnSync([docker, 'rm', '-f', REGISTRY_NAME], { stdout: 'ignore', stderr: 'ignore' })
  rmSync(SCRATCH, { recursive: true, force: true })
})

const hex = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const sha = (file: string) => hex(readFileSync(file))
const text = (file: string) => readFileSync(file, 'utf8')
/** SHA256SUMS in sha256sum's form, over the named files of a directory. */
const sums = (dir: string, ...names: string[]) => writeFileSync(join(dir, 'SHA256SUMS'), names.map(n => `${sha(join(dir, n))}  ${n}\n`).join(''))
const rowsOf = (file: string, kind: string) => text(file).split('\n').filter(l => l.split('\t')[0] === kind).map(l => l.split('\t'))
const linesOf = (file: string, re: RegExp) => text(file).split('\n').filter(l => re.test(l)).join('\n')
const repeat = (c: string) => c.repeat(64)

// The environment every command sees, which the sections extend as they go.
const ENV: Record<string, string> = { ...process.env as Record<string, string> }
type Run = { code: number, out: string, all: string }
function cli(args: string[], env: Record<string, string> = {}): Run {
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'src/cli.ts'), ...args], { cwd: REPO_ROOT, env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const out = r.stdout.toString(), err = r.stderr.toString()
  return { code: r.exitCode, out: out.replace(/\n+$/, ''), all: (out + err).replace(/\n+$/, '') }
}
const release = (args: string[], env: Record<string, string> = {}) => cli(['scoped-release', ...args], env)
/** The command has to refuse, naming the fragment; a refusal for another reason is not this one. */
function refuses(run: Run, fragment: string, label: string) {
  expect(run.code, `${label}: it succeeded`).not.toBe(0)
  expect(run.all, `${label}: refused, but not naming '${fragment}'`).toContain(fragment)
}

// --- 1. The plan: the scope's products, their generations and previous releases. ---------------------------------
const HISTORY = join(SCRATCH, 'history')
const PREVIOUS = join(HISTORY, 'uefi-x64.20260914-2042')
mkdirSync(PREVIOUS, { recursive: true })
// The spec vector, copied rather than rewritten; that is what tests/fixtures/release-lock/vectors.pin is for.
copyFileSync(join(REPO_ROOT, 'tests/fixtures/release-lock/vectors/lock/valid/mica-build.uefi-x64.lock'), join(PREVIOUS, 'mica-build.lock'))
sums(PREVIOUS, 'mica-build.lock')
const K = repeat('b'), R = repeat('c')
ENV.MICA_RELEASE_HISTORY = HISTORY

test('a board scope plans every product of its board, one generation above their previous release', () => {
  expect(release(['plan', 'uefi-x64.20260916-0000']).out).toBe(`uefi-x64-dev\tuefi-x64\t4\tuefi-x64.20260914-2042\t${K}\t${R}\nuefi-x64-prod\tuefi-x64\t2\t-\t-\t-`)
})

test('a product scope plans that product, at generation 2 for its first release', () => {
  expect(release(['plan', 'uefi-arm64-dev.20260916-0000']).out).toBe('uefi-arm64-dev\tuefi-arm64\t2\t-\t-\t-')
})

test('tags that are no scoped release tag are refused', () => {
  refuses(release(['plan', '20260916-0000']), 'must be <scope>.<YYYYMMDD-HHMM>', 'an unscoped tag')
  refuses(release(['plan', 'nosuch.20260916-0000']), 'neither a product nor the board of a product', 'a scope that is no product or board')
  // The retired <scope>/<stamp> form (mica:docs/decisions/2026-09-16-scoped-tags-use-a-dot.md) is no release tag here.
  refuses(release(['plan', 'uefi-x64/20260916-0000']), 'must be <scope>.<YYYYMMDD-HHMM>', 'a slash between the scope and the stamp')
  refuses(release(['verify-index', 'mica/20260915-2242']), 'verify-index takes mica.<YYYYMMDD-HHMM>', 'a slash index tag')
})

test('an earlier release whose lock carries a slash release row is refused', () => {
  const dir = join(HISTORY, 'uefi-x64.20260915-0100')
  mkdirSync(dir)
  writeFileSync(join(dir, 'mica-build.lock'), text(join(PREVIOUS, 'mica-build.lock')).split('\n').map(l => l.replace(/uefi-x64\.20260914-2042/, 'uefi-x64/20260914-2042')).join('\n'))
  sums(dir, 'mica-build.lock')
  refuses(release(['plan', 'uefi-x64-dev.20260916-0000']), 'its mica-build.lock breaks a rule', 'an earlier release whose lock carries a slash release row')
  rmSync(dir, { recursive: true })
})

// A generation floor for a history this tree no longer reads; it never lowers one.
test('MICA_RELEASE_GENERATIONS raises a planned generation, and refuses to lower one or to be no decimal', () => {
  const r = release(['plan', 'uefi-x64.20260916-0000'], { MICA_RELEASE_GENERATIONS: 'uefi-x64-dev=9 uefi-x64-prod=4' })
  expect(r.out.split('\n').map(l => l.split('\t')).map(f => `${f[0]}\t${f[2]}`).join('\n')).toBe('uefi-x64-dev\t9\nuefi-x64-prod\t4')
  refuses(release(['plan', 'uefi-x64.20260916-0000'], { MICA_RELEASE_GENERATIONS: 'uefi-x64-dev=3' }), 'gives uefi-x64-dev generation 3, below the planned 4', 'a generation floor below the planned generation')
  refuses(release(['plan', 'uefi-x64.20260916-0000'], { MICA_RELEASE_GENERATIONS: 'uefi-x64-dev=one' }), 'each item is <product>=<generation>, a decimal of at least 2', 'a generation floor that is no decimal')
})

test('the release being built and an earlier release with no asset (a failed run) are not previous releases; one with assets and no lock is refused', () => {
  for (const d of ['uefi-x64.20260916-0000', 'uefi-x64.20260915-0000']) mkdirSync(join(HISTORY, d))
  expect(release(['plan', 'uefi-x64-dev.20260916-0000']).out.split('\t').slice(2, 4).join('\t')).toBe('4\tuefi-x64.20260914-2042')
  writeFileSync(join(HISTORY, 'uefi-x64.20260915-0000/mica-uefi-x64-dev-20260915-0000.img'), 'partial\n')
  refuses(release(['plan', 'uefi-x64-dev.20260916-0000']), 'release uefi-x64.20260915-0000: SHA256SUMS does not list exactly its mica-build.lock', 'an earlier release with assets and no lock')
  for (const d of ['uefi-x64.20260916-0000', 'uefi-x64.20260915-0000']) rmSync(join(HISTORY, d), { recursive: true })
})

test('a release older than the previous one, and a previous release whose SHA256SUMS does not list its lock, are refused', () => {
  refuses(release(['plan', 'uefi-x64-dev.20260913-0000']), 'which is not earlier than 20260913-0000', 'a release older than the previous one')
  writeFileSync(join(PREVIOUS, 'SHA256SUMS'), repeat('0'))
  refuses(release(['plan', 'uefi-x64.20260916-0000']), 'SHA256SUMS does not list exactly its mica-build.lock', 'a previous release whose SHA256SUMS does not list its lock')
  sums(PREVIOUS, 'mica-build.lock')
})

// --- 2. The collection: which update packages ship, against the previous identities, and the guard that refuses a
// kernel packed to other bytes from the same inputs. The contract's deployment, and variants of it for the previous
// release's archive, signed with a throwaway updates key. ------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the index and the fixture are read and reshaped freely
type Json = Record<string, any>
const PRODUCTS = join(SCRATCH, 'products'), OUT = join(PRODUCTS, 'uefi-x64-dev'), SIGNING = join(SCRATCH, 'signing')
for (const d of [join(OUT, 'deployments'), join(OUT, 'kinds'), join(OUT, 'updates'), join(SIGNING, 'updates')]) mkdirSync(d, { recursive: true })

const clone = (v: Json): Json => JSON.parse(JSON.stringify(v))
/** A component's id: the digest of its canonical content without the id. */
function ident(component: Json) {
  const { id: _id, ...content } = component
  component.id = hex(canonicalJson(content))
}
const updatesKey = generateKeyPairSync('ed25519').privateKey, otherKey = generateKeyPairSync('ed25519').privateKey
const rawPublic = (key: KeyObject) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url')
function envelope(deployment: Json, key: KeyObject): string {
  const body = Buffer.from(canonicalJson(deployment))
  return JSON.stringify({ schema: 'mica/update-envelope/v1', keyId: hex(rawPublic(key)), payload: body.toString('base64'), signature: sign(null, body, key).toString('base64') })
}
/** A previous-release archive head: MICAUPD1, the envelope's length, the envelope, an empty object table. */
function archive(deployment: Json, key = updatesKey): Uint8Array {
  const env = Buffer.from(envelope(deployment, key)), length = Buffer.alloc(4)
  length.writeUInt32BE(env.length)
  return Buffer.concat([Buffer.from('MICAUPD1'), length, env, Buffer.alloc(4)])
}
// The contract fixture is mica-core's copy and names its own product and board; this tree's are the renamed ones,
// and collect refuses a deployment naming another product, so the fixture is renamed here, its kernel id recomputed
// over the renamed content, and everything re-signed.
const golden = JSON.parse(text(join(REPO_ROOT, 'tests/fixtures/component-contracts/envelope.json'))) as Json
const payload = JSON.parse(Buffer.from(golden.envelope.payload, 'base64').toString()) as Json
payload.product = 'uefi-x64-dev'
payload.board = 'uefi-x64'
payload.kernel.board = 'uefi-x64'
ident(payload.kernel)
const rebuilt = clone(payload)
rebuilt.kernel.buildId = repeat('f')
ident(rebuilt.kernel)
const repacked = clone(payload)
repacked.kernel.boot.artifact.sha256 = '5a'.repeat(32)
ident(repacked.kernel)
const ARCHIVES = { same: archive(payload), rebuilt: archive(rebuilt), repacked: archive(repacked), otherKey: archive(payload, otherKey) }
const KERNEL: string = payload.kernel.id, ROOTFS: string = payload.rootfs.id, K_REBUILT: string = rebuilt.kernel.id, K_REPACKED: string = repacked.kernel.id
const DEPLOYMENT = hex(canonicalJson(payload))
writeFileSync(join(SIGNING, 'updates/public.key'), `${rawPublic(updatesKey).toString('base64')}\n`)
writeFileSync(join(OUT, 'deployments/1.json'), envelope(payload, updatesKey))
const PREVIOUS_ARCHIVE = join(PREVIOUS, 'mica-uefi-x64-dev-20260914-2042.micaupd')
const receipt = (generation: number) => writeFileSync(join(OUT, 'receipt.txt'), `release 20260916-0000\ngeneration ${generation}\n`)
receipt(1)
function productFile(table: string, kind: string, file: string) {
  writeFileSync(join(OUT, file), `${file} bytes\n`)
  appendFileSync(join(OUT, table), `${kind}\t${file}\t${sha(join(OUT, file))}\n`)
}
writeFileSync(join(OUT, 'kinds.tsv'), '')
writeFileSync(join(OUT, 'updates.tsv'), '')
productFile('kinds.tsv', 'disk', 'kinds/mica-uefi-x64-dev-20260916-0000.img')
copyFileSync(join(OUT, 'kinds/mica-uefi-x64-dev-20260916-0000.img'), join(SCRATCH, 'raw-disk.img'))
productFile('updates.tsv', 'full', 'updates/mica-uefi-x64-dev-20260916-0000.micaupd')
productFile('updates.tsv', 'kernel', 'updates/mica-uefi-x64-dev-20260916-0000.kernel.micaupd')
productFile('updates.tsv', 'root', 'updates/mica-uefi-x64-dev-20260916-0000.root.micaupd')
const PLAN = join(SCRATCH, 'plan.tsv')
const COLLECT_ENV = { MICA_RELEASE_PRODUCTS: PRODUCTS, MICA_SIGNING_OUTPUT: SIGNING }
const collectInto = (dir: string) => release(['collect', 'uefi-x64-dev', 'uefi-x64.20260916-0000', PLAN, dir], COLLECT_ENV)
function collect(plan: string, dir: string, previous?: Uint8Array): Run {
  writeFileSync(PLAN, `${plan}\n`)
  if (previous !== undefined) writeFileSync(PREVIOUS_ARCHIVE, previous)
  return collectInto(dir)
}
const assetsOf = (dir: string) => rowsOf(join(dir, 'rows/uefi-x64-dev.tsv'), 'asset').map(f => `${f[2]}/${f[3]}`)

test('an unchanged kernel id ships the root package, and the product row is the signed deployment\'s', () => {
  const r = collect(`uefi-x64-dev\tuefi-x64\t1\tuefi-x64.20260914-2042\t${KERNEL}\t${R}`, join(SCRATCH, 'root-only'), ARCHIVES.same)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(join(SCRATCH, 'root-only'))).toEqual(['image/disk', 'update/full', 'update/root'])
  expect(linesOf(join(SCRATCH, 'root-only/rows/uefi-x64-dev.tsv'), /^product\t/)).toBe(`product\tuefi-x64-dev\tuefi-x64\tdev\t1\t${DEPLOYMENT}\t${KERNEL}\t${ROOTFS}`)
})

test('an unchanged rootfs id ships the kernel package, and a kernel of other inputs passes the guard', () => {
  const r = collect(`uefi-x64-dev\tuefi-x64\t1\tuefi-x64.20260914-2042\t${K_REBUILT}\t${ROOTFS}`, join(SCRATCH, 'kernel-only'), ARCHIVES.rebuilt)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(join(SCRATCH, 'kernel-only'))).toEqual(['image/disk', 'update/full', 'update/kernel'])
})

test('the previous descriptor is refused when its kernel was repacked, is not the plan\'s, or is signed by another key', () => {
  const refused = join(SCRATCH, 'refused')
  refuses(collect(`uefi-x64-dev\tuefi-x64\t1\tuefi-x64.20260914-2042\t${K_REPACKED}\t${ROOTFS}`, refused, ARCHIVES.repacked),
    `equals release uefi-x64.20260914-2042's, and the kernel id ${KERNEL} differs`, 'a kernel of the previous release\'s buildId packed to another id')
  refuses(collect(`uefi-x64-dev\tuefi-x64\t1\tuefi-x64.20260914-2042\t${K}\t${ROOTFS}`, refused, ARCHIVES.same),
    `not its product row's kernel ${K}`, 'a previous descriptor that is not its product row\'s kernel')
  refuses(collect(`uefi-x64-dev\tuefi-x64\t1\tuefi-x64.20260914-2042\t${KERNEL}\t${ROOTFS}`, refused, ARCHIVES.otherKey),
    'does not authenticate with this release\'s updates key', 'a previous descriptor signed by another key')
})

test('a first release ships only full; the image ships as .img.gz recording its raw sha256 and size', () => {
  const first = join(SCRATCH, 'first')
  const r = collect('uefi-x64-dev\tuefi-x64\t1\t-\t-\t-', first, ARCHIVES.same)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(first)).toEqual(['image/disk', 'update/full'])
  expect(readdirSync(join(first, 'assets')).sort()).toEqual(['mica-uefi-x64-dev-20260916-0000.img.gz', 'mica-uefi-x64-dev-20260916-0000.micaupd'])
  expect(rowsOf(join(first, 'rows/uefi-x64-dev.tsv'), 'asset').filter(f => f[2] === 'image').map(f => `${f[4]} ${f[5]}`))
    .toEqual([`mica-uefi-x64-dev-20260916-0000.img.gz ${sha(join(first, 'assets/mica-uefi-x64-dev-20260916-0000.img.gz'))}`])
  const img = join(OUT, 'kinds/mica-uefi-x64-dev-20260916-0000.img')
  expect(text(join(first, 'rows/uefi-x64-dev.uncompressed')).trimEnd()).toBe(`disk\t${sha(img)}\t${statSync(img).size}`)
})

test('a build of another generation than the plan, and a file that is not its table\'s bytes, are refused', () => {
  receipt(2)
  refuses(collectInto(join(SCRATCH, 'refused')), 'is not a build of release 20260916-0000 at generation 1', 'a build of another generation than the plan')
  receipt(1)
  appendFileSync(join(OUT, 'kinds/mica-uefi-x64-dev-20260916-0000.img'), 'changed\n')
  refuses(collectInto(join(SCRATCH, 'refused')), 'does not hash to its kinds.tsv row', 'a file that is not its table\'s bytes')
})

// --- 3. The publication: bundles in a registry, read back, and the lock. ------------------------------------------
const DIR = join(SCRATCH, 'root-only')
const A64 = repeat('a')
let registry = ''
const manifestAt = async (reference: string) => (await (await fetch(`http://${registry}/v2/micaoss/mica-build/manifests/${reference.split('@')[1]}`, { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json' } })).json()) as Json

test('a local registry answers', async () => {
  const quiet = { stdout: 'pipe', stderr: 'pipe' } as const
  if (Bun.spawnSync([docker, 'network', 'inspect', 'traefik'], quiet).exitCode !== 0) Bun.spawnSync([docker, 'network', 'create', '--label', 'ai-agent=true', 'traefik'], quiet)
  const started = Bun.spawnSync([docker, 'run', '-d', '--rm', '--label', 'ai-agent=true', '--name', REGISTRY_NAME, '--network', 'traefik', '-p', '127.0.0.1::5000', imageOf('upstream:registry:3.1.1@amd64', inputs())], quiet)
  expect(started.exitCode, started.stderr.toString()).toBe(0)
  // By its name where this runs on the traefik network (a sibling container, bin/bun.sh's container route), else by
  // the loopback port the host publishes; the publisher below runs where this does, so it reaches the same address.
  for (let i = 0; i < 30 && registry === ''; i++) {
    const port = Bun.spawnSync([docker, 'port', REGISTRY_NAME, '5000/tcp'], quiet).stdout.toString().split('\n')[0]?.split(':').at(-1) ?? ''
    for (const candidate of [`${REGISTRY_NAME}:5000`, `127.0.0.1:${port}`]) {
      try { if ((await fetch(`http://${candidate}/v2/`, { signal: AbortSignal.timeout(2000) })).ok) { registry = candidate; break } }
      catch { /* not yet, or not from here */ }
    }
    if (registry === '') await Bun.sleep(1000)
  }
  expect(registry, `the registry ${REGISTRY_NAME} did not answer`).not.toBe('')
  ENV.MICA_REGISTRY = `${registry}/micaoss`
  ENV.MICA_REGISTRY_PLAIN_HTTP = '1'
  // The board's rows, as src/pool/publish.ts and src/release/publish-components.ts leave them for the board of the scope.
  mkdirSync(join(DIR, 'board-rows'), { recursive: true })
  writeFileSync(join(DIR, 'board-rows/pool.tsv'), `amd64\tpool.uefi-x64.amd64.20260916-0000\tsha256:${A64}\n`)
  writeFileSync(join(DIR, 'board-rows/package.tsv'), `mica-board-uefi-x64\tamd64\t0.1.0-1\t${K}\n`)
  writeFileSync(join(DIR, 'board-rows/board.tsv'), `uefi-x64\tkernel\tamd64\tkernel.uefi-x64.20260916-0000\tsha256:${R}\n`)
})

const LOCK = join(DIR, 'mica-build.lock')
test('publish writes a valid mica-build.lock and SHA256SUMS listing only it', () => {
  const r = release(['publish', 'uefi-x64.20260916-0000', DIR])
  expect(r.code, r.all).toBe(0)
  expect(cli(['locks', 'lock', LOCK]).code).toBe(0)
  expect(text(join(DIR, 'SHA256SUMS')).trimEnd()).toBe(`${sha(LOCK)}  mica-build.lock`)
})

test('the image bundle\'s layer is the .img.gz, annotated with gzip and the raw image\'s sha256 and size', async () => {
  const [, unSha, unSize] = text(join(DIR, 'rows/uefi-x64-dev.uncompressed')).trimEnd().split('\t')
  const m = await manifestAt(rowsOf(LOCK, 'bundle').find(f => f[2] === 'image')![3]!)
  expect(m.layers.map((l: Json) => ['org.opencontainers.image.title', 'mica.image-kind', 'mica.compression', 'mica.uncompressed-sha256', 'mica.uncompressed-size'].map(k => l.annotations[k])))
    .toEqual([['mica-uefi-x64-dev-20260916-0000.img.gz', 'disk', 'gzip', unSha, unSize]])
  expect(unSha).toBe(sha(join(SCRATCH, 'raw-disk.img')))
})

test('the update bundle carries one layer per shipped kind, annotated with kind, deployment and generation; each asset row is its layer\'s digest', async () => {
  const reference = rowsOf(LOCK, 'bundle').find(f => f[2] === 'update')![3]!
  expect(reference.startsWith('ghcr.io/micaoss/mica-build:update.uefi-x64-dev.20260916-0000@sha256:')).toBe(true)
  const m = await manifestAt(reference)
  expect([m.artifactType, m.layers.map((l: Json) => ['org.opencontainers.image.title', 'mica.update-kind', 'mica.deployment-id', 'mica.generation'].map(k => l.annotations[k]))]).toEqual(['application/vnd.mica.update', [
    ['mica-uefi-x64-dev-20260916-0000.micaupd', 'full', DEPLOYMENT, '1'],
    ['mica-uefi-x64-dev-20260916-0000.root.micaupd', 'root', DEPLOYMENT, '1'],
  ]])
  expect(m.layers[0].digest).toBe(`sha256:${rowsOf(LOCK, 'asset').find(f => f[3] === 'full')![5]}`)
})

test('the inputs are every pin, and the board\'s pool, package and board rows are the published ones', () => {
  expect(rowsOf(LOCK, 'input').map(f => f[1])).toEqual(readdirSync(join(REPO_ROOT, 'locks/pins')).filter(f => f.endsWith('.pin')).map(f => basename(f, '.pin')).sort())
  expect(linesOf(LOCK, /^(pool|package|board)\t/)).toBe(`pool\tamd64\tghcr.io/micaoss/mica-build:pool.uefi-x64.amd64.20260916-0000@sha256:${A64}\npackage\tmica-board-uefi-x64\tamd64\t0.1.0-1\t${K}\nboard\tuefi-x64\tkernel\tamd64\tghcr.io/micaoss/mica-build:kernel.uefi-x64.20260916-0000@sha256:${R}`)
})

test('publishing the same files again writes the same lock, and a tag holding another digest is refused', () => {
  const first = readFileSync(LOCK)
  expect(release(['publish', 'uefi-x64.20260916-0000', DIR]).code).toBe(0)
  expect(readFileSync(LOCK).equals(first)).toBe(true)
  appendFileSync(join(DIR, 'assets/mica-uefi-x64-dev-20260916-0000.root.micaupd'), 'other\n')
  refuses(release(['publish', 'uefi-x64.20260916-0000', DIR]), 'a published tag is never re-pointed', 'a bundle tag that holds another digest')
})

// --- 4. The Mica version index over the published release above (A, uefi-x64-dev) and a release of cx3576-prod made
// of its files (C): the first index in full, then an incremental one carrying C's entry while a newer release of
// uefi-x64-dev (B) replaces A's; the refusals, a product dropped, and the verifier's incremental and full rebuilds. --
const IDX = join(SCRATCH, 'index')
const A = 'uefi-x64.20260916-0000', B = 'uefi-x64.20260918-0000', C = 'cx3576-prod.20260916-0100'
const at = (...p: string[]) => join(IDX, ...p)
/** A release of <product> alone, release A's lock and files renamed (its bundle references keep A's manifest
 * digests, which the registry serves). */
function fabricate(label: string, productName: string, generation: number) {
  const stamp = label.slice(label.indexOf('.') + 1), dir = at('history', label)
  for (const d of [dir, at('assets', label), at('downloads', label)]) mkdirSync(d, { recursive: true })
  writeFileSync(join(dir, 'mica-build.lock'), text(LOCK).split('\n').map(l => l.replaceAll('uefi-x64-dev', productName).replace(new RegExp(A), label)
    .replaceAll('20260916-0000', stamp).replace(/^(product\t[^\t]*\t[^\t]*\t[^\t]*\t)1\t/, `$1${generation}\t`)).join('\n'))
  sums(dir, 'mica-build.lock')
  for (const f of readdirSync(join(DIR, 'assets')))
    copyFileSync(join(DIR, 'assets', f), at('assets', label, f.replace('uefi-x64-dev', productName).replace('20260916-0000', stamp)))
  for (const f of ['mica-build.lock', 'SHA256SUMS']) copyFileSync(join(dir, f), at('downloads', label, f))
}
const INDEX_ENV = () => ({ MICA_RELEASE_HISTORY: at('history'), MICA_RELEASE_ASSETS: at('assets'), MICA_INDEX_BOARD_ENV_DIR: at('boards'), MICA_RELEASE_DOWNLOADS: `file://${IDX}/downloads`, MICA_INDEX_STAMP: '20260917-0000' })
const index = (args: string[], env: Record<string, string> = {}) => release(['index', '--dry-run', ...args], { ...INDEX_ENV(), ...env })
const verifyIndex = (args: string[]) => release(['verify-index', ...args], INDEX_ENV())
const L = at('one/mica-build.lock'), J = at('one/mica-index.json')
const json = (file: string) => JSON.parse(text(file)) as Json
/** mica-index.json's products, images and updates, each entry with its mirrors member or none. */
const entries = (d: Json): Json[] => d.products.flatMap((p: Json) => [...p.images, ...p.updates])
const productIn = (d: Json, name: string) => d.products.find((p: Json) => p.product === name)
const previousIndex = (...f: string[]) => at('history/mica.20260917-0000', ...f)
const resumPrevious = () => sums(previousIndex(), 'mica-build.lock', 'mica-index.json')
function publishIndex(dir: string, stamp: string) {
  for (const d of [at('history', `mica.${stamp}`), at('downloads', `mica.${stamp}`)]) {
    mkdirSync(d, { recursive: true })
    for (const f of ['mica-build.lock', 'mica-index.json', 'SHA256SUMS']) copyFileSync(join(dir, f), join(d, f))
  }
}
const emit = (list: string, out: string) => cli(['release-index', 'json', L, ...['history', 'entering', 'products', 'boards', 'layers', 'assets'].map(t => at('one', `${t}.tsv`)), `file://${IDX}/downloads`, list, out])

test('the first index is built in full from the newest release of every published product, and its lock is valid', () => {
  truncateSync(join(DIR, 'assets/mica-uefi-x64-dev-20260916-0000.root.micaupd'), statSync(join(DIR, 'assets/mica-uefi-x64-dev-20260916-0000.root.micaupd')).size - 6)
  for (const d of [at('history', A), at('downloads', A), at('assets')]) mkdirSync(d, { recursive: true })
  for (const f of ['mica-build.lock', 'SHA256SUMS']) { copyFileSync(join(DIR, f), at('history', A, f)); copyFileSync(join(DIR, f), at('downloads', A, f)) }
  cpSync(join(DIR, 'assets'), at('assets', A), { recursive: true })
  fabricate(C, 'cx3576-prod', 1)
  for (const { name } of boards()) {
    mkdirSync(at('boards', name), { recursive: true })
    writeFileSync(at('boards', name, 'board.env'), `BOARD_RELEASE_TARGET=${name === 'uefi-x64' || name === 'cx3576' ? 1 : 0}\n`)
  }
  const r = index([C], { MICA_INDEX_OUT: at('one') })
  expect(r.code, r.all).toBe(0)
  expect(cli(['locks', 'lock', L]).code).toBe(0)
  expect(r.all).toContain('mica.20260917-0000: full, 2 product(s) from 2 release(s), 2 entering')
})

test('the lock holds each release\'s trust hash, origin and built rows, and its product, bundle and asset rows byte-for-byte', () => {
  expect(rowsOf(L, 'release').map(f => f[2])).toEqual(['mica.20260917-0000'])
  expect(linesOf(L, /^input\t/)).toBe(`input\tmica-build.cx3576-prod\t20260916-0100\t${sha(at('history', C, 'SHA256SUMS'))}\ninput\tmica-build.uefi-x64\t20260916-0000\t${sha(join(DIR, 'SHA256SUMS'))}`)
  expect(linesOf(L, /^origin\tmica-build\.uefi-x64\t/)).toBe(`origin\tmica-build.uefi-x64\t${rowsOf(LOCK, 'release')[0]![3]}`)
  expect(rowsOf(L, 'built').filter(f => f[1] === 'mica-build.uefi-x64').map(f => f.slice(2).join('\t'))).toEqual(rowsOf(LOCK, 'input').map(f => f.slice(1).join('\t')))
  expect(linesOf(L, /^index\t/)).toBe('index\tcx3576-prod\tmica-build.cx3576-prod\nindex\tuefi-x64-dev\tmica-build.uefi-x64')
  expect(linesOf(L, /^(product|bundle|asset)\tuefi-x64-dev\t/)).toBe(linesOf(LOCK, /^(product|bundle|asset)\t/))
})

test('mica-index.json renders the releases, the products with image and update requirements, and the catalogue, keys in the shape\'s order; SHA256SUMS lists both', () => {
  const d = json(J), unSize = Number(text(join(DIR, 'rows/uefi-x64-dev.uncompressed')).trimEnd().split('\t')[2])
  const x64 = productIn(d, 'uefi-x64-dev')
  expect([d.schema, d.version, d.releases.map((r: Json) => r.release),
    [x64.product, x64.generation, x64.images.map((i: Json) => [i.kind, i.compression, i.uncompressedSize]), x64.updates.map((u: Json) => [u.kind, Object.keys(u.requires).sort()])],
    d.catalogue.products.filter((p: Json) => ['cx3576-prod', 's905x5m-dev'].includes(p.product)).map((p: Json) => [p.product, p.publish, p.indexed]),
    d.catalogue.boards.filter((b: Json) => b.board === 'uefi-x64').map((b: Json) => b.releaseTarget),
  ]).toEqual(['mica/index/v1', '20260917-0000', ['cx3576-prod.20260916-0100', 'uefi-x64.20260916-0000'],
    ['uefi-x64-dev', 1, [['disk', 'gzip', unSize]], [['full', ['generationBelow']], ['root', ['generationBelow', 'kernel']]]],
    [['cx3576-prod', true, true], ['s905x5m-dev', false, false]], [true]])
  const keys = (v: Json) => Object.keys(v)
  expect([keys(d), keys(d.lock), [...new Set(d.inputs.map((i: Json) => JSON.stringify(keys(i))))].map(k => JSON.parse(k as string)), keys(d.releases[0]), keys(d.products[0]),
    keys(d.products[0].bundles), keys(d.products[0].images[0]), keys(d.products[1].updates[1]), keys(d.products[1].updates[1].requires), keys(d.catalogue),
    keys(d.catalogue.boards[0]), keys(d.catalogue.products[0])]).toEqual([
    ['schema', 'version', 'commit', 'lock', 'inputs', 'releases', 'products', 'catalogue'], ['file', 'sha256'], [['id', 'repository', 'release', 'trust']],
    ['release', 'trust', 'commit', 'inputs'], ['product', 'board', 'profile', 'generation', 'deployment', 'kernel', 'rootfs', 'release', 'bundles', 'images', 'updates'],
    ['image', 'update'], ['kind', 'file', 'url', 'mirrors', 'sha256', 'size', 'compression', 'uncompressedSha256', 'uncompressedSize'],
    ['kind', 'file', 'url', 'mirrors', 'sha256', 'size', 'requires'], ['generationBelow', 'kernel'], ['boards', 'products'], ['board', 'arch', 'releaseTarget'],
    ['product', 'board', 'profile', 'features', 'publish', 'indexed']])
  expect(text(at('one/SHA256SUMS')).trimEnd()).toBe(`${sha(L)}  mica-build.lock\n${sha(J)}  mica-index.json`)
})

test('releases name their inputs by id in one shared, sorted input table with no scoped input, and the catalogue\'s flags are booleans', () => {
  const d = json(J), n = rowsOf(LOCK, 'input').length
  const ids: string[] = d.inputs.map((i: Json) => i.id)
  expect([ids.length, d.releases.map((r: Json) => r.inputs.length), JSON.stringify(ids) === JSON.stringify([...new Set(d.releases.flatMap((r: Json) => r.inputs))].sort()),
    JSON.stringify(ids) === JSON.stringify([...ids].sort()), d.inputs.filter((i: Json) => i.scope).length]).toEqual([n, [n, n], true, true, 0])
  expect([...new Set([...d.catalogue.products.flatMap((p: Json) => [p.publish, p.indexed]), ...d.catalogue.boards.map((b: Json) => b.releaseTarget)].map(v => typeof v))]).toEqual(['boolean'])
})

// mirrors: derived from the committed mirrors.list, in its order, and omitted entirely where there is none. The base
// is a committed value and never an environment variable (mica:docs/design/mica-index.md 3.1), so these cases drive
// the emitter over exactly the inputs that produced the index above, with a mirrors.list of their own.
test('every image and update names its mirrors, derived from the committed base with the release\'s own scope, stamp and file name', () => {
  const d = json(J), x64 = productIn(d, 'uefi-x64-dev')
  expect([x64.images[0].mirrors, x64.updates[0].mirrors]).toEqual([['https://dl.res.micaos.dev/mica/uefi-x64/20260916-0000/mica-uefi-x64-dev-20260916-0000.img.gz'], ['https://dl.res.micaos.dev/mica/uefi-x64/20260916-0000/mica-uefi-x64-dev-20260916-0000.micaupd']])
  const all = entries(d).flatMap(e => e.mirrors as string[])
  expect(all.length).toBeGreaterThan(0)
  expect(all.filter(m => !m.startsWith('https://'))).toEqual([])
})

test('mirrors keep the order of the committed list; with no list, or an empty one, the member is omitted', () => {
  writeFileSync(join(SCRATCH, 'two-mirrors.list'), 'https://b.example/mica\n# a comment, and the order below is the content\nhttps://a.example/mica\n')
  const r = emit(join(SCRATCH, 'two-mirrors.list'), join(SCRATCH, 'two-mirrors.json'))
  expect(r.code, r.all).toBe(0)
  expect(json(join(SCRATCH, 'two-mirrors.json')).products[0].images[0].mirrors).toEqual(['https://b.example/mica/cx3576-prod/20260916-0100/mica-cx3576-prod-20260916-0100.img.gz', 'https://a.example/mica/cx3576-prod/20260916-0100/mica-cx3576-prod-20260916-0100.img.gz'])
  writeFileSync(join(SCRATCH, 'no-mirrors.list'), '')
  expect(emit(join(SCRATCH, 'no-mirrors.list'), join(SCRATCH, 'no-mirrors.json')).code).toBe(0)
  expect([...new Set(entries(json(join(SCRATCH, 'no-mirrors.json'))).map(e => 'mirrors' in e))]).toEqual([false])
  expect(emit('-', join(SCRATCH, 'absent-mirrors.json')).code).toBe(0)
  expect(readFileSync(join(SCRATCH, 'no-mirrors.json')).equals(readFileSync(join(SCRATCH, 'absent-mirrors.json')))).toBe(true)
})

test.each([
  ['a mirror base that is not https', 'is no absolute https base', 'http://plain.example'],
  ['a mirror base with a trailing slash', 'is no absolute https base', 'https://trailing.example/'],
  ['the same mirror base twice', 'each mirror appears once', 'https://twice.example\nhttps://twice.example'],
])('%s is refused', (label, fragment, content) => {
  writeFileSync(join(SCRATCH, 'bad-mirrors.list'), `${content}\n`)
  refuses(emit(join(SCRATCH, 'bad-mirrors.list'), join(SCRATCH, 'bad-mirrors.json')), fragment, label)
})

test('a mirror equal to the asset\'s own url is refused', () => {
  expect(() => mirrorsOf(['https://m.example/mica'], 'a.20260101-0000', 'f.img.gz', 'https://m.example/mica/a/20260101-0000/f.img.gz')).toThrow('which is the source the reader already has')
})

test('a second index run gives the same lock and mica-index.json', () => {
  expect(index([C], { MICA_INDEX_OUT: at('two') }).code).toBe(0)
  expect(readFileSync(at('two/mica-build.lock')).equals(readFileSync(L))).toBe(true)
  expect(readFileSync(at('two/mica-index.json')).equals(readFileSync(J))).toBe(true)
})

test('an index by hand, a stamp not later than a referenced release, and one scope from two releases are refused', () => {
  refuses(release(['plan', 'mica.20260917-0000']), 'cut by the index job of a scoped release, never by hand', 'a mica/* release published by hand')
  refuses(index([C], { MICA_INDEX_STAMP: '20260916-0100' }), 'the stamp 20260916-0100 is not later than 20260916-0100', 'a stamp not later than a referenced release')
  fabricate('uefi-x64.20260916-0200', 'uefi-x64-prod', 1)
  refuses(index(['uefi-x64.20260916-0200']), 'products of the scope uefi-x64 come from two releases', 'products of one scope from two releases')
  rmSync(at('history/uefi-x64.20260916-0200'), { recursive: true })
})

test('verify-index rebuilds the first index from the releases it references, byte-identically', () => {
  publishIndex(at('one'), '20260917-0000')
  const r = verifyIndex(['mica.20260917-0000'])
  expect(r.code, r.all).toBe(0)
  expect(r.all).toContain('rebuilt byte-identically from its 2 referenced release(s)')
})

test('an incremental index carries an unchanged entry from the previous index without reading its release, and the entering release replaces its product\'s entry', () => {
  // B replaces uefi-x64-dev's entry; C's entry is carried with C's lock and files out of reach.
  fabricate(B, 'uefi-x64-dev', 2)
  for (const d of [at('aside/history'), at('aside/assets')]) mkdirSync(d, { recursive: true })
  renameSync(at('history', C), at('aside/history', C))
  renameSync(at('assets', C), at('aside/assets', C))
  rmSync(at('history', A), { recursive: true })
  const r = index([B], { MICA_INDEX_STAMP: '20260918-0100', MICA_INDEX_OUT: at('inc') })
  expect(r.code, r.all).toBe(0)
  expect(r.all).toContain('mica.20260918-0100: incremental, 2 product(s) from 2 release(s), 1 entering, the rest carried from mica.20260917-0000')
  const inc = at('inc/mica-build.lock'), carried = /\tx64-prod(\t|$)|mica-build\.uefi-x64-prod\t/
  expect(linesOf(inc, carried)).toBe(linesOf(L, carried))
  expect(rowsOf(inc, 'input').filter(f => f[1] === 'mica-build.uefi-x64').map(f => `${f[2]}\t${f[3]}`)).toEqual([`20260918-0000\t${sha(at('history', B, 'SHA256SUMS'))}`])
  const d = json(at('inc/mica-index.json'))
  expect(JSON.stringify(productIn(d, 'cx3576-prod'))).toBe(JSON.stringify(productIn(json(J), 'cx3576-prod')))
  const x64 = productIn(d, 'uefi-x64-dev')
  expect([d.previous, [x64.release, x64.generation, x64.images[0].size]]).toEqual([{ release: 'mica.20260917-0000', trust: sha(at('one/SHA256SUMS')) },
    [B, 2, statSync(join(DIR, 'assets/mica-uefi-x64-dev-20260916-0000.img.gz')).size]])
  expect(Object.keys(d)).toEqual(['schema', 'version', 'commit', 'lock', 'previous', 'inputs', 'releases', 'products', 'catalogue'])
})

test('an entering asset that does not read back, and a previous index that is not its sums or its lock, are refused', () => {
  const asset = at('assets', B, 'mica-uefi-x64-dev-20260918-0000.micaupd')
  renameSync(asset, at('aside/mica-uefi-x64-dev-20260918-0000.micaupd'))
  refuses(index([B], { MICA_INDEX_STAMP: '20260918-0100' }), `the asset mica-uefi-x64-dev-20260918-0000.micaupd of release ${B} does not read back anonymously`, 'an entering release whose asset does not read back')
  renameSync(at('aside/mica-uefi-x64-dev-20260918-0000.micaupd'), asset)
  writeFileSync(previousIndex('mica-index.json'), text(previousIndex('mica-index.json')).split('\n').map(l => l.replace('"generation":1,', '"generation":7,')).join('\n'))
  refuses(index([B], { MICA_INDEX_STAMP: '20260918-0100' }), 'release mica.20260917-0000: SHA256SUMS does not list exactly its mica-build.lock and mica-index.json', 'a previous index whose files are not its SHA256SUMS')
  resumPrevious()
  refuses(index([B], { MICA_INDEX_STAMP: '20260918-0100' }), 'the previous index mica.20260917-0000: its mica-index.json does not match its mica-build.lock', 'a previous index whose JSON is not its lock')
})

test('an entering generation lower than the previous index\'s, and an input of another trust than a carried entry\'s, are refused', () => {
  for (const f of ['mica-index.json', 'SHA256SUMS']) copyFileSync(at('one', f), previousIndex(f))
  writeFileSync(previousIndex('mica-build.lock'), text(previousIndex('mica-build.lock')).split('\n').map(l => l.replace(/^(product\tuefi-x64-dev\t[^\t]*\t[^\t]*\t)1\t/, '$19\t')).join('\n'))
  resumPrevious()
  refuses(index([B], { MICA_INDEX_STAMP: '20260918-0100' }), `uefi-x64-dev: generation 2 of ${B} is lower than 9 in the previous index mica.20260917-0000`, 'an entering generation lower than in the previous index')
  copyFileSync(L, previousIndex('mica-build.lock'))
  copyFileSync(at('one/SHA256SUMS'), previousIndex('SHA256SUMS'))
  fabricate('uefi-x64.20260918-0200', 'uefi-x64-dev', 2)
  const other = at('history/uefi-x64.20260918-0200')
  writeFileSync(join(other, 'mica-build.lock'), text(join(other, 'mica-build.lock')).split('\n').map(l => l.replace(/^(input\tmica-core\t[^\t]*\t).*/, `$1${repeat('8')}`)).join('\n'))
  sums(other, 'mica-build.lock')
  refuses(index(['uefi-x64.20260918-0200'], { MICA_INDEX_STAMP: '20260918-0300' }), `${repeat('8')} in another`, 'an entering release whose input differs in trust from a carried entry\'s')
  rmSync(other, { recursive: true })
})

test('a missing entering release is refused, and a release no newer than its entries cuts no index', () => {
  refuses(index(['cx3576-prod.20260917-0000'], { MICA_INDEX_STAMP: '20260918-0100' }), 'release cx3576-prod.20260917-0000 has no lock to read', 'a missing entering release')
  cpSync(at('aside/history', C), at('history', C), { recursive: true })
  const r = index([C], { MICA_INDEX_STAMP: '20260918-0100' })
  expect(r.code, r.all).toBe(0)
  expect(r.all).toContain('nothing enters or leaves the previous index mica.20260917-0000')
  expect(r.all).toContain('no index is cut')
  rmSync(at('history', C), { recursive: true })
})

// No scoped release at all -- the state right after a tag form changes -- cuts no index and is no refusal.
test('a history without a scoped release cuts no index and is no refusal', () => {
  mkdirSync(at('empty'))
  const r = release(['index', '--dry-run'], { MICA_RELEASE_HISTORY: at('empty'), MICA_INDEX_BOARD_ENV_DIR: at('boards'), MICA_INDEX_STAMP: '20260918-0100' })
  expect(r.code, r.all).toBe(0)
  expect(r.all).toContain('there is nothing to index')
  expect(r.all).toContain('no index is cut')
})

// A product whose board stops being a release target is no longer published: its entry is dropped, and the catalogue
// shows it publish false, indexed false (mica:docs/design/mica-index.md 3.1).
test('the entry of a product whose board is no release target is dropped from the index and shown in the catalogue', () => {
  writeFileSync(at('boards/cx3576/board.env'), 'BOARD_RELEASE_TARGET=0\n')
  const r = index([B], { MICA_INDEX_STAMP: '20260918-0100', MICA_INDEX_OUT: at('dropped') })
  writeFileSync(at('boards/cx3576/board.env'), 'BOARD_RELEASE_TARGET=1\n')
  expect(r.code, r.all).toBe(0)
  expect(r.all).toContain('cx3576-prod is no longer published; its entry is dropped')
  expect(text(at('dropped/mica-build.lock'))).not.toContain('cx3576-prod')
  const d = json(at('dropped/mica-index.json'))
  expect([d.products.map((p: Json) => p.product), d.releases.map((x: Json) => x.release), d.catalogue.products.filter((p: Json) => p.product === 'cx3576-prod').map((p: Json) => [p.publish, p.indexed])[0]])
    .toEqual([['uefi-x64-dev'], [B], [false, false]])
})

// An index cut before a mirror base was committed carries entries with no mirrors; the next index re-derives them,
// so the incremental cut and the --full rebuild, which re-derives every entry, agree on the same bytes.
test('a carried entry has its mirrors derived afresh, so an incremental index and a full rebuild agree', () => {
  const d = json(at('inc/mica-index.json'))
  expect([...new Set(entries(d).map(e => 'mirrors' in e))]).toEqual([true])
  expect(productIn(d, 'cx3576-prod').images[0].mirrors[0]).toBe('https://dl.res.micaos.dev/mica/cx3576-prod/20260916-0100/mica-cx3576-prod-20260916-0100.img.gz')
})

// The verifier: the incremental rebuild reads the previous index and B only; --full reads every reference.
// mirrors.list changing between two indexes is a normal operational event and must not fail a cut: the predecessor's
// entries were derived from the old list, this cut re-derives from the new one, and the consistency check never
// compares them -- it only requires the predecessor's to be well formed.
test('a predecessor whose mirrors came from another base is carried, re-derived from this checkout\'s list, and equals the full rebuild byte for byte', () => {
  renameSync(at('aside/assets', C), at('assets', C))
  cpSync(at('aside/history', C), at('history', C), { recursive: true })
  writeFileSync(previousIndex('mica-index.json'), text(previousIndex('mica-index.json')).replaceAll('"mirrors":["https://dl.res.micaos.dev', '"mirrors":["https://old.example'))
  resumPrevious()
  const r = index([B], { MICA_INDEX_STAMP: '20260918-0100', MICA_INDEX_OUT: at('moved-base') })
  expect(r.code, r.all).toBe(0)
  expect(productIn(json(at('moved-base/mica-index.json')), 'cx3576-prod').images[0].mirrors[0]).toBe('https://dl.res.micaos.dev/mica/cx3576-prod/20260916-0100/mica-cx3576-prod-20260916-0100.img.gz')
  expect(index([], { MICA_INDEX_STAMP: '20260918-0100', MICA_INDEX_FULL: '1', MICA_INDEX_OUT: at('moved-full') }).code).toBe(0)
  expect(readFileSync(at('moved-base/mica-index.json')).equals(readFileSync(at('moved-full/mica-index.json')))).toBe(true)
})

// The invariant: every mirrors member of an index is derived from the base committed at that index's own commit.
test('an incremental cut over a predecessor with no mirrors at all is byte-identical to the full rebuild, and every entry has them', () => {
  const d = json(previousIndex('mica-index.json'))
  for (const e of entries(d)) delete e.mirrors
  writeFileSync(previousIndex('mica-index.json'), `${JSON.stringify(d)}\n`)
  resumPrevious()
  expect(index([B], { MICA_INDEX_STAMP: '20260918-0100', MICA_INDEX_OUT: at('from-none') }).code).toBe(0)
  expect(index([], { MICA_INDEX_STAMP: '20260918-0100', MICA_INDEX_FULL: '1', MICA_INDEX_OUT: at('full-none') }).code).toBe(0)
  expect(readFileSync(at('from-none/mica-index.json')).equals(readFileSync(at('full-none/mica-index.json')))).toBe(true)
  expect([...new Set(entries(json(at('from-none/mica-index.json'))).map(e => 'mirrors' in e))]).toEqual([true])
})

test('a predecessor whose mirror is no https URL is refused', () => {
  const d = json(J)
  d.products[0].images[0].mirrors = ['http://plain.example/x']
  writeFileSync(previousIndex('mica-index.json'), `${JSON.stringify(d)}\n`)
  resumPrevious()
  refuses(index([B], { MICA_INDEX_STAMP: '20260918-0100' }), 'carries a mirror that is no absolute https URL', 'a predecessor whose mirror is no https URL')
  copyFileSync(J, previousIndex('mica-index.json'))
  resumPrevious()
})

test('verify-index rebuilds an incremental index from its previous index and the entering release, and in full from every reference', () => {
  publishIndex(at('inc'), '20260918-0100')
  const r = verifyIndex(['mica.20260918-0100'])
  expect(r.code, r.all).toBe(0)
  expect(r.all).toContain('rebuilt byte-identically from mica.20260917-0000 and 1 entering release(s)')
  const full = verifyIndex(['mica.20260918-0100', '--full'])
  expect(full.code, full.all).toBe(0)
  expect(full.all).toContain('verified in full')
})

test('a referenced release changed after its entry was indexed passes the incremental rebuild and is refused by --full', () => {
  const lock = at('downloads', C, 'mica-build.lock')
  writeFileSync(lock, text(lock).split('\n').map(l => l.replace(new RegExp(`^release\\tmica-build\\t${C}\\t[0-9a-f]*`), `release\tmica-build\t${C}\t${'7'.repeat(40)}`)).join('\n'))
  sums(at('downloads', C), 'mica-build.lock')
  expect(verifyIndex(['mica.20260918-0100']).code).toBe(0)
  refuses(verifyIndex(['mica.20260918-0100', '--full']), 'mica-build.lock of mica.20260918-0100 differs from the index rebuilt from its references', 'verify-index --full on a changed reference')
})

test('verify-index refuses an index whose copied row differs from the referenced lock', () => {
  for (const f of ['mica-build.lock', 'SHA256SUMS']) copyFileSync(at('aside/history', C, f), at('downloads', C, f))
  const dir = at('downloads/mica.20260918-0100'), lock = join(dir, 'mica-build.lock')
  writeFileSync(lock, text(lock).split('\n').map(l => l.replace(/^(built\tmica-build.uefi-x64\tmica-core\t[^\t]*\t).*/, `$1${repeat('9')}`)).join('\n'))
  sums(dir, 'mica-build.lock', 'mica-index.json')
  refuses(verifyIndex(['mica.20260918-0100']), 'mica-build.lock of mica.20260918-0100 differs from the index rebuilt from its references', 'verify-index accepted an index whose built row differs from its referenced lock')
})

// --- 5. The plan once an index exists: each product's previous release from the newest index's entries and every
// scoped release later than that index (a pending index job lags behind), never from older releases. --------------
const planAfter = (scope: string) => release(['plan', scope], { MICA_RELEASE_HISTORY: at('history') }).all

test('the plan takes a scoped release later than the newest index over its entry, another product\'s from the index entry, and reads no older release', () => {
  const ids = rowsOf(LOCK, 'product').map(f => `${f[6]}\t${f[7]}`)[0]
  rmSync(at('history/mica.20260918-0100'), { recursive: true })
  // Both scopes hold one indexed product, so neither falls back to the full history, and a broken older release
  // proves that no older release is read.
  mkdirSync(at('history/uefi-x64.20260915-0000'))
  writeFileSync(at('history/uefi-x64.20260915-0000/mica-build.lock'), 'not a lock\n')
  expect(planAfter('uefi-x64-dev.20260919-0000')).toBe(`uefi-x64-dev\tuefi-x64\t3\t${B}\t${ids}`)
  expect(planAfter('cx3576-prod.20260919-0000')).toBe(`cx3576-prod\tcx3576\t2\t${C}\t${ids}`)
  // With no release later than the index, the plan is the index entry's.
  renameSync(at('history', B), at('aside/history', B))
  expect(planAfter('uefi-x64-dev.20260919-0000')).toBe(`uefi-x64-dev\tuefi-x64\t2\t${A}\t${ids}`)
  rmSync(at('history/uefi-x64.20260915-0000'), { recursive: true })
  // A product outside the newest index with an older release plans one generation above it, from the full history.
  fabricate('uefi-arm64-dev.20260916-0300', 'uefi-arm64-dev', 5)
  expect(planAfter('uefi-arm64-dev.20260919-0000')).toBe(`uefi-arm64-dev\tuefi-arm64\t6\tuefi-arm64-dev.20260916-0300\t${ids}`)
  rmSync(at('history/uefi-arm64-dev.20260916-0300'), { recursive: true })
  expect(planAfter('uefi-arm64-dev.20260919-0000')).toBe('uefi-arm64-dev\tuefi-arm64\t2\t-\t-\t-')
})

test('a plan over a tampered index is refused', () => {
  appendFileSync(previousIndex('mica-build.lock'), '\n')
  refuses(release(['plan', 'uefi-x64.20260919-0000'], { MICA_RELEASE_HISTORY: at('history') }), 'release mica.20260917-0000: SHA256SUMS does not list exactly its mica-build.lock and mica-index.json', 'a plan over a tampered index')
  copyFileSync(L, previousIndex('mica-build.lock'))
})
