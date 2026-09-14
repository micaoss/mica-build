import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadBoard } from './board.ts'
import { runChecks } from './checks.ts'
import { verifyFactoryImage } from './file-image.ts'
import { REPO_ROOT, boardEnvPath } from './paths.ts'
import { readProductConf } from './product-conf.ts'
import { chooseRoute, createToolRuntime, missingHostTools } from './tools.ts'

async function main() {
  let name = process.env.MICA_BOARD ?? '', image = '', work = join(REPO_ROOT, '_out/verify')
  const keys: string[] = []
  const args = Bun.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help') {
      console.log('Usage: verify/run.sh --verify --board BOARD --image FULL_FACTORY_IMAGE --public-key BASE64_KEY_FILE [--public-key FILE] [--work DIRECTORY]')
      return
    }
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    switch (arg) {
      case '--board': name = value; break
      case '--image': image = resolve(value); break
      case '--work': work = resolve(value); break
      case '--public-key': keys.push(readFileSync(value, 'utf8').trim()); break
      default: throw new Error(`Unknown option ${arg}`)
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name) || !image || !keys.length) throw new Error('Explicit current board, full factory image and metadata public keys are required')
  const board = loadBoard(boardEnvPath(name))
  mkdirSync(work, { recursive: true })
  const workDir = mkdtempSync(join(work, `${name}-`))
  const tools = await createToolRuntime({ workDir, readOnly: [image, REPO_ROOT],
    route: chooseRoute(process.env.MICA_VERIFY_TOOLS, await missingHostTools()), log: console.log })
  let passed = 0, failed = 0, skipped = 0
  try {
    const roots = await verifyFactoryImage(board.layout, image, keys, workDir, tools, fact => { console.log(`PASS: ${fact}`); passed++ })
    for (const root of roots) {
      const product = readProductConf(root)
      if (product.board !== name) throw new Error(`the root was composed for product ${product.name} on board ${product.board}, not ${name}`)
      console.log(`verify: product ${product.name} (${product.profile}; features: ${[...product.features].join(' ') || 'none, the minimal image'})`)
      const run = await runChecks({ board, product, image, tools, workDir, outDir: join(REPO_ROOT, '_out', name), unpackRoot: async () => root })
      for (const n of run.notRun) console.log(`NOT RUN: ${n.id}: needs ${n.features.join(', ')}, which product ${product.name} did not select`)
      for (const result of run.results) {
        if (result.verdict === 'pass') passed++
        else if (result.verdict === 'fail') failed++
        else skipped++
        console.log(`${result.verdict.toUpperCase()}: ${result.message}`)
      }
      for (const failure of run.failures) { failed++; console.error(`ERROR: ${failure.id}: ${failure.error.message}`) }
    }
    if (!passed || failed) throw new Error(`${failed} failed checks; ${passed} passed; ${skipped} skipped`)
    console.log(`RESULT: PASS (${passed} checks, ${skipped} skipped); evidence ${workDir}`)
  } finally { await tools.dispose() }
}
try { await main() } catch (error) { console.error(`RESULT: FAIL: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 }
