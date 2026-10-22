// The flash image of a ubi board, assembled in the MTD_UTILS toolbox: its regions where flash.tsv puts them, the
// record copies and every object in its UBI device, and the same bytes from the same content however it was staged.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFitEnvironment } from './fit-environment.ts'
import { assembleFlash, assembleFlashImage, checkFlashContent, checkFlashKernel, flashRecord, pinUbifs, readFlashInputs, ubinizeIni, type FlashContent } from './flash-image.ts'
import { parseFlashLayout } from './flash-layout.ts'
import { makeWorkDir, REPO_ROOT } from './paths.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from './testing.ts'
import { Toolbox } from './toolbox.ts'
import { MTD_UTILS } from './toolsets.ts'

const MIB = 1048576
const LAYOUT = parseFlashLayout(['# mica flash layout v1', `flash\tnor\t262144\t1\t1\t64\t${32 * MIB}`, `mtd\tu-boot\tloader\t0\t${MIB}\tloader`,
  `mtd\tenv\tfixed\t${MIB}\t${MIB}\tfile:env.bin`, `mtd\tubi\tubi\t${2 * MIB}\t${30 * MIB}\t-`, 'volume\tsystem\t24', 'volume\tdata\t24',
  'reserve\tsystem\t1', 'reserve\tdata\t1', ''].join('\n'), 'demo')
// The same flash with its env region a local build input, and its first four blocks raw.
const VENDOR = Buffer.alloc(MIB, 0x33)
const INPUT_LAYOUT = parseFlashLayout(['# mica flash layout v1', `flash\tnand\t262144\t2048\t2048\t2048\t${32 * MIB}`, `mtd\tu-boot\tloader\t0\t${MIB}\tloader`,
  `mtd\tenv\tfixed\t${MIB}\t${MIB}\tinput:MICA_DEMO_VENDOR:${createHash('sha256').update(VENDOR).digest('hex')}`, `mtd\tubi\tubi\t${2 * MIB}\t${30 * MIB}\t-`,
  'volume\tsystem\t24', 'volume\tdata\t24', 'reserve\tsystem\t1', 'reserve\tdata\t1', 'raw\t4', ''].join('\n'), 'demo')
const KERNEL = 'a'.repeat(64), DEPLOYMENT = 'b'.repeat(64)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

let tb: Toolbox
let work = ''
beforeAll(async () => {
  work = makeWorkDir('flash-image')
  tb = await Toolbox.open(MTD_UTILS, { mounts: [work], cwd: work })
  writeFileSync(join(work, 'u-boot.bin'), Buffer.alloc(300000, 0x5a))
  writeFileSync(join(work, 'env.bin'), Buffer.alloc(4096, 0x11))
  writeFileSync(join(work, 'boot.itb'), Buffer.alloc(700000, 0x42))
  // One SYSTEM tree, staged twice in opposite orders.
  for (const [dir, order] of [['system-1', ['deployments', 'roots']], ['system-2', ['roots', 'deployments']]] as const) {
    for (const sub of order) {
      mkdirSync(join(work, dir, sub), { recursive: true })
      writeFileSync(join(work, dir, sub, `${DEPLOYMENT}.json`), `${sub}\n`)
      utimesSync(join(work, dir, sub, `${DEPLOYMENT}.json`), 1577836800, 1577836800)
      utimesSync(join(work, dir, sub), 1577836800, 1577836800)
    }
    utimesSync(join(work, dir), 1577836800, 1577836800)
  }
}, OPEN_TIMEOUT_MS)
afterAll(async () => {
  await tb?.close()
  if (work !== '') rmSync(work, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

const content = (system: string): FlashContent => ({ loader: join(work, 'u-boot.bin'), system: join(work, system),
  records: [{ id: DEPLOYMENT, kernelId: KERNEL, generation: 1, tries: null }], objects: [{ volume: `k-${KERNEL}`, file: join(work, 'boot.itb') }] })

test('the regions lie where flash.tsv puts them, erased beyond their bytes, and the UBI device holds the records and the objects', async () => {
  const out = join(work, 'flash-1.img')
  mkdirSync(join(work, 'w1'))
  await assembleFlash(tb, LAYOUT, work, content('system-1'), join(work, 'w1'), out)
  const image = readFileSync(out)
  expect(image.length).toBe(32 * MIB)
  expect(image.subarray(0, 300000).every(b => b === 0x5a)).toBe(true)
  expect(image.subarray(300000, MIB).every(b => b === 0xff)).toBe(true)
  expect(image.subarray(MIB, MIB + 4096).every(b => b === 0x11)).toBe(true)
  expect(image.subarray(MIB + 4096, 2 * MIB).every(b => b === 0xff)).toBe(true)
  const ubi = image.subarray(2 * MIB)
  expect(ubi.subarray(0, 4).toString('ascii')).toBe('UBI#')
  expect(ubi.includes(encodeFitEnvironment(content('').records, 0))).toBe(true)
  expect(ubi.includes(encodeFitEnvironment(content('').records, 1))).toBe(true)
  expect(ubi.includes(Buffer.alloc(200000, 0x42))).toBe(true)
}, TOOL_TIMEOUT_MS * 4)

test('the same content staged in another order, at another time, is the same image', async () => {
  const out = join(work, 'flash-2.img')
  mkdirSync(join(work, 'w2'))
  await Bun.sleep(1100)
  await assembleFlash(tb, LAYOUT, work, content('system-2'), join(work, 'w2'), out)
  expect(sha(readFileSync(out))).toBe(sha(readFileSync(join(work, 'flash-1.img'))))
}, TOOL_TIMEOUT_MS * 4)

test('a local build input region holds the file its variable names, recorded with the raw blocks', async () => {
  writeFileSync(join(work, 'vendor.bin'), VENDOR)
  const inputs = readFlashInputs(INPUT_LAYOUT, { MICA_DEMO_VENDOR: join(work, 'vendor.bin') })
  expect(inputs).toEqual({ env: join(work, 'vendor.bin') })
  const out = join(work, 'flash-3.img')
  mkdirSync(join(work, 'w3'))
  await assembleFlash(tb, INPUT_LAYOUT, work, { ...content('system-1'), inputs }, join(work, 'w3'), out)
  expect(readFileSync(out).subarray(MIB, 2 * MIB).equals(VENDOR)).toBe(true)
  expect(flashRecord(INPUT_LAYOUT)).toEqual({ schema: 'mica/flash-image/v1', board: 'demo', eraseBlock: 262144, rawBlocks: 4,
    inputs: [{ region: 'env', variable: 'MICA_DEMO_VENDOR', sha256: sha(VENDOR) }] })
  expect(flashRecord(LAYOUT)).toEqual({ schema: 'mica/flash-image/v1', board: 'demo', eraseBlock: 262144, rawBlocks: 0, inputs: [] })
}, TOOL_TIMEOUT_MS * 4)

test.each([
  ['an unset variable', {}, 'MICA_DEMO_VENDOR, which is unset'],
  ['an empty variable', { MICA_DEMO_VENDOR: '' }, 'MICA_DEMO_VENDOR, which is unset'],
  ['a missing file', { MICA_DEMO_VENDOR: '/nowhere/vendor.bin' }, 'could not be read'],
  ['a file short of the region', { MICA_DEMO_VENDOR: 'short.bin' }, 'is 4096 bytes, and the region env is 1048576'],
  ['a file of another sha256', { MICA_DEMO_VENDOR: 'other.bin' }, 'flash.tsv names'],
])('a local build input refused: %s', (_what, env: Record<string, string>, message) => {
  writeFileSync(join(work, 'short.bin'), Buffer.alloc(4096, 0x33))
  writeFileSync(join(work, 'other.bin'), Buffer.alloc(MIB, 0x34))
  const at = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' || v.startsWith('/') ? v : join(work, v)]))
  expect(() => readFlashInputs(INPUT_LAYOUT, at)).toThrow(message)
})

test('pinUbifs keeps mkfs.ubifs\'s own CRC algorithm: an image whose nodes it rewrites without change is unchanged', () => {
  const raw = readFileSync(join(work, 'w1', 'system.raw.ubifs'))
  const pinned = pinUbifs(raw, 262016)
  // Pinning twice changes nothing more: the UUID is the image's own and the times are already the mtimes.
  expect(sha(pinUbifs(pinned, 262016))).toBe(sha(pinned))
  expect(pinned.subarray(108, 124).equals(raw.subarray(108, 124))).toBe(false)
  expect(() => pinUbifs(Buffer.alloc(262016), 262016)).toThrow('not a UBIFS image')
})

test.each([
  ['an object volume out of form', { objects: [{ volume: 'x-1', file: 'boot.itb' }] }, 'is not an object volume'],
  ['an object volume named twice', { objects: [{ volume: `k-${KERNEL}`, file: 'boot.itb' }, { volume: `k-${KERNEL}`, file: 'boot.itb' }] }, 'named twice'],
  ['a loader larger than its region', { loader: 'too-big.bin' }, 'its region u-boot is 1048576'],
  ['objects beyond the UBI device', { objects: [{ volume: `r-${KERNEL}`, file: 'huge.img' }] }, 'the UBI partition offers'],
])('refused before anything is written: %s', (_what, change, message) => {
  writeFileSync(join(work, 'too-big.bin'), Buffer.alloc(MIB + 1))
  writeFileSync(join(work, 'huge.img'), Buffer.alloc(24 * MIB))
  const c = { ...content('system-1'), ...change }
  const at = (f: string) => (f.startsWith('/') ? f : join(work, f))
  expect(() => checkFlashContent(LAYOUT, { ...c, loader: at(c.loader), objects: c.objects.map(o => ({ ...o, file: at(o.file) })) })).toThrow(message)
})

test('ubinize\'s configuration: ids in order, sizes and images as given, nothing resized on attach', () => {
  expect(ubinizeIni([{ name: 'records-a', type: 'dynamic', image: '/r', bytes: 262016 }, { name: 'data', type: 'dynamic', bytes: 1048064 }]))
    .toBe('[records-a]\nmode=ubi\nvol_id=0\nvol_type=dynamic\nvol_name=records-a\nvol_size=262016\nimage=/r\n\n'
      + '[data]\nmode=ubi\nvol_id=1\nvol_type=dynamic\nvol_name=data\nvol_size=1048064\n')
})

test('a factory flash image takes two deployments, before anything is read or assembled', async () => {
  const never = new Proxy({}, { get: () => { throw new Error('the toolbox must not be touched') } }) as unknown as Toolbox
  await expect(assembleFlashImage(LAYOUT, '/nowhere', [], { envelope: '', coreDirectory: '/nowhere' }, [], '/nowhere', '/nowhere/out', never)).rejects.toThrow('two deployments')
  // An unset local build input refuses the image, rather than an erased region in its place.
  const two = [0, 1].map(() => ({ envelope: '', kernelDirectory: '/nowhere', rootDirectory: '/nowhere' }))
  await expect(assembleFlashImage(INPUT_LAYOUT, '/nowhere', two, { envelope: '', coreDirectory: '/nowhere' }, [], '/nowhere', '/nowhere/out', never, {})).rejects.toThrow('MICA_DEMO_VENDOR, which is unset')
})

test('a ubi board\'s factory kernel carries the board\'s policy and no partition UUID', async () => {
  const { boardFactsFrom } = await import('./board-facts.ts')
  const facts = boardFactsFrom(join(REPO_ROOT, 'boards/qemu-armhf/board.env'))
  const boot = { board: facts.policy, systemPartUuid: undefined, dataPartUuid: undefined }
  expect(() => checkFlashKernel(boot, facts)).not.toThrow()
  expect(() => checkFlashKernel({ ...boot, board: { ...facts.policy, boot: 'uefi' } }, facts)).toThrow('policy')
  expect(() => checkFlashKernel({ ...boot, systemPartUuid: '00000000-0000-4000-8000-000000000002' }, facts)).toThrow('UUID')
})
