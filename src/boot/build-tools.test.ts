// src/boot/build-tools.ts without docker: the target the argument and MICA_BOOT_TARGET agree on, and the
// inputs label, which is the shell's `sha256sum` over the same lines (a kernel component's buildId names it, so
// the port must not move it).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BuildToolsError, inputsLabel, STAGE_FILES, target, TOOLS_PLATFORM } from './build-tools.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('the target', () => {
  test('the argument, MICA_BOOT_TARGET, or x64; a disagreement and an unknown target are refused with 64', () => {
    expect(target([], {})).toBe('x64')
    expect(target([], { MICA_BOOT_TARGET: 'aa64' })).toBe('aa64')
    expect(target(['--target', 'aa64'], {})).toBe('aa64')
    expect(target(['--target', 'aa64'], { MICA_BOOT_TARGET: 'aa64' })).toBe('aa64')
    for (const [argv, env, message] of [
      [['--target', 'x64'], { MICA_BOOT_TARGET: 'aa64' }, 'conflicting boot-tools targets'],
      [['--target', 'ia32'], {}, 'must be x64 or aa64'],
      [[], { MICA_BOOT_TARGET: 'arm' }, 'must be x64 or aa64'],
      [['x64'], {}, 'usage'],
      [['--target'], {}, 'usage'],
    ] as [string[], Record<string, string>, string][]) {
      expect(() => target(argv, env)).toThrow(BuildToolsError)
      expect(() => target(argv, env)).toThrow(message)
      try { target(argv, env) }
      catch (e) { expect((e as BuildToolsError).code).toBe(64) }
    }
  })
})

describe('the inputs label', () => {
  test('is sha256 over the base, snapshot, target and loader lines and the sha256sum lines of the stage files', () => {
    const d = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'build-tools-test.'))
    try {
      const loader = join(d, 'loader.deb')
      writeFileSync(loader, 'not a deb\n')
      const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
      const expected = sha([`base b@sha256:0\nsnapshot http://s\ntarget x64\nloader ${sha('not a deb\n')}\n`,
        ...STAGE_FILES.map(f => `${sha(readFileSync(join(REPO_ROOT, 'stages/boot', f)))}  ${f}\n`)].join(''))
      expect(inputsLabel('b@sha256:0', 'http://s', 'x64', loader)).toBe(expected)
      expect(inputsLabel('b@sha256:0', 'http://s', 'aa64', loader)).not.toBe(expected)
    }
    finally { rmSync(d, { recursive: true, force: true }) }
  })
  test('every image is built for linux/amd64', () => {
    expect(TOOLS_PLATFORM).toBe('linux/amd64')
    expect(STAGE_FILES).toEqual(['Dockerfile', 'initramfs.sh', 'kernel.sh', 'compression.sh', 'elf-closure.sh'])
  })
})
