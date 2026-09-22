// A release target's evidence.json, checked against the shape the assembly requires.
//
//   bun src/cli.ts evidence-schema boards/<board>/evidence.json <board>
//
// The authority is src/image/release-manifest.ts (the `evidence` function): it reads the file as
// board-evidence.json, takes the product's bootAssurance from it, and gateRelease re-reads it inside the
// assembled directory. This is a pre-check, not a second authority: it exists because the assembly validates at
// `--release assemble`, which runs AFTER the product's archives and images are built, so a malformed file there
// costs a whole product build. Keep it in step with that file; where they disagree, that file wins.
//
// The port of tests/gates/evidence-schema.py (deleted 2026-09-22), rule for rule and message for message.
import { readFileSync } from 'node:fs'

// A path into a repository, not preceded by `<repository>:`. THE TOP-LEVEL NAMES ARE ENUMERATED, not derived:
// they are the directories the workspace's repositories actually have, and a new one has to be added here. What
// this catches is the shape that rotted -- on 2026-09-20 six of this repository's twelve evidence references
// named `tests/file-ab-uefi-x64/` and `tests/file-ab-fit/`, directories mica-build had renamed, and the bare form
// made them read as local paths that something here could resolve. NOTHING here can: every instrument these
// documents cite is in another repository.
//
// It asserts the citation says WHERE, not that the path exists. Resolving it would mean pinning a repository
// that consumes this one, which inverts the dependency, or pointing a gate at its `main`, which is a coupling
// worse than the staleness it catches.
const BARE_PATH = /(?<![\w:/-])(?:verify|tests|build|boot|rootfs|tools|crates|src)\/[A-Za-z0-9_./-]+/g

const LEVELS: Record<string, string[]> = {
  I1: ['verity-root'],
  I2: ['verity-root', 'ab-fallback', 'update-negative'],
  I3: ['verity-root', 'ab-fallback', 'update-negative', 'vendor-boot-capability', 'signature-negative'],
  I4: ['verity-root', 'ab-fallback', 'update-negative', 'vendor-boot-capability', 'signature-negative'],
}
const KEYS = ['schemaVersion', 'board', 'revision', 'bootAssurance', 'qualification', 'evidenceRefs', 'physicalBoundaries']
const BOUNDARIES = ['jtag', 'recoveryPath', 'serialConsole']

class Exit extends Error {}

function sorted(keys: string[]): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** A list the way Python prints one: ['a', 'b']. */
function pyList(values: string[]): string {
  return '[' + values.map(v => `'${v}'`).join(', ') + ']'
}

function pyRepr(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function check(path: string, board: string): string {
  let doc: Record<string, unknown>
  try { doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
  catch (error) { throw new Exit(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Exit(`${path} has keys ${pyList([])}; the assembly reads exactly ${pyList(sorted(KEYS))}`)
  const keys = sorted(Object.keys(doc))
  if (keys.join('\0') !== sorted(KEYS).join('\0')) throw new Exit(`${path} has keys ${pyList(keys)}; the assembly reads exactly ${pyList(sorted(KEYS))}`)
  if (doc.schemaVersion !== 2 || doc.board !== board) throw new Exit(`${path} is schemaVersion ${pyRepr(doc.schemaVersion)} for board ${pyRepr(doc.board)}`)
  for (const field of ['revision', 'qualification']) if (!isText(doc[field])) throw new Exit(`${path}: ${field} is empty`)
  const level = doc.bootAssurance
  if (typeof level !== 'string' || !(level in LEVELS)) throw new Exit(`${path}: bootAssurance ${pyRepr(level)} is not one of ${sorted(Object.keys(LEVELS)).join(', ')}`)
  const refs = doc.evidenceRefs
  if (!Array.isArray(refs) || refs.length === 0) throw new Exit(`${path}: evidenceRefs is empty`)
  const classes = new Set<string>()
  for (const ref of refs as Record<string, unknown>[]) {
    const refKeys = ref !== null && typeof ref === 'object' && !Array.isArray(ref) ? sorted(Object.keys(ref)) : []
    if (refKeys.join('\0') !== 'class\0ref') throw new Exit(`${path}: an evidence reference is ${pyList(refKeys)}, not {class, ref}`)
    if (typeof ref.class !== 'string' || !LEVELS.I4!.includes(ref.class)) throw new Exit(`${path}: ${pyRepr(ref.class)} is not an evidence class the assembly knows`)
    if (!isText(ref.ref)) throw new Exit(`${path}: the ${ref.class} reference is empty`)
    for (const bare of ref.ref.matchAll(BARE_PATH)) {
      throw new Exit(
        `${path}: the ${ref.class} reference names ${pyRepr(bare[0])} without a repository. Every instrument this file`
        + ' cites lives in another repository -- there is no verify/ or tests/lifecycle-*/'
        + ' here -- so a bare path reads as local and cannot be resolved by anybody.'
        + ' Write it as <repository>:<path> (mica:docs/README.md, *Workspace facts*).')
    }
    classes.add(ref.class)
  }
  const missing = LEVELS[level]!.filter(c => !classes.has(c))
  if (missing.length > 0) throw new Exit(`${path} claims ${level} without ${missing.join(', ')}`)
  const boundaries = doc.physicalBoundaries
  const boundaryKeys = boundaries !== null && typeof boundaries === 'object' && !Array.isArray(boundaries) ? sorted(Object.keys(boundaries as object)) : []
  if (boundaryKeys.join('\0') !== BOUNDARIES.join('\0')) throw new Exit(`${path}: physicalBoundaries is ${pyList(boundaryKeys)}; the assembly reads exactly ${pyList(BOUNDARIES)}`)
  for (const [name, text] of Object.entries(boundaries as Record<string, unknown>)) if (!isText(text)) throw new Exit(`${path}: the ${name} boundary is empty`)
  return `${path}: ${level}, ${refs.length} reference(s)`
}

export function main(argv: string[]): number {
  const [path, board] = argv
  if (path === undefined || board === undefined) { console.error('usage: bun src/cli.ts evidence-schema <evidence.json> <board>'); return 2 }
  try { console.log(check(path, board)); return 0 }
  catch (e) {
    if (e instanceof Exit) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
