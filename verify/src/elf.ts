// Enough of ELF to answer two questions about a file in the packed root: does
// it still carry debug or static symbol sections, and what is its GNU build-id.
//
// WHY A PARSER AND NOT `readelf`. Every other reader in this package goes
// through `verify/src/tools.ts`, which resolves a tool inside the pinned
// alpine image; adding binutils to that package list would put a tool in every
// check's container for the sake of two fields that are twelve bytes into a
// header. The parse is also the thing under test: PLAN-086 S2's build-id match
// is the whole claim that a separated debug file belongs to the binary beside
// it, and a claim asserted by grepping another program's prose output is one
// spelling change away from matching nothing and reporting green. That is not
// hypothetical here -- `readelf -nW` puts `Build ID:` on the SAME line as the
// note type and `readelf -n` puts it on its own, so a pattern anchored to the
// start of the line reads every binary as having no build-id at all.
//
// It reads by OFFSET rather than slurping the file. The largest binary in this
// root is podman at 42 MB after stripping, and there are 1,000-odd ELF files
// to walk: what is needed out of each is the header, the section table and one
// note section.

import { closeSync, openSync, readSync } from 'node:fs'

/** `\x7fELF`. */
const MAGIC = [0x7f, 0x45, 0x4c, 0x46]

/** ET_REL -- a relocatable object, which on this root means a kernel module. */
export const ET_REL = 1

/** SHT_NOTE. A note section whose content was moved out is SHT_NOBITS (8). */
const SHT_NOTE = 7

/** The name every toolchain gives the note this reads. */
const BUILD_ID_SECTION = '.note.gnu.build-id'

/** NT_GNU_BUILD_ID, with owner `GNU`. */
const NT_GNU_BUILD_ID = 3

export interface ElfSection {
  readonly name: string
  readonly type: number
  readonly offset: number
  readonly size: number
}

export interface ElfFile {
  /** `e_type`; compare against [`ET_REL`]. */
  readonly type: number
  /** EI_DATA, carried so a note's own fields are read the way its file writes them. */
  readonly littleEndian: boolean
  readonly sections: readonly ElfSection[]
}

/**
 * The sections whose removal is what `strip` does and what
 * `objcopy --only-keep-debug` keeps.
 *
 * `.symtab`/`.strtab` are the static symbol table; `.debug*` and its
 * compressed `.zdebug*` spelling are DWARF. Exactly the set
 * `tools/measure-rootfs.sh` sums and `rootfs/scripts/pack-export-debug.sh`
 * moves, written here a third time on purpose: this is the INDEPENDENT reader,
 * and one that imported the build script's list would agree with it by
 * construction.
 */
export function isRemovableDebugSection(name: string): boolean {
  return name === '.symtab' || name === '.strtab'
    || name.startsWith('.debug') || name.startsWith('.zdebug')
}

function at(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length)
  const got = readSync(fd, buf, 0, length, position)
  if (got !== length) {
    throw new Error(`wanted ${length} bytes at offset ${position} and read ${got}`)
  }
  return buf
}

/** The first four bytes are `\x7fELF`. Cheap enough to ask of every file in the root. */
export function isElf(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  }
  catch {
    return false
  }
  try {
    const head = Buffer.alloc(4)
    if (readSync(fd, head, 0, 4, 0) !== 4) return false
    return MAGIC.every((b, i) => head[i] === b)
  }
  finally {
    closeSync(fd)
  }
}

/**
 * The ELF header and section table.
 *
 * Both classes and both byte orders are read, because the alternative is a
 * reader that silently produces nonsense on the file it was not written for --
 * this root is 64-bit little-endian on both boards today, and a 32-bit or
 * big-endian one would be a new board rather than a corrupt file.
 *
 * `e_shnum == 0` is REFUSED rather than resolved through section 0's
 * `sh_size`. That escape hatch exists for objects with more than 65,279
 * sections; nothing in this root has 30, and implementing a path that cannot
 * be exercised is a path that is wrong when it is first taken.
 */
export function readElf(path: string): ElfFile {
  const fd = openSync(path, 'r')
  try {
    const ident = at(fd, 0, 16)
    if (!MAGIC.every((b, i) => ident[i] === b)) throw new Error(`${path} is not an ELF file`)
    const cls = ident[4]
    const data = ident[5]
    if (cls !== 1 && cls !== 2) throw new Error(`${path} declares EI_CLASS ${cls}, neither 32- nor 64-bit`)
    if (data !== 1 && data !== 2) throw new Error(`${path} declares EI_DATA ${data}, neither little- nor big-endian`)
    const le = data === 1
    const is64 = cls === 2

    const head = at(fd, 0, is64 ? 0x40 : 0x34)
    const u16 = (b: Buffer, o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
    const u32 = (b: Buffer, o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
    // Through Number, deliberately: a section offset or size beyond 2^53 is a
    // file this harness cannot address anyway, and every consumer here is an
    // fs offset.
    const u64 = (b: Buffer, o: number): number =>
      Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o))

    const type = u16(head, 16)
    const shoff = is64 ? u64(head, 0x28) : u32(head, 0x20)
    const shentsize = u16(head, is64 ? 0x3a : 0x2e)
    const shnum = u16(head, is64 ? 0x3c : 0x30)
    const shstrndx = u16(head, is64 ? 0x3e : 0x32)
    if (shnum === 0) {
      throw new Error(`${path} declares e_shnum 0, the extended section count this reader does not implement`)
    }
    if (shoff === 0) return { type, littleEndian: le, sections: [] }

    const table = at(fd, shoff, shentsize * shnum)
    const raw = Array.from({ length: shnum }, (_unused, i) => {
      const o = i * shentsize
      return {
        nameOff: u32(table, o + 0),
        type: u32(table, o + 4),
        offset: is64 ? u64(table, o + 24) : u32(table, o + 16),
        size: is64 ? u64(table, o + 32) : u32(table, o + 20),
      }
    })

    const strtab = raw[shstrndx]
    if (strtab === undefined) {
      throw new Error(`${path} names section ${shstrndx} as its section-name table and declares only ${shnum}`)
    }
    const names = at(fd, strtab.offset, strtab.size)
    const nameAt = (off: number): string => {
      const end = names.indexOf(0, off)
      return names.toString('latin1', off, end === -1 ? names.length : end)
    }

    return {
      type,
      littleEndian: le,
      sections: raw.map(s => ({ name: nameAt(s.nameOff), type: s.type, offset: s.offset, size: s.size })),
    }
  }
  finally {
    closeSync(fd)
  }
}

/**
 * The GNU build-id, lowercase hex, or `undefined` when the file carries none.
 *
 * Read out of the note's CONTENT, which is what makes this work on both sides
 * of the split: `objcopy --only-keep-debug` marks every non-debug section
 * NOBITS except the allocated ones, and `.note.gnu.build-id` is allocated, so
 * the separated debug file carries the same twenty bytes as the binary it came
 * from. A NOBITS note is read as no build-id rather than as bytes at an offset
 * that means nothing.
 */
export function buildId(path: string, elf: ElfFile = readElf(path)): string | undefined {
  const section = elf.sections.find(s => s.name === BUILD_ID_SECTION)
  if (section === undefined || section.type !== SHT_NOTE || section.size === 0) return undefined
  const fd = openSync(path, 'r')
  let note: Buffer
  try {
    note = at(fd, section.offset, section.size)
  }
  finally {
    closeSync(fd)
  }
  // One note, or several: walk them. n_namesz, n_descsz, n_type, then the name
  // and the descriptor, each padded up to four bytes.
  const align = (n: number): number => (n + 3) & ~3
  const u32 = (o: number): number =>
    (elf.littleEndian ? note.readUInt32LE(o) : note.readUInt32BE(o))
  for (let o = 0; o + 12 <= note.length;) {
    const namesz = u32(o)
    const descsz = u32(o + 4)
    const kind = u32(o + 8)
    const nameStart = o + 12
    const descStart = nameStart + align(namesz)
    const end = descStart + align(descsz)
    if (end > note.length) return undefined
    const owner = note.toString('latin1', nameStart, nameStart + Math.max(0, namesz - 1))
    if (kind === NT_GNU_BUILD_ID && owner === 'GNU' && descsz > 0) {
      return note.toString('hex', descStart, descStart + descsz)
    }
    o = end
  }
  return undefined
}
