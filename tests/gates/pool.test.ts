// `bun src/cli.ts pool` against fixture locks: the happy path of a published and an offline lock, and every
// refusal by name.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/pool.test.ts          (make os-pool-test; docker for the index)
//
// The registry is this process (Bun.serve, handed to src/pool/oci.ts as MICA_OCI_REGISTRY): it answers the
// ghcr.io token, manifest and blob endpoints out of a fixture tree, 200 or 404. The pool command is run as the
// callers run it, with MICA_LOCKS_DIR, MICA_POOL_DIR, MICA_POOL_CACHE and MICA_OCI_CACHE pointed at the scratch
// tree (with the build-env lock of this tree, for the index image), so each case perturbs one input and requires
// the refusal that names it.
//
// The port of tests/gates/pool-test.sh (deleted 2026-09-22), case for case.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp/pool-test.'))
const FIX = join(SCRATCH, 'fixtures')
const DEBS = join(SCRATCH, 'debs')
const LOCKS = join(SCRATCH, 'locks')
const MANIFESTS = join(SCRATCH, 'manifests')
const POOL = join(SCRATCH, 'pool')
const COMMIT_A = 'a'.repeat(40), COMMIT_BASE = 'b'.repeat(40), D0 = '0'.repeat(64)
const V_A = '1.0.0-1', V_BASE = '1.0.0-mica1'

let server: ReturnType<typeof Bun.serve>
let A_SHA = '', BASE_SHA = ''
const published: Record<string, string> = {}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(argv: string[], cwd = SCRATCH): void {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${r.stderr.toString()}`)
}

/** The fixture archives: fixture-a (amd64) of fixture-a, fixture-base (all) of fixture-base, and their impostors. */
function pack(name: string, repo: string, version: string, arch: string, file: string): void {
  const root = join(SCRATCH, 'pack', name)
  mkdirSync(join(root, 'DEBIAN'), { recursive: true })
  writeFileSync(join(root, 'DEBIAN/control'), `Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: test <test@invalid>\nDescription: fixture\nMica-Source-Repo: ${repo}\n`)
  run(['dpkg-deb', '--root-owner-group', '-Zgzip', '--build', root, join(DEBS, file)])
  rmSync(root, { recursive: true })
}

/** A pool manifest over [archive, title] layers, as the producers publish it. */
function poolManifest(file: string, repository: string, arch: string, layers: [string, string][]): void {
  const m = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType: 'application/vnd.mica.pool',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2 },
    layers: layers.map(([deb, title]) => ({ mediaType: 'application/vnd.mica.deb', digest: `sha256:${sha(deb)}`, size: statSync(deb).size, annotations: { 'org.opencontainers.image.title': title } })),
    annotations: { 'mica.source-repo': repository, 'mica.arch': arch } }
  writeFileSync(file, JSON.stringify(m) + '\n')
}

type Json = { artifactType: string, annotations: Record<string, string>, layers: { annotations: Record<string, string> }[] }
function editJson(file: string, edit: (m: Json) => void): void {
  const m = JSON.parse(readFileSync(file, 'utf8')) as Json
  edit(m)
  writeFileSync(file, JSON.stringify(m) + '\n')
}

/** lock <repository> <commit> <amd64 pool> <arm64 pool> <package rows> */
function lock(repository: string, commit: string, amd64: string, arm64: string, rows: string): void {
  writeFileSync(join(LOCKS, `${repository}.lock`), `# mica-lock v1\nrelease\t${repository}\t20260914-0000\t${commit}\npool\tamd64\t${amd64}\npool\tarm64\t${arm64}\n${rows}\n`)
  writeFileSync(join(LOCKS, 'pins', `${repository}.pin`), `# mica-pin v1\nREPOSITORY=${repository}\nRELEASE=20260914-0000\nSHA256SUMS=${D0}\n`)
}

/** publish: every manifest under its digest, and the locks and pins naming those digests. */
function publish(): void {
  for (const r of ['fixture-a', 'fixture-base']) {
    const dir = join(FIX, 'micaoss', r, 'manifests')
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
    for (const arch of ['amd64', 'arm64']) {
      const digest = `sha256:${sha(join(MANIFESTS, `${r}-${arch}.json`))}`
      copyFileSync(join(MANIFESTS, `${r}-${arch}.json`), join(dir, digest))
      published[`${r}-${arch}`] = `ghcr.io/micaoss/${r}:pool.${arch}.20260914-0000@${digest}`
    }
  }
  lock('fixture-a', COMMIT_A, published['fixture-a-amd64']!, published['fixture-a-arm64']!, `package\tfixture-a\tamd64\t${V_A}\t${A_SHA}`)
  lock('fixture-base', COMMIT_BASE, published['fixture-base-amd64']!, published['fixture-base-arm64']!,
    `package\tfixture-base\tamd64\t${V_BASE}\t${BASE_SHA}\npackage\tfixture-base\tarm64\t${V_BASE}\t${BASE_SHA}`)
}

/** A fresh scratch tree: the published blobs and manifests, and the locks naming them. */
function setup(): void {
  for (const d of [join(FIX, 'micaoss'), LOCKS, POOL, join(SCRATCH, 'cache'), MANIFESTS, join(SCRATCH, 'checkout')]) rmSync(d, { recursive: true, force: true })
  mkdirSync(join(LOCKS, 'pins'), { recursive: true }); mkdirSync(MANIFESTS, { recursive: true })
  // The build-env images the index runs in.
  copyFileSync(join(REPO_ROOT, 'locks/mica-build-env.lock'), join(LOCKS, 'mica-build-env.lock'))
  copyFileSync(join(REPO_ROOT, 'locks/pins/mica-build-env.pin'), join(LOCKS, 'pins/mica-build-env.pin'))
  writeFileSync(join(FIX, 'token.json'), '{"token":"fixture"}\n')
  for (const r of ['fixture-a', 'fixture-base']) mkdirSync(join(FIX, 'micaoss', r, 'blobs'), { recursive: true })
  A_SHA = sha(join(DEBS, 'a.deb')); BASE_SHA = sha(join(DEBS, 'base.deb'))
  copyFileSync(join(DEBS, 'a.deb'), join(FIX, 'micaoss/fixture-a/blobs', `sha256:${A_SHA}`))
  copyFileSync(join(DEBS, 'base.deb'), join(FIX, 'micaoss/fixture-base/blobs', `sha256:${BASE_SHA}`))
  poolManifest(join(MANIFESTS, 'fixture-a-amd64.json'), 'fixture-a', 'amd64', [[join(DEBS, 'a.deb'), `fixture-a_${V_A}_amd64.deb`]])
  poolManifest(join(MANIFESTS, 'fixture-a-arm64.json'), 'fixture-a', 'arm64', [])
  for (const arch of ['amd64', 'arm64']) poolManifest(join(MANIFESTS, `fixture-base-${arch}.json`), 'fixture-base', arch, [[join(DEBS, 'base.deb'), `fixture-base_${V_BASE}_all.deb`]])
  publish()
}

type Run = { ok: boolean, out: string }

/** `bun src/cli.ts pool <args>` over the scratch tree, against this process's registry. Asynchronous, because the
 * registry is this process: a blocking spawn would never let it answer. */
async function pool(args: string[], extra: Record<string, string> = {}): Promise<Run> {
  const env: Record<string, string> = { ...process.env as Record<string, string>,
    MICA_OCI_REGISTRY: `http://127.0.0.1:${server.port}`, MICA_LOCKS_DIR: LOCKS, MICA_POOL_DIR: POOL,
    MICA_POOL_CACHE: join(SCRATCH, 'cache'), MICA_OCI_CACHE: join(SCRATCH, 'cache/oci'), ...extra }
  for (const [k, v] of Object.entries(extra)) if (v === '') delete env[k]
  const p = Bun.spawn([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'pool', ...args], { cwd: REPO_ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { ok: await p.exited === 0, out: out + err }
}

async function expectRefusal(fragment: string, args: string[], extra: Record<string, string> = {}): Promise<void> {
  const r = await pool(args, extra)
  expect(r.ok, `pool ${args.join(' ')} succeeded:\n${r.out}`).toBe(false)
  expect(r.out, `refused, but not naming '${fragment}'`).toContain(fragment)
}

beforeAll(() => {
  mkdirSync(DEBS, { recursive: true }); mkdirSync(FIX, { recursive: true })
  pack('fixture-a', 'fixture-a', V_A, 'amd64', 'a.deb')
  pack('fixture-a', 'fixture-a', '9.9.9-1', 'amd64', 'a-wrong.deb')
  pack('fixture-base', 'fixture-base', V_BASE, 'all', 'base.deb')
  pack('fixture-base', 'fixture-other', V_BASE, 'all', 'base-other.deb')
  // The registry: URL -> fixture file, 200 or 404.
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    let file = ''
    if (url.pathname === '/token') file = join(FIX, 'token.json')
    else if (url.pathname.startsWith('/v2/')) file = join(FIX, url.pathname.slice('/v2/'.length))
    if (file === '' || !existsSync(file)) return new Response('not found', { status: 404 })
    return new Response(Bun.file(file))
  } })
})

afterAll(() => {
  server?.stop(true)
  rmSync(SCRATCH, { recursive: true, force: true })
})

// 1. Two locks: verified into the pool, then indexed.
test('fetch verifies the archives of both locks into the pool', async () => {
  setup()
  const r = await pool(['fetch', '--arch', 'amd64'])
  expect(r.ok, r.out).toBe(true)
  expect(existsSync(join(POOL, 'amd64/pool', `fixture-a_${V_A}_amd64.deb`))).toBe(true)
  expect(existsSync(join(POOL, 'amd64/pool', `fixture-base_${V_BASE}_all.deb`))).toBe(true)
})

test('index writes Packages over both archives', async () => {
  const r = await pool(['index', '--arch', 'amd64'])
  expect(r.ok, r.out).toBe(true)
  expect(readFileSync(join(POOL, 'amd64/Packages'), 'utf8').split('\n').filter(l => l.startsWith('Package: ')).length).toBe(2)
})

test('rows reads the architecture out of the layer title: an all archive, one row per pool', async () => {
  const r = await pool(['rows', '--arch', 'arm64'])
  expect(r.ok, r.out).toBe(true)
  expect(r.out.trim().split('\n').map((l) => { const f = l.split('\t'); return [f[0], f[2], f[4]].join('\t') })).toEqual(['fixture-base\tall\tfixture-base'])
})

// 2. --check reads the manifests and downloads nothing.
test('--check confirms both archives and downloads nothing', async () => {
  setup()
  const r = await pool(['fetch', '--arch', 'amd64', '--check'])
  expect(r.ok, r.out).toBe(true)
  expect(existsSync(join(SCRATCH, 'cache')) && readdirSync(join(SCRATCH, 'cache')).some(f => f.endsWith('.deb'))).toBe(false)
  expect(existsSync(POOL)).toBe(false)
})

// 3. The pool manifest.
test('a pool manifest of another repository', async () => {
  setup()
  editJson(join(MANIFESTS, 'fixture-a-amd64.json'), (m) => { m.annotations['mica.source-repo'] = 'fixture-other' })
  publish()
  await expectRefusal('is not the amd64 pool of fixture-a', ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('a new release tag on a pool digest an earlier release also tagged is accepted', async () => {
  // A pool whose packages did not change keeps its digest: a later release only tags it again.
  setup()
  const lockFile = join(LOCKS, 'fixture-a.lock')
  writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace(/\t20260914-0000\t/, '\t20260915-0000\t').replace(/:pool\.(amd64|arm64)\.20260914-0000@/g, ':pool.$1.20260915-0000@'))
  const pinFile = join(LOCKS, 'pins/fixture-a.pin')
  writeFileSync(pinFile, readFileSync(pinFile, 'utf8').replace(/^RELEASE=20260914-0000$/m, 'RELEASE=20260915-0000'))
  const r = await pool(['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
  expect(r.ok, r.out).toBe(true)
  expect(readFileSync(lockFile, 'utf8')).toContain('pool.amd64.20260915-0000@')
})

test('a manifest that is not a mica pool', async () => {
  setup()
  editJson(join(MANIFESTS, 'fixture-a-amd64.json'), (m) => { m.artifactType = 'application/vnd.oci.image.config.v1+json' })
  publish()
  await expectRefusal('is not the amd64 pool of fixture-a', ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('a layer titled other than the row\'s archive', async () => {
  setup()
  editJson(join(MANIFESTS, 'fixture-a-amd64.json'), (m) => { m.layers[0]!.annotations['org.opencontainers.image.title'] = 'fixture-a.deb' })
  publish()
  await expectRefusal('is titled fixture-a.deb', ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('a package row that is no layer of its pool', async () => {
  setup()
  A_SHA = D0
  publish()
  await expectRefusal(`carries no archive layer sha256:${D0}`, ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('a registry serving other bytes for the digest', async () => {
  setup()
  const digest = published['fixture-a-amd64']!.split('@')[1]!
  writeFileSync(join(FIX, 'micaoss/fixture-a/manifests', digest), '{}\n')
  await expectRefusal(`served a manifest for ${digest} with other bytes`, ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('no pull token', async () => {
  setup()
  rmSync(join(FIX, 'token.json'))
  await expectRefusal('the token endpoint of ghcr.io answered 404', ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

// 4. The archive.
test('a registry serving other archive bytes', async () => {
  setup()
  copyFileSync(join(DEBS, 'base-other.deb'), join(FIX, 'micaoss/fixture-base/blobs', `sha256:${BASE_SHA}`))
  await expectRefusal(`served a blob for sha256:${BASE_SHA} with other bytes`, ['fetch', '--arch', 'amd64', '--packages', 'fixture-base'])
})

test('a missing archive, with no fallback', async () => {
  setup()
  rmSync(join(FIX, 'micaoss/fixture-a/blobs', `sha256:${A_SHA}`))
  await expectRefusal('answered 404', ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('an archive whose control fields are not the row', async () => {
  setup()
  copyFileSync(join(DEBS, 'a-wrong.deb'), join(FIX, 'micaoss/fixture-a/blobs', `sha256:${sha(join(DEBS, 'a-wrong.deb'))}`))
  A_SHA = sha(join(DEBS, 'a-wrong.deb'))
  poolManifest(join(MANIFESTS, 'fixture-a-amd64.json'), 'fixture-a', 'amd64', [[join(DEBS, 'a-wrong.deb'), `fixture-a_${V_A}_amd64.deb`]])
  publish()
  await expectRefusal(`locks/ says fixture-a ${V_A} amd64`, ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'])
})

test('an archive of another source repository than its lock', async () => {
  setup()
  copyFileSync(join(DEBS, 'base-other.deb'), join(FIX, 'micaoss/fixture-base/blobs', `sha256:${sha(join(DEBS, 'base-other.deb'))}`))
  BASE_SHA = sha(join(DEBS, 'base-other.deb'))
  for (const arch of ['amd64', 'arm64']) poolManifest(join(MANIFESTS, `fixture-base-${arch}.json`), 'fixture-base', arch, [[join(DEBS, 'base-other.deb'), `fixture-base_${V_BASE}_all.deb`]])
  publish()
  await expectRefusal('says Mica-Source-Repo fixture-other; locks/ says fixture-base', ['fetch', '--arch', 'amd64', '--packages', 'fixture-base'])
})

// 5. The locks themselves.
test('a lock naming another registry', async () => {
  setup()
  const lockFile = join(LOCKS, 'fixture-a.lock')
  writeFileSync(lockFile, readFileSync(lockFile, 'utf8').replace('ghcr.io/micaoss/fixture-a:pool.amd64', 'ghcr.io/other/fixture-a:pool.amd64'))
  await expectRefusal('reference-registry ghcr.io/other/fixture-a', ['rows'])
})

test('a lock without its pin', async () => {
  setup()
  rmSync(join(LOCKS, 'pins/fixture-a.pin'))
  await expectRefusal('refused lock-without-pin', ['rows'])
})

test('a package with no row', async () => {
  setup()
  await expectRefusal('no amd64 package row for fixture-none', ['fetch', '--arch', 'amd64', '--packages', 'fixture-none'])
})

test('two packages pinned by two inputs each at one digest are one row each, with the first input\'s provenance', async () => {
  setup()
  // The shared archives both inputs publish: identical bytes under one name, as the radio packages are.
  const shared = join(DEBS, 'base-other.deb'), SHARED_SHA = sha(shared)
  copyFileSync(shared, join(FIX, 'micaoss/fixture-a/blobs', `sha256:${SHARED_SHA}`))
  copyFileSync(shared, join(FIX, 'micaoss/fixture-base/blobs', `sha256:${SHARED_SHA}`))
  poolManifest(join(MANIFESTS, 'fixture-a-amd64.json'), 'fixture-a', 'amd64',
    [[join(DEBS, 'a.deb'), `fixture-a_${V_A}_amd64.deb`], [join(DEBS, 'base.deb'), `fixture-base_${V_BASE}_all.deb`], [shared, `fixture-shared_${V_BASE}_all.deb`]])
  const digest = `sha256:${sha(join(MANIFESTS, 'fixture-a-amd64.json'))}`
  copyFileSync(join(MANIFESTS, 'fixture-a-amd64.json'), join(FIX, 'micaoss/fixture-a/manifests', digest))
  poolManifest(join(MANIFESTS, 'fixture-base-amd64.json'), 'fixture-base', 'amd64',
    [[join(DEBS, 'base.deb'), `fixture-base_${V_BASE}_all.deb`], [shared, `fixture-shared_${V_BASE}_all.deb`]])
  const baseDigest = `sha256:${sha(join(MANIFESTS, 'fixture-base-amd64.json'))}`
  copyFileSync(join(MANIFESTS, 'fixture-base-amd64.json'), join(FIX, 'micaoss/fixture-base/manifests', baseDigest))
  lock('fixture-base', COMMIT_BASE, `ghcr.io/micaoss/fixture-base:pool.amd64.20260914-0000@${baseDigest}`, published['fixture-base-arm64']!,
    `package\tfixture-base\tamd64\t${V_BASE}\t${BASE_SHA}\npackage\tfixture-shared\tamd64\t${V_BASE}\t${SHARED_SHA}`)
  lock('fixture-a', COMMIT_A, `ghcr.io/micaoss/fixture-a:pool.amd64.20260914-0000@${digest}`, published['fixture-a-arm64']!,
    `package\tfixture-a\tamd64\t${V_A}\t${A_SHA}\npackage\tfixture-base\tamd64\t${V_BASE}\t${BASE_SHA}\npackage\tfixture-shared\tamd64\t${V_BASE}\t${SHARED_SHA}`)
  // One package pinned by two inputs. Identical bytes are one package and collapse to one row: an
  // `Architecture: all` archive is published by every input that ships the feature, which is why two board locks
  // carry the same mica-bluetooth row. Two digests under one name and architecture are what the guard is for,
  // and still refuse, naming both digests and both inputs.
  // More than one, because the real tree has three: mica-bluetooth, mica-wifi and mica-wifi-ap are each pinned
  // by the cx3576 and s905x5m locks at one digest, and a rule proved on a single row is a rule proved once.
  const r = await pool(['rows', '--arch', 'amd64'])
  expect(r.ok, r.out).toBe(true)
  const rows = r.out.trim().split('\n').map(l => l.split('\t')).filter(f => f[0] === 'fixture-base' || f[0] === 'fixture-shared')
  expect(rows.length).toBe(2)
  expect(rows.find(f => f[0] === 'fixture-base')![3]).toBe(BASE_SHA)
  expect(rows.find(f => f[0] === 'fixture-shared')![3]).toBe(SHARED_SHA)
  expect(rows.find(f => f[0] === 'fixture-base')![4]).toBe('fixture-a')
})

test('one package pinned by two inputs at two digests', async () => {
  setup()
  // The same name and architecture from the other input, at other bytes: fixture-a's pool carries a different
  // archive under the all-architecture fixture-base title, so the two locks disagree about what it is.
  const other = join(DEBS, 'base-other.deb'), OTHER_SHA = sha(other)
  copyFileSync(other, join(FIX, 'micaoss/fixture-a/blobs', `sha256:${OTHER_SHA}`))
  poolManifest(join(MANIFESTS, 'fixture-a-amd64.json'), 'fixture-a', 'amd64', [[join(DEBS, 'a.deb'), `fixture-a_${V_A}_amd64.deb`], [other, `fixture-base_${V_BASE}_all.deb`]])
  const digest = `sha256:${sha(join(MANIFESTS, 'fixture-a-amd64.json'))}`
  copyFileSync(join(MANIFESTS, 'fixture-a-amd64.json'), join(FIX, 'micaoss/fixture-a/manifests', digest))
  lock('fixture-a', COMMIT_A, `ghcr.io/micaoss/fixture-a:pool.amd64.20260914-0000@${digest}`, published['fixture-a-arm64']!,
    `package\tfixture-a\tamd64\t${V_A}\t${A_SHA}\npackage\tfixture-base\tamd64\t${V_BASE}\t${OTHER_SHA}`)
  await expectRefusal('fixture-base is pinned twice for all at two digests', ['rows'])
})

// 7. An offline lock (src/cli.ts local-pins): its pool is read out of the checkout's OCI layout, never in CI.
function offlineSetup(): void {
  setup()
  const layout = join(SCRATCH, 'checkout/_out/offline/oci')
  mkdirSync(join(layout, 'blobs/sha256'), { recursive: true })
  copyFileSync(join(DEBS, 'a.deb'), join(layout, 'blobs/sha256', A_SHA))
  const offline: Record<string, string> = {}
  for (const arch of ['amd64', 'arm64']) {
    const digest = sha(join(MANIFESTS, `fixture-a-${arch}.json`))
    copyFileSync(join(MANIFESTS, `fixture-a-${arch}.json`), join(layout, 'blobs/sha256', digest))
    offline[arch] = `local/fixture-a:pool.${arch}.offline@sha256:${digest}`
  }
  writeFileSync(join(LOCKS, 'fixture-a.lock'), `# mica-lock v1\nrelease\tfixture-a\toffline\t${COMMIT_A}\npool\tamd64\t${offline.amd64}\npool\tarm64\t${offline.arm64}\npackage\tfixture-a\tamd64\t${V_A}\t${A_SHA}\n`)
  writeFileSync(join(LOCKS, 'pins/fixture-a.pin'), `# mica-pin v1\nREPOSITORY=fixture-a\nRELEASE=offline\nSHA256SUMS=${D0}\nCHECKOUT=${join(SCRATCH, 'checkout')}\n`)
}

test('an offline lock reads the checkout\'s OCI layout', async () => {
  offlineSetup()
  const r = await pool(['fetch', '--arch', 'amd64', '--packages', 'fixture-a'], { CI: '', GITHUB_ACTIONS: '' })
  expect(r.ok, r.out).toBe(true)
  expect(existsSync(join(POOL, 'amd64/pool', `fixture-a_${V_A}_amd64.deb`))).toBe(true)
})

test('an offline pin under GitHub Actions', async () => {
  offlineSetup()
  await expectRefusal('refused checkout-in-ci', ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'], { GITHUB_ACTIONS: 'true' })
})

test('an offline layout without the archive', async () => {
  offlineSetup()
  rmSync(join(SCRATCH, 'checkout/_out/offline/oci/blobs/sha256', A_SHA))
  await expectRefusal(`holds no blob sha256:${A_SHA}`, ['fetch', '--arch', 'amd64', '--packages', 'fixture-a'], { CI: '', GITHUB_ACTIONS: '' })
})
