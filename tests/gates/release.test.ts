// src/release/scoped.ts without a GitHub Release: the plan over fixture release history, the collection over a
// fixture product carrying the contract's signed deployment, and the publication into a local registry; each refusal
// by name (make os-release-test; docker).
//
// The registry is registry:3.1.1 from locks/mica-build-env.lock, a sibling container on the traefik network. attach
// (gh release upload) is not run here. The tests run in file order over one scratch tree, each leaving the state
// the next one reads.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { canonicalJson } from '../../src/image/components.ts'
import { resolve as imageOf } from '../../src/locks/inputs.ts'
import { inputs } from '../../src/locks/inputs.ts'
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
/** mica-build-tools' lock check over one lock: 0 when it is valid. */
function lockCheck(path: string): number {
  return Bun.spawnSync(['bash', join(REPO_ROOT, 'bin/mica-tools'), 'lock', 'check', path], { stdout: 'pipe', stderr: 'pipe' }).exitCode
}

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

// --- 1. The plan: the product, its generation and its previous release. -------------------------------------------
const HISTORY = join(SCRATCH, 'history')
const PREVIOUS = join(HISTORY, 'uefi-x64.basic.20260927-1422')
mkdirSync(PREVIOUS, { recursive: true })
// The spec's valid scoped lock (mica-build-tools:docs/spec/release-lock/vectors/lock/valid/mica-build.uefi-x64.basic.lock at
// 07d5a16), copied unchanged.
copyFileSync(join(REPO_ROOT, 'tests/fixtures/release/previous-mica-build.uefi-x64.basic.lock'), join(PREVIOUS, 'mica-build.lock'))
sums(PREVIOUS, 'mica-build.lock')
const K = repeat('b'), R = repeat('c')
ENV.MICA_RELEASE_HISTORY = HISTORY

test('a product plans one generation above its previous release', () => {
  expect(release(['plan', 'uefi-x64.basic.20260928-0000']).out).toBe(`uefi-x64.basic\tuefi-x64\t3\tuefi-x64.basic.20260927-1422\t${K}\t${R}`)
})

test('a product plans generation 2 for its first release', () => {
  expect(release(['plan', 'uefi-arm64.basic.20260928-0000']).out).toBe('uefi-arm64.basic\tuefi-arm64\t2\t-\t-\t-')
})

test('tags that are no release tag of a product, and a dev product, are refused', () => {
  refuses(release(['plan', '20260928-0000']), 'must be <board>.<variant>.<YYYYMMDD-HHMM>', 'a tag with no product')
  refuses(release(['plan', 'uefi-x64.20260928-0000']), 'must be <board>.<variant>.<YYYYMMDD-HHMM>', 'a board\'s tag')
  refuses(release(['plan', 'nosuch.basic.20260928-0000']), 'nosuch.basic is no product', 'a product that does not exist')
  refuses(release(['plan', 'uefi-x64.basic/20260928-0000']), 'must be <board>.<variant>.<YYYYMMDD-HHMM>', 'a slash between the product and the stamp')
  refuses(release(['plan', 'uefi-x64.dev.20260928-0000']), 'uefi-x64.dev is a dev product, which is built locally and never released', 'a dev product')
})

test('an earlier release whose lock carries a slash release row is refused', () => {
  const dir = join(HISTORY, 'uefi-x64.basic.20260927-2100')
  mkdirSync(dir)
  writeFileSync(join(dir, 'mica-build.lock'), text(join(PREVIOUS, 'mica-build.lock')).split('\n').map(l => l.replace(/uefi-x64\.basic\.20260927-1422\t/, 'uefi-x64.basic/20260927-1422\t')).join('\n'))
  sums(dir, 'mica-build.lock')
  refuses(release(['plan', 'uefi-x64.basic.20260928-0000']), 'its mica-build.lock breaks a rule', 'an earlier release whose lock carries a slash release row')
  rmSync(dir, { recursive: true })
})

// A generation floor above what the readable releases imply; it never lowers one.
test('MICA_RELEASE_GENERATIONS raises a planned generation, and refuses to lower one or to be no decimal', () => {
  const r = release(['plan', 'uefi-x64.basic.20260928-0000'], { MICA_RELEASE_GENERATIONS: 'uefi-x64.basic=9 uefi-x64.full=4' })
  expect(r.out.split('\t').slice(0, 3).join('\t')).toBe('uefi-x64.basic\tuefi-x64\t9')
  refuses(release(['plan', 'uefi-x64.basic.20260928-0000'], { MICA_RELEASE_GENERATIONS: 'uefi-x64.basic=2' }), 'gives uefi-x64.basic generation 2, below the planned 3', 'a generation floor below the planned generation')
  refuses(release(['plan', 'uefi-x64.basic.20260928-0000'], { MICA_RELEASE_GENERATIONS: 'uefi-x64.basic=one' }), 'each item is <product>=<generation>, a decimal of at least 2', 'a generation floor that is no decimal')
})

test('the release being built and an earlier release with no asset (a failed run) are not previous releases; one with assets and no lock is refused', () => {
  for (const d of ['uefi-x64.basic.20260928-0000', 'uefi-x64.basic.20260927-2000']) mkdirSync(join(HISTORY, d))
  expect(release(['plan', 'uefi-x64.basic.20260928-0000']).out.split('\t').slice(2, 4).join('\t')).toBe('3\tuefi-x64.basic.20260927-1422')
  writeFileSync(join(HISTORY, 'uefi-x64.basic.20260927-2000/mica-uefi-x64.basic-20260927-2000.img'), 'partial\n')
  refuses(release(['plan', 'uefi-x64.basic.20260928-0000']), 'release uefi-x64.basic.20260927-2000: SHA256SUMS does not list exactly its mica-build.lock', 'an earlier release with assets and no lock')
  for (const d of ['uefi-x64.basic.20260928-0000', 'uefi-x64.basic.20260927-2000']) rmSync(join(HISTORY, d), { recursive: true })
})

// Every product releases on its own: the plan reads the product's own releases, not another product's of its board
// or of another board.
test('the plan reads no release of another product, however broken', () => {
  for (const other of ['uefi-x64.full.20260927-2000', 'cx3576.full.20260927-2000']) {
    mkdirSync(join(HISTORY, other))
    writeFileSync(join(HISTORY, other, 'mica-build.lock'), 'not a lock\n')
  }
  expect(release(['plan', 'uefi-x64.basic.20260928-0000']).code).toBe(0)
  refuses(release(['plan', 'uefi-x64.full.20260928-0000']), 'SHA256SUMS does not list exactly its mica-build.lock', 'a broken release of the planned product')
  for (const other of ['uefi-x64.full.20260927-2000', 'cx3576.full.20260927-2000']) rmSync(join(HISTORY, other), { recursive: true })
})

test('a release older than the previous one, and a previous release whose SHA256SUMS does not list its lock, are refused', () => {
  refuses(release(['plan', 'uefi-x64.basic.20260927-1400']), 'which is not earlier than 20260927-1400', 'a release older than the previous one')
  writeFileSync(join(PREVIOUS, 'SHA256SUMS'), repeat('0'))
  refuses(release(['plan', 'uefi-x64.basic.20260928-0000']), 'SHA256SUMS does not list exactly its mica-build.lock', 'a previous release whose SHA256SUMS does not list its lock')
  sums(PREVIOUS, 'mica-build.lock')
})

// --- 2. The collection: which update packages ship, against the previous identities, and the guard that refuses a
// kernel packed to other bytes from the same inputs. The contract's deployment, and variants of it for the previous
// release's archive, signed with a throwaway updates key. ------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the index and the fixture are read and reshaped freely
type Json = Record<string, any>
const PRODUCTS = join(SCRATCH, 'products'), OUT = join(PRODUCTS, 'uefi-x64.basic'), SIGNING = join(SCRATCH, 'signing')
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
payload.product = 'uefi-x64.basic'
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
const PREVIOUS_ARCHIVE = join(PREVIOUS, 'mica-uefi-x64.basic-20260927-1422.micaupd')
const receipt = (generation: number) => writeFileSync(join(OUT, 'receipt.txt'), `release 20260928-0000\ngeneration ${generation}\n`)
receipt(1)
function productFile(table: string, kind: string, file: string) {
  writeFileSync(join(OUT, file), `${file} bytes\n`)
  appendFileSync(join(OUT, table), `${kind}\t${file}\t${sha(join(OUT, file))}\n`)
}
writeFileSync(join(OUT, 'kinds.tsv'), '')
writeFileSync(join(OUT, 'updates.tsv'), '')
productFile('kinds.tsv', 'disk', 'kinds/mica-uefi-x64.basic-20260928-0000.img')
copyFileSync(join(OUT, 'kinds/mica-uefi-x64.basic-20260928-0000.img'), join(SCRATCH, 'raw-disk.img'))
productFile('updates.tsv', 'full', 'updates/mica-uefi-x64.basic-20260928-0000.micaupd')
productFile('updates.tsv', 'kernel', 'updates/mica-uefi-x64.basic-20260928-0000.kernel.micaupd')
productFile('updates.tsv', 'root', 'updates/mica-uefi-x64.basic-20260928-0000.root.micaupd')
productFile('updates.tsv', 'core', 'updates/mica-uefi-x64.basic-20260928-0000.core.micaupd')
const PLAN = join(SCRATCH, 'plan.tsv')
const COLLECT_ENV = { MICA_RELEASE_PRODUCTS: PRODUCTS, MICA_SIGNING_OUTPUT: SIGNING }
const collectInto = (dir: string) => release(['collect', 'uefi-x64.basic', 'uefi-x64.basic.20260928-0000', PLAN, dir], COLLECT_ENV)
function collect(plan: string, dir: string, previous?: Uint8Array): Run {
  writeFileSync(PLAN, `${plan}\n`)
  if (previous !== undefined) writeFileSync(PREVIOUS_ARCHIVE, previous)
  return collectInto(dir)
}
const assetsOf = (dir: string) => rowsOf(join(dir, 'rows/uefi-x64.basic.tsv'), 'asset').map(f => `${f[2]}/${f[3]}`)

test('an unchanged kernel id ships the root package, and the product row is the signed deployment\'s', () => {
  const r = collect(`uefi-x64.basic\tuefi-x64\t1\tuefi-x64.basic.20260927-1422\t${KERNEL}\t${R}`, join(SCRATCH, 'root-only'), ARCHIVES.same)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(join(SCRATCH, 'root-only'))).toEqual(['image/disk', 'update/full', 'update/root'])
  expect(linesOf(join(SCRATCH, 'root-only/rows/uefi-x64.basic.tsv'), /^product\t/)).toBe(`product\tuefi-x64.basic\tuefi-x64\tprod\t1\t${DEPLOYMENT}\t${KERNEL}\t${ROOTFS}`)
})

test('an unchanged rootfs id ships the kernel package, and a kernel of other inputs passes the guard', () => {
  const r = collect(`uefi-x64.basic\tuefi-x64\t1\tuefi-x64.basic.20260927-1422\t${K_REBUILT}\t${ROOTFS}`, join(SCRATCH, 'kernel-only'), ARCHIVES.rebuilt)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(join(SCRATCH, 'kernel-only'))).toEqual(['image/disk', 'update/full', 'update/kernel'])
})

test('an unchanged kernel and rootfs id, a core release, ship the core package', () => {
  const r = collect(`uefi-x64.basic\tuefi-x64\t1\tuefi-x64.basic.20260927-1422\t${KERNEL}\t${ROOTFS}`, join(SCRATCH, 'core-only'), ARCHIVES.same)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(join(SCRATCH, 'core-only'))).toEqual(['image/disk', 'update/full', 'update/kernel', 'update/root', 'update/core'])
})

test('the previous descriptor is refused when its kernel was repacked, is not the plan\'s, or is signed by another key', () => {
  const refused = join(SCRATCH, 'refused')
  refuses(collect(`uefi-x64.basic\tuefi-x64\t1\tuefi-x64.basic.20260927-1422\t${K_REPACKED}\t${ROOTFS}`, refused, ARCHIVES.repacked),
    `equals release uefi-x64.basic.20260927-1422's, and the kernel id ${KERNEL} differs`, 'a kernel of the previous release\'s buildId packed to another id')
  refuses(collect(`uefi-x64.basic\tuefi-x64\t1\tuefi-x64.basic.20260927-1422\t${K}\t${ROOTFS}`, refused, ARCHIVES.same),
    `not its product row's kernel ${K}`, 'a previous descriptor that is not its product row\'s kernel')
  refuses(collect(`uefi-x64.basic\tuefi-x64\t1\tuefi-x64.basic.20260927-1422\t${KERNEL}\t${ROOTFS}`, refused, ARCHIVES.otherKey),
    'does not authenticate with this release\'s updates key', 'a previous descriptor signed by another key')
})

test('a first release ships only full; the image ships as .img.gz recording its raw sha256 and size', () => {
  const first = join(SCRATCH, 'first')
  const r = collect('uefi-x64.basic\tuefi-x64\t1\t-\t-\t-', first, ARCHIVES.same)
  expect(r.code, r.all).toBe(0)
  expect(assetsOf(first)).toEqual(['image/disk', 'update/full'])
  expect(readdirSync(join(first, 'assets')).sort()).toEqual(['mica-uefi-x64.basic-20260928-0000.img.gz', 'mica-uefi-x64.basic-20260928-0000.micaupd'])
  expect(rowsOf(join(first, 'rows/uefi-x64.basic.tsv'), 'asset').filter(f => f[2] === 'image').map(f => `${f[4]} ${f[5]}`))
    .toEqual([`mica-uefi-x64.basic-20260928-0000.img.gz ${sha(join(first, 'assets/mica-uefi-x64.basic-20260928-0000.img.gz'))}`])
  const img = join(OUT, 'kinds/mica-uefi-x64.basic-20260928-0000.img')
  expect(text(join(first, 'rows/uefi-x64.basic.uncompressed')).trimEnd()).toBe(`disk\t${sha(img)}\t${statSync(img).size}`)
})

test('a build of another generation than the plan, and a file that is not its table\'s bytes, are refused', () => {
  receipt(2)
  refuses(collectInto(join(SCRATCH, 'refused')), 'is not a build of release 20260928-0000 at generation 1', 'a build of another generation than the plan')
  receipt(1)
  appendFileSync(join(OUT, 'kinds/mica-uefi-x64.basic-20260928-0000.img'), 'changed\n')
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
  writeFileSync(join(DIR, 'board-rows/pool.tsv'), `amd64\tpool.uefi-x64.amd64.20260928-0000\tsha256:${A64}\n`)
  writeFileSync(join(DIR, 'board-rows/package.tsv'), `mica-board-uefi-x64\tamd64\t0.1.0-1\t${K}\n`)
  writeFileSync(join(DIR, 'board-rows/board.tsv'), `uefi-x64\tkernel\tamd64\tkernel.uefi-x64.20260928-0000\tsha256:${R}\n`)
})

const LOCK = join(DIR, 'mica-build.lock')
test('publish writes a valid mica-build.lock and SHA256SUMS listing only it', () => {
  const r = release(['publish', 'uefi-x64.basic.20260928-0000', DIR])
  expect(r.code, r.all).toBe(0)
  expect(lockCheck(LOCK)).toBe(0)
  expect(text(join(DIR, 'SHA256SUMS')).trimEnd()).toBe(`${sha(LOCK)}  mica-build.lock`)
})

test('the image bundle\'s layer is the .img.gz, annotated with gzip and the raw image\'s sha256 and size', async () => {
  const [, unSha, unSize] = text(join(DIR, 'rows/uefi-x64.basic.uncompressed')).trimEnd().split('\t')
  const m = await manifestAt(rowsOf(LOCK, 'bundle').find(f => f[2] === 'image')![3]!)
  expect(m.layers.map((l: Json) => ['org.opencontainers.image.title', 'mica.image-kind', 'mica.compression', 'mica.uncompressed-sha256', 'mica.uncompressed-size'].map(k => l.annotations[k])))
    .toEqual([['mica-uefi-x64.basic-20260928-0000.img.gz', 'disk', 'gzip', unSha, unSize]])
  expect(unSha).toBe(sha(join(SCRATCH, 'raw-disk.img')))
})

test('the update bundle carries one layer per shipped kind, annotated with kind, deployment and generation; each asset row is its layer\'s digest', async () => {
  const reference = rowsOf(LOCK, 'bundle').find(f => f[2] === 'update')![3]!
  expect(reference.startsWith('ghcr.io/micaoss/mica-build:update.uefi-x64.basic.20260928-0000@sha256:')).toBe(true)
  const m = await manifestAt(reference)
  expect([m.artifactType, m.layers.map((l: Json) => ['org.opencontainers.image.title', 'mica.update-kind', 'mica.deployment-id', 'mica.generation'].map(k => l.annotations[k]))]).toEqual(['application/vnd.mica.update', [
    ['mica-uefi-x64.basic-20260928-0000.micaupd', 'full', DEPLOYMENT, '1'],
    ['mica-uefi-x64.basic-20260928-0000.root.micaupd', 'root', DEPLOYMENT, '1'],
  ]])
  expect(m.layers[0].digest).toBe(`sha256:${rowsOf(LOCK, 'asset').find(f => f[3] === 'full')![5]}`)
})

test('the inputs are every pin, and the board\'s pool, package and board rows are the published ones', () => {
  expect(rowsOf(LOCK, 'input').map(f => f[1])).toEqual(readdirSync(join(REPO_ROOT, 'locks/pins')).filter(f => f.endsWith('.pin')).map(f => basename(f, '.pin')).sort())
  expect(linesOf(LOCK, /^(pool|package|board)\t/)).toBe(`pool\tamd64\tghcr.io/micaoss/mica-build:pool.uefi-x64.amd64.20260928-0000@sha256:${A64}\npackage\tmica-board-uefi-x64\tamd64\t0.1.0-1\t${K}\nboard\tuefi-x64\tkernel\tamd64\tghcr.io/micaoss/mica-build:kernel.uefi-x64.20260928-0000@sha256:${R}`)
})

test('publishing the same files again writes the same lock, and a tag holding another digest is refused', () => {
  const first = readFileSync(LOCK)
  expect(release(['publish', 'uefi-x64.basic.20260928-0000', DIR]).code).toBe(0)
  expect(readFileSync(LOCK).equals(first)).toBe(true)
  appendFileSync(join(DIR, 'assets/mica-uefi-x64.basic-20260928-0000.root.micaupd'), 'other\n')
  refuses(release(['publish', 'uefi-x64.basic.20260928-0000', DIR]), 'a published tag is never re-pointed', 'a bundle tag that holds another digest')
})
