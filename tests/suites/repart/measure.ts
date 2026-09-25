// Measure GPT identities and all protected partition bytes around DATA growth.
//
//   bun /harness/measure.ts <disk.img> <record.json> [<before.json>]
//
// Writes the partition table as a JSON record (the first two partitions with the sha256 of every byte they
// cover); with a third argument, compares against the record taken before DATA grew and refuses any change
// outside DATA's last LBA. Runs in the lab image (tests/suites/repart/inner.sh). The port of measure.py
// (deleted 2026-09-22), check for check.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'

type Record_ = { number: number, first: number, last: number, type: string, guid: string, attributes: bigint, label: string, sha256?: string }

function assert(condition: unknown, message = 'AssertionError'): asserts condition {
  if (!condition) throw new Error(message)
}

/** A GUID as uuid.UUID(bytes_le=...) prints it. */
function guidLE(b: Buffer): string {
  const hex = (x: Buffer): string => x.toString('hex')
  return `${hex(Buffer.from(b.subarray(0, 4)).reverse())}-${hex(Buffer.from(b.subarray(4, 6)).reverse())}-${hex(Buffer.from(b.subarray(6, 8)).reverse())}-${hex(b.subarray(8, 10))}-${hex(b.subarray(10, 16))}`
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const out = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = readSync(fd, out, done, length - done, offset + done)
    assert(n > 0)
    done += n
  }
  return out
}

const [disk, recordPath, beforePath] = Bun.argv.slice(2) as [string, string, string | undefined]
const fd = openSync(disk, 'r')
const header = readAt(fd, 512, 512)
assert(header.subarray(0, 8).equals(Buffer.from('EFI PART')))
const entryLba = Number(header.readBigUInt64LE(72)), count = header.readUInt32LE(80), size = header.readUInt32LE(84)
assert(count === 128 && size === 128)
const entries = readAt(fd, entryLba * 512, count * size)
const records: Record_[] = []
for (let index = 0; index < count; index++) {
  const entry = entries.subarray(index * size, (index + 1) * size)
  if (entry.subarray(0, 16).equals(Buffer.alloc(16))) continue
  const first = Number(entry.readBigUInt64LE(32)), last = Number(entry.readBigUInt64LE(40)), attributes = entry.readBigUInt64LE(48)
  const record: Record_ = { number: index + 1, first, last, type: guidLE(entry.subarray(0, 16)), guid: guidLE(entry.subarray(16, 32)),
    attributes, label: entry.subarray(56, 128).toString('utf16le').replace(/\0+$/, '') }
  if (index < 2) {
    const digest = createHash('sha256')
    let remaining = (last - first + 1) * 512
    let offset = first * 512
    while (remaining > 0) {
      const block = readAt(fd, offset, Math.min(4194304, remaining))
      digest.update(block)
      remaining -= block.length
      offset += block.length
    }
    record.sha256 = digest.digest('hex')
  }
  records.push(record)
}
closeSync(fd)
assert(JSON.stringify(records.map(r => r.number)) === JSON.stringify([1, 2, 3]))
assert(JSON.stringify(records.map(r => r.label).slice(1)) === JSON.stringify(['system', 'data']))
// The record as json.dumps(records, indent=2) wrote it: attributes as a bare integer.
const text = JSON.stringify(records, (_k, v: unknown) => (typeof v === 'bigint' ? `\0${v}\0` : v), 2).replace(/"\\u0000(\d+)\\u0000"/g, '$1')
writeFileSync(recordPath, text + '\n')
if (beforePath !== undefined) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Record_[]
  // before.json parses attributes back as a number while the fresh record holds a bigint; both compare as decimal
  // text. The bits GPT defines (0-2, 48-63) sum to integers a double holds exactly.
  const canonical = (r: Record_) => JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : v))
  const same = (a: Record_, b: Record_): boolean => canonical(a) === canonical(b)
  assert(same(records[0]!, before[0]!) && same(records[1]!, before[1]!), 'Firmware/ESP or SYSTEM bytes/geometry changed')
  assert(records[2]!.last > before[2]!.last + 2048 * 1024, 'DATA did not grow by at least 1 GiB')
  for (const key of ['first', 'type', 'guid', 'attributes', 'label', 'number'] as const)
    assert(String(records[2]![key]) === String(before[2]![key]), `DATA ${key} changed`)

  console.log('PASS: only DATA grows; every firmware/counter/SYSTEM byte and partition identity is unchanged')
}
