// Every Debian package producer in this repository, discovered from the tree.
//
//   bun src/cli.ts producers
//   -> board@cx3576 common/board arm64 mica-board-cx3576 mica-board-cx3576=1
//      board@uefi-x64 common/board amd64 mica-board-uefi-x64 mica-board-uefi-x64=0
//
//   bun src/cli.ts producers --dir-for <producer>        -> common/board
//   bun src/cli.ts producers --instance-for <producer>   -> boards/cx3576/board.env  (the FOR_EACH file the
//                                                          instance is; empty for a plain producer)
//   bun src/cli.ts producers --control-for <producer>    -> boards/cx3576/package/control  (CONTROL_DIR of the
//                                                          producer.env, else <dir>/control)
//   bun src/cli.ts producers --version-for <producer>    -> 0.0.1-1 1789430400  (the declared VERSION and
//                                                          SOURCE_DATE_EPOCH)
//
// A producer declares its packages' version in its control templates: `Version: <upstream>-<revision>` and
// `Source-Date-Epoch: <seconds>`, bumped together, the same in every template of one producer, and what it
// hashes in the `mica-inputs` beside them (mica-build-tools:docs/design.md 3.3.1 and 3.3.2). The version
// carries no commit, date, release or .dirty stamp.
//
// Five space-separated fields, sorted by producer name:
//
//   <producer>    the producer directory's basename, and what `make board-pool` selects on; a matrix
//                 producer (FOR_EACH in its producer.env) is one row per instance, <basename>@<instance>
//   <dir>         the producer directory, repository-relative
//   <arches>      comma-separated, from ARCHES
//   <packages>    comma-separated, from PACKAGES
//   <enablement>  comma-separated <package>=<count>, from ENABLEMENT, or `-`
//
// A producer is a directory anywhere in the tree holding both a Dockerfile and a producer.env. This is the
// only discovery; every other module reads it. The convention is documented in docs/design/packages.md.
//
// producer.env and the instance files are plain KEY=value, read here rather than sourced: a value may be
// double-quoted and may name an earlier key or the instance's keys as ${NAME} or $NAME (the shell sourced
// the instance first, then producer.env, under set -u); a command substitution, a line that is not an
// assignment and a name nothing set are refused.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { inputsHash, packDeclaration, readDeclaration } from '@mica/build-tools'

export class ProducersError extends Error {}

export const REPO_ROOT = resolve(import.meta.dir, '../..')

export type Producer = {
  /** <basename>[@<instance>] */
  name: string
  /** the producer directory, repository-relative */
  dir: string
  arches: string[]
  packages: string[]
  /** <package>=<count>, ... or '-' */
  enablement: string
  /** the FOR_EACH file this instance is, repository-relative; '' for a plain producer */
  instance: string
  /** where the control templates are, repository-relative */
  control: string
  /** every value of producer.env, expanded, with the instance's values beneath */
  env: Record<string, string>
}

/** The assignments of a plain KEY=value file, expanded over <base> and its own earlier keys, as bash sourcing
 * it under set -u would leave them; <label> names the file in a refusal. */
export function readEnv(path: string, base: Record<string, string> = {}, label = path): Record<string, string> {
  const env: Record<string, string> = { ...base }
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '' || line.startsWith('#')) continue
    if (line.includes('$(') || line.includes('`')) throw new ProducersError(`error: ${label} carries a command substitution: ${line}; an env file is plain KEY=value`)
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m === null) throw new ProducersError(`error: ${label} carries a line that is neither KEY=value nor a comment: ${line}`)
    let value = m[2]!
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) value = value.slice(1, -1)
    env[m[1]!] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, a: string | undefined, b: string | undefined) => {
      const name = (a ?? b)!
      const v = env[name] ?? process.env[name]
      if (v === undefined) throw new ProducersError(`error: ${label} names ${name}, which nothing set (${name}: unbound variable)`)
      return v
    })
  }
  return env
}

/** The producer.env files of the tracked tree, sorted by path: build outputs, the tests' scratch checkouts
 * and the offline source cache may hold staged or copied ones. */
function envFiles(root: string): string[] {
  const pruned = new Set(['.git', '_out', 'tmp', '.tmp', 'repos'])
  const found: string[] = []
  const walk = (dir: string, top: boolean) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (top && pruned.has(entry.name))) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, false)
      else if (entry.isFile() && entry.name === 'producer.env') found.push(path)
    }
  }
  walk(root, true)
  return found.sort()
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(w => w !== '')
}

/** Every producer of the tree, one per instance, sorted by name. */
export function discover(root = REPO_ROOT): Producer[] {
  if (!existsSync(join(root, 'Makefile'))) throw new ProducersError(`error: ${root}/Makefile does not exist. The producer discovery derives the repository as two levels above itself; if this file moved, that arithmetic moved with it`)
  const out: Producer[] = []
  const seen = new Map<string, string>()
  for (const envFile of envFiles(root)) {
    const dir = dirname(envFile), rel = relative(root, dir), producer = basename(dir)
    if (!existsSync(join(dir, 'Dockerfile'))) throw new ProducersError(`error: ${rel}/producer.env has no Dockerfile beside it. A producer is the PAIR: producer.env declares what it emits and the Dockerfile stages and packs it. This directory has only the declaration`)
    if (/\s/.test(producer)) throw new ProducersError(`error: the producer directory ${rel} has a name containing whitespace. The discovery emits space-separated fields and every reader splits on that, so such a name would be read as a different producer entirely`)
    // A MATRIX PRODUCER runs once per file its FOR_EACH glob matches (a repository-relative glob of plain
    // KEY=value files, boards/*/board.env): the file's assignments are set when producer.env is read, so
    // PACKAGES="mica-board-${LAYOUT_BOARD}" names the instance's package. The instance is the matched file's
    // directory name, and the producer's row is <producer>@<instance>. A producer without FOR_EACH is one
    // instance, itself.
    const forEach = /^FOR_EACH=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.replace(/^"(.*)"$/, '$1') ?? ''
    let instances = ['']
    if (forEach !== '') {
      instances = [...new Bun.Glob(forEach).scanSync({ cwd: root, onlyFiles: true })].sort().filter(f => statSync(join(root, f)).isFile())
      if (instances.length === 0) throw new ProducersError(`error: ${rel}/producer.env declares FOR_EACH='${forEach}', which matches no file under ${root}; a matrix producer over nothing would build nothing and report success`)
    }
    for (const inst of instances) {
      const name = inst === '' ? producer : `${producer}@${basename(dirname(join(root, inst)))}`
      const prior = seen.get(name)
      if (prior !== undefined) throw new ProducersError(`error: two producers are both named '${name}': ${prior} and ${rel}. The name is the producer's identity -- it is what \`make board-pool\` selects on -- so one of them has to be renamed`)
      seen.set(name, rel)
      const base = inst === '' ? {} : readEnv(join(root, inst), {}, inst)
      const env = readEnv(envFile, base, `${rel}/producer.env`)
      const arches = words(env.ARCHES ?? ''), packages = words(env.PACKAGES ?? ''), enablement = words(env.ENABLEMENT ?? '')
      if (env.FOR_LAYOUTS === '1') {
        if (inst === '' || packages.length !== 1) throw new ProducersError('FOR_LAYOUTS requires a matrix instance with one default package')
        const pkg = packages[0]!
        const count = enablement.find(e => e.startsWith(`${pkg}=`))?.slice(pkg.length + 1)
        if (count === undefined) throw new ProducersError(`FOR_LAYOUTS: ${pkg} has no enablement count`)
        for (const layout of readdirSync(dirname(join(root, inst))).filter(f => /^layout-[a-z0-9][a-z0-9-]{0,31}\.tsv$/.test(f)).sort().map(f => f.slice(7, -4))) {
          packages.push(`${pkg}-${layout}`)
          enablement.push(`${pkg}-${layout}=${count}`)
        }
      }
      // ENABLEMENT is only carried through; the package gate enforces it.
      if (packages.length === 0) throw new ProducersError(`error: ${rel}/producer.env declares no PACKAGES. That is the list of Debian packages this producer emits, and everything downstream is derived from it: an empty one builds nothing, clears nothing out of the pool and contributes nothing to any expectation -- which reports green rather than reporting this`)
      if (arches.length === 0) throw new ProducersError(`error: ${rel}/producer.env declares no ARCHES. That is the list of architectures this producer builds: amd64, arm64, or 'all' for an architecture-independent package`)
      for (const a of arches)
        if (!['amd64', 'arm64', 'all'].includes(a)) throw new ProducersError(`error: ${rel}/producer.env declares ARCHES entry '${a}'. The only values are amd64, arm64 and all; amd64 and arm64 are what the build-env images carry, and 'all' is an architecture-independent package that is a valid member of every pool`)
      if (arches.includes('all') && arches.length !== 1) throw new ProducersError(`error: ${rel}/producer.env declares ARCHES='${env.ARCHES}', mixing 'all' with a specific architecture. An 'all' package is already a member of every pool, so the pair says both that this producer is architecture-independent and that it is not`)
      out.push({ name, dir: rel, arches, packages, enablement: enablement.length > 0 ? enablement.join(',') : '-', instance: inst,
        control: env.CONTROL_DIR ?? `${rel}/control`, env })
    }
  }
  // An empty discovery would make every caller green having done nothing.
  if (out.length === 0) throw new ProducersError(`error: no package producer was found anywhere under ${root}. Every caller of the discovery would then have an empty set to work over: \`make board-pool\` would build nothing and the package gate would assert nothing, and both would report success. A producer is a directory holding BOTH a Dockerfile and a producer.env; see docs/design/packages.md`)
  return out.sort((a, b) => (row(a) < row(b) ? -1 : row(a) > row(b) ? 1 : 0))
}

/** The five fields of one producer's row. */
export function row(p: Producer): string {
  return `${p.name} ${p.dir} ${p.arches.join(',')} ${p.packages.join(',')} ${p.enablement}`
}

/** One producer by name, or a refusal naming the discovered ones. */
export function producer(name: string, all = discover()): Producer {
  const p = all.find(x => x.name === name)
  if (p === undefined) throw new ProducersError(`error: '${name}' is not a producer this repository defines. Discovered: ${all.map(x => x.name).join(' ')} -- a producer is a directory holding both a Dockerfile and a producer.env, and its NAME is that directory's basename; see docs/design/packages.md`)
  return p
}

/** The declared Version and Source-Date-Epoch of a producer's packages: its control templates carry them
 * (mica-build-tools:docs/design.md 3.3.2), and every template of one producer declares the same pair. */
export function version(p: Producer, root = REPO_ROOT): { version: string, epoch: string } {
  const dir = join(root, p.control)
  const templates = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.control')).sort() : []
  if (templates.length === 0) throw new ProducersError(`error: ${p.control} holds no control template; the producer '${p.name}' declares its packages' Version and Source-Date-Epoch there`)
  const declared = templates.map((t) => {
    try { return packDeclaration(readFileSync(join(dir, t), 'utf8'), join(p.control, t)) }
    catch (e) { throw new ProducersError(`error: ${e instanceof Error ? e.message : String(e)}`) }
  })
  if (new Set(declared.map(d => `${d.version} ${d.epoch}`)).size !== 1)
    throw new ProducersError(`error: the control templates of ${p.control} declare ${[...new Set(declared.map(d => `${d.version} at ${d.epoch}`))].join(' and ')}; one producer's packages are versioned and built together`)
  return { version: declared[0]!.version, epoch: String(declared[0]!.epoch) }
}

/** Where a producer's `mica-inputs` is: its directory, or for a matrix instance the directory its control
 * templates are in (boards/<board>/package), which is that instance's own. */
export function declarationDir(p: Producer): string {
  return p.instance === '' ? p.dir : dirname(p.control)
}

/** The inputs hash of a producer at one architecture (mica.inputs): mica-build-tools over its `mica-inputs`,
 * which must declare exactly the packages the producer builds. */
export function inputsOf(p: Producer, arch: string, root = REPO_ROOT): string {
  let declaration
  try { declaration = readDeclaration(root, declarationDir(p)) }
  catch (e) { throw new ProducersError(`error: ${e instanceof Error ? e.message : String(e)}`) }
  const declared = [...declaration.packages].sort().join(' '), built = [...p.packages].sort().join(' ')
  if (declared !== built) throw new ProducersError(`error: ${declarationDir(p)}/mica-inputs declares ${declared || 'no package'}, and the producer '${p.name}' builds ${built}`)
  return inputsHash(root, declaration, arch)
}

export async function main(argv: string[]): Promise<number> {
  try {
    const usage = 'usage: producers [--dir-for <producer> | --instance-for <producer> | --control-for <producer> | --version-for <producer>]'
    if (argv.length === 0) { await Bun.write(Bun.stdout, discover().map(p => row(p) + '\n').join('')); return 0 }
    if (!['--dir-for', '--instance-for', '--control-for', '--version-for'].includes(argv[0]!)) throw new ProducersError(usage)
    if (argv.length < 2 || argv[1] === '') throw new ProducersError(`error: ${argv[0]} takes a producer name`)
    if (argv.length !== 2) throw new ProducersError(usage)
    const p = producer(argv[1]!)
    if (argv[0] === '--dir-for') { console.log(p.dir) }
    else if (argv[0] === '--instance-for') { console.log(p.instance) }
    else if (argv[0] === '--control-for') { console.log(p.control) }
    else { const v = version(p); console.log(`${v.version} ${v.epoch}`) }
    return 0
  }
  catch (e) {
    if (e instanceof ProducersError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
