// A product built from local source checkouts, to verify it on hardware before anything is released.
//
//   bin/local-build.sh <product> [--core <dir>] [--pkgs <dir>] [--podman <dir>] [--docker <dir>] [--base <dir>]
//                      [--env <dir>] [--tools <dir>] [--build] [--no-gates] [--handover <name>]
//
//   reads   each named checkout, clean, at its HEAD: its offline output (_out/offline/ when it writes section 6's
//           layout, else the pools of its `make offline`); --build runs `make offline` (or `bun run offline`) in a
//           shared clone of it under _out/local-build/<stamp>/<repository> first, so the checkout is never written
//   writes  locks/ on the local branch local/<product>-<stamp> of this tree, committed and never pushed (each named
//           repository's offline pin by local-release; mica-build-tools.pin, and bin/mica-tools when the
//           checkout's bootstrap differs, for --tools), _out/products/<product>/, and the hand-over
//           _out/handover/<name>/ (default <product>): every image kind of the product as .img and .img.gz, the
//           board's committed loader (boards/<board>/loader/*.bin with its .sha256), verify.log and SHA256SUMS
//
// Then the gates that read the inputs (GATES; locks-verify refuses an offline pin, checkout-in-ci, and is reported
// as expected), the product build and its --verify, and a summary of every input: which came from a local
// checkout, which from a release, and what is third party (upstream.lock, upstream images). Refused under CI. The
// tree's branch is the one it started on again at the end; the local branch stays for the record.
//
// mica-system-base and mica-build-env publish images, which only a section 6 layout carries: they are taken
// from a checkout only once its offline build writes one (src/locks/local-images.ts reads its images).
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { modeOf } from '@mica/build-tools'
import { inputs, resolve as resolveImage } from '../locks/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'

export class LocalBuildError extends Error {}

function die(message: string): never {
  throw new LocalBuildError(`local-build: error: ${message}`)
}

const say = (message: string) => console.log(`local-build: ${message}`)

/** The flag of each input a checkout can stand in for, and whether it publishes images. */
export const INPUTS = [
  { flag: '--core', repository: 'mica-core', images: false },
  { flag: '--pkgs', repository: 'mica-pkgs', images: false },
  { flag: '--podman', repository: 'mica-podman', images: false },
  { flag: '--docker', repository: 'mica-docker', images: false },
  { flag: '--base', repository: 'mica-system-base', images: true },
  { flag: '--env', repository: 'mica-build-env', images: true },
] as const

/** The gates that read the inputs: their pins, the pools, the archives' contracts and the sources read. */
export const GATES = ['locks-verify', 'os-pool', 'os-pool-check', 'os-apid-api-spec-pins', 'os-verify-test']

export type Options = { product: string, checkouts: Record<string, string>, tools: string, build: boolean, gates: boolean, handover: string }

const USAGE = 'usage: bin/local-build.sh <product> [--core <dir>] [--pkgs <dir>] [--podman <dir>] [--docker <dir>] [--base <dir>] [--env <dir>] [--tools <dir>] [--build] [--no-gates] [--handover <name>]'

export function parse(argv: string[], env: NodeJS.ProcessEnv = process.env): Options {
  if (modeOf(env) === 'ci') die('a local build is never run in CI: its inputs are no release')
  const [product = '', ...rest] = argv
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(product)) die(USAGE)
  const o: Options = { product, checkouts: {}, tools: '', build: false, gates: true, handover: product }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!, input = INPUTS.find(x => x.flag === a)
    if (a === '--build') { o.build = true; continue }
    if (a === '--no-gates') { o.gates = false; continue }
    const dir = rest[++i] ?? ''
    if (a === '--handover') {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(dir)) die(USAGE)
      o.handover = dir
      continue
    }
    if (dir === '' || (input === undefined && a !== '--tools')) die(USAGE)
    if (!existsSync(join(dir, '.git'))) die(`${a} ${dir} is not a git checkout`)
    if (a === '--tools') o.tools = resolve(dir)
    else o.checkouts[input!.repository] = resolve(dir)
  }
  return o
}

function git(args: string[], cwd = REPO_ROOT): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) die(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

function clean(dir: string): string {
  if (git(['-C', dir, 'status', '--porcelain', '--untracked-files=no']) !== '') die(`${dir} has uncommitted changes; a local build takes a commit`)
  return git(['-C', dir, 'rev-parse', 'HEAD'])
}

/** The checkout whose offline output is pinned: the named one, or with --build a shared clone of it where
 * `make offline` has just run. A repository that publishes images needs section 6's layout. */
export function producerOutput(repository: string, images: boolean, checkout: string, build: boolean, runDir: string): string {
  const commit = clean(checkout)
  let dir = checkout
  if (build) {
    dir = join(runDir, repository)
    git(['clone', '--quiet', '--shared', '--no-checkout', checkout, dir])
    git(['-C', dir, 'checkout', '--quiet', '--detach', commit])
    // mica-system-base has no Makefile; its offline build is its package script.
    const offline = existsSync(join(dir, 'Makefile')) ? ['make', 'offline'] : ['bun', 'run', 'offline']
    say(`${repository}: ${offline.join(' ')} in ${dir} (log ${dir}.log)`)
    const log = Bun.file(`${dir}.log`)
    const r = Bun.spawnSync(offline, { cwd: dir, stdout: log, stderr: log })
    if (r.exitCode !== 0) die(`${offline.join(' ')} failed in ${dir}; see ${dir}.log`)
  }
  if (images && !existsSync(join(dir, '_out/offline', `${repository}.lock`)))
    die(`${repository} publishes images, and ${dir}/_out/offline/ holds no ${repository}.lock (release-lock.md section 6). Its offline build does not write one yet; leave out its flag to take its release`)
  return dir
}

/** The tools pin at the checkout's HEAD, and bin/mica-tools its bootstrap when that differs. */
export function pinTools(checkout: string, root = REPO_ROOT): string[] {
  const commit = clean(checkout)
  writeFileSync(join(root, 'locks/mica-build-tools.pin'), `# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${commit}\n`)
  const changed = ['locks/mica-build-tools.pin']
  const bootstrap = join(checkout, 'bootstrap/mica-tools')
  if (existsSync(bootstrap) && readFileSync(bootstrap, 'utf8') !== readFileSync(join(root, 'bin/mica-tools'), 'utf8')) {
    copyFileSync(bootstrap, join(root, 'bin/mica-tools'))
    changed.push('bin/mica-tools')
  }
  return changed
}

/** The hand-over of a built product in _out/handover/<handover>: each image kind's file as .img and .img.gz, the
 * board's committed loader, verify.log, and SHA256SUMS over them. What a previous hand-over left there is replaced. */
export function stageHandover(product: string, board: string, verifyLog: string, root = REPO_ROOT, handover = product): string[] {
  const out = join(root, '_out/products', product), dest = join(root, '_out/handover', handover)
  const kinds = existsSync(join(out, 'kinds.tsv')) ? readFileSync(join(out, 'kinds.tsv'), 'utf8').split('\n').filter(l => l !== '').map(l => l.split('\t')[1]!) : []
  if (kinds.length === 0) die(`${out}/kinds.tsv names no image; build the product first`)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const files: string[] = []
  for (const k of kinds) {
    const name = basename(k)
    cpSync(join(out, k), join(dest, name))
    const gz = Bun.spawnSync(['bash', '-c', 'gzip -6 -c "$1" > "$1.gz"', 'gzip', join(dest, name)], { stdout: 'pipe', stderr: 'pipe' })
    if (gz.exitCode !== 0) die(`gzip of ${name} failed: ${gz.stderr.toString().trim()}`)
    files.push(name, `${name}.gz`)
  }
  const loader = join(root, 'boards', board, 'loader')
  for (const f of existsSync(loader) ? readdirSync(loader).filter(f => f.endsWith('.bin') && existsSync(join(loader, `${f}.sha256`))).sort() : []) {
    copyFileSync(join(loader, f), join(dest, f))
    files.push(f)
  }
  copyFileSync(verifyLog, join(dest, 'verify.log'))
  const sums = Bun.spawnSync(['sha256sum', ...files], { cwd: dest, stdout: 'pipe', stderr: 'pipe' })
  if (sums.exitCode !== 0) die(`sha256sum in ${dest} failed`)
  writeFileSync(join(dest, 'SHA256SUMS'), sums.stdout.toString())
  return [...files, 'verify.log', 'SHA256SUMS'].map(f => join(dest, f))
}

/** Every input of locks/ and where it came from: a local checkout (an offline pin), or a release. */
export function provenance(root = REPO_ROOT): string[] {
  const lines: string[] = []
  const pins = join(root, 'locks/pins')
  for (const f of readdirSync(pins).filter(f => f.endsWith('.pin')).sort()) {
    const pin = Object.fromEntries(readFileSync(join(pins, f), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    const commit = readFileSync(join(root, 'locks', f.replace(/\.pin$/, '.lock')), 'utf8').split('\n').find(l => l.startsWith('release\t'))?.split('\t')[3] ?? ''
    lines.push(pin['RELEASE'] === 'offline'
      ? `local    ${f.replace(/\.pin$/, '')} ${commit} from ${pin['CHECKOUT']}`
      : `release  ${f.replace(/\.pin$/, '')} ${pin['RELEASE']} (${commit})`)
  }
  const tools = readFileSync(join(root, 'locks/mica-build-tools.pin'), 'utf8').match(/^COMMIT=(.*)$/m)?.[1] ?? ''
  lines.push(`${process.env['MICA_TOOLS_URL'] ? 'local   ' : 'release '} mica-build-tools ${tools} from ${process.env['MICA_TOOLS_URL'] || 'its GitHub repository'}`)
  lines.push('upstream locks/upstream.lock (kernel, u-boot, firmware sources), the upstream image rows of mica-build-env, the Debian snapshot: third party, from repos/ and the image store')
  return lines
}

function make(target: string, log: string, env: Record<string, string>): boolean {
  const file = Bun.file(log)
  return Bun.spawnSync(['make', target], { cwd: REPO_ROOT, stdout: file, stderr: file, env: { ...process.env, ...env } }).exitCode === 0
}

export function localBuild(o: Options): void {
  const start = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') die('this tree has uncommitted changes; the local branch is cut from a clean one')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
  const runDir = join(REPO_ROOT, '_out/local-build', stamp), branch = `local/${o.product}-${stamp}`
  mkdirSync(runDir, { recursive: true })
  const env: Record<string, string> = o.tools === '' ? {} : { MICA_TOOLS_URL: o.tools }
  Object.assign(process.env, env)
  git(['checkout', '--quiet', '-b', branch])
  try {
    // The tools first: every step after runs the pinned tools (bin/mica-tools sync), local-release too.
    const changed = o.tools === '' ? [] : pinTools(o.tools)
    for (const { repository, images } of INPUTS) {
      const checkout = o.checkouts[repository]
      if (checkout === undefined) continue
      const r = Bun.spawnSync(['bash', 'bin/bun.sh', 'src/cli.ts', 'local-release', repository, producerOutput(repository, images, checkout, o.build, runDir)],
        { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
      if (r.exitCode !== 0) die(`local-release ${repository} failed: ${(r.stdout.toString() + r.stderr.toString()).trim()}`)
      say(r.stdout.toString().trim())
      changed.push(`locks/${repository}.lock`, `locks/pins/${repository}.pin`)
    }
    if (changed.length > 0) {
      git(['add', '--', ...changed])
      git(['-c', 'user.name=local-build', '-c', 'user.email=local-build@localhost', 'commit', '--quiet', '-m', `LOCAL ONLY: ${o.product} from local checkouts (${stamp}), never pushed`])
    }
    say(`locks committed on ${branch} (${git(['rev-parse', '--short', 'HEAD'])}), never pushed`)
    // bin/bun.sh's container route runs the bun image of locks/mica-build-env.lock and pulls no local one.
    if (o.checkouts['mica-build-env'] !== undefined) say(`loaded ${resolveImage('mica-build-env:base', inputs())} from its layout`)

    if (o.gates) {
      for (const gate of GATES) {
        const log = join(runDir, `gate-${gate}.log`), ok = make(gate, log, env)
        const expected = !ok && gate === 'locks-verify' && readFileSync(log, 'utf8').includes('checkout-in-ci')
        say(`gate ${gate}: ${ok ? 'PASS' : expected ? 'refused checkout-in-ci, as expected for an offline pin' : `FAIL (${log})`}`)
        if (!ok && !expected) die(`gate ${gate} failed; see ${log}`)
      }
    }

    const buildLog = join(runDir, 'product-build.log'), verifyLog = join(runDir, 'product-verify.log')
    say(`product-build ${o.product} (log ${buildLog})`)
    const run = (argv: string[], log: string) => Bun.spawnSync(['bash', 'bin/bun.sh', 'src/cli.ts', ...argv], { cwd: REPO_ROOT, stdout: Bun.file(log), stderr: Bun.file(log), env: { ...process.env, ...env } }).exitCode === 0
    if (!run(['product-build', o.product], buildLog)) die(`product-build ${o.product} failed; see ${buildLog}`)
    const verified = run(['product-build', o.product, '--verify'], verifyLog)
    say(`verify: ${readFileSync(verifyLog, 'utf8').split('\n').filter(l => l.startsWith('RESULT')).at(-1) ?? 'no RESULT'} (log ${verifyLog})`)
    if (!verified) die(`product-build ${o.product} --verify failed; see ${verifyLog}`)

    const board = o.product.split('.')[0]!
    for (const f of stageHandover(o.product, board, verifyLog, REPO_ROOT, o.handover)) say(`hand-over ${f}`)
    say('inputs:')
    for (const l of provenance()) console.log(`  ${l}`)
  }
  finally {
    git(['checkout', '--quiet', start])
    say(`back on ${start}; the local branch ${branch} stays`)
  }
}

export function main(argv: string[]): number {
  try { localBuild(parse(argv)); return 0 }
  catch (e) {
    if (e instanceof LocalBuildError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
