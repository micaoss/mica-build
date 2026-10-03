// src/product/build.ts without a build: the command line (the name, the mode, the stamp and the generation),
// the EFI target of an architecture, and the receipt's shape over the tree's own files.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { efiTarget, parseArgs, ProductBuildError, receipt, toolArch } from './build.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('the command line', () => {
  test('the name alone builds; --verify verifies; --version and --release carry a stamp and an optional generation', () => {
    expect(parseArgs(['p'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: '', generation: 2, reuse: '' })
    expect(parseArgs(['p', '--verify'])).toEqual({ name: 'p', mode: 'verify', release: '', stamp: '', generation: 2, reuse: '' })
    expect(parseArgs(['p', '--version', 'v1'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: 'v1', generation: 2, reuse: '' })
    expect(parseArgs(['p', '--version', 'v1', '--generation', '7'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: 'v1', generation: 7, reuse: '' })
    expect(parseArgs(['p', '--release', '20260923-1200'])).toEqual({ name: 'p', mode: 'build', release: '20260923-1200', stamp: '20260923-1200', generation: 2, reuse: '' })
    expect(parseArgs(['p', '--release', '20260923-1200', '--generation', '5', '--reuse', 'p.20260922-0900'])).toEqual({ name: 'p', mode: 'build', release: '20260923-1200', stamp: '20260923-1200', generation: 5, reuse: 'p.20260922-0900' })
    expect(parseArgs(['p', '--release', '20260923-1200', '--reuse', 'p.20260922-0900'])).toMatchObject({ generation: 2, reuse: 'p.20260922-0900' })
  })
  test('the refusals: no name, a bad mode, a missing stamp, a generation below 2, a release name out of form', () => {
    for (const [argv, fragment] of [
      [[], 'usage'], [['p', '--bogus'], 'usage'], [['p', '--verify', 'x'], 'usage'], [['p', '--version'], 'usage'], [['p', 'extra'], 'usage'],
      [['p', '--version', 'v', '--generation', '1'], 'a decimal of at least 2'], [['p', '--version', 'v', '--generation', 'x'], 'a decimal of at least 2'],
      [['p', '--release', 'v', '--gen', '3'], 'a decimal of at least 2'], [['p', '--release', 'v1'], 'YYYYMMDD-HHMM'],
      [['p', '--version', 'v', '--reuse', 'p.20260922-0900'], 'a decimal of at least 2'], [['p', '--release', '20260923-1200', '--reuse', 'q.20260922-0900'], 'an earlier release of the product'],
      [['p', '--release', '20260923-1200', '--reuse'], 'an earlier release of the product'],
    ] as [string[], string][]) {
      expect(() => parseArgs(argv)).toThrow(ProductBuildError)
      expect(() => parseArgs(argv)).toThrow(fragment)
    }
  })
})

describe('the EFI target', () => {
  test('amd64 is x64, arm64 is aa64, anything else is refused', () => {
    expect(efiTarget('amd64')).toBe('x64')
    expect(efiTarget('arm64')).toBe('aa64')
    expect(() => efiTarget('riscv64')).toThrow('no EFI architecture for riscv64')
  })
})

describe('the receipt', () => {
  const board = join(REPO_ROOT, '_out/boards/uefi-x64'), signing = join(REPO_ROOT, 'meta')
  const ready = existsSync(join(board, 'kernel/kernel.release')) && existsSync(join(signing, 'updates/public.key'))
  test.skipIf(!ready)('lists the product files, every lock, the board and kernel facts, the certificates, then the tree, release, version and generation', () => {
    const text = receipt({ name: 'uefi-x64.dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '', version: 'v-test', generation: 3 })
    const lines = text.split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines.slice(-5, -1)).toEqual([expect.stringMatching(/^tree [0-9a-f]{40}( dirty)?$/), 'release none', 'version v-test', 'generation 3'])
    expect(lines.filter(l => / boards\/uefi-x64\/products\/dev\//.test(l)).length).toBeGreaterThan(0)
    expect(lines.filter(l => / locks\/pins\//.test(l)).length).toBeGreaterThan(0)
    expect(lines.some(l => /^[0-9a-f]{64} {2}_out\/boards\/uefi-x64\/board\.env$/.test(l))).toBe(true)
    expect(lines.some(l => /^[0-9a-f]{64} {2}meta\/updates\/public\.key$/.test(l))).toBe(true)
    expect(lines.every(l => l === '' || /^[0-9a-f]{64} {2}/.test(l) || /^(tree|release|version|generation) /.test(l))).toBe(true)
    expect(receipt({ name: 'uefi-x64.dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '20260923-1200', version: '20260923-1200', generation: 2, reuse: '' })).toContain('\nrelease 20260923-1200\nversion 20260923-1200\ngeneration 2\n')
  })
})

describe('the FIT tools architecture', () => {
  // An ELF64 little-endian header whose e_machine is the given number: all toolArch reads.
  const elf = (machine: number) => {
    const b = Buffer.alloc(64)
    b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b.writeUInt16LE(machine, 18)
    return b
  }
  const file = (bytes: Buffer) => {
    const path = join(mkdtempSync(join(tmpdir(), 'fit-tools-')), 'tool')
    writeFileSync(path, bytes)
    return path
  }
  test('x86-64 is amd64 and AArch64 is arm64', () => {
    expect(toolArch(file(elf(62)))).toBe('amd64')
    expect(toolArch(file(elf(183)))).toBe('arm64')
  })
  test('anything else is refused', () => {
    expect(() => toolArch(file(elf(40)))).toThrow('unsupported ELF machine 40')
    expect(() => toolArch(file(Buffer.from('#!/bin/sh\n')))).toThrow('not a little-endian 64-bit ELF')
  })
})
