// src/boot/dev-keys.ts and src/boot/init-keys.ts without docker: the refusals that come before any container
// runs -- an existing or aliased output, a symlink in the signing path, the usage -- and the lock two
// initializers of one directory share. tests/gates/trust-domain-hygiene-test.sh drives the generation and the
// validation themselves.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DevKeysError, generate, main as devKeysMain, present } from './dev-keys.ts'
import { initialize, InitKeysError, lockPath, main as initKeysMain } from './init-keys.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const T = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'keys-test.'))

describe('dev-keys', () => {
  test('an existing output, a symlink to one and a dangling symlink are refused before anything is minted', () => {
    mkdirSync(join(T, 'keys'))
    symlinkSync('keys', join(T, 'alias'))
    symlinkSync('nowhere', join(T, 'dangling'))
    for (const out of ['keys', 'alias', 'dangling']) {
      expect(present(join(T, out))).toBe(true)
      expect(() => generate(join(T, out))).toThrow(DevKeysError)
      expect(() => generate(join(T, out))).toThrow('key output already exists')
    }
    expect(present(join(T, 'absent'))).toBe(false)
  })
  test('the usage is refused with 2', async () => {
    expect(await devKeysMain([])).toBe(2)
    expect(await devKeysMain(['--out'])).toBe(2)
    expect(await devKeysMain(['--output', join(T, 'x')])).toBe(2)
    expect(await devKeysMain(['--out', join(T, 'keys')])).toBe(1)
  })
})

describe('init-keys', () => {
  test('a symlink anywhere in the signing path is refused, an output alias included', () => {
    mkdirSync(join(T, 'real/inner'), { recursive: true })
    symlinkSync('real', join(T, 'linked'))
    for (const out of [join(T, 'linked/inner'), join(T, 'linked'), join(T, 'alias')]) {
      expect(() => initialize(out)).toThrow(InitKeysError)
      expect(() => initialize(out)).toThrow('signing path contains a symlink')
    }
  })
  test('a file where the directory should be is refused', () => {
    writeFileSync(join(T, 'file'), 'x')
    expect(() => initialize(join(T, 'file'))).toThrow('invalid signing directory')
  })
  test('the lock is one file per output, under .tmp', () => {
    expect(lockPath('/a')).toBe(lockPath('/a'))
    expect(lockPath('/a')).not.toBe(lockPath('/b'))
    expect(lockPath('/a').startsWith(join(REPO_ROOT, '.tmp/key-init-'))).toBe(true)
    expect(lockPath('/a')).toMatch(/\.lock$/)
  })
  test('the usage is refused with 2', async () => {
    expect(await initKeysMain(['--out'])).toBe(2)
    expect(await initKeysMain(['--out', 'a', 'b'])).toBe(2)
    expect(await initKeysMain(['--output', join(T, 'x')])).toBe(2)
  })
})

afterAll(() => rmSync(T, { recursive: true, force: true }))
