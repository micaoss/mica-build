// src/pool/podman-pool.ts over fixture pools: the upstream.lock is taken out of whichever mica-podman archives
// the pools hold, the two architectures must agree, the arm64 quadlet is taken with its mode, and a pool with
// no archive or with two is refused by name.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { check, PodmanPoolError } from '../../src/pool/podman-pool.ts'
import { fixtureDeb } from './release-fixture.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const rel = (p: string) => p.slice(REPO_ROOT.length + 1)
const T = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'podman-pool-test.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const LOCK = 'git\tpodman\tv5.8.6\tabc\n'
const QUADLET = '#!/bin/sh\necho quadlet\n'

function pool(name: string, archives: { arch: string, lock: string, quadlet?: string, version?: string }[]): string {
  const root = join(T, name)
  for (const a of archives) {
    const files: Record<string, string> = { 'usr/share/mica-podman/upstream.lock': a.lock }
    if (a.quadlet !== undefined) files['usr/libexec/podman/quadlet'] = a.quadlet
    fixtureDeb(T, join(root, a.arch, 'pool', `mica-podman_${a.version ?? '5.8.6-2'}_${a.arch}.deb`), 'mica-podman', a.arch, a.version ?? '5.8.6-2', files)
  }
  return root
}

test('the lock is taken out of the one archive, and the quadlet only from arm64', async () => {
  const p = pool('amd64-only', [{ arch: 'amd64', lock: LOCK }])
  expect(await check(p)).toBe(`podman-pool: ${rel(p)}/mica-podman/upstream.lock from the amd64 archive(s)`)
  expect(readFileSync(join(p, 'mica-podman/upstream.lock'), 'utf8')).toBe(LOCK)
  expect(existsSync(join(p, 'arm64/mica-podman/quadlet'))).toBe(false)
})

test('both archives agree: the lock is written once and the arm64 quadlet with its mode', async () => {
  const p = pool('both', [{ arch: 'amd64', lock: LOCK }, { arch: 'arm64', lock: LOCK, quadlet: QUADLET }])
  expect(await check(p)).toBe(`podman-pool: ${rel(p)}/mica-podman/upstream.lock from the amd64 arm64 archive(s); arm64 quadlet at ${rel(p)}/arm64/mica-podman/quadlet`)
  expect(readFileSync(join(p, 'mica-podman/upstream.lock'), 'utf8')).toBe(LOCK)
  expect(readFileSync(join(p, 'arm64/mica-podman/quadlet'), 'utf8')).toBe(QUADLET)
  // The mode is the payload entry's: the fixture packs a 0644 file, the real archive a 0755 binary.
  expect(statSync(join(p, 'arm64/mica-podman/quadlet')).mode & 0o777).toBe(0o644)
})

test('archives that disagree are refused', async () => {
  const p = pool('disagree', [{ arch: 'amd64', lock: LOCK }, { arch: 'arm64', lock: 'git\tpodman\tv5.8.5\tdef\n', quadlet: QUADLET }])
  await expect(check(p)).rejects.toThrow(PodmanPoolError)
  await expect(check(p)).rejects.toThrow('carry different usr/share/mica-podman/upstream.lock; one release builds both from one set of trees')
})

test('no archive, and two archives in one pool, are refused by name', async () => {
  const none = join(T, 'none'); mkdirSync(join(none, 'amd64/pool'), { recursive: true })
  await expect(check(none)).rejects.toThrow(`no mica-podman archive in ${none}/amd64/pool or ${none}/arm64/pool. locks/mica-podman.lock pins it`)
  const two = pool('two', [{ arch: 'amd64', lock: LOCK }, { arch: 'amd64', lock: LOCK, version: '5.8.6-3' }])
  await expect(check(two)).rejects.toThrow(`2 mica-podman archives in ${two}/amd64/pool; a pool holds one`)
})

test('an archive without the lock is refused by the archive reader', async () => {
  const root = join(T, 'no-lock')
  fixtureDeb(T, join(root, 'amd64/pool/mica-podman_5.8.6-2_amd64.deb'), 'mica-podman', 'amd64', '5.8.6-2', {})
  await expect(check(root)).rejects.toThrow('carries no usr/share/mica-podman/upstream.lock in its payload')
})
