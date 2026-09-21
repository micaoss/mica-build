import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { kernelDirectory, loadBoardFacts, type BoardFacts, type Profile } from './board-facts.ts'
import { profileCommandLine } from './kernel-package.ts'
import { BOARDS_DIR } from './paths.ts'

// The forced kernel command line (CONFIG_CMDLINE) is asserted against
// board.env in micaoss/mica-boards (boards/<board>/tests/kernel-cmdline-test.sh), where the
// kernel configuration lives; this file holds the two legs the assembly owns:
// the board's authenticated line, which the kernel component packs, and the
// built kernel's forced line out of the imported bundle.
//
// *** EVERY FIT BOARD, BY THE FACT AND NOT BY A LITERAL. *** This file named
// one board until 2026-09-21, and the assertion was right while the
// population was half: the other FIT board's kernel had been built without
// the two tokens its own board.env declares, and nothing here saw it. The
// divergence surfaced in a ten-minute release-products build instead of in
// this test, because one product answered for one product in a file whose
// subject looks general. A `.test.ts` is exempt from tests/board-name-lint.sh
// -- fixtures name boards on purpose -- which is exactly why a hardcoded
// board here was invisible to everything. Selected by backend now, so a third
// FIT board joins the day it is pinned.
const fitBoards: BoardFacts[] = readdirSync(BOARDS_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => loadBoardFacts(entry.name))
  .filter(facts => facts.backend === 'uboot-fit')

const builtCmdline = (facts: BoardFacts, profile: Profile) =>
  /^CONFIG_CMDLINE="(.*)"$/m.exec(readFileSync(join(kernelDirectory(facts, profile), 'config'), 'utf8'))?.[1]

// A test that iterates a list must refuse an empty one: with no board fetched
// every case below would be skipped and the file would report success having
// asserted nothing.
test('the imported bundles carry at least one FIT board to check', () => {
  expect(fitBoards.length).toBeGreaterThan(0)
})

const cases: [string, BoardFacts, () => string | undefined][] = fitBoards.flatMap(facts => [
  [`${facts.board}: authenticated packaging`, facts, () => facts.cmdline] as [string, BoardFacts, () => string | undefined],
  [`${facts.board}: the built dev kernel`, facts, () => builtCmdline(facts, 'dev')] as [string, BoardFacts, () => string | undefined],
  [`${facts.board}: the built prod kernel`, facts, () => builtCmdline(facts, 'prod')] as [string, BoardFacts, () => string | undefined],
])

test.each(cases)('%s shows one centered HDMI logo with no VT cursor', (_source, _facts, read) => {
  const cmdline = read()
  expect(cmdline).toBeDefined()
  const args = cmdline!.split(/\s+/)
  expect(args.filter(arg => arg.startsWith('fbcon='))).toEqual(['fbcon=logo-pos:center,logo-count:1'])
  expect(args.filter(arg => arg.startsWith('vt.global_cursor_default='))).toEqual(['vt.global_cursor_default=0'])
})

const profileCases: [string, BoardFacts, Profile][] = fitBoards.flatMap(facts =>
  (['dev', 'prod'] as Profile[]).map(profile => [`${facts.board} ${profile}`, facts, profile] as [string, BoardFacts, Profile]),
)

test.each(profileCases)('the built %s kernel forces the board line with its profile token', (_label, facts, profile) => {
  expect(builtCmdline(facts, profile)).toBe(profileCommandLine(facts.cmdline, profile))
})
