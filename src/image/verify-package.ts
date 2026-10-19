// Shared board-env parsing and repository-path validation.
export { BoardEnvError, parseBoardEnv } from '../verify/board-env.ts'
export type { Assignment, BoardEnvFile, DuplicateAssignment } from '../verify/board-env.ts'
export { ascendTo, BOARDS_DIR, BOARDS_LIST, boardEnvPath, LOCKS_DIR, pinnedBoards, REPO_ROOT, requireShippedBoards, shippedBoards } from '../verify/paths.ts'
