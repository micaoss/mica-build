// The offline chain: products built from the side-by-side checkouts' own builds instead of their releases.
//
//   bun src/cli.ts offline-chain --workspace <dir> [--products "<product> ..."] [--signing <dir>]
//                               [--dry-run | --producers-only] [--at-release-commits]
//
//   reads   <workspace>/{mica-core,mica-podman,mica-build}   the checkouts, at their HEAD commits
//           --signing (default <workspace>/mica-build/meta)             development trust material, read only
//   writes  <workspace>/.mica-offline/<stamp>/<repository>/             throw-away clones and their builds
//           <workspace>/.mica-offline/<stamp>/logs/<step>.log
//           <workspace>/.mica-offline/<stamp>/summary.txt
//
// WHAT IT BUILDS FROM. Each producer is built from ITS CHECKOUT'S HEAD, not from the commit its release was cut
// at, and the products are then assembled from those offline pins. So a product this chain builds and a product
// a release published differ in their INPUTS unless the checkouts sit at the release commits, which every run
// reports below. "THE OFFLINE CHAIN REPRODUCES THE ONLINE BYTES" IS A CLAIM ABOUT A WORKSPACE, NOT ABOUT THIS
// COMMAND: what a run proves is that a product can be built from source without touching a release, which is
// the mechanism and not the equality. --at-release-commits builds each producer at the one commit its releases
// name instead, refusing a producer released at several commits or a checkout that lacks the object.
//
// THE CHECKOUTS ARE NEVER WRITTEN. Each is cloned with `git clone --shared` (objects read through alternates;
// nothing is added to its .git) and checked out at the commit the chain starts from; uncommitted changes in a
// checkout are not part of the build. Every step runs in the clones, and every step of the assembly runs the
// mica-build CLONE's own tooling (its bin/bun.sh), so the chain assembles with the tree it pins.
//
// THE ORDER: `make offline` in the mica-core and mica-podman clones, in parallel; then, in the mica-build clone,
// src/cli.ts local-pins for each (their offline locks and pins in locks/), committed on the local branch
// offline/<stamp>, and `make product` for every product. The build-env images and mica-system-base still come
// from their releases; the boards are the mica-build clone's own builds, whose kernels embed the certificates of
// --signing, which the products are then signed with.
//
// --dry-run clones and prints the plan without building; --producers-only stops after the producers. Refused
// under GitHub Actions: nothing an offline chain builds is a release input. The port of tools/offline-chain.sh
// (deleted 2026-09-25), message for message.
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class ChainError extends Error {}

const PRODUCERS = ['mica-core', 'mica-podman']
const USAGE = 'usage: bun src/cli.ts offline-chain --workspace <dir> [--products "..."] [--signing <dir>] [--dry-run | --producers-only] [--at-release-commits]'

function die(message: string): never {
  throw new ChainError(`offline-chain: error: ${message}`)
}

const say = (message: string) => console.log(`offline-chain: ${message}`)

function run(argv: string[], cwd: string, env: Record<string, string> = {}): { code: number, out: string } {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

function git(args: string[], cwd?: string): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new ChainError(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

function sha256(path: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')
}

/** The last lines of a log, for the refusal that names it. */
function tail(path: string, n = 20): string {
  return readFileSync(path, 'utf8').split('\n').filter(l => l !== '').slice(-n).join('\n')
}

type Options = { workspace: string, products: string[], signing: string, mode: 'build' | 'dry-run' | 'producers-only', atReleaseCommits: boolean }

export function parse(argv: string[]): Options {
  let workspace = '', products = 'uefi-x64-dev', signing = '', mode: Options['mode'] = 'build', atReleaseCommits = false
  for (let i = 0; i < argv.length;) {
    const a = argv[i]
    if (a === '--workspace') { workspace = argv[i + 1] ?? ''; i += 2 }
    else if (a === '--products') { products = argv[i + 1] ?? ''; i += 2 }
    else if (a === '--signing') { signing = argv[i + 1] ?? ''; i += 2 }
    else if (a === '--dry-run') { mode = 'dry-run'; i++ }
    else if (a === '--producers-only') { mode = 'producers-only'; i++ }
    else if (a === '--at-release-commits') { atReleaseCommits = true; i++ }
    else { die(USAGE) }
  }
  if (process.env.GITHUB_ACTIONS) die('an offline chain is never run in CI: its builds are not release inputs')
  if (workspace === '' || !existsSync(workspace) || !statSync(workspace).isDirectory()) die('--workspace must name the directory that holds the checkouts')
  workspace = realpathSync(workspace)
  if (products.trim() === '') die('--products names no product')
  const named = signing || join(workspace, 'mica-build/meta')
  try { signing = realpathSync(named) }
  catch { die(`the signing workspace ${named} does not exist`) }
  for (const f of ['verity/signer.cert.pem', 'boot/signer.cert.pem']) if (!existsSync(join(signing, f))) die(`${signing}/${f} does not exist`)
  return { workspace, products: products.split(/\s+/).filter(p => p !== ''), signing, mode, atReleaseCommits }
}

/** input, repository, release, commit: the release rows of the workspace's mica-build locks, by its own tooling. */
function releaseRows(workspace: string): string[][] {
  const r = run(['bash', 'bin/bun.sh', 'src/cli.ts', 'locks', 'rows', 'release'], join(workspace, 'mica-build'))
  if (r.code !== 0) return []
  return r.out.split('\n').filter(l => /^\S+\t/.test(l)).map(l => l.split('\t'))
}

export async function chain(o: Options): Promise<void> {
  const commit: Record<string, string> = {}, head: Record<string, string> = {}
  for (const repository of [...PRODUCERS, 'mica-build']) {
    const dir = join(o.workspace, repository)
    try { commit[repository] = head[repository] = git(['-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD']) }
    catch { die(`${dir} is not a git checkout with a commit`) }
  }
  const released = releaseRows(o.workspace)

  // --at-release-commits BUILDS AT THOSE COMMITS RATHER THAN ONLY REFUSING: the checkouts lend their objects and
  // the clones decide what is built, so the objects must be there and nothing else.
  if (o.atReleaseCommits) {
    for (const repository of PRODUCERS) {
      const commits = [...new Set(released.filter(r => r[1] === repository).map(r => r[3]!))].sort()
      if (commits.length !== 1)
        die(`${repository} is released at ${commits.length} distinct commits, so no single clone reproduces them: ${commits.map(c => `${c} `).join('')}. One clone per commit group is the shape; merging pools built at different commits is not implemented`)
      try { git(['-C', join(o.workspace, repository), 'rev-parse', '--verify', '--quiet', `${commits[0]}^{commit}`]) }
      catch { die(`${join(o.workspace, repository)} does not have the object ${commits[0]}, which its release names. Fetch that checkout (this tool never fetches) or the clone would silently be built from something else`) }
      commit[repository] = commits[0]!
    }
  }

  // WHERE EACH CHECKOUT SITS RELATIVE TO THE RELEASE IT WOULD HAVE TO REPRODUCE, printed on every run.
  let aligned = true
  for (const repository of PRODUCERS) {
    const named = released.filter(r => r[0] === repository || r[0]!.startsWith(`${repository}.`))
    const commits = [...new Set(named.map(r => r[3]!))].sort()
    if (commits.length !== 1) {
      aligned = false
      say(`checkout ${repository}: HEAD ${commit[repository]} -- locks/ names ${commits.length} release commits for this producer, so NO single checkout is at its releases:`)
      for (const r of named) console.log(`offline-chain:   ${r[0]}=${r[2]} ${r[3]}`)
    }
    else if (o.atReleaseCommits) { say(`checkout ${repository}: building at the release commit ${commits[0]} (this checkout's HEAD is ${head[repository]})`) }
    else if (commits[0] === commit[repository]) { say(`checkout ${repository}: HEAD is the release commit ${commits[0]}`) }
    else { aligned = false; say(`checkout ${repository}: HEAD ${commit[repository]} is NOT the release commit ${commits[0]}`) }
  }
  if (!aligned) say('THIS RUN CANNOT BE QUOTED FOR BYTE EQUALITY WITH ANY RELEASE. It proves a product can be built from source without touching a release, which is the mechanism and not the equality.')

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const runDir = join(o.workspace, '.mica-offline', stamp)
  if (existsSync(runDir)) die(`${runDir} already exists`)
  mkdirSync(join(runDir, 'logs'), { recursive: true })
  say(`run ${runDir}`)

  // Clones at the recorded commits; the checkouts only lend their objects.
  for (const repository of [...PRODUCERS, 'mica-build']) {
    git(['clone', '--quiet', '--shared', '--no-checkout', join(o.workspace, repository), join(runDir, repository)])
    git(['-C', join(runDir, repository), 'checkout', '--quiet', '--detach', commit[repository]!])
    say(`clone ${repository} at ${commit[repository]}`)
  }

  say(`plan: in parallel, make offline in ${PRODUCERS.join(' ')}`)
  say(`plan: in mica-build, src/cli.ts local-pins ${PRODUCERS.join(', ')}; commit on offline/${stamp}`)
  for (const p of o.products) say(`plan: make product PRODUCT=${p}`)
  if (o.mode === 'dry-run') { say('dry run: nothing built'); return }

  // The producers, in parallel, each with its own log.
  const certs = { VERITY_TRUST_CERT: join(o.signing, 'verity/signer.cert.pem'), FIT_TRUST_CERT: join(o.signing, 'boot/signer.cert.pem') }
  const duration: Record<string, number> = {}
  const started = PRODUCERS.map((repository) => {
    const log = join(runDir, 'logs', `${repository}.log`), fd = openSync(log, 'w'), start = Date.now()
    const p = Bun.spawn(['make', 'offline'], { cwd: join(runDir, repository), stdout: fd, stderr: fd, env: { ...process.env, ...certs } })
    say(`started make offline in ${repository} (log ${log})`)
    return { repository, log, start, p }
  })
  const failed: string[] = []
  for (const { repository, log, start, p } of started) {
    if (await p.exited === 0) {
      duration[repository] = Math.floor((Date.now() - start) / 1000)
      say(`${repository}: make offline done in ${duration[repository]} s`)
    }
    else {
      failed.push(repository)
      console.error(`offline-chain: ${repository}: make offline failed; the end of ${log}:`)
      console.error(tail(log))
    }
  }
  if (failed.length > 0) die(`make offline failed in: ${failed.join(' ')}`)

  const summary = () => {
    const lines = [`# offline chain ${stamp}: ${runDir}`]
    for (const repository of [...PRODUCERS, 'mica-build']) lines.push(`commit\t${repository}\t${commit[repository]}`)
    for (const repository of PRODUCERS) {
      lines.push(`duration\t${repository}\t${duration[repository]} s`)
      const debs = join(runDir, repository, '_out/debs')
      for (const arch of existsSync(debs) ? readdirSync(debs).sort() : []) {
        const sums = join(debs, arch, 'SHA256SUMS')
        if (!existsSync(sums)) continue
        const n = readFileSync(sums, 'utf8').split('\n').filter(l => l !== '').length
        lines.push(`pool\t${repository}\t${arch}\t${n} archives\tSHA256SUMS ${sha256(sums)}`)
      }
    }
    for (const p of o.products) {
      if (duration[`product:${p}`] === undefined) continue
      lines.push(`duration\tproduct ${p}\t${duration[`product:${p}`]} s`)
      const out = join(runDir, 'mica-build/_out/products', p)
      for (const l of readFileSync(join(out, 'image/SHA256SUMS'), 'utf8').split('\n').filter(x => x !== '')) {
        const image = join(out, 'image', l.split(/\s+/)[1]!)
        lines.push(`image\t${p}\t${image}\t${statSync(image).size} bytes\t${sha256(image)}`)
      }
      const update = join(out, 'update.micaupd')
      lines.push(`update\t${p}\t${update}\t${statSync(update).size} bytes\t${sha256(update)}`)
    }
    writeFileSync(join(runDir, 'summary.txt'), lines.join('\n') + '\n')
    console.log(lines.join('\n'))
  }
  if (o.mode === 'producers-only') { summary(); return }

  // The assembly: the producers' pools pinned locally, then the products, each step the clone's own tooling.
  const build = join(runDir, 'mica-build')
  const env = { MICA_SIGNING_OUTPUT: o.signing, MICA_VERITY_TRUST_CERT: join(o.signing, 'verity/signer.cert.pem') }
  const steps = (log: string, argvs: string[][]): boolean => {
    const out: string[] = []
    for (const argv of argvs) {
      const r = run(argv, build, env)
      out.push(r.out)
      if (r.code !== 0) { writeFileSync(log, out.join('')); console.error(tail(log)); return false }
    }
    writeFileSync(log, out.join(''))
    return true
  }
  const pinsLog = join(runDir, 'logs/local-pins.log')
  if (!steps(pinsLog, [
    ...PRODUCERS.map(r => ['bash', 'bin/bun.sh', 'src/cli.ts', 'local-pins', r, join(runDir, r)]),
    ['git', 'checkout', '--quiet', '-b', `offline/${stamp}`],
    ['git', 'add', '-A', '--', 'locks'],
    ['git', '-c', 'user.name=offline-chain', '-c', 'user.email=offline-chain@localhost', 'commit', '--quiet', '-m', `LOCAL ONLY: offline chain ${stamp}: ${PRODUCERS.join(' ')} from their offline builds`],
  ])) die(`pinning the offline builds failed (${pinsLog})`)
  say(`mica-build: local pins committed on offline/${stamp} (${git(['-C', build, 'rev-parse', '--short', 'HEAD'])})`)
  for (const p of o.products) {
    const start = Date.now(), log = join(runDir, 'logs', `product-${p}.log`)
    // The architecture of the product's board: its board row.
    const boardName = /^BOARD=(.*)$/m.exec(existsSync(join(build, 'products', p, 'product.env')) ? readFileSync(join(build, 'products', p, 'product.env'), 'utf8') : '')?.[1]?.replace(/"/g, '') ?? ''
    const arch = boardName === '' ? '' : run(['bash', 'bin/bun.sh', 'src/cli.ts', 'boards', 'arch', boardName], build).out.trim().split('\n').at(-1) ?? ''
    if (boardName === '' || arch === '' || !steps(log, [
      ['bash', 'bin/bun.sh', 'src/cli.ts', 'pool', 'fetch', '--arch', arch],
      ['bash', 'bin/bun.sh', 'src/cli.ts', 'pool', 'index', '--arch', arch],
      ['make', 'product', `PRODUCT=${p}`],
    ])) die(`product ${p} failed (${log})`)
    duration[`product:${p}`] = Math.floor((Date.now() - start) / 1000)
    say(`product ${p} built in ${duration[`product:${p}`]} s`)
  }
  summary()
}

export async function main(argv: string[]): Promise<number> {
  try { await chain(parse(argv)); return 0 }
  catch (e) {
    if (e instanceof ChainError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
