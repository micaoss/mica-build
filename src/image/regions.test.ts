import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardFactsFrom } from './board-facts.ts'
import { encodeFitEnvironment } from './fit-environment.ts'
import { loadLayout, parseLayout } from './file-layout.ts'
import { REPO_ROOT } from './paths.ts'
import { checkLoaderPlacement, loaderBesideImage, writeRawPartition } from './regions.ts'

const records = [
  { id: 'a'.repeat(64), kernelId: 'c'.repeat(64), generation: 2, tries: 3 },
  { id: 'b'.repeat(64), kernelId: 'c'.repeat(64), generation: 1, tries: null },
]
const board = (name: string) => ({ layout: loadLayout(join(REPO_ROOT, 'boards', name)), facts: boardFactsFrom(join(REPO_ROOT, 'boards', name, 'board.env')) })

function scratch<T>(f: (dir: string) => T): T {
  mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(REPO_ROOT, '.tmp/regions-'))
  try { return f(dir) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

test('the s905x5m firmware partition holds the two record copies and nothing else: its loader is not on the disk', () => scratch((dir) => {
  const { layout, facts } = board('s905x5m')
  const loader = join(dir, 'external-boot0.bin'), output = join(dir, 'firmware.img')
  writeFileSync(loader, Buffer.alloc(4096, 42))
  writeRawPartition(layout, layout.partitions[0]!, { facts, loader, records, bundle: dir }, output)
  const bytes = readFileSync(output)
  expect(bytes.length).toBe(128 * 1048576 - 32768)
  for (const [slot, r] of layout.regions.filter(x => x.source.startsWith('records-')).entries()) {
    expect(bytes.subarray(r.offset, r.offset + 65536)).toEqual(encodeFitEnvironment(records, slot))
    bytes.fill(0, r.offset, r.offset + 65536)
  }
  expect(bytes.every(byte => byte === 0)).toBe(true)
  expect(loaderBesideImage(layout)).toBe(true)
}))

test('the cx3576 firmware partition places only the loader and the two record copies, in their regions', () => scratch((dir) => {
  const { layout, facts } = board('cx3576')
  const loader = join(dir, 'loader.bin'), output = join(dir, 'firmware.img')
  const payload = Buffer.alloc(4096, 42)
  payload.write('RKNS')
  writeFileSync(loader, payload)
  writeRawPartition(layout, layout.partitions[0]!, { facts, loader, records, bundle: dir }, output)
  const bytes = readFileSync(output)
  expect(bytes.length).toBe(18 * 1048576 - 32768)
  expect(bytes.subarray(0, payload.length)).toEqual(payload)
  for (const [slot, offset] of [16 * 1048576 - 32768, 17 * 1048576 - 32768].entries()) {
    expect(bytes.subarray(offset, offset + 65536)).toEqual(encodeFitEnvironment(records, slot))
    bytes.fill(0, offset, offset + 65536)
  }
  expect(bytes.subarray(payload.length).every(byte => byte === 0)).toBe(true)
  expect(loaderBesideImage(layout)).toBe(false)
  expect(() => writeRawPartition(layout, layout.partitions[0]!, { facts, loader, records, bundle: dir }, output)).toThrow('exists')
  writeFileSync(loader, 'not a loader')
  expect(() => writeRawPartition(layout, layout.partitions[0]!, { facts, loader, records, bundle: dir }, join(dir, 'bad.img'))).toThrow('Invalid loader header')
  writeFileSync(loader, Buffer.concat([Buffer.from('RKNS'), Buffer.alloc(16744448)]))
  expect(() => writeRawPartition(layout, layout.partitions[0]!, { facts, loader, records, bundle: dir }, join(dir, 'big.img'))).toThrow('Invalid firmware size')
}))

test('a file region places the board directory\'s file, bounded by the region', () => scratch((dir) => {
  const text = `# mica layout v1
disk\t5AC35760-0555-4000-8000-000000000000\t512\t2048
part\t1\tvendor\traw\t2048\t16\t8DA63339-0007-60C0-C436-083AC8230908\t5AC35760-0555-4000-8000-000000000001\t-
region\tvendor\tblob\t512\t1024\tfile:vendor/blob.bin
part\t2\tesp\tesp\t4096\t2048\tC12A7328-F81F-11D2-BA4B-00A0C93EC93B\t5AC35760-0555-4000-8000-000000000002\t0555A001
part\t3\tsystem\tsystem\t6144\t2048\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5AC35760-0555-4000-8000-000000000003\t5ac35760-0555-4000-8000-000000000103
part\t4\tdata\tdata\t8192\t2048\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5AC35760-0555-4000-8000-000000000004\t5ac35760-0555-4000-8000-000000000104
`
  const layout = parseLayout(text, 'fifth', 'systemd-boot')
  const { facts } = board('uefi-x64')
  mkdirSync(join(dir, 'vendor'))
  writeFileSync(join(dir, 'vendor/blob.bin'), 'vendor bytes')
  writeRawPartition(layout, layout.partitions[0]!, { facts, loader: '', records, bundle: dir }, join(dir, 'vendor.img'))
  const bytes = readFileSync(join(dir, 'vendor.img'))
  expect(bytes.length).toBe(16 * 512)
  expect(bytes.subarray(512, 512 + 12).toString()).toBe('vendor bytes')
  expect(Buffer.concat([bytes.subarray(0, 512), bytes.subarray(524)]).every(b => b === 0)).toBe(true)
  writeFileSync(join(dir, 'vendor/blob.bin'), Buffer.alloc(1025))
  expect(() => writeRawPartition(layout, layout.partitions[0]!, { facts, loader: '', records, bundle: dir }, join(dir, 'over.img'))).toThrow('more than the region\'s 1024')
}))

test('the loader region sits exactly where the firmware facts place the loader, or neither declares one', () => {
  for (const name of ['uefi-x64', 'uefi-arm64', 'cx3576', 's905x5m']) {
    const { layout, facts } = board(name)
    expect(() => checkLoaderPlacement(layout, facts)).not.toThrow()
  }
  const cx = board('cx3576'), s905 = board('s905x5m')
  const moved = { ...cx.layout, regions: cx.layout.regions.map(r => (r.source === 'loader' ? { ...r, offset: 512 } : r)) }
  expect(() => checkLoaderPlacement(moved, cx.facts)).toThrow('is not where its firmware facts place the loader')
  const without = { ...cx.layout, regions: cx.layout.regions.filter(r => r.source !== 'loader') }
  expect(() => checkLoaderPlacement(without, cx.facts)).toThrow('has no loader region')
  const onDisk = { ...s905.layout, regions: [...s905.layout.regions, { partition: 'firmware', name: 'loader', offset: 0, size: 4193792, source: 'loader' }] }
  expect(() => checkLoaderPlacement(onDisk, s905.facts)).toThrow('its firmware facts place no loader on the disk')
})
