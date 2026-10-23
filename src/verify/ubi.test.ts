// The UBI and UBIFS readers over a flash image assembled with the real tools (src/image/flash-image.ts in the
// MTD_UTILS toolbox): what they read back is what the assembly wrote, and a byte out of place is refused.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFitEnvironment } from '../image/fit-environment.ts'
import { assembleFlash, type FlashContent } from '../image/flash-image.ts'
import { parseFlashLayout } from '../image/flash-layout.ts'
import { makeWorkDir } from '../image/paths.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../image/testing.ts'
import { Toolbox } from '../image/toolbox.ts'
import { MTD_UTILS } from '../image/toolsets.ts'
import { dynamicBytes, readUbi, staticBytes } from './ubi.ts'
import { openUbifs } from './ubifs.ts'

const MIB = 1048576, PEB = 262144, LEB = 262016
const LAYOUT = parseFlashLayout(['# mica flash layout v1', `flash\tnor\t${PEB}\t1\t1\t64\t${32 * MIB}`, `mtd\tu-boot\tloader\t0\t${MIB}\tloader`,
  `mtd\tubi\tubi\t${MIB}\t${31 * MIB}\t-`, 'volume\tsystem\t24', 'volume\tdata\t24', 'reserve\tsystem\t1', 'reserve\tdata\t1', ''].join('\n'), 'demo')
const KERNEL = 'a'.repeat(64), DEPLOYMENT = 'b'.repeat(64), CORE = 'c'.repeat(64)
// A file of three UBIFS blocks, the last partial, and bytes no other file has.
const LARGE = Buffer.from(Array.from({ length: 10000 }, (_, i) => (i * 7 + 3) % 251))
const BOOT = Buffer.alloc(700000, 0x42), CORE_IMAGE = Buffer.alloc(5000, 0x43)

let tb: Toolbox
let work = '', ubi: Buffer
const records = [{ id: DEPLOYMENT, kernelId: KERNEL, generation: 2, tries: 3 }]
beforeAll(async () => {
  work = makeWorkDir('ubi-read')
  tb = await Toolbox.open(MTD_UTILS, { mounts: [work], cwd: work })
  writeFileSync(join(work, 'u-boot.bin'), Buffer.alloc(300000, 0x5a))
  writeFileSync(join(work, 'boot.itb'), BOOT)
  writeFileSync(join(work, 'core.img'), CORE_IMAGE)
  const tree = join(work, 'system')
  mkdirSync(join(tree, 'deployments'), { recursive: true })
  mkdirSync(join(tree, 'roots', DEPLOYMENT), { recursive: true })
  writeFileSync(join(tree, 'deployments', `${DEPLOYMENT}.json`), '{"deployment":1}')
  writeFileSync(join(tree, 'roots', DEPLOYMENT, 'large.bin'), LARGE)
  writeFileSync(join(tree, 'roots', DEPLOYMENT, 'empty'), '')
  const content: FlashContent = { loader: join(work, 'u-boot.bin'), system: tree, records,
    objects: [{ volume: `k-${KERNEL}`, file: join(work, 'boot.itb') }, { volume: `c-${CORE}`, file: join(work, 'core.img') }] }
  mkdirSync(join(work, 'w'))
  await assembleFlash(tb, LAYOUT, work, content, join(work, 'w'), join(work, 'flash.img'))
  ubi = readFileSync(join(work, 'flash.img')).subarray(MIB)
}, OPEN_TIMEOUT_MS + TOOL_TIMEOUT_MS * 4)
afterAll(async () => {
  await tb?.close()
  if (work !== '') rmSync(work, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

const mutated = (at: number, value?: number) => {
  const copy = Buffer.from(ubi)
  copy[at] = value ?? copy[at]! ^ 0x01
  return copy
}

test('the UBI device reads back as assembled: the fixed volumes in order, each object at exactly its bytes', () => {
  const dev = readUbi(ubi, PEB)
  expect(dev.leb).toBe(LEB)
  expect([...dev.volumes.values()].map(v => [v.id, v.name, v.type, v.reservedPebs])).toEqual([
    [0, 'records-a', 'dynamic', 1], [1, 'records-b', 'dynamic', 1], [2, 'system', 'dynamic', 24], [3, 'data', 'dynamic', 24],
    [4, `k-${KERNEL}`, 'static', 3], [5, `c-${CORE}`, 'static', 1]])
  expect(staticBytes(dev.volumes.get(`k-${KERNEL}`)!).equals(BOOT)).toBe(true)
  expect(staticBytes(dev.volumes.get(`c-${CORE}`)!).equals(CORE_IMAGE)).toBe(true)
  for (const [i, name] of ['records-a', 'records-b'].entries()) {
    const expected = encodeFitEnvironment(records, i), leb0 = dev.volumes.get(name)!.lebs.get(0)!
    expect(leb0.subarray(0, expected.length).equals(expected)).toBe(true)
  }
  expect(dev.volumes.get('data')!.lebs.size).toBe(0)
  expect(() => staticBytes(dev.volumes.get('system')!)).toThrow('not a static volume')
})

test('SYSTEM\'s UBIFS reads back as staged: its directories, a file over several blocks and an empty one', () => {
  const dev = readUbi(ubi, PEB)
  const fs = openUbifs(dynamicBytes(dev.volumes.get('system')!, dev.leb), dev.leb, 1)
  expect(fs.list('/').map(e => [e.name, e.type])).toEqual([['deployments', 'directory'], ['roots', 'directory']])
  expect(fs.list(`/roots/${DEPLOYMENT}`).map(e => e.name)).toEqual(['empty', 'large.bin'])
  expect(fs.read(`/deployments/${DEPLOYMENT}.json`).toString()).toBe('{"deployment":1}')
  expect(fs.read(`/roots/${DEPLOYMENT}/large.bin`).equals(LARGE)).toBe(true)
  expect(fs.read(`/roots/${DEPLOYMENT}/empty`).length).toBe(0)
  expect(() => fs.read('/roots')).toThrow('not a regular file')
  expect(() => fs.list(`/deployments/${DEPLOYMENT}.json`)).toThrow('not a directory')
  expect(() => fs.read('/kernels/x')).toThrow('no such entry')
})

test('a wrong erase counter header, VID header or static LEB is refused', () => {
  expect(() => readUbi(mutated(8), PEB)).toThrow('PEB 0: the erase counter header\'s CRC is wrong')
  expect(() => readUbi(mutated(64 + 8), PEB)).toThrow('PEB 0: the VID header\'s CRC is wrong')
  const boot = ubi.indexOf(Buffer.alloc(4096, 0x42))
  expect(() => readUbi(mutated(boot + 100), PEB)).toThrow(`the data CRC of volume 4 LEB 0 is wrong`)
  expect(() => readUbi(ubi.subarray(0, ubi.length - 1), PEB)).toThrow('not whole PEBs')
})

test('a LEB two PEBs claim is refused: a factory image writes each LEB once', () => {
  const copy = Buffer.from(ubi), boot = Math.floor(ubi.indexOf(Buffer.alloc(4096, 0x42)) / PEB) * PEB
  const last = copy.length - PEB
  expect(copy.subarray(last).every(b => b === 0xff)).toBe(true)
  copy.copy(copy, last, boot, boot + PEB)
  expect(() => readUbi(copy, PEB)).toThrow('a second PEB holds volume 4 LEB 0')
})

test('a UBIFS node whose bytes changed is refused', () => {
  const dev = readUbi(ubi, PEB), system = dynamicBytes(dev.volumes.get('system')!, dev.leb)
  const at = system.indexOf(LARGE.subarray(0, 64))
  expect(at).toBeGreaterThan(0)
  const copy = Buffer.from(system)
  copy[at + 10] = copy[at + 10]! ^ 0x01
  expect(() => openUbifs(copy, dev.leb, 1)).toThrow('the node\'s CRC is wrong')
  expect(() => openUbifs(system.subarray(1), dev.leb, 1)).toThrow('not whole LEBs')
})

test('a compressed UBIFS is refused rather than decompressed: SYSTEM is written uncompressed', async () => {
  const out = join(work, 'lzo.ubifs')
  await tb.must(['mkfs.ubifs', '-m', '1', '-e', String(LEB), '-c', '24', '-x', 'lzo', '-r', join(work, 'system'), out])
  expect(() => openUbifs(readFileSync(out), LEB, 1)).toThrow('the default compressor is 1')
}, TOOL_TIMEOUT_MS)

test('a NAND UBIFS reads back: each LEB padded out to its 2048-byte page by a padding node, the rest erased', async () => {
  const out = join(work, 'nand.ubifs'), nandLeb = 131072 - 2 * 2048
  await tb.must(['mkfs.ubifs', '-m', '2048', '-e', String(nandLeb), '-c', '24', '-x', 'none', '-r', join(work, 'system'), out])
  const nand = readFileSync(out)
  // The master node (512 bytes), then a padding node of 28 bytes and its zero bytes to the page's end.
  expect([nand.readUInt32LE(nandLeb + 16), nand[nandLeb + 512 + 20], nand.readUInt32LE(nandLeb + 512 + 24)]).toEqual([512, 5, 2048 - 512 - 28])
  const fs = openUbifs(nand, nandLeb, 2048)
  expect(fs.read(`/roots/${DEPLOYMENT}/large.bin`).equals(LARGE)).toBe(true)
  expect(() => openUbifs(nand, nandLeb, 1)).toThrow('the superblock\'s min I/O is 2048, the flash\'s 8')
  const at = (offset: number) => {
    const copy = Buffer.from(nand)
    copy[offset] = copy[offset]! ^ 0x01
    return copy
  }
  expect(() => openUbifs(at(nandLeb + 2000), nandLeb, 2048)).toThrow('LEB 1 holds more than one master node')
  expect(() => openUbifs(at(nandLeb + 2048), nandLeb, 2048)).toThrow('LEB 1 holds more than one master node')
  expect(() => openUbifs(at(nandLeb + 512 + 26), nandLeb, 2048)).toThrow('a padding node at LEB 1:512: the node\'s CRC is wrong')
  expect(() => openUbifs(at(3 * nandLeb + 1000), nandLeb, 2048)).toThrow('the log holds more than its commit start node')
}, TOOL_TIMEOUT_MS)
