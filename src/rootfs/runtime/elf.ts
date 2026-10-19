// What the runtime selection reads out of an ELF file (64- or 32-bit, little-endian) and the loader cache: the dynamic dependencies,
// the interpreter, the search paths and the SONAME, from the program headers alone (a stripped input has no
// sections), and the glibc ld.so.cache of the target root. Refusals name the file.
import { normalized, Refusal, require } from './fsx.ts'
import { ARCH, isArch } from './arch.ts'

export type ElfInfo = { needed: string[], interp: string | null, rpath: string | null, runpath: string | null, soname: string | null }

export function elfInfo(data: Uint8Array, machine: number, path: string): ElfInfo {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  // ELF64 and ELF32 differ in the width of an address, and so in every offset after it; the class is the file's
  // and the machine the caller's, which together are the architecture.
  const wide = data[4] === 2
  require(data.length >= 52 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46 && (data[4] === 1 || data[4] === 2) && data[5] === 1 && data[6] === 1
    && dv.getUint16(18, true) === machine, `ELF architecture: ${path}`)
  const word = (at: number) => (wide ? Number(dv.getBigUint64(at, true)) : dv.getUint32(at, true))
  const header = wide ? 64 : 52, entry = wide ? 56 : 32, dyn = wide ? 16 : 8
  require(data.length >= header, `unsupported ELF header: ${path}`)
  const type = dv.getUint16(16, true), version = dv.getUint32(20, true), phoff = word(wide ? 32 : 28)
  const ehsize = dv.getUint16(wide ? 52 : 40, true), phentsize = dv.getUint16(wide ? 54 : 42, true), phnum = dv.getUint16(wide ? 56 : 44, true)
  require((type === 2 || type === 3) && version === 1 && ehsize === header && phentsize === entry && phnum > 0 && phnum < 65535, `unsupported ELF header: ${path}`)
  require(phoff + phnum * entry <= data.length, `truncated ELF headers: ${path}`)
  type Segment = { type: number, flags: number, offset: number, vaddr: number, paddr: number, filesz: number, memsz: number, align: number }
  const segments: Segment[] = []
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * entry
    segments.push(wide
      ? {
          type: dv.getUint32(at, true), flags: dv.getUint32(at + 4, true), offset: word(at + 8),
          vaddr: word(at + 16), paddr: word(at + 24), filesz: word(at + 32), memsz: word(at + 40), align: word(at + 48),
        }
      : {
          type: dv.getUint32(at, true), offset: word(at + 4), vaddr: word(at + 8), paddr: word(at + 12),
          filesz: word(at + 16), memsz: word(at + 20), flags: dv.getUint32(at + 24, true), align: word(at + 28),
        })
  }
  for (const s of segments) require(s.offset + s.filesz <= data.length, `truncated ELF segment: ${path}`)
  const dynamic = segments.filter(s => s.type === 2), interps = segments.filter(s => s.type === 3)
  require(dynamic.length <= 1 && interps.length <= 1, `ambiguous ELF segments: ${path}`)
  const result: ElfInfo = { needed: [], interp: null, rpath: null, runpath: null, soname: null }
  if (interps.length === 1) {
    const s = interps[0]!, raw = data.subarray(s.offset, s.offset + s.filesz)
    require(raw.length > 0 && raw[raw.length - 1] === 0 && !raw.subarray(0, -1).includes(0), `invalid ELF interpreter: ${path}`)
    result.interp = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, -1))
  }
  if (dynamic.length === 0) return result
  const s = dynamic[0]!
  require(s.filesz % dyn === 0, `invalid ELF dynamic size: ${path}`)
  const entries: [number, number][] = []
  let terminated = false
  for (let at = s.offset; at < s.offset + s.filesz; at += dyn) {
    const tag = word(at), value = word(at + dyn / 2)
    if (tag === 0) { terminated = true; break }
    entries.push([tag, value])
  }
  if (!terminated) throw new Refusal(`unterminated ELF dynamic table: ${path}`)
  // These change loader behavior beyond the declared closure; never ignore them.
  require(!entries.some(([t, v]) => [0x6ffffefb, 0x6ffffefc, 0x7fffffff, 0x7ffffffd].includes(t) || (t === 0x6ffffffb && (v & 0x800) !== 0)),
    `unsupported ELF loader policy: ${path}`)
  for (const tag of [5, 10, 14, 15, 29]) require(entries.filter(([t]) => t === tag).length <= 1, `ambiguous ELF dynamic tag: ${path}`)
  const values = new Map<number, number>()
  for (const [t, v] of entries) values.set(t, v)
  if (!entries.some(([t]) => [1, 14, 15, 29].includes(t))) return result
  require(values.has(5) && values.has(10), `missing ELF string table: ${path}`)
  const strtab = values.get(5)!, strsz = values.get(10)!
  const loads = segments.filter(seg => seg.type === 1 && seg.vaddr <= strtab && strtab + strsz <= seg.vaddr + seg.filesz)
  require(loads.length === 1, `ambiguous ELF string mapping: ${path}`)
  const start = loads[0]!.offset + strtab - loads[0]!.vaddr
  const strings = data.subarray(start, start + strsz)
  for (const [tag, value] of entries) {
    if (![1, 14, 15, 29].includes(tag)) continue
    const end = strings.indexOf(0, value)
    require(value >= 0 && value < strings.length && end >= 0, `invalid ELF string: ${path}`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(strings.subarray(value, end))
    if (tag === 1) {
      require(text.length > 0, `empty ELF dependency: ${path}`)
      result.needed.push(text)
    }
    else if (tag === 14) {
      require(/^[^/\x00-\x20\x7f$]+$/.test(text) && text !== '.' && text !== '..', `invalid ELF SONAME: ${path}`)
      result.soname = text
    }
    else if (tag === 15) { result.rpath = text }
    else { result.runpath = text }
  }
  return result
}

/** The glibc ld.so.cache (format 1.1, little-endian) of a root: name -> the paths it maps to, in file order. */
export function readLoaderCache(data: Uint8Array, arch: string): Map<string, string[]> {
  const magic = new TextDecoder('ascii').decode(data.subarray(0, 20))
  require(data.length >= 48 && magic === 'glibc-ld.so.cache1.1' && data[28] === 2, 'unsupported loader cache format or endianness')
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = dv.getUint32(20, true), size = dv.getUint32(24, true)
  const start = 48 + 24 * count, end = 48 + 24 * count + size
  require(end <= data.length, 'truncated loader cache')
  const cache = new Map<string, string[]>()
  const expectFlags = isArch(arch) ? ARCH[arch].loaderCacheFlags : undefined
  for (let i = 0; i < count; i++) {
    const at = 48 + 24 * i
    const flags = dv.getInt32(at, true), key = dv.getUint32(at + 4, true), value = dv.getUint32(at + 8, true), hwcap = dv.getBigUint64(at + 16, true)
    require(flags === expectFlags && hwcap === 0n, 'unsupported loader cache architecture/hwcaps')
    const strings: string[] = []
    for (const offset of [key, value]) {
      const stop = data.subarray(0, end).indexOf(0, offset)
      require(start <= offset && offset < end && stop >= 0, 'invalid loader cache string')
      strings.push(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, stop)))
    }
    const [name, path] = strings as [string, string]
    require(name !== '' && !name.includes('/') && path === normalized(path), 'invalid loader cache path')
    if (!cache.has(name)) cache.set(name, [])
    cache.get(name)!.push(path)
  }
  return cache
}
