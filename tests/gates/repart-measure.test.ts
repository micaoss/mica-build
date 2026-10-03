import { expect, test } from 'bun:test'
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadLayout } from '../../src/image/file-layout.ts'
import { patternProtectedRanges } from './repart-loader.ts'
import { measure, compareGrowth } from '../suites/repart/measure.ts'

const root = resolve(import.meta.dir, '../..')

test('growth measurement protects every vendor slot and gap, allows only DATA expansion', () => {
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const dir = mkdtempSync(join(root, 'tmp/repart-measure.'))
  try {
    const file = join(dir, 'disk.img'), bytes = Buffer.alloc(4 * 1024 * 1024)
    const header = bytes.subarray(512, 1024)
    header.write('EFI PART'); header.writeBigUInt64LE(2n, 72); header.writeUInt32LE(128, 80); header.writeUInt32LE(128, 84)
    const part = (number: number, first: number, last: number, label: string) => {
      const entry = bytes.subarray(1024 + (number - 1) * 128, 1024 + number * 128)
      entry[0] = 1; entry[16] = number; entry.writeBigUInt64LE(BigInt(first), 32); entry.writeBigUInt64LE(BigInt(last), 40); entry.write(label, 56, 'utf16le')
    }
    part(4, 64, 95, 'bootloader_a'); part(5, 128, 159, 'reserved'); part(6, 192, 223, 'env')
    part(1, 256, 287, 'firmware'); part(2, 288, 319, 'system'); part(3, 320, 351, 'data')
    bytes.fill(0x5a, 34 * 512, 64 * 512); bytes.fill(0xa5, 64 * 512, 96 * 512)
    writeFileSync(file, bytes)
    const before = measure(file, 3)
    part(3, 320, 4095, 'data'); writeFileSync(file, bytes)
    expect(() => compareGrowth(measure(file, 3), before, 3, 1)).not.toThrow()
    bytes[100 * 512] = 9; writeFileSync(file, bytes)
    expect(() => compareGrowth(measure(file, 3), before, 3, 1)).toThrow('gap')
    bytes[100 * 512] = 0; bytes[200 * 512] = 7; writeFileSync(file, bytes)
    expect(() => compareGrowth(measure(file, 3), before, 3, 1)).toThrow('partition')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const selector of ['', 'emmc']) {
  test(`growth fixture seeds protected ranges for ${selector || 'default'} discard policy`, () => {
    const boardLayout = loadLayout(join(root, 'boards/s905x5m'), selector)
    const layout = { ...boardLayout, sizeSectors: 512, partitions: boardLayout.partitions.map((p, index) => ({ ...p, startSector: 64 + index * 64, sizeSectors: 32 })) }
    const dir = mkdtempSync(join(root, 'tmp/repart-pattern.'))
    try {
      const file = join(dir, 'disk.img')
      writeFileSync(file, Buffer.alloc(34 * 512, 0x37))
      truncateSync(file, layout.sizeSectors * 512)
      const disk = openSync(file, 'r+')
      try {
        for (const p of layout.partitions.filter(p => p.role !== 'preserved')) writeSync(disk, Buffer.alloc(512, 0x37), 0, 512, p.startSector * 512)
        patternProtectedRanges(file, layout)
        const byte = (sector: number) => { const b = Buffer.alloc(1); readSync(disk, b, 0, 1, sector * 512); return b[0] }
        expect(byte(0)).toBe(0x37)
        let end = 34
        for (const p of layout.partitions) {
          if (p.startSector > end) {
            expect(byte(end)).toBe(selector ? 0xa5 : 0)
            expect(byte(p.startSector - 1)).toBe(selector ? 0xa5 : 0)
          }
          expect(byte(p.startSector)).toBe(p.role === 'preserved' ? 0xa5 : 0x37)
          if (p.role === 'preserved') expect(byte(p.startSector + p.sizeSectors - 1)).toBe(0xa5)
          end = p.startSector + p.sizeSectors
        }
      }
      finally { closeSync(disk) }
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
