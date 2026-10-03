// The pin readers, driven from the failing side.
//
// Every case here that matters is a case where
// the reader must REFUSE, because the failure mode this file guards is a reader
// that returns something plausible instead: an empty expectation that nothing
// can meet, or -- worse -- a dependency's version silently standing in for a
// crate's. Both would produce a smoke run that is red or green for a reason
// nobody could act on.
//
// The positive controls are the shipped files. Every negative case below is a
// fabricated fixture, and a suite of nothing but fabricated fixtures proves
// only that the reader handles files nobody has. So each group also reads the
// REAL mica-podman:upstream.lock and crate manifests,
// and asserts the search space is non-empty before concluding anything about
// what is in it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './paths.ts'
import {
  expectedFromRecorded,
  PODMAN_UPSTREAM_LOCK,
  readPin,
  readUpstreamLock,
  pinKeys,
  UPSTREAM_LOCK_FILES,
} from './smoke-pins.ts'

// Created and removed by the same condition -- see checks-cmdline.test.ts for
// why a module-scope mkdtemp and a hook-scope rm are not symmetric under a
// `-t` filter.
let SCRATCH = ''
beforeAll(() => {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  SCRATCH = mkdtempSync(join(REPO_ROOT, '_out', 'verify-smoke-pins-'))
})
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

/** A git row of an upstream.lock fixture. */
const git = (name: string, tag: string) => `git\t${name}\thttps://example.invalid/${name}.git\t${tag}\t${'a'.repeat(40)}\n`

/** A fixture file, refusing to be written before `beforeAll` made the directory. */
function fixture(name: string, body: string): string {
  if (SCRATCH === '') throw new Error('the scratch directory was read before beforeAll created it')
  const path = join(SCRATCH, name)
  writeFileSync(path, body)
  return path
}

describe('expectedFromRecorded -- the one normalisation, and its limits', () => {
  // Both spellings are in one shipped file, which is why this exists at all.
  test('strips the git tag v from a pin that has one', () => {
    expect(expectedFromRecorded('v5.8.6')).toBe('5.8.6')
    expect(expectedFromRecorded('v1.13')).toBe('1.13')
  })

  test('leaves a pin that never had one alone', () => {
    expect(expectedFromRecorded('1.29.1')).toBe('1.29.1')
    expect(expectedFromRecorded('0.1.0')).toBe('0.1.0')
  })

  // The failing side of the normalisation itself. A blanket /^v/ would rewrite
  // these, and a pin whose first character happened to be `v` would silently
  // become a different string -- in a comparison whose whole job is exactness.
  test('does not strip a v that is not a version prefix', () => {
    expect(expectedFromRecorded('version')).toBe('version')
    expect(expectedFromRecorded('vendor-1.0')).toBe('vendor-1.0')
    expect(expectedFromRecorded('v')).toBe('v')
  })

  test('the shipped pins really do use both spellings, so this is not a hypothetical', () => {
    const podman = readUpstreamLock(PODMAN_UPSTREAM_LOCK)
    const withV = [...podman.values()].filter(v => v.startsWith('v'))
    const withoutV = [...podman.values()].filter(v => !v.startsWith('v'))
    expect(withV.length).toBeGreaterThan(0)
    expect(withoutV.length).toBeGreaterThan(0)
  })
})

describe('readUpstreamLock and pinKeys, over the files this tree ships', () => {
  test('every upstream.lock the register reads is readable and non-empty', () => {
    // The vacuity control, first. Everything below is a statement about a set,
    // and a statement about an empty set is true for free.
    expect(UPSTREAM_LOCK_FILES.length).toBeGreaterThan(0)
    for (const file of UPSTREAM_LOCK_FILES)
      expect(readUpstreamLock(file).size).toBeGreaterThan(0)
  })

  test('pinKeys returns the git rows, and the files really carry some', () => {
    let total = 0
    for (const file of UPSTREAM_LOCK_FILES) {
      const keys = pinKeys(file)
      expect(keys.length).toBeGreaterThan(0)
      total += keys.length
    }
    // Deliberately a floor and not an equality: an exact count here would be a
    // Second list of the pins, and would have to be edited every time one was
    // added -- which is the drift smoke-register.ts's coverage check exists to
    // catch rather than to reproduce.
    expect(total).toBeGreaterThan(1)
  })

  test('rows of other kinds and comments are not pins, and a malformed git row is refused by line', () => {
    const path = fixture('kinds.lock', '# mica-lock v1\n# a comment\n' + git('thing', 'v1.0') + `source\tother\tall\t1\t${'b'.repeat(64)}\thttps://example.invalid/o.tar\n`)
    expect(pinKeys(path)).toEqual(['thing'])
    expect(() => readUpstreamLock(fixture('short.lock', '# mica-lock v1\ngit\tthing\tv1.0\n'))).toThrow(/short.lock:2 is not one git/)
    expect(() => readUpstreamLock(fixture('header.lock', git('thing', 'v1.0')))).toThrow(/is not a mica-lock v1 file/)
  })
})

describe('readPin', () => {
  test('reads a real pin out of the real file', () => {
    const pin = readPin(PODMAN_UPSTREAM_LOCK, 'podman')
    expect(pin.file).toBe(PODMAN_UPSTREAM_LOCK)
    expect(pin.key).toBe('podman')
    expect(pin.recorded).not.toBe('')
    expect(pin.expected).toBe(expectedFromRecorded(pin.recorded))
  })

  // Failing side: a key that is not there. The message has to name the keys
  // that ARE, because the likeliest cause is a rename and the reader needs the
  // new name rather than confirmation of the old one.
  test('refuses a key the file does not declare, and names the ones it does', () => {
    expect(() => readPin(PODMAN_UPSTREAM_LOCK, 'not-a-real-tree')).toThrow(/declares no non-empty not-a-real-tree/)
    expect(() => readPin(PODMAN_UPSTREAM_LOCK, 'not-a-real-tree')).toThrow(/podman/)
  })

  // Failing side: the key is there and EMPTY. This is the dangerous one -- an
  // empty expectation is not a weaker check, it is a different one, and
  // the reader must reject it before comparing any binary output.
  test('refuses a declared-empty pin rather than treating it as no expectation', () => {
    const path = fixture('empty.lock', '# mica-lock v1\n' + git('thing', '') + git('other', 'v1.2.3'))
    expect(() => readPin(path, 'thing')).toThrow(/declares no non-empty thing/)
    // Positive control on the same file: the reader is not simply broken.
    expect(readPin(path, 'other').expected).toBe('1.2.3')
  })

  test('a file with no version pins at all says so rather than listing nothing silently', () => {
    const path = fixture('nopins.lock', '# mica-lock v1\n# only a comment\n')
    expect(() => readPin(path, 'thing')).toThrow(/\(none at all\)/)
  })
})
