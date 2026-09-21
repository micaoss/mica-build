// Path arithmetic, driven from the failing side.
//
// The reason this file exists rather than "the imports resolved, so the paths
// are right": they would also resolve if the count were wrong and the wrong
// directory happened to exist. Each ascent below is checked at the count it
// uses AND at the counts on either side, and the neighbours must FAIL. An
// anchor satisfied by more than one answer is not an anchor, and directories
// in this repository do move.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ascendTo } from './verify-package.ts'
import {
  BOARDS_DIR,
  boardEnvPath,
  FROM_SH,
  makeWorkDir,
  PACKAGE_DIR,
  REPO_ROOT,
  pinnedBoards,
  requireShippedBoards,
  shippedBoards,
  SRC_DIR,
  VERIFY_PACKAGE_DIR,
  WORK_DIR,
} from './paths.ts'

describe('every ascent is anchored, and the neighbours miss', () => {
  test('src is where this module lives', () => {
    expect(basename(SRC_DIR)).toBe('src')
    expect(existsSync(join(SRC_DIR, 'file-layout.ts'))).toBe(true)
  })

  test('the package directory: 1 up, and neither 0 nor 2', () => {
    expect(PACKAGE_DIR).toBe(ascendTo(SRC_DIR, 1, 'package.json', 'x'))
    expect(basename(PACKAGE_DIR)).toBe('build')
    expect(() => ascendTo(SRC_DIR, 0, 'package.json', 'x')).toThrow()
    expect(() => ascendTo(SRC_DIR, 2, 'package.json', 'x')).toThrow()
  })

  test('the repository root: 2 up, and neither 1 nor 3', () => {
    expect(existsSync(join(REPO_ROOT, 'Makefile'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'locks', 'pins'))).toBe(true)
    expect(() => ascendTo(SRC_DIR, 1, 'Makefile', 'x')).toThrow()
    expect(() => ascendTo(SRC_DIR, 3, 'Makefile', 'x')).toThrow()
  })

  test('verify: 2 up plus its own manifest, and neither 1 nor 3', () => {
    expect(basename(VERIFY_PACKAGE_DIR)).toBe('verify')
    expect(existsSync(join(VERIFY_PACKAGE_DIR, 'src', 'board.ts'))).toBe(true)
    expect(() => ascendTo(SRC_DIR, 1, 'verify/package.json', 'x')).toThrow()
    expect(() => ascendTo(SRC_DIR, 3, 'verify/package.json', 'x')).toThrow()
  })

  test('tools/from.sh: the resolver this package shells out to is where it says', () => {
    expect(FROM_SH).toBe(join(REPO_ROOT, 'tools', 'from.sh'))
    expect(existsSync(FROM_SH)).toBe(true)
    expect(() => ascendTo(SRC_DIR, 1, 'tools/from.sh', 'x')).toThrow()
    expect(() => ascendTo(SRC_DIR, 3, 'tools/from.sh', 'x')).toThrow()
  })

  test('a miscount names the path it computed, the marker and the count', () => {
    let msg = ''
    try {
      ascendTo(SRC_DIR, 1, 'locks', 'the repository root')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('the repository root')
    expect(msg).toContain('climbing 1 level')
    expect(msg).toContain(PACKAGE_DIR)
    expect(msg).toContain('locks')
  })
})

describe('the boards are discovered, not written down', () => {
  test('every shipped board is found, and by reading the directory', () => {
    const found = shippedBoards()
    // Asserted as a SET rather than as ">= 2": a discovery that returned the
    // right count of the wrong names would satisfy a count.
    // boards/boards.tsv is the board list; every assembled bundle is a listed board.
    for (const board of found) expect(pinnedBoards()).toContain(board)
    expect(found.length).toBeGreaterThan(1)
    for (const board of found) {
      expect(`${board}: ${existsSync(boardEnvPath(board))}`).toBe(`${board}: true`)
    }
  })

  test('_out/boards is where the fetched bundles are, and a board that is not there is not a path that is', () => {
    expect(BOARDS_DIR).toBe(join(REPO_ROOT, '_out', 'boards'))
    expect(existsSync(boardEnvPath('no-such-board'))).toBe(false)
    expect(shippedBoards()).not.toContain('no-such-board')
  })

  test('the positive control: requireShippedBoards agrees when there is something to find', () => {
    expect(requireShippedBoards()).toEqual(shippedBoards())
    expect(requireShippedBoards().length).toBeGreaterThan(1)
  })

  test('an empty discovery is REFUSED rather than handed on as an empty loop', () => {
    // Driven, not asserted about. "every board passed" over an empty list is
    // the green this tree keeps finding in its own checkers -- the shell lint's
    // RESULT: PASS (0/0 checks), run.sh's Ran 0 tests, the bash-oracle
    // comparison that agreed "on all 0 keys" -- so the refusal is reachable
    // from here and this runs it.
    const empty = makeWorkDir('no-boards')
    try {
      expect(shippedBoards(empty)).toEqual([])
      expect(() => requireShippedBoards(empty)).toThrow(/pass by asserting nothing/)
      expect(() => requireShippedBoards(empty)).toThrow(empty)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('a directory under boards/ with no board.env in it is not a board', () => {
    const dir = makeWorkDir('half-boards')
    try {
      mkdirSync(join(dir, 'notaboard'), { recursive: true })
      mkdirSync(join(dir, 'realboard'), { recursive: true })
      writeFileSync(join(dir, 'realboard', 'board.env'), 'LAYOUT_BOARD=realboard\n')
      // The definition file IS the board -- which is also why verify takes a
      // board's name from its DIRECTORY rather than from the filename.
      expect(shippedBoards(dir)).toEqual(['realboard'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scratch space is somewhere a container can see', () => {
  test('WORK_DIR is inside the repository, which /tmp is not', () => {
    // Not a style rule. A docker bind mount of anything under /tmp on this host
    // SUCCEEDS and delivers an empty directory, so a scratch file there is one
    // the tool cannot see -- reported as a file that does not exist.
    expect(WORK_DIR.startsWith(`${REPO_ROOT}/`)).toBe(true)
    expect(WORK_DIR.startsWith('/tmp/')).toBe(false)
  })

  test('makeWorkDir hands back a fresh directory each time', () => {
    const a = makeWorkDir('paths-test')
    const b = makeWorkDir('paths-test')
    try {
      expect(a).not.toBe(b)
      expect(existsSync(a)).toBe(true)
      expect(existsSync(b)).toBe(true)
      expect(a.startsWith(`${WORK_DIR}/`)).toBe(true)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
})
