// The local build inputs a board's flash names and this environment does not set (flash.tsv input:<VARIABLE>:<sha256>).
//
//   bun src/cli.ts flash-inputs <board>
//
// Prints each absent variable on a line of its own; nothing for a board whose flash names none, or a gpt board.
// CI reads it to skip a product's flash image with a notice where an input is absent (release-product.yml,
// privileged.yml); the assembly itself refuses the image (src/image/flash-image.ts readFlashInputs).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { flashInputs, loadFlashLayout } from './flash-layout.ts'
import { REPO_ROOT } from './paths.ts'

export function absentInputs(boardDir: string, board: string, env: Record<string, string | undefined>): string[] {
  if (!existsSync(join(boardDir, 'flash.tsv'))) return []
  return flashInputs(loadFlashLayout(boardDir, board)).filter(i => (env[i.variable] ?? '') === '').map(i => i.variable)
}

export function main(argv: string[]): number {
  const [board = ''] = argv
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(board) || !existsSync(join(REPO_ROOT, 'boards', board, 'board.env'))) {
    console.error('usage: bun src/cli.ts flash-inputs <board>')
    return 1
  }
  for (const v of absentInputs(join(REPO_ROOT, 'boards', board), board, process.env)) console.log(v)
  return 0
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
