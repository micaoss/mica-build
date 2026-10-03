// Independently measure every GPT slot and unpartitioned gap before DATA growth.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'

type Partition = { number: number, first: number, last: number, type: string, guid: string, attributes: string, label: string, sha256?: string }
type Measurement = { diskGuid: string, partitions: Partition[], gaps: { first: number, last: number, sha256: string }[] }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function guidLE(b: Buffer): string {
  const hex = (x: Buffer) => x.toString('hex')
  return `${hex(Buffer.from(b.subarray(0, 4)).reverse())}-${hex(Buffer.from(b.subarray(4, 6)).reverse())}-${hex(Buffer.from(b.subarray(6, 8)).reverse())}-${hex(b.subarray(8, 10))}-${hex(b.subarray(10, 16))}`
}

export function measure(disk: string, dataNumber: number): Measurement {
  const fd = openSync(disk, 'r')
  const read = (offset: number, length: number) => {
    const out = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const n = readSync(fd, out, done, length - done, offset + done)
      assert(n > 0, 'short disk read')
      done += n
    }
    return out
  }
  const hash = (first: number, last: number) => {
    const digest = createHash('sha256')
    for (let offset = first * 512; offset < (last + 1) * 512;) {
      const block = read(offset, Math.min(4194304, (last + 1) * 512 - offset))
      digest.update(block)
      offset += block.length
    }
    return digest.digest('hex')
  }
  try {
    const header = read(512, 512)
    assert(header.subarray(0, 8).toString() === 'EFI PART', 'GPT header missing')
    const entryLba = Number(header.readBigUInt64LE(72)), count = header.readUInt32LE(80), size = header.readUInt32LE(84)
    assert(count === 128 && size === 128, 'unexpected GPT entry geometry')
    const entries = read(entryLba * 512, count * size), partitions: Partition[] = []
    for (let index = 0; index < count; index++) {
      const entry = entries.subarray(index * size, (index + 1) * size)
      if (entry.subarray(0, 16).equals(Buffer.alloc(16))) continue
      const first = Number(entry.readBigUInt64LE(32)), last = Number(entry.readBigUInt64LE(40)), number = index + 1
      partitions.push({ number, first, last, type: guidLE(entry.subarray(0, 16)), guid: guidLE(entry.subarray(16, 32)), attributes: String(entry.readBigUInt64LE(48)),
        label: entry.subarray(56, 128).toString('utf16le').replace(/\0+$/, ''), ...(number !== dataNumber ? { sha256: hash(first, last) } : {}) })
    }
    const ordered = partitions.toSorted((a, b) => a.first - b.first)
    assert(ordered.at(-1)?.number === dataNumber, 'DATA must end last on disk')
    const gaps: Measurement['gaps'] = []
    let end = entryLba + count * size / 512
    for (const p of ordered) {
      assert(p.first >= end, 'overlapping partition geometry')
      if (p.first > end) gaps.push({ first: end, last: p.first - 1, sha256: hash(end, p.first - 1) })
      end = p.last + 1
    }
    return { diskGuid: guidLE(header.subarray(56, 72)), partitions, gaps }
  }
  finally { closeSync(fd) }
}

export function compareGrowth(after: Measurement, before: Measurement, dataNumber: number, minimumSectors = 2048 * 1024): void {
  assert(after.diskGuid === before.diskGuid && after.partitions.length === before.partitions.length, 'GPT identities changed')
  for (const p of before.partitions) {
    const actual = after.partitions.find(q => q.number === p.number)
    assert(actual !== undefined, `partition ${p.number} missing`)
    if (p.number !== dataNumber) { assert(JSON.stringify(actual) === JSON.stringify(p), `partition ${p.number} bytes or geometry changed`) }
    else {
      assert(actual.last > p.last + minimumSectors, 'DATA did not grow')
      assert(JSON.stringify({ ...actual, last: p.last }) === JSON.stringify(p), 'DATA identity or start changed')
    }
  }
  assert(JSON.stringify(after.gaps) === JSON.stringify(before.gaps), 'unpartitioned gap bytes changed')
}

if (import.meta.main) {
  const [disk, output, before] = Bun.argv.slice(2)
  if (!disk || !output) throw new Error('usage: measure.ts <disk> <record> [<before>] (DATA_NUMBER required)')
  const dataNumber = Number(process.env.DATA_NUMBER)
  if (!Number.isInteger(dataNumber) || dataNumber < 1) throw new Error('DATA_NUMBER required')
  const measured = measure(disk, dataNumber)
  writeFileSync(output, JSON.stringify(measured, null, 2) + '\n')
  if (before) {
    compareGrowth(measured, JSON.parse(readFileSync(before, 'utf8')) as Measurement, dataNumber)
    console.log('PASS: only DATA grows; all other partition bytes, vendor slots and unpartitioned gaps are byte-identical')
  }
}
