// The layout lint: every shipped board's layout.tsv against the rules of src/image/file-layout.ts, and its loader
// region against where its firmware facts place the loader; a ubi board's flash.tsv against the rules of
// src/image/flash-layout.ts, read with its facts (make os-layout-lint; the board contract test runs it over
// boards/<board>/).
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { boardFactsFrom } from '../image/board-facts.ts'
import { layoutNames, loadLayout } from '../image/file-layout.ts'
import { storageOf } from '../image/flash-layout.ts'
import { checkLoaderPlacement } from '../image/regions.ts'
import { parseBoardEnv } from './board-env.ts'
import { boardEnvPath, requireShippedBoards } from './paths.ts'

const args = Bun.argv.slice(2)
const files = args.length ? args : requireShippedBoards().map(boardEnvPath)
for (const file of files) {
  try {
    if (storageOf(parseBoardEnv(readFileSync(file, 'utf8'), file).values, file) === 'ubi') {
      const flash = boardFactsFrom(file).flash!
      console.log(`PASS: ${flash.board} flash ${flash.flash.kind}: ${flash.regions.map(r => `${r.name}:${r.role}`).join(' ')}`)
      continue
    }
    for (const name of layoutNames(dirname(file))) {
      const layout = loadLayout(dirname(file), name)
      checkLoaderPlacement(layout, boardFactsFrom(file, name))
      console.log(`PASS: ${layout.board} ${layout.backend} layout ${name || 'default'}: ${layout.partitions.map(p => `${p.name}:${p.role}`).join(' ')}`)
    }
  }
  catch (error) { console.error(`FAIL: ${file}: ${String(error)}`); process.exitCode = 1 }
}
