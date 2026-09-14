import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFitEnvironment, writeFirmwareRegion } from './fit-environment.ts'
import { parseFileLayout } from './file-layout.ts'
import { REPO_ROOT } from './paths.ts'

const records = [
  { id: 'a'.repeat(64), kernelId: 'c'.repeat(64), generation: 2, tries: 3 },
  { id: 'b'.repeat(64), kernelId: 'c'.repeat(64), generation: 1, tries: null },
]
test('S905X5M factory records do not place a bootloader in vendor-owned user storage', () => {
  const directory = mkdtempSync(join(REPO_ROOT, '.tmp/s905-region-'))
  try {
    const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/s905x5m/board.env'), 'utf8'))
    const loader = join(directory, 'external-boot0.bin'), output = join(directory, 'firmware.img')
    writeFileSync(loader, Buffer.alloc(4096, 42))
    writeFirmwareRegion(layout, loader, records, output)
    const bytes = readFileSync(output)
    expect(bytes.length).toBe(128 * 1048576 - 32768)
    for (const [slot, offset] of layout.firmware!.envOffsets.entries()) {
      expect(bytes.subarray(offset - 32768, offset - 32768 + 65536)).toEqual(encodeFitEnvironment(records, slot))
      bytes.fill(0, offset - 32768, offset - 32768 + 65536)
    }
    expect(bytes.every(byte => byte === 0)).toBe(true)
  } finally { rmSync(directory, { recursive: true }) }
})
test('factory environment matches native firmware and the independent CRC fixture', () => {
  const bytes = encodeFitEnvironment(records, 7)
  expect(bytes.length).toBe(65536)
  expect(bytes.readUInt32LE(0)).toBe(0xc2800412)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('91f6bfd298a72e948eff9b04908c9c01487e102bc5a806a6827ba4e4954554a3')
  for (const bad of [[], [{ ...records[0]!, id: 'd'.repeat(64), generation: 3 }, ...records], [...records, ...records], records.toReversed(),
    [{ ...records[0]!, tries: 4 }], [{ ...records[0]!, generation: 0 }],
    [{ ...records[0]!, id: 'A'.repeat(64) }], [{ ...records[0]!, generation: Number.MAX_SAFE_INTEGER + 1 }]]) {
    expect(() => encodeFitEnvironment(bad, 0)).toThrow()
  }
})

test('FIRMWARE assembly places only loader and two counters inside protected ranges', () => {
  const directory = mkdtempSync(join(REPO_ROOT, '.tmp/fit-region-'))
  try {
    const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'))
    const loader = join(directory, 'loader.bin'), output = join(directory, 'firmware.img')
    const payload = Buffer.alloc(4096, 42)
    payload.write('RKNS')
    writeFileSync(loader, payload)
    writeFirmwareRegion(layout, loader, records, output)
    const bytes = readFileSync(output)
    expect(bytes.length).toBe(18 * 1048576 - 32768)
    expect(bytes.subarray(0, payload.length)).toEqual(payload)
    for (const [slot, offset] of layout.firmware!.envOffsets.entries()) {
      expect(bytes.subarray(offset - 32768, offset - 32768 + 65536)).toEqual(encodeFitEnvironment(records, slot))
      bytes.fill(0, offset - 32768, offset - 32768 + 65536)
    }
    expect(bytes.subarray(payload.length).every(byte => byte === 0)).toBe(true)
    expect(() => writeFirmwareRegion(layout, loader, records, output)).toThrow()
    writeFileSync(loader, 'not a loader')
    expect(() => writeFirmwareRegion(layout, loader, records, join(directory, 'bad.img'))).toThrow()
  } finally { rmSync(directory, { recursive: true }) }
})
