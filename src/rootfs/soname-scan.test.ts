import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { report, scanRoot } from './soname-scan.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'soname-scan.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const elf = (...names: string[]) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(`\0${names.join('\0')}\0`)])

test('a name an ELF file mentions is carried when a file or directory of that name is in the root, absent otherwise', () => {
  mkdirSync(join(T, 'usr/bin'), { recursive: true }); mkdirSync(join(T, 'usr/lib'), { recursive: true })
  writeFileSync(join(T, 'usr/bin/stdbuf'), elf('libstdbuf.so', 'libc.so.6'))
  writeFileSync(join(T, 'usr/bin/tool'), elf('libc.so.6', 'libgone.so.1.2'))
  writeFileSync(join(T, 'usr/lib/libc.so.6'), elf())
  writeFileSync(join(T, 'usr/share-notes.txt'), 'libnot-elf.so\n')
  symlinkSync('libc.so.6', join(T, 'usr/lib/libc-link.so'))
  expect(scanRoot(T)).toEqual([
    ['libc.so.6', 'carried', '/usr/bin/stdbuf;/usr/bin/tool'],
    ['libgone.so.1.2', 'absent', '/usr/bin/tool'],
    ['libstdbuf.so', 'absent', '/usr/bin/stdbuf'],
  ])
})

test('an absent name in a class is explained by it; one in none is the finding', () => {
  const rows = [['libc.so.6', 'carried', '/a'], ['libgone.so.1.2', 'absent', '/b'], ['libstdbuf.so', 'absent', '/c']]
  const r = report(rows, { 'removed on purpose': { reason: 'the root drops them', names: ['libgone.so.1.2'] } }, 'fixture')
  expect(r.lines).toEqual([
    'soname scan: 3 name(s) mentioned by fixture\'s binaries, 2 not carried',
    '    1 explained: removed on purpose -- the root drops them',
    '  UNEXPLAINED: libstdbuf.so, named by /c',
    'RESULT: 1 unexplained name(s) of 2 absent',
  ])
  expect(r.unexplained).toBe(1)
})
