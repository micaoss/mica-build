// The board publishers against a real registry, for scoped releases <scope>.<YYYYMMDD-HHMM>: the pool
// publisher (src/pool/publish.ts) pushes the board's pool as pool.<board>.<arch>.<YYYYMMDD-HHMM>,
// tools/publish-components.sh its built components as <component>.<board>.<YYYYMMDD-HHMM>, reusing an
// unchanged component of the latest release that published it by digest, and both leave the rows
// tools/release.sh publish folds into mica-build.lock. Everything reads back anonymously; a tag holding
// another digest is refused; two boards released in one minute do not collide.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/publish.test.ts     (make publish-test; docker)
//
// The registry is the upstream registry:3.1.1 image locks/mica-build-env.lock lists, a sibling container
// spoken to over plain HTTP. The commands run in a scratch clone of the working tree, committed and tagged
// there (the tags never leave the clone), over fixture build outputs laid out as outputs.tsv lists them and
// fixture archives of the board's packages. Previous releases are served from file://. The port of
// tests/gates/publish-test.sh (deleted 2026-09-22), case for case.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cloneTree, fixtureDeb, inClone, lockOf, must, Registry, releaseEnv, Releases, REPO_ROOT, sh } from './release-fixture.ts'

const work = mkdtempSync(join((mkdirSync(join(REPO_ROOT, '_out'), { recursive: true }), join(REPO_ROOT, '_out')), 'publish-test.'))
const registry = new Registry()
let clone: string, releases: Releases
const STAMP = '20260101-0000', NEXT = '20260101-0100'
const boardsSh = (...args: string[]) => must(['bash', join(REPO_ROOT, 'tools/boards.sh'), ...args]).split('\n').filter(l => l !== '')

function env(owner: string, tag: string, extra: Record<string, string> = {}): Record<string, string> {
  const rows = join(work, `rows-${owner}-${tag}`)
  return { ...releaseEnv(work, registry, owner, tag, releases, rows), MICA_RELEASE_OUT: join(rows, 'out'), MICA_LOCK_REGISTRY: 'ghcr.io/micaoss',
    VERITY_TRUST_CERT: join(work, 'verity.pem'), FIT_TRUST_CERT: join(work, 'boot.pem'), ...extra }
}

function poolPublish(owner: string, tag: string): { code: number, out: string } {
  return inClone(clone, ['pool-publish'], env(owner, tag))
}

function components(owner: string, tag: string, extra: Record<string, string> = {}): { code: number, out: string } {
  return sh(['bash', 'tools/publish-components.sh'], { cwd: clone, env: env(owner, tag, extra) })
}

/** pool, components; the lock of the rows both left. */
function release(owner: string, tag: string, extra: Record<string, string> = {}): { pool: string, components: string, lock: string } {
  const p = poolPublish(owner, tag)
  expect(p.code, p.out).toBe(0)
  const c = components(owner, tag, extra)
  expect(c.code, c.out).toBe(0)
  return { pool: p.out, components: c.out, lock: lockOf(join(work, `rows-${owner}-${tag}`)) }
}

/** Fixture build outputs for <board>: every kernel and uboot file its outputs.tsv lists, under _out/<board>/. */
function outputs(board: string): void {
  const boardEnv = readFileSync(join(clone, 'boards', board, 'board.env'), 'utf8')
  const loader = /^FIRMWARE_FORMAT=rockchip-loader$/m.test(boardEnv) ? 'uboot-mica' : 'uboot'
  for (const line of readFileSync(join(clone, 'boards', board, 'outputs.tsv'), 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#'))) {
    const [kind, component, path] = line.split('\t')
    if (kind !== 'file') continue
    let p: string
    if (component === 'kernel' && path!.startsWith('kernel/')) p = join(clone, '_out', board, path!)
    else if (component === 'uboot' && path!.startsWith('uboot/')) p = join(clone, '_out', board, loader, path!.slice('uboot/'.length))
    else if (component === 'uboot' && path!.startsWith('uboot-package/')) p = join(clone, '_out', board, path!)
    else continue
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, `fixture ${board} ${path}\n`)
  }
}

async function manifest(owner: string, ref: string): Promise<{ annotations: Record<string, string>, layers: { annotations: Record<string, string> }[] }> {
  const m = await registry.manifest(`${owner}/mica-build`, ref)
  expect(m.status).toBe(200)
  return JSON.parse(new TextDecoder().decode(m.bytes))
}

beforeAll(async () => {
  await registry.start()
  clone = cloneTree(work)
  releases = new Releases(work)
  // Fixture trust certificates (any bytes: they are hashed and carried, not parsed here).
  writeFileSync(join(work, 'verity.pem'), 'fixture verity certificate\n')
  writeFileSync(join(work, 'boot.pem'), 'fixture boot certificate\n')
  for (const b of ['uefi-x64', 'cx3576']) {
    outputs(b)
    const a = boardsSh('arch', b)[0]!
    for (const row of boardsSh('producers', b)) {
      const [producer, , arches, packages] = row.split(' ')
      const v = inClone(clone, ['producers', '--version-for', producer!], {}).out.split(/\s+/)[0]!
      const arch = arches === 'all' ? 'all' : a
      for (const p of packages!.split(',')) {
        const out = join(clone, '_out/debs', a, 'pool', `${p}_${v}_${arch}.deb`)
        if (!existsSync(out)) fixtureDeb(work, out, p, arch, v)
      }
    }
  }
}, 600000)

afterAll(() => {
  registry.stop()
  rmSync(work, { recursive: true, force: true })
})

test('0. only a release publishes', () => {
  const notag = poolPublish('notag', `uefi-x64.${STAMP}`)
  expect(notag.code).not.toBe(0)
  expect(notag.out).toContain('carries no release tag')
  must(['git', '-C', clone, 'tag', `uefi-x64.${STAMP}`])
  must(['git', '-C', clone, 'tag', `cx3576.${STAMP}`])
  const other = components('othertag', 'uefi-x64.20260101-0001')
  expect(other.code).not.toBe(0)
  expect(other.out).toContain('the release event names uefi-x64.20260101-0001')
  const otherPool = poolPublish('othertag', 'uefi-x64.20260101-0001')
  expect(otherPool.code).not.toBe(0)
  expect(otherPool.out).toContain('the release event names uefi-x64.20260101-0001')
}, 600000)

test('1. two first releases in one minute: every component built and published, locks valid', async () => {
  for (const b of ['uefi-x64', 'cx3576']) {
    const tag = `${b}.${STAMP}`, a = boardsSh('arch', b)[0]!
    const r = release('one', tag)
    const lock = r.lock.split('\n')
    expect(lock.filter(l => l.startsWith('pool')), r.lock).toEqual([`pool\t${a}\tghcr.io/micaoss/mica-build:pool.${b}.${a}.${STAMP}@${await registry.served('one/mica-build', `pool.${b}.${a}.${STAMP}`)}`])
    const comps = must(['bash', join(REPO_ROOT, 'tools/component.sh'), 'list', b]).split('\n').filter(c => c !== '' && c !== 'board')
    for (const c of comps) {
      expect(lock, `${tag}: board row of ${c}`).toContain(`board\t${b}\t${c}\t${a}\tghcr.io/micaoss/mica-build:${c}.${b}.${STAMP}@${await registry.served('one/mica-build', `${c}.${b}.${STAMP}`)}`)
      const m = await manifest('one', `${c}.${b}.${STAMP}`)
      expect(`${m.annotations['mica.component']} ${m.annotations['mica.inputs']}`).toBe(`${c} ${must(['bash', 'tools/inputs.sh', b, c], { cwd: clone, env: { VERITY_TRUST_CERT: join(work, 'verity.pem'), FIT_TRUST_CERT: join(work, 'boot.pem') } }).trim()}`)
      const titles = m.layers.map(l => l.annotations['org.opencontainers.image.title']).sort().join(' ')
      const files = [...new Set(boardsSh('files', b, c).map(f => (f.startsWith('firmware/') ? 'firmware.tar' : f)))].sort().join(' ')
      expect(titles).toBe(files)
    }
    expect(lock.filter(l => l.startsWith('board')).length).toBe(comps.length)
    expect((await registry.manifest('one/mica-build', `board.${b}.${STAMP}`)).status).not.toBe(200)
    expect(lock.filter(l => l.startsWith('package')).map(l => l.split('\t')[1]).sort()).toEqual(boardsSh('packages', b).sort())
  }
  expect((await registry.tags('one/mica-build')).length).toBe(6)
}, 600000)

test('2. the next uefi-x64 release with unchanged inputs reuses every component by digest', async () => {
  releases.add(`uefi-x64.${STAMP}`, lockOf(join(work, `rows-one-uefi-x64.${STAMP}`)))
  must(['git', '-C', clone, 'tag', `uefi-x64.${NEXT}`])
  const r = release('one', `uefi-x64.${NEXT}`)
  expect(r.components).toContain('0 component(s) published, 1 reused')
  expect(await registry.served('one/mica-build', `kernel.uefi-x64.${NEXT}`)).toBe(await registry.served('one/mica-build', `kernel.uefi-x64.${STAMP}`))
  expect(await registry.served('one/mica-build', `pool.uefi-x64.amd64.${NEXT}`)).toBe(await registry.served('one/mica-build', `pool.uefi-x64.amd64.${STAMP}`))
  const m = await manifest('one', `pool.uefi-x64.amd64.${STAMP}`)
  expect(JSON.stringify(m.annotations)).toBe('{"mica.source-repo":"mica-build","mica.arch":"amd64"}')
  expect(m.layers[0]!.annotations['mica.inputs']).toBe(inClone(clone, ['package-inputs', 'board@uefi-x64', 'amd64'], {}).out.trim())
}, 600000)

test('3. the next cx3576 release with another boot certificate rebuilds only its uboot', async () => {
  releases.add(`cx3576.${STAMP}`, lockOf(join(work, `rows-one-cx3576.${STAMP}`)))
  must(['git', '-C', clone, 'tag', `cx3576.${NEXT}`])
  writeFileSync(join(work, 'boot2.pem'), 'another boot certificate\n')
  const r = release('one', `cx3576.${NEXT}`, { FIT_TRUST_CERT: join(work, 'boot2.pem') })
  expect(r.components).toContain('1 component(s) published, 2 reused')
  expect(await registry.served('one/mica-build', `uboot.cx3576.${NEXT}`)).not.toBe(await registry.served('one/mica-build', `uboot.cx3576.${STAMP}`))
  expect(await registry.served('one/mica-build', `kernel.cx3576.${NEXT}`)).toBe(await registry.served('one/mica-build', `kernel.cx3576.${STAMP}`))
}, 600000)

test('4. refusals: a tag holding another digest, a component or a pool missing a listed file', async () => {
  releases.set([])
  const edited = await manifest('one', `kernel.uefi-x64.${STAMP}`)
  edited.annotations['mica.arch'] = 'other'
  must(['git', '-C', clone, 'tag', 'uefi-x64.20260101-0200'])
  await registry.putManifest('one/mica-build', 'kernel.uefi-x64.20260101-0200', JSON.stringify(edited))
  const two = components('one', 'uefi-x64.20260101-0200')
  expect(two.code).not.toBe(0)
  expect(two.out).toContain('a published tag is never re-pointed')
  const pool = await manifest('one', `pool.uefi-x64.amd64.${STAMP}`)
  pool.annotations['mica.arch'] = 'other'
  await registry.putManifest('one/mica-build', 'pool.uefi-x64.amd64.20260101-0200', JSON.stringify(pool))
  const twoPool = poolPublish('one', 'uefi-x64.20260101-0200')
  expect(twoPool.code).not.toBe(0)
  expect(twoPool.out).toContain('a published tag is never re-pointed')
  must(['git', '-C', clone, 'tag', 'uefi-x64.20260101-0300'])
  rmSync(join(clone, '_out/uefi-x64/kernel/config'))
  const three = components('three', 'uefi-x64.20260101-0300')
  expect(three.code).not.toBe(0)
  expect(three.out).toContain('missing kernel/config')
  for (const f of Bun.spawnSync(['ls', join(clone, '_out/debs/amd64/pool')]).stdout.toString().split('\n')) if (f.startsWith('mica-board-uefi-x64_')) rmSync(join(clone, '_out/debs/amd64/pool', f))
  const threePool = poolPublish('three', 'uefi-x64.20260101-0300')
  expect(threePool.code).not.toBe(0)
  expect(threePool.out).toContain('exactly one mica-board-uefi-x64 archive')
}, 600000)
