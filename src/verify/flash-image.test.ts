import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flashRecord } from '../image/flash-image.ts'
import { parseFlashLayout } from '../image/flash-layout.ts'
import { checkFlashInputs } from './flash-image.ts'

const MIB = 1048576
const VENDOR = Buffer.alloc(MIB, 0x33)
const LAYOUT = parseFlashLayout(['# mica flash layout v1', `flash\tnand\t262144\t2048\t2048\t2048\t${32 * MIB}`, `mtd\tu-boot\tloader\t0\t${MIB}\tloader`,
  `mtd\tvendor\tfixed\t${MIB}\t${MIB}\tinput:MICA_DEMO_VENDOR:${createHash('sha256').update(VENDOR).digest('hex')}`, `mtd\tubi\tubi\t${2 * MIB}\t${30 * MIB}\t-`,
  'volume\tsystem\t24', 'volume\tdata\t24', 'reserve\tsystem\t1', 'reserve\tdata\t1', 'raw\t4', ''].join('\n'), 'demo')
const dir = mkdtempSync(join(tmpdir(), 'verify-flash-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const image = (vendor: Buffer) => {
  const flash = Buffer.alloc(32 * MIB, 0xff)
  vendor.copy(flash, MIB)
  return flash
}

test('a local build input region is whole of its recorded sha256, and the record beside the image is the layout\'s', () => {
  const record = join(dir, 'flash.json')
  expect(checkFlashInputs(LAYOUT, image(VENDOR), record)).toBe(`, vendor the local build input MICA_DEMO_VENDOR (${createHash('sha256').update(VENDOR).digest('hex').slice(0, 12)})`)
  writeFileSync(record, JSON.stringify(flashRecord(LAYOUT)))
  expect(checkFlashInputs(LAYOUT, image(VENDOR), record)).toEndWith(', flash.json its record (4 raw blocks)')
})

test('refused: another region content, or a record of another layout', () => {
  const other = Buffer.from(VENDOR)
  other[MIB - 1] = 0x34
  expect(() => checkFlashInputs(LAYOUT, image(other), join(dir, 'none.json'))).toThrow('is not the local build input MICA_DEMO_VENDOR')
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...flashRecord(LAYOUT), rawBlocks: 0 }))
  expect(() => checkFlashInputs(LAYOUT, image(VENDOR), join(dir, 'other.json'))).toThrow('is not the flash record of demo')
})
