import { readFileSync } from 'node:fs'
import { parseFileLayout } from '../../build/src/file-layout.ts'
import { boardEnvPath, requireShippedBoards } from './paths.ts'
const args = Bun.argv.slice(2)
const files = args.length ? args : requireShippedBoards().map(boardEnvPath)
for (const file of files) {
  try { const layout = parseFileLayout(readFileSync(file, 'utf8')); console.log(`PASS: ${layout.board} ${layout.backend} three-partition layout`) }
  catch (error) { console.error(`FAIL: ${file}: ${String(error)}`); process.exitCode = 1 }
}
