import { expect, test } from 'bun:test'
import { elfInfo, readLoaderCache } from './elf.ts'

/**
 * A shared object of either class, little-endian: PT_LOAD over the whole file, PT_INTERP, PT_DYNAMIC with
 * DT_NEEDED, DT_SONAME, DT_STRTAB and DT_STRSZ, the strings after the dynamic table.
 */
function elf(wide: boolean, machine: number): Uint8Array {
  const header = wide ? 64 : 52, entry = wide ? 56 : 32, dyn = wide ? 16 : 8
  const interp = Buffer.from('/lib/ld-linux-armhf.so.3\0')
  const strings = Buffer.from('\0libc.so.6\0libdemo.so.1\0')
  const phoff = header, interpAt = phoff + 3 * entry, dynAt = interpAt + interp.length + (8 - (interp.length % 8)) % 8
  const tags: [number, number][] = [[1, 1], [14, 11], [5, 0], [10, strings.length], [0, 0]]
  const strAt = dynAt + tags.length * dyn, size = strAt + strings.length
  const b = Buffer.alloc(size)
  const word = (at: number, v: number) => (wide ? b.writeBigUInt64LE(BigInt(v), at) : b.writeUInt32LE(v, at))
  b.set([0x7f, 0x45, 0x4c, 0x46, wide ? 2 : 1, 1, 1])
  b.writeUInt16LE(3, 16); b.writeUInt16LE(machine, 18); b.writeUInt32LE(1, 20)
  word(wide ? 32 : 28, phoff)
  b.writeUInt16LE(header, wide ? 52 : 40); b.writeUInt16LE(entry, wide ? 54 : 42); b.writeUInt16LE(3, wide ? 56 : 44)
  const segment = (i: number, type: number, offset: number, filesz: number) => {
    const at = phoff + i * entry
    b.writeUInt32LE(type, at)
    if (wide) { word(at + 8, offset); word(at + 16, offset); word(at + 32, filesz); word(at + 40, filesz) }
    else { word(at + 4, offset); word(at + 8, offset); word(at + 16, filesz); word(at + 20, filesz) }
  }
  segment(0, 1, 0, size)
  segment(1, 3, interpAt, interp.length)
  segment(2, 2, dynAt, tags.length * dyn)
  interp.copy(b, interpAt)
  tags.forEach(([tag, value], i) => { word(dynAt + i * dyn, tag); word(dynAt + i * dyn + dyn / 2, tag === 5 ? strAt : value) })
  strings.copy(b, strAt)
  return new Uint8Array(b)
}

test('an ELF64 and an ELF32 object read the same: interpreter, dependencies, SONAME', () => {
  for (const [wide, machine] of [[true, 183], [false, 40]] as const) {
    const info = elfInfo(elf(wide, machine), machine, 'demo')
    expect(info).toEqual({ needed: ['libc.so.6'], interp: '/lib/ld-linux-armhf.so.3', rpath: null, runpath: null, soname: 'libdemo.so.1' })
  }
})

test('the machine is the caller\'s: an object of another architecture is refused by name', () => {
  expect(() => elfInfo(elf(false, 40), 183, 'demo')).toThrow('ELF architecture: demo')
  expect(() => elfInfo(elf(true, 183), 40, 'demo')).toThrow('ELF architecture: demo')
})

/** An ld.so.cache 1.1 of one entry with `flags`. */
function cache(flags: number): Uint8Array {
  const names = Buffer.from('libc.so.6\0/usr/lib/arm-linux-gnueabihf/libc.so.6\0')
  const b = Buffer.alloc(48 + 24 + names.length)
  b.write('glibc-ld.so.cache1.1', 0, 'ascii')
  b.writeUInt32LE(1, 20); b.writeUInt32LE(names.length, 24); b[28] = 2
  b.writeInt32LE(flags, 48); b.writeUInt32LE(72, 52); b.writeUInt32LE(82, 56)
  names.copy(b, 72)
  return new Uint8Array(b)
}

test('an armhf loader cache carries the hard-float library flag; another architecture\'s is refused', () => {
  expect(readLoaderCache(cache(0x903), 'armhf').get('libc.so.6')).toEqual(['/usr/lib/arm-linux-gnueabihf/libc.so.6'])
  expect(() => readLoaderCache(cache(0xa03), 'armhf')).toThrow('architecture')
})
