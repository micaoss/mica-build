// The ELF reader, driven from the side that would silently produce nonsense.
//
// Every consumer of this module asks a question whose wrong answer is GREEN: "no
// debug sections" and "the build-ids match" are both what a parser that read the
// wrong bytes reports. So the cases below are mostly about what it must REFUSE
// and about the two shapes that are indistinguishable to a careless reader -- a
// note section whose content was moved out, and a file that has no note at all.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildIdNote,
  ELF_TYPE_REL,
  writeSyntheticElf,
} from './checks-fixture.ts'
import { buildId, ET_REL, isElf, isRemovableDebugSection, readElf } from './elf.ts'

const ID = '4764889a4dce315a880b6e0c2038ef0fda2cf589'

function work(): { dir: string, dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mica-elf-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('the magic', () => {
  test('an ELF is one and a text file is not', () => {
    const w = work()
    try {
      const elf = join(w.dir, 'bin')
      writeSyntheticElf(elf, { buildId: ID })
      expect(isElf(elf)).toBe(true)
      const text = join(w.dir, 'script')
      writeFileSync(text, '#!/bin/sh\necho hello\n')
      expect(isElf(text)).toBe(false)
    } finally { w.dispose() }
  })

  test('a file shorter than the magic is not an ELF, and is not an error', () => {
    // /usr/lib/modules carries empty marker files and the root has zero-byte
    // ones elsewhere; a reader that threw on them would fail the walk rather
    // than skip the file.
    const w = work()
    try {
      const p = join(w.dir, 'empty')
      writeFileSync(p, '')
      expect(isElf(p)).toBe(false)
    } finally { w.dispose() }
  })

  test('a path that is not there is not an ELF, and is not an error', () => {
    expect(isElf(join(tmpdir(), 'mica-elf-nothing-here'))).toBe(false)
  })
})

describe('the section table', () => {
  test('POSITIVE CONTROL: the sections come back by name, with their type', () => {
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      writeSyntheticElf(p, {
        buildId: ID,
        sections: [
          { name: '.text', content: Buffer.from('code') },
          { name: '.debug_info', content: Buffer.from('dwarf') },
        ],
      })
      const elf = readElf(p)
      expect(elf.sections.map(s => s.name))
        .toEqual(['', '.note.gnu.build-id', '.text', '.debug_info', '.shstrtab'])
      expect(elf.littleEndian).toBe(true)
      expect(elf.sections.find(s => s.name === '.debug_info')?.size).toBe(5)
    } finally { w.dispose() }
  })

  test('e_type distinguishes a relocatable object from an executable', () => {
    // The rule that keeps a kernel module out of the stripping set.
    const w = work()
    try {
      const exe = join(w.dir, 'exe')
      const mod = join(w.dir, 'mod.ko')
      writeSyntheticElf(exe, { buildId: ID })
      writeSyntheticElf(mod, { type: ELF_TYPE_REL, sections: [{ name: '.symtab', content: Buffer.from('s') }] })
      expect(readElf(exe).type).not.toBe(ET_REL)
      expect(readElf(mod).type).toBe(ET_REL)
    } finally { w.dispose() }
  })

  test('a file that is not an ELF is refused rather than parsed as one', () => {
    const w = work()
    try {
      const p = join(w.dir, 'text')
      writeFileSync(p, 'not an elf at all, but long enough to have a header\n')
      expect(() => readElf(p)).toThrow(/is not an ELF file/)
    } finally { w.dispose() }
  })

  test('a corrupt EI_CLASS is refused rather than read as 64-bit', () => {
    // The difference decides every field offset below it, so a reader that
    // guessed would return sections that do not exist.
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      writeSyntheticElf(p, { buildId: ID })
      const bytes = Buffer.from(readFileSync(p))
      bytes[4] = 9
      writeFileSync(p, bytes)
      expect(() => readElf(p)).toThrow(/EI_CLASS 9/)
    } finally { w.dispose() }
  })

  test('the extended section count is refused rather than misread', () => {
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      writeSyntheticElf(p, { buildId: ID })
      const bytes = Buffer.from(readFileSync(p))
      bytes.writeUInt16LE(0, 60)
      writeFileSync(p, bytes)
      expect(() => readElf(p)).toThrow(/e_shnum 0/)
    } finally { w.dispose() }
  })
})

describe('the build-id', () => {
  test('POSITIVE CONTROL: the note is read back as lowercase hex', () => {
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      writeSyntheticElf(p, { buildId: ID })
      expect(buildId(p)).toBe(ID)
    } finally { w.dispose() }
  })

  test('a binary with no note reports undefined, not an empty string', () => {
    // The two are the same to a `if (!id)` and different to the check: an
    // absent build-id is a binary that cannot be matched to a debug file, and
    // it has to be distinguishable from one whose id is being compared.
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      writeSyntheticElf(p, { sections: [{ name: '.text', content: Buffer.from('x') }] })
      expect(buildId(p)).toBeUndefined()
    } finally { w.dispose() }
  })

  test('a NOBITS note is not read as bytes that happen to be at its offset', () => {
    // What `objcopy` leaves when a section's content has been moved out. The
    // section header still names it and still carries an offset, and the bytes
    // there belong to whatever section really occupies them.
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      writeSyntheticElf(p, { buildId: ID, buildIdNobits: true })
      expect(buildId(p)).toBeUndefined()
    } finally { w.dispose() }
  })

  test('a note owned by somebody other than GNU is not a build-id', () => {
    // Go binaries carry .note.go.buildid beside the GNU one; a reader that
    // took the first note it saw would report a base64 Go stamp as a build-id.
    const w = work()
    try {
      const p = join(w.dir, 'bin')
      const foreign = buildIdNote(ID)
      foreign.set(Buffer.from('AAA\0', 'latin1'), 12)
      writeSyntheticElf(p, { sections: [{ name: '.note.gnu.build-id', type: 7, content: foreign }] })
      expect(buildId(p)).toBeUndefined()
    } finally { w.dispose() }
  })
})

describe('what counts as removable', () => {
  test('the set is the static symbol table and DWARF, in both spellings', () => {
    for (const name of ['.symtab', '.strtab', '.debug_info', '.debug_line', '.zdebug_info']) {
      expect(isRemovableDebugSection(name)).toBe(true)
    }
  })

  test('nothing a running binary needs is in it', () => {
    // .dynsym and .dynstr are the DYNAMIC symbol table -- allocated, resolved
    // at load time, and not what `strip` takes. Classing either as removable
    // would make this family demand a root whose binaries cannot link.
    for (const name of ['.text', '.dynsym', '.dynstr', '.rodata', '.note.gnu.build-id', '.gnu_debuglink']) {
      expect(isRemovableDebugSection(name)).toBe(false)
    }
  })
})
