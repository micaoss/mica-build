// Every Debian package producer in this repository, discovered from the tree.
//
//   bun src/cli.ts producers
//   -> board@cx3576 producers/board arm64 mica-board-cx3576 mica-board-cx3576=1
//      radio-wifi producers/radio-wifi all mica-wifi,mica-wifi-ap mica-wifi=1,mica-wifi-ap=0
//
//   bun src/cli.ts producers --dir-for <producer>        -> producers/board
//   bun src/cli.ts producers --instance-for <producer>   -> boards/cx3576/board.env  (the FOR_EACH file the
//                                                          instance is; empty for a plain producer)
//   bun src/cli.ts producers --control-for <producer>    -> boards/cx3576/package/control  (CONTROL_DIR of the
//                                                          producer.env, else <dir>/control)
//   bun src/cli.ts producers --version-for <producer>    -> 0.1.0-1 1789430400  (the declared VERSION and
//                                                          SOURCE_DATE_EPOCH)
//
// A producer declares its packages' version in version.env beside its control templates (the control
// directory's parent: <dir>/version.env, or boards/<board>/package/version.env for the board producer),
// exactly two lines VERSION=<upstream>-<revision> and SOURCE_DATE_EPOCH=<seconds>, bumped together. The
// version carries no commit, date, release or .dirty stamp and no epoch (mica:docs/decisions/2026-09-15-
// package-versions.md).
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
// only discovery; every other module reads it. The convention is documented in tools/deb/README.md.
//
// producer.env and the instance files are plain KEY=value, read here rather than sourced: a value may be
// double-quoted and may name an earlier key or the instance's keys as ${NAME} or $NAME (the shell sourced
// the instance first, then producer.env, under set -u); a command substitution, a line that is not an
// assignment and a name nothing set are refused. The port of tools/deb/producers.sh (deleted 2026-09-22),
// message for message.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

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
  if (out.length === 0) throw new ProducersError(`error: no package producer was found anywhere under ${root}. Every caller of the discovery would then have an empty set to work over: \`make board-pool\` would build nothing and the package gate would assert nothing, and both would report success. A producer is a directory holding BOTH a Dockerfile and a producer.env; see tools/deb/README.md`)
  return out.sort((a, b) => (row(a) < row(b) ? -1 : row(a) > row(b) ? 1 : 0))
}

/** The five fields of one producer's row. */
export function row(p: Producer): string {
  return `${p.name} ${p.dir} ${p.arches.join(',')} ${p.packages.join(',')} ${p.enablement}`
}

/** One producer by name, or a refusal naming the discovered ones. */
export function producer(name: string, all = discover()): Producer {
  const p = all.find(x => x.name === name)
  if (p === undefined) throw new ProducersError(`error: '${name}' is not a producer this repository defines. Discovered: ${all.map(x => x.name).join(' ')} -- a producer is a directory holding both a Dockerfile and a producer.env, and its NAME is that directory's basename; see tools/deb/README.md`)
  return p
}

/** The declared VERSION and SOURCE_DATE_EPOCH of a producer's packages (version.env beside its control templates). */
export function version(p: Producer, root = REPO_ROOT): { version: string, epoch: string } {
  const vf = join(dirname(p.control), 'version.env')
  if (!existsSync(join(root, vf))) throw new ProducersError(`error: ${vf} does not exist. The producer '${p.name}' declares its packages' version there: VERSION=<upstream>-<revision> and SOURCE_DATE_EPOCH=<seconds>`)
  const lines = readFileSync(join(root, vf), 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#'))
  if (lines.map(l => l.replace(/=.*/, '')).sort().join(' ') !== 'SOURCE_DATE_EPOCH VERSION') throw new ProducersError(`error: ${vf} must declare exactly VERSION and SOURCE_DATE_EPOCH, once each, as plain KEY=value lines`)
  const v = lines.find(l => l.startsWith('VERSION='))!.slice('VERSION='.length), e = lines.find(l => l.startsWith('SOURCE_DATE_EPOCH='))!.slice('SOURCE_DATE_EPOCH='.length)
  if (!/^[0-9][A-Za-z0-9.+~]*-[A-Za-z0-9.+~]+$/.test(v)) throw new ProducersError(`error: ${vf} declares VERSION=${v}, which is not a Debian <upstream>-<revision> version without an epoch`)
  if (v.includes('+git') || v.includes('.dirty')) throw new ProducersError(`error: ${vf} declares VERSION=${v}; a package version carries no commit or .dirty stamp`)
  if (!/^[1-9][0-9]*$/.test(e)) throw new ProducersError(`error: ${vf} declares SOURCE_DATE_EPOCH=${e}, which is not whole seconds since the epoch`)
  return { version: v, epoch: e }
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
