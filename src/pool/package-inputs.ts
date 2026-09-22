// The inputs hash of a producer at one architecture: sha256 over a sorted manifest of everything in this
// repository that determines its archives' bytes. It is a guard, not a reuse key: a pool layer records it as
// mica.inputs (src/pool/publish.ts), and the version guard refuses an archive whose version is published
// with other inputs -- a change that forgot its version bump (mica:docs/decisions/2026-09-15-package-
// versions.md R4).
//
//   bun src/cli.ts package-inputs <producer> <amd64|arm64|all>             the hash
//   bun src/cli.ts package-inputs --manifest <producer> <amd64|arm64|all>  the manifest it is taken over
//
// The manifest: the producer name (without its instance), the architecture, the declared version and
// SOURCE_DATE_EPOCH; every tracked file of the producer directory, its control templates and version.env,
// the build driver, the packer and the discovery (src/pool/build.ts, stages/pool/pack.sh,
// src/pool/producers.ts), the instance file, and what its Dockerfile COPYs from each named build context;
// the PREPARE_INPUTS paths and the pinned reference of each image:<name> it names; and the pinned reference
// of every upstream FROM_IMAGES base. Not in it: the build-env image digests, which change with every
// build-env release and are inputs of no package's bytes. The port of tools/deb/package-inputs.sh (deleted
// 2026-09-22): the three tool rows name the TypeScript files, which is the one move of this hash the plan
// allows (mica:docs/plan/20260922-0817-one-language-one-layout.md, Risks).
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolve as resolveImage } from '../locks/from.ts'
import { inputs, type Records } from '../locks/locks.ts'
import { discover, producer as findProducer, version, type Producer, REPO_ROOT } from './producers.ts'

export class PackageInputsError extends Error {}

const TOOLS = ['src/pool/build.ts', 'stages/pool/pack.sh', 'src/pool/producers.ts']

/** `file <path> <sha256>` or `link <path> <target>` for every tracked file under the paths; none is a refusal. */
function files(root: string, paths: string[]): string[] {
  const r = Bun.spawnSync(['git', '-C', root, 'ls-files', '--', ...paths], { stdout: 'pipe', stderr: 'pipe' })
  const listed = r.stdout.toString().split('\n').filter(l => l !== '')
  if (r.exitCode !== 0 || listed.length === 0) throw new PackageInputsError(`no tracked file under ${paths.join(' ')}`)
  return listed.map((f) => {
    const full = join(root, f)
    if (lstatSync(full).isSymbolicLink()) return `link ${f} ${readlinkSync(full)}`
    return `file ${f} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`
  })
}

/** The sources a Dockerfile COPYs from the named context: `COPY --from=<name> <src>... <dest>`. */
export function copiedFrom(dockerfile: string, name: string): string[] {
  const out: string[] = []
  let line = ''
  for (const raw of readFileSync(dockerfile, 'utf8').split('\n')) {
    line += raw
    if (line.endsWith('\\')) { line = line.slice(0, -1); continue }
    const w = line.split(/[ \t]+/)
    line = ''
    if (w[0]?.toUpperCase() !== 'COPY') continue
    let from = '', first = 0
    for (let i = 1; i < w.length; i++) {
      if (w[i]!.startsWith('--from=')) { from = w[i]!.slice('--from='.length) }
      else if (!w[i]!.startsWith('--')) { first = i; break }
    }
    if (from === name && first) for (let i = first; i < w.length - 1; i++) out.push(w[i]!)
  }
  return out
}

/** The manifest lines, sorted and unique. */
export function manifest(p: Producer, arch: string, records: Records = inputs(), root = REPO_ROOT): string[] {
  if (!['amd64', 'arm64', 'all'].includes(arch)) throw new PackageInputsError(`'${arch}' is not amd64, arm64 or all`)
  const declared = version(p, root)
  const contexts = (p.env.BUILD_CONTEXTS ?? '').split(/\s+/).filter(e => e !== '')
  const fromImages = (p.env.FROM_IMAGES ?? '').split(/\s+/).filter(e => e !== '')
  const prepare = p.env.PREPARE ?? '', prepareInputs = (p.env.PREPARE_INPUTS ?? '').split(/\s+/).filter(e => e !== '')
  if (prepare !== '' && prepareInputs.length === 0) throw new PackageInputsError(`${p.dir}/producer.env names PREPARE=${prepare} and no PREPARE_INPUTS: the paths and image:<name> upstream images the hook builds from`)
  const lines = [`producer ${p.name.split('@')[0]}`, `arch ${arch}`, `version ${declared.version} ${declared.epoch}`]
  lines.push(...files(root, [p.dir, p.control, join(dirname(p.control), 'version.env'), ...TOOLS]))
  if (p.instance !== '') lines.push(...files(root, [p.instance]))
  for (const entry of contexts) {
    const i = entry.indexOf('='), name = entry.slice(0, i), path = entry.slice(i + 1)
    const srcs = copiedFrom(join(root, p.dir, 'Dockerfile'), name)
    if (srcs.length > 0) lines.push(...files(root, srcs.map(s => `${path}/${s}`)))
  }
  for (const entry of prepareInputs) {
    if (entry.startsWith('image:')) lines.push(`image ${entry.slice('image:'.length)} ${resolveImage(`upstream:${entry.slice('image:'.length)}`, records)}`)
    else lines.push(...files(root, [entry]))
  }
  for (const entry of fromImages) {
    const key = entry.slice(entry.indexOf('=') + 1)
    if (key.startsWith('upstream:')) lines.push(`image ${key.slice('upstream:'.length)} ${resolveImage(key, records)}`)
  }
  return [...new Set(lines)].sort()
}

/** The hash: sha256 of the manifest as a text of LF-terminated lines. */
export function hash(p: Producer, arch: string, records: Records = inputs(), root = REPO_ROOT): string {
  return createHash('sha256').update(manifest(p, arch, records, root).map(l => l + '\n').join('')).digest('hex')
}

export async function main(argv: string[]): Promise<number> {
  try {
    let mode = 'hash'
    if (argv[0] === '--manifest') { mode = 'manifest'; argv = argv.slice(1) }
    if (argv.length !== 2) throw new PackageInputsError('usage: package-inputs [--manifest] <producer> <amd64|arm64|all>')
    const p = findProducer(argv[0]!, discover())
    if (mode === 'manifest') await Bun.write(Bun.stdout, manifest(p, argv[1]!).map(l => l + '\n').join(''))
    else console.log(hash(p, argv[1]!))
    return 0
  }
  catch (e) {
    if (e instanceof PackageInputsError) { console.error(`package-inputs: error: ${e.message}`); return 1 }
    if (e instanceof Error && ['ProducersError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
