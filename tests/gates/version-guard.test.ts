// Package versions end to end on the uefi-x64 board's real producer against a real registry: the version
// guard (src/pool/version-guard.ts) holds a freshly built pool to the board's latest release, and the pool
// publisher (src/pool/publish.ts) publishes an unchanged pool as the same manifest digest. An unchanged
// version with unchanged inputs is the published bytes; a bump is built; changed inputs without a bump, a
// lower version, bytes that moved under an unchanged version, and a previous archive that is missing or not
// its lock row's are refused; a release from before the rules is not compared.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/version-guard.test.ts     (make version-guard-test; docker)
//
// The commands run in a scratch clone of the working tree, untracked files included, committed and tagged
// there (the tags never leave the clone). The registry is registry:3.1.1 from locks/mica-build-env.lock, a
// sibling container over plain HTTP; published releases are served from file://. The port of
// tests/gates/version-guard-test.sh (deleted 2026-09-22), case for case.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloneTree, commit, fixtureDeb, inClone, lockOf, Registry, releaseEnv, Releases, REPO_ROOT, sha256 } from './release-fixture.ts'

const work = mkdtempSync(join((mkdirSync(join(REPO_ROOT, '_out'), { recursive: true }), join(REPO_ROOT, '_out')), 'version-guard-test.'))
const registry = new Registry()
let clone: string, releases: Releases, pool: string, versionEnv: string
const A = 'uefi-x64.20260101-0000', B = 'uefi-x64.20260101-0100', C = 'uefi-x64.20260101-0200'
const REPO = 'one/mica-build'
let aPool = '', aLock = '', cLock = ''

function declareVersion(version: string, epoch: string): void {
  writeFileSync(versionEnv, `VERSION=${version}\nSOURCE_DATE_EPOCH=${epoch}\n`)
}

function env(tag: string): Record<string, string> {
  return releaseEnv(work, registry, 'one', tag, releases, join(work, `rows-${tag}`))
}

/** The uefi-x64 pool at the clone's HEAD. */
function buildPool(): { code: number, out: string } {
  rmSync(join(clone, '_out/debs'), { recursive: true, force: true })
  return inClone(clone, ['pool-build', '--producer', 'board@uefi-x64', '--arch', 'amd64'], env('-'))
}

function guard(...args: string[]): { code: number, out: string } {
  return inClone(clone, ['version-guard', '--board', 'uefi-x64', ...args], env('-'))
}

/** pool, guard, publish; the lock of the release's pool and package rows. */
function release(tag: string): { guard: string, publish: string, lock: string } {
  Bun.spawnSync(['git', '-C', clone, 'tag', tag])
  const p = buildPool()
  expect(p.code, p.out).toBe(0)
  const g = guard('--release', tag)
  expect(g.code, g.out).toBe(0)
  const pub = inClone(clone, ['pool-publish'], env(tag))
  expect(pub.code, pub.out).toBe(0)
  return { guard: g.out, publish: pub.out, lock: lockOf(join(work, `rows-${tag}`)) }
}

/** The guard over a fresh pool refuses, naming <expected>. */
function refused(expected: string, ...args: string[]): void {
  const p = buildPool()
  expect(p.code, p.out).toBe(0)
  const g = guard(...args)
  expect(g.code, g.out).not.toBe(0)
  expect(g.out).toContain(expected)
}

function inputsHash(): string {
  const r = inClone(clone, ['package-inputs', 'board@uefi-x64', 'amd64'], env('-'))
  expect(r.code, r.out).toBe(0)
  return r.out.trim()
}

function lockFor(poolTag: string, manifest: Uint8Array, version: string, sha: string): string {
  return `# mica-lock v1\npool\tamd64\tghcr.io/micaoss/mica-build:${poolTag}@sha256:${sha256(manifest)}\npackage\tmica-board-uefi-x64\tamd64\t${version}\t${sha}\n`
}

beforeAll(async () => {
  await registry.start()
  clone = cloneTree(work, { untracked: true })
  pool = join(clone, '_out/debs/amd64/pool')
  versionEnv = join(clone, 'boards/uefi-x64/package/version.env')
  releases = new Releases(work)
  // The test owns the versions it asserts, whatever the tree declares today.
  declareVersion('0.1.0-1', '1789430400')
  commit(clone, 'the version this test starts from')
}, 600000)

afterAll(() => {
  registry.stop()
  rmSync(work, { recursive: true, force: true })
})

test('1. no published release: everything is built and published, its layer carries the inputs', async () => {
  releases.set([])
  const r = release(A)
  expect(r.guard).toContain('has no published release')
  aPool = await registry.served(REPO, 'pool.uefi-x64.amd64.20260101-0000')
  expect(aPool).toMatch(/^sha256:/)
  expect(readdirSync(pool)).toEqual(['mica-board-uefi-x64_0.1.0-1_amd64.deb'])
  const commitField = inClone(clone, ['deb', 'control', join(pool, 'mica-board-uefi-x64_0.1.0-1_amd64.deb'), 'Mica-Source-Commit'], env('-'))
  expect(commitField.out.trim()).toBe('')
  const m = JSON.parse(new TextDecoder().decode((await registry.manifest(REPO, 'pool.uefi-x64.amd64.20260101-0000')).bytes))
  const inputs = inputsHash()
  expect(inputs).toMatch(/^[0-9a-f]{64}$/)
  expect(m.layers[0].annotations['mica.inputs']).toBe(inputs)
  aLock = r.lock
}, 600000)

test('2. a previous release from before the rules (no mica.inputs) is not compared', async () => {
  const m = JSON.parse(new TextDecoder().decode((await registry.manifest(REPO, 'pool.uefi-x64.amd64.20260101-0000')).bytes))
  for (const l of m.layers) delete l.annotations['mica.inputs']
  const old = new TextEncoder().encode(JSON.stringify(m))
  expect(await registry.putManifest(REPO, 'pool.uefi-x64.amd64.20251231-0000', old)).toBe(201)
  const sha = aLock.split('\n').find(l => l.startsWith('package\t'))!.split('\t')[4]!
  releases.set([['uefi-x64.20251231-0000', lockFor('pool.uefi-x64.amd64.20251231-0000', old, '0.1.0+git0123456789ab-1', sha)]])
  const p = buildPool()
  expect(p.code, p.out).toBe(0)
  const g = guard()
  expect(g.code, g.out).toBe(0)
  expect(g.out).toContain('predates the package-version rules')
}, 600000)

test('3. a commit outside the package inputs: same version, same bytes, same pool digest (CI and release)', async () => {
  releases.set([[A, aLock]])
  writeFileSync(join(clone, 'README.md'), readFileSync(join(clone, 'README.md'), 'utf8') + '\nA change outside every package input.\n')
  commit(clone, 'outside the inputs')
  const p = buildPool()
  expect(p.code, p.out).toBe(0)
  const g = guard()
  expect(g.code, g.out).toBe(0)
  expect(g.out).toContain('1 unchanged, 0 bumped, 0 new')
  const r = release(B)
  expect(r.guard).toContain('1 unchanged')
  expect(await registry.served(REPO, 'pool.uefi-x64.amd64.20260101-0100')).toBe(aPool)
  releases.set([[B, r.lock]])
}, 600000)

test('4. a changed input without a bump: refused in CI and at release', () => {
  writeFileSync(join(clone, 'producers/board/producer.env'), readFileSync(join(clone, 'producers/board/producer.env'), 'utf8') + '# a changed input\n')
  commit(clone, 'a producer input, not bumped')
  refused('inputs of mica-board-uefi-x64 changed without a version bump')
  refused('inputs of mica-board-uefi-x64 changed without a version bump', '--release', C)
}, 600000)

test('5. the bump: built, published, a new pool', async () => {
  declareVersion('0.1.0-2', '1789516800')
  commit(clone, 'mica-board-uefi-x64 0.1.0-2')
  const r = release(C)
  expect(r.guard).toContain('mica-board-uefi-x64 0.1.0-1 -> 0.1.0-2: bumped')
  expect(await registry.served(REPO, 'pool.uefi-x64.amd64.20260101-0200')).not.toBe(aPool)
  cLock = r.lock
  releases.set([[C, cLock]])
}, 600000)

test('6. a lower version than the latest release: refused', () => {
  declareVersion('0.1.0-1', '1789430400')
  commit(clone, 'back to 0.1.0-1')
  refused('lower than 0.1.0-2')
  declareVersion('0.1.0-2', '1789516800')
  commit(clone, '0.1.0-2 again')
}, 600000)

test('7. bytes that moved under an unchanged version and unchanged inputs: refused', async () => {
  const moved = join(work, 'moved.deb')
  fixtureDeb(work, moved, 'mica-board-uefi-x64', 'amd64', '0.1.0-2', { 'usr/share/doc/mica-board-uefi-x64/copyright': 'moved\n' })
  const bytes = new Uint8Array(readFileSync(moved))
  const digest = await registry.putBlob(REPO, bytes)
  const m = JSON.parse(new TextDecoder().decode((await registry.manifest(REPO, 'pool.uefi-x64.amd64.20260101-0200')).bytes))
  m.layers[0].digest = digest; m.layers[0].size = bytes.length
  const edited = new TextEncoder().encode(JSON.stringify(m))
  expect(await registry.putManifest(REPO, 'pool.uefi-x64.amd64.20260101-0250', edited)).toBe(201)
  releases.set([['uefi-x64.20260101-0250', lockFor('pool.uefi-x64.amd64.20260101-0250', edited, '0.1.0-2', digest.slice('sha256:'.length))]])
  refused('is not the published archive')
}, 600000)

test('8. a previous archive that is not its lock row\'s, or missing: refused', async () => {
  const cSha = cLock.split('\n').find(l => l.startsWith('package\t'))!.split('\t')[4]!
  releases.set([[C, cLock.replace(cSha, '0'.repeat(64))]])
  refused('is no layer of its pool')
  releases.set([[C, cLock]])
  expect(await registry.deleteBlob(REPO, `sha256:${cSha}`)).toBe(202)
  refused('does not download anonymously')
  expect(existsSync(pool)).toBe(true)
}, 600000)
