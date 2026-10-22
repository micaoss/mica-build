import { expect, test } from 'bun:test'
import { flashInputs, lebs, objectVolume, parseFlashLayout, storageOf, ubiCapacity, ubiGeometry, ubiRegion } from './flash-layout.ts'

const KIB = 1024, MIB = 1048576
// Two 64 MiB NOR banks: the loader and an erased rest in the first, UBI over all of the second.
const NOR = ['# mica flash layout v1',
  `flash\tnor\t${256 * KIB}\t1\t1\t64\t${128 * MIB}`,
  `mtd\tu-boot\tloader\t0\t${MIB}\tloader`,
  `mtd\tboot-rest\tfixed\t${MIB}\t${63 * MIB}\t-`,
  `mtd\tubi\tubi\t${64 * MIB}\t${64 * MIB}\t-`,
  'volume\tsystem\t24', 'volume\tdata\t24', 'reserve\tsystem\t4', 'reserve\tdata\t4', ''].join('\n')
// A 128 MiB SPI-NAND: 128 KiB erase blocks, 2 KiB pages, VID header at the second page.
const NAND = ['# mica flash layout v1',
  `flash\tnand\t${128 * KIB}\t2048\t2048\t2048\t${128 * MIB}`,
  `mtd\tspl\tloader\t0\t${MIB}\tloader`,
  `mtd\tenv\tfixed\t${MIB}\t${MIB}\tfile:env.bin`,
  `mtd\tubi\tubi\t${2 * MIB}\t${126 * MIB}\t-`,
  'volume\tsystem\t32', 'volume\tdata\t64', 'reserve\tsystem\t8', 'reserve\tdata\t8', ''].join('\n')
const parse = (text: string) => parseFlashLayout(text, 'demo')

test('a NOR layout: a LEB is the erase block less both headers, every PEB but UBI\'s four offered', () => {
  const layout = parse(NOR)
  expect(ubiRegion(layout)).toEqual({ name: 'ubi', role: 'ubi', offset: 64 * MIB, size: 64 * MIB, source: '-' })
  expect(ubiGeometry(layout)).toEqual({ leb: 262016, pebs: 256, available: 252 })
  expect(layout.declaredReserves).toEqual({ system: 4, data: 4 })
})

test('a NAND layout: the headers take two pages, and the bad-block reserve is sized by the whole chip', () => {
  // 1024 PEBs on the chip reserve 20, though the UBI partition has 1008 of them.
  expect(ubiGeometry(parse(NAND))).toEqual({ leb: 126976, pebs: 1008, available: 1008 - 4 - 20 })
})

test.each([
  ['a wrong first line', NOR.replace('# mica flash layout v1', '# mica layout v1'), 'the first line'],
  ['no flash row', NOR.replace(/^flash.*\n/m, ''), 'no flash row'],
  ['an unknown flash kind', NOR.replace('flash\tnor', 'flash\temmc'), 'neither nor nor nand'],
  ['a VID header inside the erase counter header', NOR.replace('\t1\t1\t64\t', '\t1\t1\t32\t'), 'VID header offset'],
  ['a gap between regions', NOR.replace(`boot-rest\tfixed\t${MIB}\t${63 * MIB}`, `boot-rest\tfixed\t${MIB}\t${62 * MIB}`), 'without gaps or overlap'],
  ['an unaligned region', NOR.replace(`u-boot\tloader\t0\t${MIB}`, `u-boot\tloader\t0\t${MIB + 4096}`), 'erase-block aligned'],
  ['no UBI region', NOR.replace('ubi\tubi\t', 'ubi\tfixed\t'), 'exactly one ubi region'],
  ['a UBI region with a source', NOR.replace(`${64 * MIB}\t${64 * MIB}\t-`, `${64 * MIB}\t${64 * MIB}\tfile:ubi.img`), 'UBI holds what the assembly writes'],
  ['a loader region of another source', NOR.replace(`${MIB}\tloader\n`, `${MIB}\tfile:u-boot.bin\n`), 'source is loader'],
  ['an MTD name out of form', NOR.replace('mtd\tboot-rest', 'mtd\tboot rest'), 'not an MTD name'],
  ['regions short of the flash', NOR.replace(`${128 * MIB}\n`, `${256 * MIB}\n`), 'the flash is'],
  ['no data volume', NOR.replace('volume\tdata\t24\n', ''), 'volume rows are both required'],
  ['a UBIFS volume below 24 LEBs', NOR.replace('volume\tsystem\t24', 'volume\tsystem\t23'), 'of at least 24'],
  ['no data reserve', NOR.replace('reserve\tdata\t4\n', ''), 'reserve rows are both required'],
  ['a reserve above 1 GiB', NOR.replace('reserve\tsystem\t4', 'reserve\tsystem\t2048'), 'above 1024'],
  ['fixed volumes beyond the partition', NOR.replace('volume\tdata\t24', 'volume\tdata\t240'), 'the UBI partition has 252'],
  ['a fixed source of no form', NAND.replace('file:env.bin', 'vendor.bin'), 'file:<path>, input:<VARIABLE>:<sha256> or -'],
  ['an input source without its sha256', NAND.replace('file:env.bin', 'input:MICA_ENV'), 'file:<path>, input:<VARIABLE>:<sha256> or -'],
  ['an input variable in lower case', NAND.replace('file:env.bin', `input:mica_env:${'a'.repeat(64)}`), 'file:<path>, input:<VARIABLE>:<sha256> or -'],
  ['an input variable outside MICA_', NAND.replace('file:env.bin', `input:VENDOR_FILE:${'a'.repeat(64)}`), 'file:<path>, input:<VARIABLE>:<sha256> or -'],
  ['raw blocks on NOR', NOR.replace('reserve\tdata\t4\n', 'reserve\tdata\t4\nraw\t2\n'), 'on NOR flash'],
  ['raw blocks into UBI', `${NAND}raw\t17\n`, 'inside the UBI region ubi'],
  ['two raw rows', `${NAND}raw\t2\nraw\t2\n`, 'a second raw row'],
  ['no raw blocks', `${NAND}raw\t0\n`, 'of at least 1'],
  ['a LEB smaller than a boot record copy', NOR.replace(`flash\tnor\t${256 * KIB}`, `flash\tnor\t${64 * KIB}`), 'below the 65536'],
])('refused: %s', (_what, text, message) => {
  expect(() => parse(text)).toThrow(message)
})

test('a fixed region may be a local build input, and the raw blocks are the leading ones up to UBI', () => {
  const sha = 'ab'.repeat(32)
  expect(parse(NAND).rawBlocks).toBe(0)
  expect(flashInputs(parse(NAND))).toEqual([])
  const layout = parse(`${NAND.replace('file:env.bin', `input:MICA_DEMO_ENV:${sha}`)}raw\t16\n`)
  expect(layout.rawBlocks).toBe(16)
  expect(flashInputs(layout)).toEqual([{ region: 'env', variable: 'MICA_DEMO_ENV', sha256: sha }])
})

test('the capacity rule counts whole LEBs: two deployments, the core set, one object being written and the reserve', () => {
  const layout = parse(NOR)
  expect(lebs(layout, 1)).toBe(1)
  expect(lebs(layout, 262016)).toBe(1)
  expect(lebs(layout, 262017)).toBe(2)
  // 50 fixed LEBs (24 + 24 + 2 records) and 17 of reserve (4 MiB); a deployment of 20 + 10 + 30 LEBs twice and
  // its largest object being written: 217 of 252. A 65-LEB core component is also the largest object: 317.
  const deployment = [20 * 262016, 10 * 262016, 30 * 262016]
  expect(ubiCapacity(layout, deployment, [])).toBeUndefined()
  expect(ubiCapacity(layout, deployment, [64 * 262016 + 1])).toContain('need 317 LEBs')
})

test('an object\'s volume is its kind and id, and its `p.` name fits UBI\'s limit', () => {
  const id = 'a'.repeat(64)
  expect(objectVolume('k', id)).toBe(`k-${id}`)
  expect(() => objectVolume('r', 'A'.repeat(64))).toThrow('not a component id')
})

test('BOARD_STORAGE: gpt unless the board says ubi', () => {
  expect(storageOf(new Map())).toBe('gpt')
  expect(storageOf(new Map([['BOARD_STORAGE', 'ubi']]))).toBe('ubi')
  expect(() => storageOf(new Map([['BOARD_STORAGE', 'nand']]))).toThrow('neither gpt nor ubi')
})
