// The NEGATIVE half of the three-artefact logo equivalence of the board contract (tests/gates/board-contract.ts).
// Every board but the mini ones sets BOARD_BOOT_LOGO=1 and carries all three artefacts, so the contract only ever exercises its
// positive case; the refusals are exercised here over synthetic board directories, through the contract's own
// logoArtefacts -- one definition of "present", where the shell kept a second copy beside the first.
//
// ONE DEFECT PER FIXTURE, DELIBERATELY: a negative fixture that violates two rules tests neither, because the reader
// may refuse it for the other one. Each board below is a complete three-artefact board with exactly one thing removed
// or added (make logo-fixtures-test).
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logoAgrees, logoArtefacts } from './board-contract.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'logo-fixtures.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

/** A board with all three artefacts, and BOARD_BOOT_LOGO=<flag>. */
function complete(name: string, flag: 0 | 1): string {
  const d = join(T, name)
  for (const p of ['kernel/config', 'kernel/hooks']) mkdirSync(join(d, p), { recursive: true })
  writeFileSync(join(d, 'board.env'), `BOARD_CMDLINE_ARGS="ro fbcon=logo-pos:center,logo-count:1 vt.global_cursor_default=0"\nBOARD_BOOT_LOGO=${flag}\n`)
  writeFileSync(join(d, 'kernel/config/board.fragment'), 'CONFIG_LOGO=y\n')
  writeFileSync(join(d, 'kernel/hooks/prepare.sh'), 'bun mklogo.ts splash.png out.ppm 720 405\n')
  return d
}

const edit = (d: string, from: string, to: string) => writeFileSync(join(d, 'board.env'), readFileSync(join(d, 'board.env'), 'utf8').replace(from, to))

test('a board with the flag and all three artefacts is accepted', () => {
  expect(logoArtefacts(complete('all-three', 1))).toEqual({ flag: true, have: 3 })
})

test('a board with neither the flag nor any artefact is accepted', () => {
  const d = join(T, 'none')
  mkdirSync(join(d, 'kernel'), { recursive: true })
  writeFileSync(join(d, 'board.env'), 'BOARD_CMDLINE_ARGS="ro"\nBOARD_BOOT_LOGO=0\n')
  expect(logoArtefacts(d)).toEqual({ flag: false, have: 0 })
  expect(logoAgrees(logoArtefacts(d))).toBe(true)
})

test.each([
  ['the flag without CONFIG_LOGO', (d: string) => unlinkSync(join(d, 'kernel/config/board.fragment'))],
  ['the flag without the mklogo render', (d: string) => unlinkSync(join(d, 'kernel/hooks/prepare.sh'))],
  ['the flag without fbcon=logo-pos:', (d: string) => edit(d, ' fbcon=logo-pos:center,logo-count:1', '')],
  ['the flag without vt.global_cursor_default=0', (d: string) => edit(d, ' vt.global_cursor_default=0', '')],
] as const)('%s is refused', (name, defect) => {
  const d = complete(name.replace(/[^a-z0-9]+/g, '-'), 1)
  defect(d)
  const got = logoArtefacts(d)
  expect(got.have).toBe(2)
  expect(logoAgrees(got)).toBe(false)
})

// The other direction: artefacts without the flag, the case that would ship a policy protecting nothing.
test('the three artefacts without the flag are refused', () => {
  expect(logoAgrees(logoArtefacts(complete('policy-without-flag', 0)))).toBe(false)
})

test('a logo render with no flag and no logo is refused', () => {
  const d = join(T, 'render-only')
  mkdirSync(join(d, 'kernel/hooks'), { recursive: true })
  writeFileSync(join(d, 'board.env'), 'BOARD_CMDLINE_ARGS="ro"\nBOARD_BOOT_LOGO=0\n')
  writeFileSync(join(d, 'kernel/hooks/prepare.sh'), 'bun mklogo.ts splash.png out.ppm 720 405\n')
  expect(logoArtefacts(d)).toEqual({ flag: false, have: 1 })
  expect(logoAgrees(logoArtefacts(d))).toBe(false)
})
