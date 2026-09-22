// Where this package sits, and the proof that it still does.
//
// Path arithmetic counted in `..` is right until a file moves, and then it is
// wrong SILENTLY: `resolve(dir, '..', '..')` always produces a path, and the
// first thing to notice is a reader failing on a directory that is empty
// rather than absent, so every ascent here is anchored on something that must be
// AT the destination, and the failure names the path it computed, the marker
// it wanted and the number of levels it climbed.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Climb `levels` directories from `from` and require `marker` to be there.
 *
 * @throws Error naming the computed path when the marker is missing -- which
 *   is the only way a miscount here becomes visible at the moment it is made.
 */
export function ascendTo(from: string, levels: number, marker: string, what: string): string {
  const dir = resolve(from, ...Array.from({ length: levels }, () => '..'))
  if (!existsSync(join(dir, marker))) {
    throw new Error(
      `${what} was computed as ${dir} by climbing ${levels} level${levels === 1 ? '' : 's'} from ${from}, `
      + `but ${join(dir, marker)} does not exist. Either this package moved and the count is stale, `
      + `or ${marker} did.`,
    )
  }
  return dir
}

/** `src/verify` -- resolved from this module, not from the caller's cwd. */
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
 * The boards this tree ships, in name order, READ OFF THE TREE.
 *
 * Discovered rather than written down. A literal -- `SHIPPED_BOARDS =
 * ['cx3576', 'uefi-x64']` -- is what every caller iterates, so a board added under
 * boards/ and not to the literal is a board nothing here ever reads:
 * `make os-layout-lint` reports `RESULT: PASS (26/26 checks)` and never names
 * it. That is green by having looked at less. A directory
 * listing cannot fall behind the directory.
 *
 * A `boards/<name>/` with no `board.env` in it is not a board and is skipped:
 * the definition file IS the board, which is also why `boardNameForPath` takes
 * the name from the DIRECTORY.
 *
 * The behaviour is src/image/paths.ts's, arrived at there first and copied
 * here as behaviour rather than as code -- the two packages resolve their own
 * BOARDS_DIR and neither should import the other's.
 *
 * `dir` is a parameter so the refusal below is REACHABLE from a test: a guard
 * that can only fire when boards/ is empty is a guard nobody has run.
 */
export function shippedBoards(dir: string = BOARDS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(dir, e.name, 'board.env')))
    .map(e => e.name)
    .sort()
}

/**
 * `shippedBoards()`, refusing an answer that would make its caller vacuous.
 *
 * A discovery that finds nothing hands every `for (const b of boards)` an empty
 * loop, and a suite of empty loops is green. That is the exact shape this tree
 * keeps finding in its own checkers -- the shell lint's "RESULT: PASS (0/0
 * checks)", run.sh's "Ran 0 tests", M3a's oracle agreeing "on all 0 keys" -- so
 * a discovery used as a checker's input refuses to return nothing, by name,
 * rather than leaving the caller to decide to notice.
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
