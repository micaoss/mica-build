import { builderImagesAt } from './images.ts'
import { loadBoardFacts } from './board-facts.ts'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { assembleRelease, gateRelease, type ReleaseInputs } from './release-manifest.ts'
import { REPO_ROOT } from './paths.ts'
import { Toolbox } from './toolbox.ts'

const USAGE = `Usage: build/run.sh --release assemble --board BOARD --version VERSION
  --image IMAGE --update FILE.micaupd --firmware DIR --package-manifest FILE
  --runtime-report FILE --baked-meta DIR --notes FILE --out DIR --public-key FILE (repeatable)
  [--channel development|candidate|stable] [--profile dev|prod] [--evidence FILE]
       build/run.sh --release gate --dir DIR --public-key FILE (repeatable)

Paths are relative to the repository root. Public-key files contain base64
Ed25519 public anchors. The gate authenticates update and firmware artifacts;
complete image, runtime and physical acceptance are separate required checks.
`
export async function sourceIdentity(checkout = REPO_ROOT) {
  checkout = realpathSync(checkout)
  const dotGit = join(checkout, '.git')
  const entry = statSync(dotGit)
  let gitDir = dotGit
  if (!entry.isDirectory()) {
    if (!entry.isFile()) throw new Error(`${dotGit} must be a Git directory or gitfile`)
    const match = /^gitdir: (.+)\s*$/s.exec(readFileSync(dotGit, 'utf8'))
    if (!match) throw new Error(`${dotGit} is not a valid gitfile`)
    gitDir = resolve(checkout, match[1]!.trimEnd())
  }
  gitDir = realpathSync(gitDir)
  const commonFile = join(gitDir, 'commondir')
  const commonDir = existsSync(commonFile) ? realpathSync(resolve(gitDir, readFileSync(commonFile, 'utf8').trimEnd())) : gitDir
  // Identity reads need no writable checkout or Git metadata. Toolbox removes
  // covered descendants, so an ordinary checkout needs just one narrow mount.
  const tb = await Toolbox.open({ key: 'release-source', imageKey: 'upstream:alpine:3.24.1', manager: 'apk', packages: ['git'], tools: ['git'] }, {
    readOnlyMounts: [checkout, gitDir, commonDir],
  })
  try {
    const git = async (args: string[]) => (await tb.must([
      'git', '--no-optional-locks', '--git-dir', gitDir, '--work-tree', checkout,
      '-c', `safe.directory=${checkout}`, '-C', checkout, '--no-pager', ...args,
    ], { env: { GIT_COMMON_DIR: commonDir } })).stdout.trim()
    return { commit: await git(['rev-parse', 'HEAD']), dirty: (await git(['status', '--porcelain'])).length > 0 }
  } finally { await tb.close() }
}
function releaseBoard(board: string) {
  if (!loadBoardFacts(board).releaseTarget) throw new Error(`Board ${board} has no release publication target`)
}
export async function main(argv = Bun.argv.slice(2)) {
  const strings = ['board', 'version', 'image', 'update', 'firmware', 'package-manifest', 'runtime-report', 'baked-meta', 'notes', 'out', 'channel', 'profile', 'evidence', 'dir']
  const options: Record<string, { type: 'string' | 'boolean', multiple?: boolean }> = Object.fromEntries(strings.map(name => [name, { type: 'string' }]))
  options['public-key'] = { type: 'string', multiple: true }; options.help = { type: 'boolean' }
  const { values, positionals, tokens } = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true })
  if (values.help) { console.log(USAGE); return }
  const seen = new Set<string>()
  for (const token of tokens) if (token.kind === 'option' && token.name !== 'public-key') {
    if (seen.has(token.name)) throw new Error(`Duplicate --${token.name}`)
    seen.add(token.name)
  }
  const value = (name: string) => { const v = values[name]; if (typeof v !== 'string' || !v) throw new Error(`Missing --${name}\n${USAGE}`); return v }
  const path = (name: string) => resolve(REPO_ROOT, value(name))
  const rawKeys = values['public-key']
  if (!Array.isArray(rawKeys) || !rawKeys.length) throw new Error('At least one --public-key file is required')
  const keys = rawKeys.map(p => readFileSync(resolve(REPO_ROOT, p as string), 'utf8').trim())
  if (positionals.length !== 1) throw new Error(USAGE)
  const mode = positionals[0]
  if (mode === 'gate') {
    if ([...seen].some(name => name !== 'dir')) throw new Error('Gate accepts only --dir and --public-key')
    const report = gateRelease(path('dir'), keys)
    releaseBoard(report.manifest.board)
    console.log(`RELEASE_GATE_PASS board=${report.manifest.board} artifacts=${report.artifactsChecked}`)
    return
  }
  if (mode !== 'assemble' || seen.has('dir')) throw new Error(USAGE)
  const board = value('board'); releaseBoard(board)
  const runtimeReport = path('runtime-report')
  const builderImages = builderImagesAt(REPO_ROOT)
  const report = assembleRelease({ out: path('out'), board: board as ReleaseInputs['board'], version: value('version'),
    channel: (values.channel ?? 'development') as ReleaseInputs['channel'], profile: (values.profile ?? 'dev') as ReleaseInputs['profile'],
    source: await sourceIdentity(), builderImages, lock: join(REPO_ROOT, 'locks'),
    image: path('image'), update: path('update'), firmware: path('firmware'), packages: path('package-manifest'), runtimeReport, meta: path('baked-meta'), notes: path('notes'),
    evidence: values.evidence ? path('evidence') : join(REPO_ROOT, '_out', 'boards', board, 'evidence.json'), keys })
  console.log(`RELEASE_GATE_PASS board=${report.manifest.board} artifacts=${report.artifactsChecked}`)
}
if (import.meta.main) {
  try { await main() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
