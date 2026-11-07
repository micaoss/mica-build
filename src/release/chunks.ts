// The transfer index and chunks of a published object (mica-core:docs/mica-core.md 6.3 "Delta transfer",
// crates/mica-deploy/src/chunks.rs): the device assembles an object it lacks from chunks it already holds and fetches
// only the rest, from `<object>.index` (MICAIDX1) and `chunks/<digest>` beside the object's directory. The cut is
// pinned: the origin cuts what it publishes and the device re-cuts what it holds, and the two agree byte for byte or
// nothing is reused. tests/fixtures/component-contracts/chunker.json fixes the boundaries for a known input.
//
// Nothing here is trusted by the device: it verifies the assembled object against the signed digest and falls back to
// the whole object on any failure. An origin that publishes no index is still conforming.
import { createHash } from 'node:crypto'

export const MIN_CHUNK = 4096
export const MAX_CHUNK = 65536

export type Chunk = { sha256: string, length: number }

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** GEAR[i] = sha256("mica-chunker/v1" || i)[0..8], big-endian, held as its high and low 32 bits. */
const GEAR_HI = new Uint32Array(256), GEAR_LO = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  const d = createHash('sha256').update(Buffer.concat([Buffer.from('mica-chunker/v1'), Buffer.from([i])])).digest()
  GEAR_HI[i] = d.readUInt32BE(0)
  GEAR_LO[i] = d.readUInt32BE(4)
}

/** The first `n` entries of the gear table as hex, for the contract's gearPrefix. */
export const gearPrefix = (n: number): string[] =>
  [...Array(n).keys()].map(i => GEAR_HI[i]!.toString(16).padStart(8, '0') + GEAR_LO[i]!.toString(16).padStart(8, '0'))

/** Cut `bytes` as mica-deploy does: `hash = (hash << 1) + GEAR[b]` (mod 2^64), a cut when the chunk is at least
 * MIN_CHUNK long and the top fourteen bits of the hash are zero, or at MAX_CHUNK; the hash restarts after a cut. */
export function cut(bytes: Uint8Array): Chunk[] {
  const out: Chunk[] = []
  let start = 0, hi = 0, lo = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    // (hi:lo << 1) + gear, in two 32-bit halves.
    const shifted = (lo << 1) >>> 0
    const sum = shifted + GEAR_LO[b]!
    hi = (((hi << 1) | (lo >>> 31)) + GEAR_HI[b]! + (sum > 0xFFFFFFFF ? 1 : 0)) >>> 0
    lo = sum >>> 0
    const length = i - start + 1
    if ((length >= MIN_CHUNK && (hi & 0xFFFC0000) === 0) || length === MAX_CHUNK) {
      out.push({ sha256: sha256(bytes.subarray(start, i + 1)), length })
      start = i + 1
      hi = 0
      lo = 0
    }
  }
  if (start < bytes.length) out.push({ sha256: sha256(bytes.subarray(start)), length: bytes.length - start })
  return out
}

/** MICAIDX1: the object digest (64 ASCII), its length (u64 BE), the chunk count (u32 BE), then each chunk's digest
 * (64 ASCII) and length (u32 BE). */
export function index(object: { sha256: string, bytes: number }, chunks: Chunk[]): Buffer {
  const out = Buffer.alloc(8 + 64 + 8 + 4 + chunks.length * 68)
  out.write('MICAIDX1', 0, 'ascii')
  out.write(object.sha256, 8, 'ascii')
  out.writeBigUInt64BE(BigInt(object.bytes), 72)
  out.writeUInt32BE(chunks.length, 80)
  chunks.forEach((c, i) => {
    out.write(c.sha256, 84 + i * 68, 'ascii')
    out.writeUInt32BE(c.length, 84 + i * 68 + 64)
  })
  return out
}

export type ArchiveObject = { sha256: string, bytes: Uint8Array }

/** The objects of a MICAUPD1 archive in the order it carries them, each checked against its digest. */
export function archiveObjects(archive: Uint8Array): ArchiveObject[] {
  const buffer = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  if (buffer.subarray(0, 8).toString() !== 'MICAUPD1') throw new Error('Not a MICAUPD1 archive')
  let at = 12 + buffer.readUInt32BE(8)
  const count = buffer.readUInt32BE(at)
  at += 4
  const objects: ArchiveObject[] = []
  for (let i = 0; i < count; i++) {
    if (at + 72 > buffer.length) throw new Error('Truncated update archive')
    const sha = buffer.subarray(at, at + 64).toString()
    const length = Number(buffer.readBigUInt64BE(at + 64))
    at += 72
    if (!/^[0-9a-f]{64}$/.test(sha) || at + length > buffer.length) throw new Error('Invalid archive object header')
    const bytes = buffer.subarray(at, at + length)
    if (sha256(bytes) !== sha) throw new Error(`Object ${sha} does not match its digest`)
    objects.push({ sha256: sha, bytes })
    at += length
  }
  if (at !== buffer.length) throw new Error('Trailing bytes after the last archive object')
  return objects
}

export type Transfer = {
  /** objects/<sha>.index for every object, relative to the release directory. */
  indexes: { path: string, bytes: Buffer }[]
  /** chunks/<digest> for every distinct chunk, relative to the release directory. */
  chunks: { path: string, sha256: string, bytes: Uint8Array }[]
}

/** The index of every object and every distinct chunk they cut into, as a release directory publishes them. */
export function transfer(objects: ArchiveObject[]): Transfer {
  const indexes: Transfer['indexes'] = []
  const chunks = new Map<string, Uint8Array>()
  for (const o of objects) {
    const cs = cut(o.bytes)
    indexes.push({ path: `objects/${o.sha256}.index`, bytes: index({ sha256: o.sha256, bytes: o.bytes.length }, cs) })
    let offset = 0
    for (const c of cs) {
      if (!chunks.has(c.sha256)) chunks.set(c.sha256, o.bytes.subarray(offset, offset + c.length))
      offset += c.length
    }
  }
  return { indexes, chunks: [...chunks].map(([sha, bytes]) => ({ path: `chunks/${sha}`, sha256: sha, bytes })) }
}
