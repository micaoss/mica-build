import { expect, test } from 'bun:test'
import { bootPolicy } from './boot-policy.ts'

const policy = { identity: { board: 'test' }, board: { storage: 'emmc' }, systemPartUuid: 'system', dataPartUuid: 'data' }
const align = (n: number) => (n + 3) & ~3
function initrd() {
  const name = Buffer.from('etc/mica/boot.json\0'), data = Buffer.from(JSON.stringify(policy))
  const h = Buffer.from('070701' + Array.from({ length: 13 }, (_, i) => (i === 6 ? data.length : i === 11 ? name.length : 0).toString(16).padStart(8, '0')).join(''))
  return Bun.zstdCompressSync(Buffer.concat([h, name, Buffer.alloc(align(h.length + name.length) - h.length - name.length), data, Buffer.alloc(align(data.length) - data.length)]))
}
function fit() {
  const strings = Buffer.from('data\0'), chunks: Buffer[] = []
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const node = (name: string) => { const b = Buffer.from(name + '\0'); chunks.push(u32(1), b, Buffer.alloc(align(b.length) - b.length)) }
  node(''); node('images'); node('ramdisk')
  const data = initrd(); chunks.push(u32(3), u32(data.length), u32(0), data, Buffer.alloc(align(data.length) - data.length), u32(2), u32(2), u32(2), u32(9))
  const structure = Buffer.concat(chunks), h = Buffer.alloc(40)
  for (const [offset, value] of [[0, 0xd00dfeed], [4, 40 + structure.length + strings.length], [8, 40], [12, 40 + structure.length], [32, strings.length], [36, structure.length]]) h.writeUInt32BE(value!, offset!)
  return Buffer.concat([h, structure, strings])
}
function uki() {
  const data = initrd(), b = Buffer.alloc(512 + data.length)
  b.write('MZ'); b.writeUInt32LE(64, 60); b.write('PE\0\0', 64); b.writeUInt16LE(1, 70)
  b.write('.initrd', 88); b.writeUInt32LE(data.length, 96); b.writeUInt32LE(data.length, 104); b.writeUInt32LE(512, 108); data.copy(b, 512)
  return b
}
test('reads policy from the exact FIT and UKI initrd bytes', () => {
  expect(bootPolicy(fit(), 'fit')).toEqual(policy)
  expect(bootPolicy(uki(), 'uki')).toEqual(policy)
})
test('refuses malformed boot objects and an absent embedded policy', () => {
  expect(() => bootPolicy(Buffer.alloc(64), 'fit')).toThrow()
  expect(() => bootPolicy(Buffer.alloc(64), 'uki')).toThrow()
  const missing = uki(); missing.write('.other\0', 88)
  expect(() => bootPolicy(missing, 'uki')).toThrow('initrd')
})
