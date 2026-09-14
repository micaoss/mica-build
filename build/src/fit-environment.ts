import { loadBoardFacts } from './board-facts.ts'
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import type { FileLayout } from './file-layout.ts'

export interface FitBootRecord { id: string, kernelId: string, generation: number, tries: number | null }

/** Raw U-Boot redundant-environment encoding; only mica_entries is accepted. */
export function encodeFitEnvironment(records: FitBootRecord[], flag: number): Buffer<ArrayBuffer> {
  const id = /^[0-9a-f]{64}$/
  if (!records.length || records.length > 2 || !Number.isInteger(flag) || flag < 0 || flag > 255) throw new Error('Invalid environment bounds')
  for (const [i, record] of records.entries()) {
    if (!id.test(record.id) || !id.test(record.kernelId) || !Number.isSafeInteger(record.generation) || record.generation <= 0
      || (record.tries !== null && (!Number.isInteger(record.tries) || record.tries < 0 || record.tries > 3))
      || records.slice(0, i).some(previous => previous.id === record.id || previous.generation <= record.generation)) throw new Error('Invalid boot record')
  }
  const value = `v1|${records.map(record => `${record.id},${record.kernelId},${record.generation},${record.tries ?? '-'}`).join(';')}`
  if (value.length > 512) throw new Error('Boot records exceed environment bound')
  const bytes = Buffer.alloc(65536)
  bytes[4] = flag
  bytes.write(`mica_entries=${value}`, 5, 'ascii')
  let crc = 0xffffffff
  for (const byte of bytes.subarray(5)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  bytes.writeUInt32LE((~crc) >>> 0, 0)
  return bytes
}

export function writeFirmwareRegion(layout: FileLayout, loader: string, records: FitBootRecord[], output: string): void {
  const ranges = layout.firmware, partition = layout.partitions[0]!
  if (!ranges || layout.backend !== 'uboot-fit') throw new Error('Expected supported FIT firmware geometry')
  if (existsSync(output)) throw new Error('Firmware output exists')
  const fw = loadBoardFacts(layout.board).firmware
  if (fw.format === 'rockchip-loader') {
    const size = statSync(loader).size
    if (!ranges.loaderSizeSectors || size <= fw.magic.length || size > ranges.loaderSizeSectors * 512) throw new Error('Invalid firmware size')
    if (readFileSync(loader).subarray(0, fw.magic.length).toString('ascii') !== fw.magic) throw new Error('Invalid Rockchip loader header')
    copyFileSync(loader, output)
  } else {
    // An amlogic-boot0 payload executes from eMMC boot0, outside the system image.
    writeFileSync(output, '', { flag: 'wx' })
  }
  const copies = [encodeFitEnvironment(records, 0), encodeFitEnvironment(records, 1)]
  truncateSync(output, partition.sizeSectors * 512)
  const fd = openSync(output, 'r+')
  try {
    for (const [slot, offset] of ranges.envOffsets.entries()) {
      const copy = copies[slot]!
      if (writeSync(fd, copy, 0, copy.length, offset - partition.startSector * 512) !== copy.length) throw new Error('Short environment write')
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
