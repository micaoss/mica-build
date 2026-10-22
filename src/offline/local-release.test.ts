import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ociBlob, ociManifest } from '@mica/build-tools'
import { localRelease } from './local-release.ts'

const work = mkdtempSync(join(tmpdir(), 'local-release-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function must(argv: string[], cwd?: string): void {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr.toString()}`)
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A producer checkout: micad declared and committed, its amd64 pool an archive of `repo` and a core.json item. */
function producer(name: string, repo = 'mica-core'): string {
  const dir = join(work, name)
  mkdirSync(join(dir, 'micad'), { recursive: true })
  writeFileSync(join(dir, 'micad/mica-inputs'), '# mica-inputs v1\npackage micad\n')
  must(['git', 'init', '--quiet', dir])
  must(['git', '-C', dir, 'add', '-A'])
  must(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '--quiet', '-m', 'fixture'])
  const pack = join(work, `${name}-pack`), pool = join(dir, '_out/debs/amd64/pool')
  mkdirSync(join(pack, 'DEBIAN'), { recursive: true })
  mkdirSync(pool, { recursive: true })
  writeFileSync(join(pack, 'DEBIAN/control'), `Package: micad\nVersion: 0.0.4-1\nArchitecture: amd64\nMaintainer: test <test@invalid>\nDescription: fixture\nMica-Source-Repo: ${repo}\n`)
  must(['dpkg-deb', '--root-owner-group', '-Zgzip', '--build', pack, join(pool, 'micad_0.0.4-1_amd64.deb')])
  writeFileSync(join(pool, 'micad_0.0.4_amd64.core.json'), '{}\n')
  return dir
}

test('a producer\'s make offline pool becomes its offline pin: section 6 layout in a clone, lock and pin in locks/', async () => {
  const checkout = producer('core'), root = join(work, 'build')
  mkdirSync(join(root, 'locks'), { recursive: true })
  const commit = Bun.spawnSync(['git', '-C', checkout, 'rev-parse', 'HEAD']).stdout.toString().trim()
  const pool = join(checkout, '_out/debs/amd64/pool')
  expect(localRelease('mica-core', checkout, root, {})).toContain(`mica-core offline at ${commit}`)

  const clone = join(root, '_out/local-releases/mica-core'), locks = join(root, 'locks')
  const lock = readFileSync(join(locks, 'mica-core.lock'), 'utf8').split('\n')
  expect(lock[0]).toBe('# mica-lock v1')
  expect(lock[1]).toBe(`release\tmica-core\toffline\t${commit}`)
  expect(lock[2]).toMatch(/^pool\tamd64\tlocal\/mica-core:pool\.amd64\.offline@sha256:[0-9a-f]{64}$/)
  expect(lock.slice(3)).toEqual([`package\tmicad\tamd64\t0.0.4-1\t${sha(join(pool, 'micad_0.0.4-1_amd64.deb'))}`,
    `item\tcore.json\tmicad\tamd64\t0.0.4\t${sha(join(pool, 'micad_0.0.4_amd64.core.json'))}`, ''])
  expect(readFileSync(join(locks, 'pins/mica-core.pin'), 'utf8')).toBe(`# mica-pin v1\nREPOSITORY=mica-core\nRELEASE=offline\nSHA256SUMS=${sha(join(clone, '_out/offline/SHA256SUMS'))}\nCHECKOUT=${clone}\n`)
  expect(Bun.spawnSync(['git', '-C', clone, 'rev-parse', 'HEAD']).stdout.toString().trim()).toBe(commit)

  // Read back as a consumer reads it: the pool manifest by its reference, its archive by digest, from the clone.
  const m = JSON.parse(new TextDecoder().decode(await ociManifest(lock[2]!.split('\t')[2]!, locks, 'local')))
  expect(m.artifactType).toBe('application/vnd.mica.pool')
  expect(m.annotations).toEqual({ 'mica.source-repo': 'mica-core', 'mica.arch': 'amd64' })
  expect(m.layers.map((l: { mediaType: string }) => l.mediaType)).toEqual(['application/vnd.mica.deb', 'application/vnd.mica.item.core.json'])
  expect((await ociBlob('local/mica-core', sha(join(pool, 'micad_0.0.4-1_amd64.deb')), locks, 'local')).length).toBe(readFileSync(join(pool, 'micad_0.0.4-1_amd64.deb')).length)
  await expect(ociManifest(lock[2]!.split('\t')[2]!, locks, 'ci')).rejects.toThrow('checkout-in-ci')
})

test('refused: under CI, a dirty checkout, an archive of another repository, a checkout with no pool', () => {
  const root = join(work, 'refused')
  mkdirSync(join(root, 'locks'), { recursive: true })
  const checkout = producer('dirty')
  expect(() => localRelease('mica-core', checkout, root, { GITHUB_ACTIONS: 'true' })).toThrow('never pinned in CI')
  writeFileSync(join(checkout, 'micad/mica-inputs'), '# mica-inputs v1\npackage micad\npackage micad-dbg\n')
  expect(() => localRelease('mica-core', checkout, root, {})).toThrow('has uncommitted changes')
  expect(() => localRelease('mica-core', producer('other', 'mica-pkgs'), root, {})).toThrow('is of mica-pkgs')
  const empty = producer('empty')
  rmSync(join(empty, '_out'), { recursive: true })
  expect(() => localRelease('mica-core', empty, root, {})).toThrow('holds no pool')
  expect(existsSync(join(root, 'locks/mica-core.lock'))).toBe(false)
})
