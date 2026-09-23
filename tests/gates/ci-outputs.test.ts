// src/release/ci-outputs.ts: output tars packed per job unpack the same from a directory holding one of them
// (a board release) or several (CI), and a missing expected tar is refused rather than taken for a reused
// component. And bundle-is (src/boards/boards.ts): the ASSEMBLED shape, which `make offline` must produce and a
// consumer fetches from a release, built here from outputs.tsv itself rather than from a kernel build, so the
// check is exercised on every run instead of only on a machine that has just built four boards. The port of
// tests/gates/ci-outputs-test.sh (deleted 2026-09-23), case for case.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { boards, bundleIs, BoardsError, outputs } from '../../src/boards/boards.ts'
import { pack, unpack, CiOutputsError } from '../../src/release/ci-outputs.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const T = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'ci-outputs-test.'))
const OUT = join(REPO_ROOT, '_out')
const cleanup = () => { for (const p of ['ci-outputs-test', 'kernel-ci-outputs-test.tar', 'pool-ci-outputs-test.tar']) rmSync(join(OUT, p), { recursive: true, force: true }) }

afterAll(() => { rmSync(T, { recursive: true, force: true }); cleanup() })

test('output tars packed per job unpack the same from one artifact or several; a missing expected tar is refused', () => {
  cleanup()
  mkdirSync(join(OUT, 'ci-outputs-test/kernel'), { recursive: true }); mkdirSync(join(OUT, 'ci-outputs-test/debs/amd64'), { recursive: true })
  writeFileSync(join(OUT, 'ci-outputs-test/kernel/Image'), 'kernel\n')
  writeFileSync(join(OUT, 'ci-outputs-test/debs/amd64/Packages'), 'pool\n')
  pack('kernel-ci-outputs-test', ['ci-outputs-test/kernel'])
  pack('pool-ci-outputs-test', ['ci-outputs-test/debs/amd64'])
  for (const d of ['one', 'two', 'none']) mkdirSync(join(T, d), { recursive: true })
  writeFileSync(join(T, 'one/pool-ci-outputs-test.tar'), readFileSync(join(OUT, 'pool-ci-outputs-test.tar')))
  writeFileSync(join(T, 'two/pool-ci-outputs-test.tar'), readFileSync(join(OUT, 'pool-ci-outputs-test.tar')))
  writeFileSync(join(T, 'two/kernel-ci-outputs-test.tar'), readFileSync(join(OUT, 'kernel-ci-outputs-test.tar')))
  rmSync(join(OUT, 'ci-outputs-test'), { recursive: true })
  unpack(join(T, 'one'), ['pool-ci-outputs-test'])
  expect(readFileSync(join(OUT, 'ci-outputs-test/debs/amd64/Packages'), 'utf8')).toBe('pool\n')
  rmSync(join(OUT, 'ci-outputs-test'), { recursive: true })
  unpack(join(T, 'two'), ['pool-ci-outputs-test', 'kernel-ci-outputs-test'])
  expect(existsSync(join(OUT, 'ci-outputs-test/kernel/Image'))).toBe(true)
  expect(existsSync(join(OUT, 'ci-outputs-test/debs/amd64/Packages'))).toBe(true)
  expect(() => unpack(join(T, 'one'), ['pool-ci-outputs-test', 'kernel-ci-outputs-test'])).toThrow(/kernel-ci-outputs-test\.tar is missing/)
  expect(() => unpack(join(T, 'none'), [])).toThrow(CiOutputsError)
  expect(() => pack('Bad', ['ci-outputs-test/kernel'])).toThrow(/is not an artifact name/)
})

test('bundle-is accepts each board\'s whole bundle and refuses one file more or less', () => {
  for (const b of boards()) {
    const B = join(T, `bundle-${b.name}`)
    // One file per direction, so each refusal is provably about its own defect.
    for (const r of outputs(b.name)) {
      if (r[0] !== 'file') continue
      mkdirSync(dirname(join(B, r[2]!)), { recursive: true })
      writeFileSync(join(B, r[2]!), '')
    }
    expect(() => bundleIs(b.name, B), `${b.name}: exactly its outputs.tsv files`).not.toThrow()
    writeFileSync(join(B, 'unexpected-file'), '')
    expect(() => bundleIs(b.name, B), `${b.name}: an unlisted file`).toThrow(BoardsError)
    rmSync(join(B, 'unexpected-file'))
    rmSync(join(B, 'board.env'))
    expect(() => bundleIs(b.name, B), `${b.name}: a missing file`).toThrow(/missing board.env/)
  }
})
