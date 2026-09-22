// The static half of the package gate (src/pool/gate.ts) over synthetic producers and fixture archives: the
// happy path, and every refusal by name. The producers are handed in (no discovery), their control templates
// and version.env live under a scratch directory of the tree, and the archives are packed by this host's
// dpkg-deb into a scratch pool. No docker: the rebuild half (c) is exercised by the gate's own run in CI.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { gate, GateError } from '../../src/pool/gate.ts'
import type { Producer } from '../../src/pool/producers.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp/package-gate-test.'))
const POOL = join(SCRATCH, 'pool')
const CONTROL = join(SCRATCH, 'fx/control'), CONTROL_ALL = join(SCRATCH, 'fx-all/control')
const OWN = 'fixture-repo'

let producers: Producer[]

type Archive = { name: string, version?: string, arch?: string, repo?: string, fields?: Record<string, string>, files?: Record<string, string>, links?: Record<string, string>, scripts?: Record<string, string>, conffiles?: string, copyright?: boolean }

/** One archive into the pool of <poolArch>, packed by dpkg-deb. */
function pack(poolArch: string, a: Archive): string {
  const root = join(SCRATCH, 'pack', `${poolArch}-${a.name}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'DEBIAN'), { recursive: true })
  const version = a.version ?? '1.0-1', arch = a.arch ?? poolArch
  let control = `Package: ${a.name}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: test <test@invalid>\nDescription: fixture\nMica-Source-Repo: ${a.repo ?? OWN}\n`
  for (const [k, v] of Object.entries(a.fields ?? {})) control += `${k}: ${v}\n`
  writeFileSync(join(root, 'DEBIAN/control'), control)
  if (a.conffiles !== undefined) writeFileSync(join(root, 'DEBIAN/conffiles'), a.conffiles)
  for (const [s, body] of Object.entries(a.scripts ?? {})) { writeFileSync(join(root, 'DEBIAN', s), body); Bun.spawnSync(['chmod', '0755', join(root, 'DEBIAN', s)]) }
  const files: Record<string, string> = { ...(a.copyright === false ? {} : { [`usr/share/doc/${a.name}/copyright`]: 'fixture copyright\n' }), [`usr/lib/${a.name}/payload`]: `${a.name}\n`, ...(a.files ?? {}) }
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body) }
  for (const [path, target] of Object.entries(a.links ?? {})) { mkdirSync(join(root, path, '..'), { recursive: true }); symlinkSync(target, join(root, path)) }
  const out = join(POOL, poolArch, 'pool', `${a.name}_${version}_${arch}.deb`)
  mkdirSync(join(POOL, poolArch, 'pool'), { recursive: true })
  const r = Bun.spawnSync(['dpkg-deb', '--root-owner-group', '-Zgzip', '--build', root, out], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`dpkg-deb: ${r.stderr.toString()}`)
  return out
}

/** The clean pools: fx (fx-a, fx-b; amd64) and fx-all (fx-c; all, so in both). */
function clean(): void {
  rmSync(POOL, { recursive: true, force: true })
  pack('amd64', { name: 'fx-a', links: { 'etc/systemd/system/multi-user.target.wants/fx-a.service': '/usr/lib/systemd/system/fx-a.service' }, fields: { Depends: 'fx-b (= 1.0-1), libc6 (>= 2.36)' } })
  pack('amd64', { name: 'fx-b' })
  for (const arch of ['amd64', 'arm64']) pack(arch, { name: 'fx-c', arch: 'all' })
}

async function run(options: { arch?: string } = {}): Promise<{ lines: string[], pass: number, fail: number, result: string }> {
  const lines: string[] = []
  const r = await gate({ static: true, poolRoot: POOL, ownRepo: OWN, producers, say: l => lines.push(l), ...options })
  return { lines, ...r }
}

async function refusal(fragment: string, options: { arch?: string } = {}): Promise<string[]> {
  const r = await run(options)
  expect(r.fail, r.lines.join('\n')).toBeGreaterThan(0)
  expect(r.lines.filter(l => l.startsWith('FAIL:')).join('\n')).toContain(fragment)
  return r.lines
}

beforeAll(() => {
  for (const dir of [CONTROL, CONTROL_ALL]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(CONTROL, 'fx-a.control'), 'Package: fx-a\n'); writeFileSync(join(CONTROL, 'fx-b.control'), 'Package: fx-b\n')
  writeFileSync(join(CONTROL_ALL, 'fx-c.control'), 'Package: fx-c\n')
  writeFileSync(join(SCRATCH, 'fx/version.env'), 'VERSION=1.0-1\nSOURCE_DATE_EPOCH=1700000000\n')
  writeFileSync(join(SCRATCH, 'fx-all/version.env'), 'VERSION=1.0-1\nSOURCE_DATE_EPOCH=1700000000\n')
  const rel = (p: string) => relative(REPO_ROOT, p)
  producers = [
    { name: 'fx', dir: rel(join(SCRATCH, 'fx')), arches: ['amd64'], packages: ['fx-a', 'fx-b'], enablement: 'fx-a=1,fx-b=0', instance: '', control: rel(CONTROL), env: {} },
    { name: 'fx-all', dir: rel(join(SCRATCH, 'fx-all')), arches: ['all'], packages: ['fx-c'], enablement: 'fx-c=0', instance: '', control: rel(CONTROL_ALL), env: {} },
  ]
})

beforeEach(clean)

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

test('clean pools pass every static check, and the all archive is compared across pools', async () => {
  const r = await run()
  expect(r.fail, r.lines.join('\n')).toBe(0)
  expect(r.result).toMatch(/^RESULT: PASS \(\d+\/\d+ checks passed, 4 archives, \d+ payload paths, 0 maintainer scripts, 2 all-architecture archives compared, 0 local-virtual dependencies resolved\)$/)
  expect(r.lines).toContain('PASS: fx-a amd64: depends on fx-b at its exact pool version (= 1.0-1)')
  expect(r.lines.find(l => l.startsWith('note: external dependencies'))).toContain('libc6')
})

test('--arch gates one pool with its rebuild and --static every pool without one; they do not combine', async () => {
  await expect(run({ arch: 'arm64' })).rejects.toThrow(/--arch gates one pool with its rebuild and --static every pool without one/)
  const r = await run()
  expect(r.lines.some(l => l.startsWith('note: one pool gated'))).toBe(false)
})

test('a path in two archives of one pool', async () => {
  pack('amd64', { name: 'fx-b', files: { 'usr/lib/fx-a/payload': 'taken\n' } })
  await refusal('fx-b amd64: ships path(s) another package already owns: /usr/lib/fx-a/payload (also in fx-a)')
})

test('a shared path is exempt only between packages that declare mutual unversioned Conflicts', async () => {
  pack('amd64', { name: 'fx-a', fields: { Conflicts: 'fx-b' }, links: { 'etc/systemd/system/multi-user.target.wants/fx-a.service': '/x' } })
  pack('amd64', { name: 'fx-b', fields: { Conflicts: 'fx-a' }, files: { 'usr/lib/fx-a/payload': 'taken\n' } })
  const r = await run()
  expect(r.fail, r.lines.join('\n')).toBe(0)
  expect(r.lines.some(l => l.startsWith('PASS: fx-b amd64: EXEMPT shared path(s)') && l.includes('/usr/lib/fx-a/payload (with fx-a)'))).toBe(true)
})

test('Replaces is refused', async () => {
  pack('amd64', { name: 'fx-b', fields: { Replaces: 'fx-a' } })
  await refusal('fx-b amd64: declares Replaces: fx-a')
})

test('DEBIAN/conffiles is refused', async () => {
  pack('amd64', { name: 'fx-b', conffiles: '/etc/fx-b.conf\n', files: { 'etc/fx-b.conf': 'x\n' } })
  await refusal('fx-b amd64: carries DEBIAN/conffiles')
})

test('a maintainer script that is not POSIX sh is refused, and a valid one is counted', async () => {
  pack('amd64', { name: 'fx-b', scripts: { postinst: '#!/bin/sh\nif [ 1 ]; then\n' } })
  pack('amd64', { name: 'fx-a', scripts: { prerm: '#!/bin/sh\nexit 0\n' }, links: { 'etc/systemd/system/multi-user.target.wants/fx-a.service': '/x' } })
  const lines = await refusal('fx-b amd64: DEBIAN/postinst is not valid POSIX sh')
  expect(lines).toContain('PASS: fx-a amd64: DEBIAN/prerm parses as POSIX sh')
  expect(lines.at(-1)).toContain('2 maintainer scripts')
})

test('a missing or empty copyright is refused', async () => {
  pack('amd64', { name: 'fx-b', copyright: false })
  await refusal('fx-b amd64: ships no non-empty /usr/share/doc/fx-b/copyright (size: absent)')
  pack('amd64', { name: 'fx-b', files: { 'usr/share/doc/fx-b/copyright': '' } })
  await refusal('fx-b amd64: ships no non-empty /usr/share/doc/fx-b/copyright (size: 0)')
})

test('the enablement links are counted against the declaration', async () => {
  pack('amd64', { name: 'fx-a', fields: { Depends: 'fx-b (= 1.0-1)' } })
  await refusal('fx-a amd64: ships 0 multi-user.target.wants symlink(s), but')
  pack('amd64', { name: 'fx-b', links: { 'etc/systemd/system/multi-user.target.wants/fx-b.service': '/x' } })
  await refusal('fx-b amd64: ships 1 multi-user.target.wants symlink(s) (./etc/systemd/system/multi-user.target.wants/fx-b.service), but')
})

test('an archive not at its producer declared version is refused', async () => {
  rmSync(join(POOL, 'amd64/pool/fx-b_1.0-1_amd64.deb'))
  pack('amd64', { name: 'fx-b', version: '1.0-2' })
  const lines = await refusal('amd64: archive(s) not at their producer\'s declared version (version.env): fx-b=1.0-2(declared 1.0-1)')
  expect(lines.filter(l => l.includes('at its exact pool version')).length).toBe(0)
  expect(lines).toContain('FAIL: fx-a amd64: depends on the local package fx-b as \'fx-b (= 1.0-1)\', which is neither unversioned nor that package\'s exact pool version (= 1.0-2)')
})

test('an archive no producer declares, and a producer that contributed nothing', async () => {
  pack('amd64', { name: 'fx-z' })
  const lines = await refusal('amd64: pool/amd64/pool holds archive(s) no discovered producer declares and no lock row names: fx-z'.replace('pool/amd64/pool', join(POOL, 'amd64/pool')))
  expect(lines.some(l => l.startsWith('FAIL: amd64: the pool holds [fx-a fx-b fx-c fx-z], but the producers building for amd64 declare and the lock imports [fx-a fx-b fx-c]'))).toBe(true)
  rmSync(join(POOL, 'arm64/pool/fx-c_1.0-1_all.deb'))
  pack('arm64', { name: 'fx-c', arch: 'all', repo: 'other' })
  pack('arm64', { name: 'fx-z' })
  await refusal('arm64: the producer \'fx-all\' contributed NO archive to')
})

test('an archive of another architecture in the pool', async () => {
  rmSync(join(POOL, 'amd64/pool/fx-b_1.0-1_amd64.deb'))
  pack('amd64', { name: 'fx-b', arch: 'arm64' })
  await refusal('fx-b in the amd64 pool declares Architecture: arm64')
})

test('a local dependency must be pinned exactly, and a local virtual name resolves through Provides', async () => {
  pack('amd64', { name: 'fx-a', fields: { Depends: 'fx-b, fx-virtual' }, links: { 'etc/systemd/system/multi-user.target.wants/fx-a.service': '/x' } })
  pack('amd64', { name: 'fx-b', fields: { Provides: 'fx-virtual' } })
  const lines = await refusal('fx-a amd64: depends on the local package fx-b as \'fx-b\', which is not that package\'s exact pool version (= 1.0-1)')
  expect(lines).toContain('PASS: fx-a amd64: depends on the local virtual fx-virtual, provided in this pool by fx-b')
  expect(lines.at(-1)).toContain('1 local-virtual dependencies resolved')
})

test('a local dependency that is not in the pool', async () => {
  rmSync(join(POOL, 'amd64/pool/fx-b_1.0-1_amd64.deb'))
  const lines = await refusal('fx-a amd64: depends on the local package fx-b, which is not in')
  expect(lines.some(l => l.startsWith('FAIL: amd64: the producer \'fx\' contributed only part of what it declares -- missing: fx-b'))).toBe(true)
})

test('an all archive that differs between the pools', async () => {
  rmSync(join(POOL, 'arm64/pool/fx-c_1.0-1_all.deb'))
  pack('arm64', { name: 'fx-c', arch: 'all', files: { 'usr/lib/fx-c/extra': 'other bytes\n' } })
  await refusal('fx-c: Architecture: all, but the pools hold DIFFERENT bytes under that one filename')
})

test('an imported archive beside the own ones is not gated, and an empty own pool is refused', async () => {
  pack('amd64', { name: 'imported', repo: 'other-repo', copyright: false })
  const r = await run()
  expect(r.fail, r.lines.join('\n')).toBe(0)
  expect(r.lines.some(l => l.includes('imported'))).toBe(false)
  rmSync(join(POOL, 'arm64'), { recursive: true })
  await expect(run()).rejects.toThrow(GateError)
  mkdirSync(join(POOL, 'arm64/pool'), { recursive: true })
  pack('arm64', { name: 'imported', repo: 'other-repo' })
  await expect(run()).rejects.toThrow(/holds no \.deb/)
})

test('a producer whose PACKAGES and control templates disagree, or whose ENABLEMENT is incomplete, is refused before any archive is read', async () => {
  const broken = { ...producers[0]!, packages: ['fx-a', 'fx-b', 'fx-d'], enablement: 'fx-a=1,fx-b=0,fx-d=0' }
  await expect(gate({ static: true, poolRoot: POOL, ownRepo: OWN, producers: [broken, producers[1]!], say: () => undefined })).rejects.toThrow(/declares PACKAGES='fx-a fx-b fx-d' and .* holds templates for 'fx-a fx-b'/)
  const missing = { ...producers[0]!, enablement: 'fx-a=1' }
  await expect(gate({ static: true, poolRoot: POOL, ownRepo: OWN, producers: [missing, producers[1]!], say: () => undefined })).rejects.toThrow(/emits 'fx-b' and its ENABLEMENT does not mention it/)
  const bad = { ...producers[0]!, enablement: 'fx-a=one,fx-b=0' }
  await expect(gate({ static: true, poolRoot: POOL, ownRepo: OWN, producers: [bad, producers[1]!], say: () => undefined })).rejects.toThrow(/whose count is not a non-negative integer/)
  expect(readFileSync(join(POOL, 'amd64/pool/fx-a_1.0-1_amd64.deb')).length).toBeGreaterThan(0)
})
