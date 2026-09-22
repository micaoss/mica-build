// Inspect the assembled cx3576 medium independently of the image producer.
//
//   bun tests/suites/lifecycle-uboot-fit/image.ts <work directory>
//
// <work>/image/disk.img is the medium, <work>/firmware/u-boot-rockchip.bin the loader it must start with,
// <work>/factory-records.json the signed manifests whose boot records the two U-Boot environments carry, and
// <work>/image/{system,data}.img the filesystems. Every check is an assertion; the last line is the pass
// marker. The port of image.py (deleted 2026-09-22), check for check.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

function assert(condition: unknown, message = 'AssertionError'): asserts condition {
  if (!condition) throw new Error(message)
}

function readAt(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const out = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const n = readSync(fd, out, done, length - done, offset + done)
      if (n === 0) return out.subarray(0, done)
      done += n
    }
    return out
  }
  finally { closeSync(fd) }
}

/** json.dumps(value, sort_keys=True, separators=(',', ':')) for the manifest values the records hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return '{' + Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

const work = Bun.argv[2]!
const disk = join(work, 'image/disk.img')
const header = readAt(disk, 512, 92)
assert(header.subarray(0, 8).equals(Buffer.from('EFI PART')))
const headerChecksum = header.readUInt32LE(16)
assert(crc32(Buffer.concat([header.subarray(0, 16), Buffer.alloc(4), header.subarray(20)])) === headerChecksum)
const tableLba = Number(header.readBigUInt64LE(72)), count = header.readUInt32LE(80), size = header.readUInt32LE(84), tableChecksum = header.readUInt32LE(88)
const table = readAt(disk, tableLba * 512, count * size)
assert(crc32(table) === tableChecksum)
const entries: Buffer[] = []
for (let i = 0; i < table.length; i += size) if (table.subarray(i, i + 16).some(b => b !== 0)) entries.push(table.subarray(i, i + size))
assert(entries.length === 3)
const expected: [string, number, number][] = [['firmware', 64, 36863], ['system', 36864, 2134015], ['data', 2134016, 2658303]]
entries.forEach((entry, i) => {
  const [name, first, last] = expected[i]!
  assert(Number(entry.readBigUInt64LE(32)) === first && Number(entry.readBigUInt64LE(40)) === last)
  assert(entry.subarray(56, 128).toString('utf16le').replace(/\0+$/, '') === name)
})
const firmware = Buffer.from(readAt(disk, 32768, 18 * 1048576 - 32768))

const loader = readFileSync(join(work, 'firmware/u-boot-rockchip.bin'))
assert(loader.length <= 16744448 && firmware.subarray(0, loader.length).equals(loader))
const records = JSON.parse(readFileSync(join(work, 'factory-records.json'), 'utf8')) as { envelope: string }[]
const manifests = records.map(r => JSON.parse(Buffer.from((JSON.parse(r.envelope) as { payload: string }).payload, 'base64').toString()) as { generation: number, kernel: { id: string } })
manifests.sort((a, b) => b.generation - a.generation)
const expectedRecords = 'v1|' + manifests.map(value => `${createHash('sha256').update(canonical(value)).digest('hex')},${value.kernel.id},${value.generation},3`).join(';')
for (const [flag, absolute] of [[0, 16 * 1048576], [1, 17 * 1048576]] as [number, number][]) {
  const offset = absolute - 32768
  const environment = firmware.subarray(offset, offset + 65536)
  assert(environment[4] === flag)
  assert(environment.readUInt32LE(0) === crc32(environment.subarray(5)))
  const payload = Buffer.concat([Buffer.from('mica_entries=' + expectedRecords), Buffer.from([0, 0])])
  assert(environment.subarray(5).equals(Buffer.concat([payload, Buffer.alloc(65531 - payload.length)])))
  firmware.fill(0, offset, offset + 65536)
}
assert(!firmware.subarray(loader.length).some(b => b !== 0), 'unexpected data in protected firmware slack')

for (const name of ['system', 'data']) {
  const superblock = readAt(join(work, `image/${name}.img`), 1024, 1024)
  assert(superblock.readUInt16LE(56) === 0xEF53)
  const compat = superblock.readUInt32LE(92), incompat = superblock.readUInt32LE(96), ro = superblock.readUInt32LE(100)
  assert(!(compat & 0x1000) && !(incompat & 0x2000))
  assert(compat & 4, 'journal is required')
  if (name === 'data') assert((ro & 0x100) && (ro & 0x2000), 'project quota is required')
}
console.log('CX3576_GPT_LOADER_COUNTERS_FILESYSTEM_PASS')
