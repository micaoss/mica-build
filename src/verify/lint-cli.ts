// The layout lint: every shipped board's layout.tsv against the rules of src/image/file-layout.ts, and its loader
// region against where its firmware facts place the loader (make os-layout-lint; the board contract test runs it
// over boards/<board>/).
import { dirname } from 'node:path'
import { boardFactsFrom } from '../image/board-facts.ts'
import { loadLayout } from '../image/file-layout.ts'
import { checkLoaderPlacement } from '../image/regions.ts'
import { boardEnvPath, requireShippedBoards } from './paths.ts'

const args = Bun.argv.slice(2)
const files = args.length ? args : requireShippedBoards().map(boardEnvPath)
for (const file of files) {
  try {
    const layout = loadLayout(dirname(file))
    checkLoaderPlacement(layout, boardFactsFrom(file))
    console.log(`PASS: ${layout.board} ${layout.backend} layout: ${layout.partitions.map(p => `${p.name}:${p.role}`).join(' ')}`)
  }
  catch (error) { console.error(`FAIL: ${file}: ${String(error)}`); process.exitCode = 1 }
}
