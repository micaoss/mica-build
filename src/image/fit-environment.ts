// The boot record copies of a uboot-fit board, as U-Boot's redundant environment encodes them; placed on the disk
// by the records-a and records-b regions of its layout.tsv (src/image/regions.ts).

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
