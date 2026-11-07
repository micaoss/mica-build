import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import contract from '../../tests/fixtures/component-contracts/chunker.json'
import { archiveObjects, cut, gearPrefix, index, MAX_CHUNK, MIN_CHUNK, transfer } from './chunks.ts'

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// The contract's input: sha256("mica-chunker-vector/v1" || uint32be(i)) for i in 0..8192, concatenated.
const input = Buffer.concat([...Array(8192).keys()].map((i) => {
  const n = Buffer.alloc(4)
  n.writeUInt32BE(i)
  return createHash('sha256').update(Buffer.concat([Buffer.from('mica-chunker-vector/v1'), n])).digest()
}))

test('the chunker is mica-deploy\'s: the contract\'s parameters, gear table, boundaries and index', () => {
  expect(contract.parameters.minChunk).toBe(MIN_CHUNK)
  expect(contract.parameters.maxChunk).toBe(MAX_CHUNK)
  expect(input.length).toBe(contract.input.bytes)
  expect(sha256(input)).toBe(contract.input.sha256)
  expect(gearPrefix(contract.gearPrefix.length)).toEqual(contract.gearPrefix)
  let offset = 0
  expect(cut(input).map((c) => {
    const at = offset
    offset += c.length
    return { length: c.length, offset: at, sha256: c.sha256 }
  })).toEqual(contract.chunks)
  expect(index({ sha256: contract.input.sha256, bytes: input.length }, cut(input)).toString('hex')).toBe(contract.index)
})

test('a run with no cut point is cut at the largest chunk, and a short tail is a chunk of its own', () => {
  const lengths = cut(new Uint8Array(MAX_CHUNK * 2 + 100)).map(c => c.length)
  expect(lengths.reduce((a, b) => a + b, 0)).toBe(MAX_CHUNK * 2 + 100)
  expect(lengths.every(l => l <= MAX_CHUNK)).toBe(true)
  expect(cut(new Uint8Array(10)).map(c => c.length)).toEqual([10])
})

function archive(objects: Uint8Array[]): Buffer {
  const envelope = Buffer.from('{"payload":""}')
  const parts = [Buffer.from('MICAUPD1'), Buffer.alloc(4), envelope, Buffer.alloc(4)]
  parts[1]!.writeUInt32BE(envelope.length)
  parts[3]!.writeUInt32BE(objects.length)
  for (const o of objects) {
    const size = Buffer.alloc(8)
    size.writeBigUInt64BE(BigInt(o.length))
    parts.push(Buffer.from(sha256(o)), size, Buffer.from(o))
  }
  return Buffer.concat(parts)
}

test('every object of an archive gets an index, and every distinct chunk is published once', () => {
  const small = Buffer.from('a signature')
  const objects = archiveObjects(archive([input, small, Buffer.concat([input, small])]))
  expect(objects.map(o => o.sha256)).toEqual([sha256(input), sha256(small), sha256(Buffer.concat([input, small]))])
  const t = transfer(objects)
  expect(t.indexes.map(i => i.path)).toEqual(objects.map(o => `objects/${o.sha256}.index`))
  expect(t.indexes[0]!.bytes.toString('hex')).toBe(contract.index)
  // Each chunk is its digest's bytes, published under chunks/<digest>, and the third object reuses the first's.
  for (const c of t.chunks) {
    expect(sha256(c.bytes)).toBe(c.sha256)
    expect(c.path).toBe(`chunks/${c.sha256}`)
  }
  expect(new Set(t.chunks.map(c => c.sha256)).size).toBe(t.chunks.length)
  expect(t.chunks.length).toBeLessThan(cut(input).length * 2 + 2)
})

test('an archive whose object does not match its digest is refused', () => {
  const bad = archive([input])
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1
  expect(() => archiveObjects(bad)).toThrow('does not match its digest')
  expect(() => archiveObjects(Buffer.from('MICAUPD0'))).toThrow('Not a MICAUPD1 archive')
})
