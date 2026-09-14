// Where this package sits, and the proof that it still does.
//
// The reasoning is verify/src/paths.ts's and the helper IS its function,
// imported through verify-package.ts rather than copied. Counted `..` over
// directories always produces a path, so a stale count fails later on an empty
// directory rather than an absent one; every ascent here is anchored on
// something that must be at the destination, and the failure names the path.
//
// Two anchors verify does not have: verify itself, because the board
// model build stands on lives there (see verify-package.ts) and naming it
// here tells a reader which of the two packages moved instead of a bare
// "Cannot find module" from bun; and tools/from.sh, which src/images.ts
// hands to bash, where a wrong path surfaces as "No such file or directory"
// attached to an image key and reads as though the key were bad.

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ascendTo } from './verify-package.ts'

/** `build/src` -- resolved from this module, not from the caller's cwd. */
export const SRC_DIR: string = import.meta.dir

/** `build`, anchored on the package manifest. */
export const PACKAGE_DIR: string = ascendTo(SRC_DIR, 1, 'package.json', 'the build package directory')

/** The repository root, anchored on the Makefile that routes every target. */
export const REPO_ROOT: string = ascendTo(SRC_DIR, 2, 'Makefile', 'the repository root')

/** `verify`, anchored on ITS manifest -- the package this one imports its model from. */
export const VERIFY_PACKAGE_DIR: string = join(
  ascendTo(SRC_DIR, 2, 'verify/package.json', 'the verify package that build takes its board model from'),
  'verify',
)

/** `_out/boards`: the fetched board bundles (tools/board-pool.sh --fetch). */
export const BOARDS_DIR: string = join(REPO_ROOT, '_out', 'boards')

/** `deps/packages`: the pins, among them `mica-kernel-<board>.json` for every board. */
export const PINS_DIR: string = join(REPO_ROOT, 'deps', 'packages')

/** `tools/from.sh` -- the tree's only resolver of an image key (build-env-image.lock, system-base.lock, base-images.env). */
export const FROM_SH: string = join(
  ascendTo(SRC_DIR, 2, 'tools/from.sh', 'tools/from.sh, the one resolver of an image key'),
  'tools', 'from.sh',
)

/** `_out/boards/<board>/board.env`, out of the fetched bundle. */
export function boardEnvPath(board: string): string {
  return join(BOARDS_DIR, board, 'board.env')
}

/**
 * The boards this tree ships, in name order, read off the tree. Discovered
 * rather than written down: verify/src/lint.ts keeps the same
 * list as a literal (`SHIPPED_BOARDS = ['cx3576', 'x64']`), and every geometry
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
 * The boards this tree pins: `deps/packages/mica-kernel-<board>.json`, one per
 * board. A board exists here exactly when its kernel archive is pinned; its
 * definition is read out of the fetched bundle under BOARDS_DIR.
 */
export function pinnedBoards(dir: string = PINS_DIR): string[] {
  return readdirSync(dir)
    .flatMap(name => { const match = /^mica-kernel-(.+)\.json$/.exec(name); return match ? [match[1]!] : [] })
    .sort()
}

export function requireShippedBoards(dir: string = BOARDS_DIR, pins: string = PINS_DIR): string[] {
  const boards = shippedBoards(dir)
  // The real tree: the fetched set and the pinned set must be one set, or
  // a pinned board nobody fetched is a board every loop below silently skips.
  if (dir === BOARDS_DIR) {
    const pinned = pinnedBoards(pins)
    const missing = pinned.filter(b => !boards.includes(b))
    const stale = boards.filter(b => !pinned.includes(b))
    if (missing.length > 0) throw new Error(`the pinned board(s) ${missing.join(', ')} are not fetched under ${dir}; run: make board-fetch-all`)
    if (stale.length > 0) throw new Error(`${dir} holds ${stale.join(', ')}, which no pin under ${pins} names; run: make board-fetch-all`)
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
 * empty directory -- measured 2026-08-25, and verify/run.sh carries a guard
 * whose whole job is to name that failure when it happens. Every tool this
 * package drives may be running in a container, so a scratch file under /tmp
 * would be a file the tool cannot see, reported as a file that does not exist.
 * Inside the repository it is covered by the identity mount that is already
 * there. `.work/` is gitignored.
 */
export const WORK_DIR: string = join(PACKAGE_DIR, '.work')

/** A fresh scratch directory under WORK_DIR. The caller removes it. */
export function makeWorkDir(prefix: string): string {
  mkdirSync(WORK_DIR, { recursive: true })
  return mkdtempSync(join(WORK_DIR, `${prefix}-`))
}
