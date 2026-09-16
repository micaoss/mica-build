// Path arithmetic, driven from the failing side.
//
// The reason this file exists rather than "the imports resolved, so the paths
// are right": they would also resolve if the count were wrong and the wrong
// directory happened to exist. Each ascent below is therefore checked at the
// count it uses AND at the counts on either side of it, and the neighbours
// must FAIL. An anchor that is satisfied by more than one answer is not an
// anchor.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  ascendTo, BOARDS_DIR, boardEnvPath, PACKAGE_DIR, REPO_ROOT,
  pinnedBoards, requireShippedBoards, shippedBoards, SRC_DIR,
} from './paths.ts'

describe('every ascent is anchored, and the neighbours miss', () => {
  test('src is where this module lives', () => {
    expect(basename(SRC_DIR)).toBe('src')
    expect(existsSync(join(SRC_DIR, 'board-env.ts'))).toBe(true)
  })

  test('the package directory: 1 up, and neither 0 nor 2', () => {
    expect(PACKAGE_DIR).toBe(ascendTo(SRC_DIR, 1, 'package.json', 'x'))
    expect(basename(PACKAGE_DIR)).toBe('verify')
    expect(() => ascendTo(SRC_DIR, 0, 'package.json', 'x')).toThrow()
    expect(() => ascendTo(SRC_DIR, 2, 'package.json', 'x')).toThrow()
  })

  test('the repository root: 2 up, and neither 1 nor 3', () => {
    expect(existsSync(join(REPO_ROOT, 'Makefile'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'locks', 'pins'))).toBe(true)
    expect(() => ascendTo(SRC_DIR, 1, 'Makefile', 'x')).toThrow()
    expect(() => ascendTo(SRC_DIR, 3, 'Makefile', 'x')).toThrow()
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

describe('the board definitions the package reads', () => {
  test('_out/boards holds every pinned board, fetched out of its bundle', () => {
    expect(BOARDS_DIR).toBe(join(REPO_ROOT, '_out', 'boards'))
    for (const board of pinnedBoards()) {
      expect(`${board}: ${existsSync(boardEnvPath(board))}`).toBe(`${board}: true`)
    }
  })

  test('a board that does not exist is not silently a path that does', () => {
    expect(existsSync(boardEnvPath('no-such-board'))).toBe(false)
  })
})

describe('the shipped boards are DISCOVERED, not written down', () => {
  // A literal list is green by having looked at less: measured on 2026-08-26,
  // a third definition under boards/ was never opened by the lint, which
  // went on reporting `RESULT: PASS (26/26 checks)` and never named it.

  function tree(entries: ReadonlyArray<readonly [string, boolean]>): string {
    const dir = mkdtempSync(join(tmpdir(), 'mica-boards-'))
    for (const [name, withEnv] of entries) {
      mkdirSync(join(dir, name), { recursive: true })
      if (withEnv) writeFileSync(join(dir, name, 'board.env'), 'LAYOUT_VERSION=2\n')
    }
    return dir
  }

  test('a board added to the directory is FOUND, with no list to update', () => {
    const dir = tree([['cx3576', true], ['uefi-x64', true], ['zztest', true]])
    try {
      expect(shippedBoards(dir)).toEqual(['cx3576', 'uefi-x64', 'zztest'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the answer is SORTED, so a run\'s order does not depend on the filesystem', () => {
    const dir = tree([['zzz', true], ['aaa', true], ['mmm', true]])
    try {
      expect(shippedBoards(dir)).toEqual(['aaa', 'mmm', 'zzz'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a directory with NO board.env is not a board', () => {
    // The definition file IS the board -- which is also why boardNameForPath
    // takes the name from the directory. A leftover scratch directory under
    // boards/ must not become a board the lint then fails to read.
    const dir = tree([['cx3576', true], ['scratch', false]])
    try {
      expect(shippedBoards(dir)).toEqual(['cx3576'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a FILE beside the board directories is not a board either', () => {
    const dir = tree([['cx3576', true]])
    try {
      writeFileSync(join(dir, 'README.md'), '# boards\n')
      expect(shippedBoards(dir)).toEqual(['cx3576'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an EMPTY discovery is refused, because an empty loop is a green suite', () => {
    // The guard that makes the discovery safe to build checks on. Reachable
    // only because the directory is a parameter: a guard that could fire only
    // when the real boards/ was empty is a guard nobody has ever run.
    const dir = tree([['scratch', false]])
    try {
      expect(() => requireShippedBoards(dir)).toThrow(/would run over an empty list/)
      expect(() => requireShippedBoards(dir)).toThrow(dir)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('and the real tree answers with the boards that are actually in it', () => {
    // Not a literal comparison -- that would reinstate exactly what this
    // replaced. The assertion is that discovery and the directory agree.
    const onDisk = readdirSync(BOARDS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(BOARDS_DIR, e.name, 'board.env')))
      .map(e => e.name).sort()
    expect(requireShippedBoards()).toEqual(onDisk)
    expect(requireShippedBoards().length).toBeGreaterThan(0)
  })
})
