// Where this package sits, and the proof that it still does.
//
// The reasoning is src/verify/paths.ts's and the helper IS its function,
// imported through verify-package.ts rather than copied. Counted `..` over
// directories always produces a path, so a stale count fails later on an empty
// directory rather than an absent one; every ascent here is anchored on
// something that must be at the destination, and the failure names the path.
//
// Two anchors verify does not have: verify itself, because the board
// model build stands on lives there (see verify-package.ts) and naming it
// here tells a reader which of the two packages moved instead of a bare
// "Cannot find module" from bun.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ascendTo } from './verify-package.ts'

/** `src/image` -- resolved from this module, not from the caller's cwd. */
export const SRC_DIR: string = import.meta.dir

/** The repository root, anchored on the Makefile that routes every target. */
export const REPO_ROOT: string = ascendTo(SRC_DIR, 2, 'Makefile', 'the repository root')

/** `_out/boards`: the fetched board bundles (tools/board-pool.sh --fetch). */
export const BOARDS_DIR: string = join(REPO_ROOT, '_out', 'boards')

/** `locks`: the release locks this tree pins. */
export const LOCKS_DIR: string = join(REPO_ROOT, 'locks')

/** `boards/boards.tsv`: the boards this tree has, one row each (tools/boards.sh). */
export const BOARDS_LIST: string = join(REPO_ROOT, 'boards', 'boards.tsv')

/** `_out/boards/<board>/board.env`, out of the fetched bundle. */
export function boardEnvPath(board: string): string {
  return join(BOARDS_DIR, board, 'board.env')
}

/**
 * The boards this tree ships, in name order, read off the tree. Discovered
 * rather than written down: src/verify/lint.ts keeps the same
 * list as a literal (`SHIPPED_BOARDS = ['cx3576', 'uefi-x64']`), and every geometry
 * assertion here iterates this list, so a board added to boards/ and not to
 * a literal is a board nothing here ever read, with the suite green by having
 * looked at less. A directory listing cannot fall behind the directory. A
 * `boards/<name>/` with no `board.env` is not a board and is skipped: the
 * definition file IS the board, which is why boardNameForPath in verify
 * takes the name from the directory. The caller must still refuse an empty
 * answer (requireShippedBoards); the directory is a parameter so that refusal
 * is reachable from a test, a guard firing only on an empty boards/ being a
 * guard nobody has run.
 */
export function shippedBoards(dir: string = BOARDS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, e.name, 'board.env')))
    .map(e => e.name)
    .sort()
}

/**
 * shippedBoards(), refusing an answer that would make its caller vacuous.
 *
 * A discovery that finds nothing hands every `for (const b of boards)` an empty
 * loop, and a suite of empty loops is green. That is the exact failure this
 * tree keeps finding in its own checkers -- the shell lint's "RESULT: PASS
 * (0/0 checks)", run.sh's `Ran 0 tests`, the bash-oracle comparison that
 * "agreed on all 0 keys" -- so a discovery used as a test's input refuses to
 * return nothing, by name, rather than letting the caller decide to notice.
 */
/**
 * The boards this tree has: boards/boards.tsv (mica-boards boards v1), one row
 * per board. A board exists here exactly when that list names it; its
 * definition is read out of the assembled bundle under BOARDS_DIR
 * (tools/board-pool.sh --fetch).
 */
export function pinnedBoards(list: string = BOARDS_LIST): string[] {
  const text = readFileSync(list, 'utf8')
  const lines = text.split('\n')
  if (lines[0] !== '# mica-boards boards v1') throw new Error(`${list} is not mica-boards boards v1`)
  return [...new Set(lines.slice(1).filter(line => line !== '' && !line.startsWith('#')).map(line => line.split('\t')[0]!))].sort()
}

export function requireShippedBoards(dir: string = BOARDS_DIR, pins: string = BOARDS_LIST): string[] {
  const boards = shippedBoards(dir)
  // The real tree: every assembled board is a listed one. Not every listed
  // board need be assembled -- a product's build assembles its own board only
  // -- but a directory the list does not name is a board nothing else reads.
  if (dir === BOARDS_DIR) {
    const listed = pinnedBoards(pins)
    const stale = boards.filter(b => !listed.includes(b))
    if (stale.length > 0) throw new Error(`${dir} holds ${stale.join(', ')}, which ${pins} does not list; run: make board-fetch-all`)
  }
  if (boards.length === 0) {
    throw new Error(
      `no board defines a board.env under ${dir}, so every check that iterates the shipped boards `
      + `would run over an empty list and pass by asserting nothing. Either this path is stale or `
      + `that directory holds no board.`,
    )
  }
  return boards
}

/**
 * Scratch space for anything that has to exist as a FILE on disk.
 *
 * Under the package rather than under /tmp, and that is not a preference. On
 * this host a docker bind mount of anything under /tmp succeeds and delivers an
 * empty directory -- measured 2026-08-25, and bin/bun.sh src/cli.ts carries a guard
 * whose whole job is to name that failure when it happens. Every tool this
 * package drives may be running in a container, so a scratch file under /tmp
 * would be a file the tool cannot see, reported as a file that does not exist.
 * Inside the repository it is covered by the identity mount that is already
 * there. `.work/` is gitignored.
 */
export const WORK_DIR: string = join(REPO_ROOT, '.work')

/** A fresh scratch directory under WORK_DIR. The caller removes it. */
export function makeWorkDir(prefix: string): string {
  mkdirSync(WORK_DIR, { recursive: true })
  return mkdtempSync(join(WORK_DIR, `${prefix}-`))
}
