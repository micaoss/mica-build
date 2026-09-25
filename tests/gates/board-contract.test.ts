// The board bundle contract over every board of the tree (make board-contract-test); the rules are
// tests/gates/board-contract.ts.
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { check as boardsCheck } from '../../src/boards/boards.ts'
import { contract } from './board-contract.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const BOARDS = readdirSync(join(REPO_ROOT, 'boards')).filter(b => existsSync(join(REPO_ROOT, 'boards', b, 'board.env'))).sort()

test('the contract has boards to hold: a directory with a board.env is a board', () => {
  expect(BOARDS.length).toBeGreaterThan(0)
})

test.each(BOARDS)('%s holds the board contract', (board) => {
  expect(contract(board)).toEqual([])
})

test('boards/boards.tsv lists every board, and its outputs.tsv are the tree\'s', () => {
  expect(() => boardsCheck()).not.toThrow()
})

// The refusals, each over a copy of a real board with exactly one defect: a contract that only ever sees healthy
// boards proves nothing about the ones it exists to stop.
describe('each refusal fires on its one defect', () => {
  const root = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'board-contract.'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const fresh = () => {
    rmSync(join(root, 'boards'), { recursive: true, force: true })
    for (const d of ['Makefile', 'locks', 'producers', 'common/package']) if (!existsSync(join(root, d))) cpSync(join(REPO_ROOT, d), join(root, d), { recursive: true, verbatimSymlinks: true })
    mkdirSync(join(root, 'boards'), { recursive: true })
    cpSync(join(REPO_ROOT, 'boards/uefi-x64'), join(root, 'boards/uefi-x64'), { recursive: true, verbatimSymlinks: true })
    cpSync(join(REPO_ROOT, 'boards/boards.tsv'), join(root, 'boards/boards.tsv'))
    return join(root, 'boards/uefi-x64')
  }
  const env = (d: string, from: RegExp, to: string) => writeFileSync(join(d, 'board.env'), readFileSync(join(d, 'board.env'), 'utf8').replace(from, to))
  test.each([
    ['the healthy copy', () => {}, undefined],
    ['a feature outside the vocabulary', (d: string) => env(d, /^BOARD_FEATURES="/m, 'BOARD_FEATURES="teleport '), 'BOARD_FEATURES names \'teleport\''],
    ['an IMAGE_KINDS line', (d: string) => env(d, /$/, '\nIMAGE_KINDS=disk\n'), 'declares IMAGE_KINDS'],
    ['no layout.tsv', (d: string) => rmSync(join(d, 'layout.tsv')), 'layout.tsv is missing'],
    ['a second disk row in layout.tsv', (d: string) => writeFileSync(join(d, 'layout.tsv'), readFileSync(join(d, 'layout.tsv'), 'utf8') + 'disk\t5AC35760-0064-4000-8000-000000000009\t512\t2048\n'), 'a second disk row'],
    ['a builtin image kind other than disk', (d: string) => writeFileSync(join(d, 'images.tsv'), readFileSync(join(d, 'images.tsv'), 'utf8') + 'image\traw\tbuiltin\t-\traw\n'), 'an image kind other than disk names the packer builtin'],
    ['a manifest line naming nothing a producer emits', (d: string) => writeFileSync(join(d, 'manifests/board.pkgs'), 'no-such-package\n'), 'which no producer of this repository emits'],
    ['a radio manifest for a radio the board lacks', (d: string) => writeFileSync(join(d, 'manifests/radio-wifi.pkgs'), 'mica-wifi\n'), 'names a radio the board\'s BOARD_FEATURES does not'],
    ['a command line without the signed-boot floor', (d: string) => env(d, / dm_verity\.require_signatures=1/, ''), 'lacks dm_verity.require_signatures=1'],
    ['a cgroup v1 command line', (d: string) => env(d, /rdinit=\/init/, 'rdinit=/init systemd.unified_cgroup_hierarchy=0'), 'selects a cgroup v1 hierarchy'],
    ['a board file outputs.tsv does not list', (d: string) => writeFileSync(join(d, 'manifests/component-extra.pkgs'), 'mica-wifi\n'), 'not listed by outputs.tsv: manifests/component-extra.pkgs'],
    ['half the boot logo', (d: string) => rmSync(join(d, 'package/overlay/etc/systemd/system/getty@tty1.service')), '4 of the five logo artefacts'],
    ['a producer inside the board', (d: string) => { writeFileSync(join(d, 'package/producer.env'), 'PACKAGES=stray\nARCHES=all\n'); writeFileSync(join(d, 'package/Dockerfile'), 'FROM scratch\n') }, 'carries a producer.env outside extras/'],
  ] as const)('%s', (_what, defect, message) => {
    const d = fresh()
    defect(d)
    const fails = contract('uefi-x64', root)
    if (message === undefined) expect(fails).toEqual([])
    else expect(fails.some(f => f.includes(message)), `wanted a refusal containing "${message}"; got ${JSON.stringify(fails)}`).toBe(true)
  })
})
