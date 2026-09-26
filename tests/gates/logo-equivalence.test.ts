// The NEGATIVE half of the four-artefact logo equivalence of the board contract (tests/gates/board-contract.ts).
// Every board but the mini ones sets BOARD_BOOT_LOGO=1 and carries all four artefacts, so the contract only ever exercises its
// positive case; the refusals are exercised here over synthetic board directories, through the contract's own
// logoArtefacts -- one definition of "present", where the shell kept a second copy beside the first.
//
// ONE DEFECT PER FIXTURE, DELIBERATELY: a negative fixture that violates two rules tests neither, because the reader
// may refuse it for the other one. Each board below is a complete four-artefact board with exactly one thing removed
// or added (make logo-fixtures-test). The port of tests/gates/logo-equivalence-fixtures.sh (deleted 2026-09-25),
// case for case.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logoAgrees, logoArtefacts } from './board-contract.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'logo-fixtures.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const DROPIN = 'package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf'
// The getty@tty1 mask is not one of them: every root carries it (src/rootfs/runtime/consumers.json), logo or none, so
// the contract holds it as a rule of its own and a fixture here carries it either way.
const MASK = 'package/overlay/etc/systemd/system/getty@tty1.service'

/** A board with all four artefacts, and BOARD_BOOT_LOGO=<flag>. */
function complete(name: string, flag: 0 | 1): string {
  const d = join(T, name)
  for (const p of ['kernel/config', 'kernel/hooks', 'package/overlay/etc/systemd/logind.conf.d', 'package/overlay/etc/systemd/system']) mkdirSync(join(d, p), { recursive: true })
  writeFileSync(join(d, 'board.env'), `BOARD_CMDLINE_ARGS="ro fbcon=logo-pos:center,logo-count:1 vt.global_cursor_default=0"\nBOARD_BOOT_LOGO=${flag}\n`)
  writeFileSync(join(d, 'kernel/config/board.fragment'), 'CONFIG_LOGO=y\n')
  writeFileSync(join(d, 'kernel/hooks/prepare.sh'), 'bun mklogo.ts splash.png out.ppm 720 405\n')
  writeFileSync(join(d, DROPIN), '[Login]\nNAutoVTs=0\nReserveVT=2\n')
  symlinkSync('/dev/null', join(d, MASK))
  return d
}

const edit = (d: string, from: string, to: string) => writeFileSync(join(d, 'board.env'), readFileSync(join(d, 'board.env'), 'utf8').replace(from, to))

test('a board with the flag and all four artefacts is accepted', () => {
  expect(logoArtefacts(complete('all-four', 1))).toEqual({ flag: true, have: 4 })
})

test('a board with neither the flag nor any artefact is accepted, and the mask does not count', () => {
  const d = join(T, 'none')
  mkdirSync(join(d, 'kernel'), { recursive: true }); mkdirSync(join(d, 'package/overlay/etc/systemd/system'), { recursive: true })
  writeFileSync(join(d, 'board.env'), 'BOARD_CMDLINE_ARGS="ro"\nBOARD_BOOT_LOGO=0\n')
  symlinkSync('/dev/null', join(d, MASK))
  expect(logoArtefacts(d)).toEqual({ flag: false, have: 0 })
  expect(logoAgrees(logoArtefacts(d))).toBe(true)
})

test.each([
  ['the flag without the logind drop-in', (d: string) => unlinkSync(join(d, DROPIN))],
  ['the flag without CONFIG_LOGO', (d: string) => unlinkSync(join(d, 'kernel/config/board.fragment'))],
  ['the flag without the mklogo render', (d: string) => unlinkSync(join(d, 'kernel/hooks/prepare.sh'))],
  ['the flag without fbcon=logo-pos:', (d: string) => edit(d, ' fbcon=logo-pos:center,logo-count:1', '')],
  ['the flag without vt.global_cursor_default=0', (d: string) => edit(d, ' vt.global_cursor_default=0', '')],
] as const)('%s is refused', (name, defect) => {
  const d = complete(name.replace(/[^a-z0-9]+/g, '-'), 1)
  defect(d)
  const got = logoArtefacts(d)
  expect(got.have).toBe(3)
  expect(logoAgrees(got)).toBe(false)
})

// The other direction: artefacts without the flag, the case that would ship a policy protecting nothing.
test('the four artefacts without the flag are refused', () => {
  expect(logoAgrees(logoArtefacts(complete('policy-without-flag', 0)))).toBe(false)
})

test('a drop-in with no flag and no logo is refused', () => {
  const d = join(T, 'dropin-only')
  mkdirSync(join(d, 'kernel'), { recursive: true }); mkdirSync(join(d, 'package/overlay/etc/systemd/logind.conf.d'), { recursive: true })
  writeFileSync(join(d, 'board.env'), 'BOARD_CMDLINE_ARGS="ro"\nBOARD_BOOT_LOGO=0\n')
  writeFileSync(join(d, DROPIN), '[Login]\nNAutoVTs=0\n')
  expect(logoArtefacts(d)).toEqual({ flag: false, have: 1 })
  expect(logoAgrees(logoArtefacts(d))).toBe(false)
})
