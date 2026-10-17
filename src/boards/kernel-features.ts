// The kernel features (common/kernel/features.tsv): what a board's kernel merges beside core, and what makes a
// product need each. A board names its features in board.env's KERNEL_FEATURES; its kernel build composes the
// floor from them (common/kernel/compose-floor.sh), and three places hold a product to them:
//
//   src/product/product.ts      the product's init, features and storage model
//   src/rootfs/build.ts         the Debian packages of the root it composed
//   src/image/kernel-package.ts the fetched kernel: the floor it was built with names the board's features,
//                               and every =y line of that floor is in its config
//
// The table is read here and by compose-floor.sh; tests/gates/kernel-features.test.ts holds the two readers to
// one answer.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class KernelFeatureError extends Error {}

export const FEATURES_TABLE = join(resolve(import.meta.dir, '../..'), 'common/kernel/features.tsv')
export const TRIGGER_KINDS = ['init', 'storage', 'feature', 'package'] as const
export type TriggerKind = typeof TRIGGER_KINDS[number]
export interface Trigger { kind: TriggerKind, value: string }
export interface KernelFeature { name: string, requires: string[], lsm: string[], triggers: Trigger[] }

const NAME = /^[a-z0-9][a-z0-9-]*$/

const list = (cell: string) => (cell === '-' ? [] : cell.split(','))

/** The table's rows, core first. */
export function parseKernelFeatures(text: string, file = 'features.tsv'): KernelFeature[] {
  const fail = (m: string): never => { throw new KernelFeatureError(`${file}: ${m}`) }
  const lines = text.split('\n')
  if (lines[0] !== '# mica kernel features v1') fail('the first line is not "# mica kernel features v1"')
  const rows: KernelFeature[] = []
  for (const [i, line] of lines.entries()) {
    if (line === '' || line.startsWith('#')) continue
    const c = line.split('\t')
    if (c.length !== 4 || c.some(x => x === '')) fail(`line ${i + 1}: a row is <feature> <requires> <lsm> <triggers>, four columns`)
    const [name, requires, lsm, triggers] = c as [string, string, string, string]
    if (!NAME.test(name)) fail(`line ${i + 1}: '${name}' is not a feature name`)
    if (rows.some(r => r.name === name)) fail(`line ${i + 1}: a second row for ${name}`)
    const parsed = list(triggers).map((t) => {
      const at = t.indexOf(':'), kind = t.slice(0, at), value = t.slice(at + 1)
      if (at < 1 || !(TRIGGER_KINDS as readonly string[]).includes(kind) || !/^[a-z0-9][a-z0-9+.-]*$/.test(value)) fail(`line ${i + 1}: '${t}' is no trigger (${TRIGGER_KINDS.map(k => `${k}:<name>`).join(', ')})`)
      return { kind: kind as TriggerKind, value }
    })
    rows.push({ name, requires: list(requires), lsm: list(lsm), triggers: parsed })
  }
  if (rows[0]?.name !== 'core') fail('the first row is not core')
  if (rows[0]!.requires.length > 0 || rows[0]!.triggers.length > 0) fail('core requires nothing and is triggered by nothing: every board merges it')
  for (const r of rows) for (const q of r.requires) if (q === 'core' || !rows.some(x => x.name === q)) fail(`${r.name} requires '${q}', which is no feature beside core`)
  return rows
}

export function kernelFeatures(file = FEATURES_TABLE): KernelFeature[] {
  return parseKernelFeatures(readFileSync(file, 'utf8'), file)
}

/** The storage models the table knows: the values of its storage: triggers. */
export function storageFeature(table: readonly KernelFeature[], model: string): string {
  const found = table.filter(f => f.triggers.some(t => t.kind === 'storage' && t.value === model))
  if (found.length !== 1) throw new KernelFeatureError(`features.tsv has ${found.length} features for the storage model ${model}, not one`)
  return found[0]!.name
}

/**
 * board.env's KERNEL_FEATURES, held to the table: every name a row beside core, none twice, every required
 * feature named too, and exactly one storage model -- `model`'s, the board's layout's.
 */
export function boardKernelFeatures(table: readonly KernelFeature[], value: string | undefined, model: string, where = 'board.env'): string[] {
  const fail = (m: string): never => { throw new KernelFeatureError(`${where}: ${m}`) }
  if (value === undefined) fail('declares no KERNEL_FEATURES; every board names the kernel features it merges beside core (common/kernel/features.tsv)')
  const names = value!.split(/\s+/).filter(Boolean)
  for (const [i, n] of names.entries()) {
    if (n === 'core') fail('KERNEL_FEATURES names core; every board merges it, and a board names only the features beside it')
    if (!table.some(f => f.name === n)) fail(`KERNEL_FEATURES names '${n}', which common/kernel/features.tsv has no row for; the features are: ${table.slice(1).map(f => f.name).join(' ')}`)
    if (names.indexOf(n) !== i) fail(`KERNEL_FEATURES names '${n}' twice`)
  }
  for (const n of names) for (const r of table.find(f => f.name === n)!.requires) if (!names.includes(r)) fail(`KERNEL_FEATURES names ${n}, which requires ${r}, and not ${r}`)
  const storage = names.filter(n => table.find(f => f.name === n)!.triggers.some(t => t.kind === 'storage'))
  const want = storageFeature(table, model)
  if (storage.length !== 1 || storage[0] !== want) fail(`KERNEL_FEATURES names the storage feature(s) ${storage.join(' ') || 'none'}; the board's layout is the ${model} storage model, whose kernel feature is ${want}, and a board names exactly that one`)
  return names
}

/** What a product brings that triggers a feature. */
export interface Needs { init?: string, storage?: string, features?: readonly string[], packages?: Iterable<string> }

/** The features `needs` triggers, each with the reasons, and the features those require. */
export function neededKernelFeatures(table: readonly KernelFeature[], needs: Needs): Map<string, string[]> {
  const have: Record<TriggerKind, Set<string>> = {
    init: new Set(needs.init === undefined ? [] : [needs.init]), storage: new Set(needs.storage === undefined ? [] : [needs.storage]),
    feature: new Set(needs.features ?? []), package: new Set(needs.packages ?? []),
  }
  const needed = new Map<string, string[]>()
  const add = (name: string, why: string) => { needed.set(name, [...(needed.get(name) ?? []), why]) }
  for (const f of table) for (const t of f.triggers) if (have[t.kind].has(t.value)) add(f.name, `${t.kind}:${t.value}`)
  for (let grown = true; grown;) {
    grown = false
    for (const [name] of needed) for (const r of table.find(f => f.name === name)!.requires) if (!needed.has(r)) { add(r, `required by ${name}`); grown = true }
  }
  return needed
}

/** One line per needed feature the board does not name, saying what needs it; empty when the board has them all. */
export function missingKernelFeatures(board: readonly string[], needed: Map<string, string[]>): string[] {
  return [...needed].filter(([name]) => !board.includes(name)).map(([name, why]) => `${name} (${why.join(', ')})`)
}

/** The features a composed floor (mica-required.fragment, compose-floor.sh) says it holds: its second line. */
export function floorFeatures(text: string): string[] {
  const line = text.split('\n')[1] ?? ''
  if (!line.startsWith('# mica kernel features:')) throw new KernelFeatureError('the floor does not name its kernel features on its second line ("# mica kernel features: ..."); it was not composed by common/kernel/compose-floor.sh')
  return line.slice('# mica kernel features:'.length).split(/\s+/).filter(Boolean)
}

/**
 * A fetched kernel against its board: the floor it was built with (its mica-required.fragment) names exactly the
 * board's KERNEL_FEATURES, and every =y line of that floor is =y in its resolved config. A refusal, or undefined.
 */
export function kernelFloorRefusal(floor: string, config: string, board: readonly string[]): string | undefined {
  let built: string[]
  try { built = floorFeatures(floor) }
  catch (e) { return (e as Error).message }
  if (built.length !== board.length || board.some(f => !built.includes(f)))
    return `the kernel was built with the kernel features "${built.join(' ')}", and its board names KERNEL_FEATURES="${board.join(' ')}"`
  const lines = new Set(config.split('\n'))
  const absent = floor.split('\n').filter(l => /^CONFIG_[A-Z0-9_]+=y$/.test(l) && !lines.has(l))
  return absent.length > 0 ? `the kernel's config lacks ${absent.join(', ')}, which its floor states` : undefined
}
