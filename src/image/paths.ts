// Where this package sits. The repository paths and the board discovery are src/verify/paths.ts's, through
// verify-package.ts; this module adds its own directory and the scratch directory the image tools write under.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './verify-package.ts'

export { BOARDS_DIR, BOARDS_LIST, boardEnvPath, LOCKS_DIR, pinnedBoards, REPO_ROOT, requireShippedBoards, shippedBoards } from './verify-package.ts'

/** `src/image` -- resolved from this module, not from the caller's cwd. */
export const SRC_DIR: string = import.meta.dir

/** The scratch root the image tools write under, inside the repository. */
export const WORK_DIR: string = join(REPO_ROOT, '.work')

/** A fresh scratch directory under WORK_DIR. */
export function makeWorkDir(prefix: string): string {
  mkdirSync(WORK_DIR, { recursive: true })
  return mkdtempSync(join(WORK_DIR, `${prefix}-`))
}
