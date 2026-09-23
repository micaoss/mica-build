// src/product/build.ts without a build: the command line (the name, the mode, the stamp and the generation),
// the EFI target of an architecture, and the receipt's shape over the tree's own files.
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { efiTarget, parseArgs, ProductBuildError, receipt } from './build.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('the command line', () => {
  test('the name alone builds; --verify verifies; --version and --release carry a stamp and an optional generation', () => {
    expect(parseArgs(['p'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: '', generation: 2 })
    expect(parseArgs(['p', '--verify'])).toEqual({ name: 'p', mode: 'verify', release: '', stamp: '', generation: 2 })
    expect(parseArgs(['p', '--version', 'v1'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: 'v1', generation: 2 })
    expect(parseArgs(['p', '--version', 'v1', '--generation', '7'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: 'v1', generation: 7 })
    expect(parseArgs(['p', '--release', '20260923-1200'])).toEqual({ name: 'p', mode: 'build', release: '20260923-1200', stamp: '20260923-1200', generation: 2 })
  })
  test('the refusals: no name, a bad mode, a missing stamp, a generation below 2, a release name out of form', () => {
    for (const [argv, fragment] of [
      [[], 'usage'], [['p', '--bogus'], 'usage'], [['p', '--verify', 'x'], 'usage'], [['p', '--version'], 'usage'], [['p', 'extra'], 'usage'],
      [['p', '--version', 'v', '--generation', '1'], 'a decimal of at least 2'], [['p', '--version', 'v', '--generation', 'x'], 'a decimal of at least 2'],
      [['p', '--release', 'v', '--gen', '3'], 'a decimal of at least 2'], [['p', '--release', 'v1'], 'YYYYMMDD-HHMM'],
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
    const text = receipt({ name: 'uefi-x64-dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '', version: 'v-test', generation: 3 })
    const lines = text.split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines.slice(-5, -1)).toEqual([expect.stringMatching(/^tree [0-9a-f]{40}( dirty)?$/), 'release none', 'version v-test', 'generation 3'])
    expect(lines.filter(l => / products\/uefi-x64-dev\//.test(l)).length).toBeGreaterThan(0)
    expect(lines.filter(l => / locks\/pins\//.test(l)).length).toBeGreaterThan(0)
    expect(lines.some(l => /^[0-9a-f]{64} {2}_out\/boards\/uefi-x64\/board\.env$/.test(l))).toBe(true)
    expect(lines.some(l => /^[0-9a-f]{64} {2}meta\/updates\/public\.key$/.test(l))).toBe(true)
    expect(lines.every(l => l === '' || /^[0-9a-f]{64} {2}/.test(l) || /^(tree|release|version|generation) /.test(l))).toBe(true)
    expect(receipt({ name: 'uefi-x64-dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '20260923-1200', version: '20260923-1200', generation: 2 })).toContain('\nrelease 20260923-1200\nversion 20260923-1200\ngeneration 2\n')
  })
})
