// The inputs of this tree: locks/ (mica:docs/design/release-lock.md).
//
//   bun src/cli.ts locks check                  locks/: every lock, pin and locks/upstream.lock (CI mode under CI or GITHUB_ACTIONS)
//   bun src/cli.ts locks lock <file>            one release lock
//   bun src/cli.ts locks upstream <file>        one locks/upstream.lock
//   bun src/cli.ts locks pins <dir> ci|local    a locks/ directory
//   bun src/cli.ts locks release <input>        <release> TAB <commit> of that input; an input is <repository>[.<scope>],
//                                               and a bare repository names all its scopes when they share one commit
//   bun src/cli.ts locks image <source>:<name>[@<platform>]
//                                               the reference of that image row; a repository image defaults to its
//                                               index, an upstream image names its index digest on every platform row
//   bun src/cli.ts locks rows <kind> [<input>]  every row of that kind, prefixed with its input <repository>[.<scope>];
//                                               the input upstream.lock names the rows of locks/upstream.lock
//   bun src/cli.ts locks pin <input>            the pin as KEY=value lines
//   bun src/cli.ts locks checkout <repository>  the CHECKOUT of that repository's offline pins (one for all its scopes)
//   bun src/cli.ts locks verify                 every pinned release: SHA256SUMS hashes to the pin and lists exactly
//                                               the lock, whose bytes are the committed ones (network, no credential)
//
// Every command except lock, upstream and pins first checks the whole locks/
// directory, so no reader acts on a lock that breaks a rule. A refusal prints
// `locks: refused <rule>: <detail>` and exits 1. Registry checks (a digest
// reads back, a package is a layer of its pool) belong to the readers that
// fetch: tools/pool.sh and tools/board-pool.sh.
//
// This is the port of the Python tools/locks.py (deleted 2026-09-22), rule for rule and message for message;
// the canonical vectors of mica:docs/design/release-lock.md section 9 hold it
// (tests/gates/release-lock-test.sh, tests/gates/vectors-pin-check.sh).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export class Refused extends Error {
  constructor(readonly rule: string, readonly detail = '') { super(rule) }
}

export const REPO_ROOT: string = join(import.meta.dir, '..', '..')
export const LOCKS: string = process.env.MICA_LOCKS_DIR || join(REPO_ROOT, 'locks')
const RELEASES = process.env.MICA_LOCKS_RELEASES ?? 'https://github.com/micaoss/{repository}/releases/download/{release}/'

const KIND_COLUMNS: Record<string, number> = {
  release: 4, image: 5, pool: 3, package: 5, board: 5, upstream: 7, apt: 5,
  input: 4, origin: 3, built: 5, index: 3, product: 8, bundle: 4, asset: 6,
  // `data <name> <file> <sha256>`: something a producer computed about its OWN output that a consumer must read
  // reproducibly from a pinned release (release-lock.md 1.2.4, user 2026-09-20). Any repository may carry it; the
  // name is the key and the meaning belongs to the producer, so a reader that does not understand a row may skip
  // the FILE -- never the row. It is last in the kind order, which is why it is last here.
  data: 4,
}
const KIND_ORDER = Object.keys(KIND_COLUMNS)
const BASE_ONLY = new Set(['upstream', 'apt'])
const BUILD_ONLY = new Set(['input', 'origin', 'built', 'index', 'product', 'bundle', 'asset'])
// The Mica version index: a mica-build release of the reserved scope mica, which references scoped releases.
const INDEX_SCOPE = 'mica'
const INDEX_KINDS = new Set(['origin', 'built', 'index'])
const INDEX_ALLOWED = new Set(['release', 'input', 'origin', 'built', 'index', 'product', 'bundle', 'asset'])
const BUILD_INPUT = /^mica-build\.[a-z0-9][a-z0-9-]*$/
const PROFILE = new Set(['dev', 'prod'])
const GENERATION = /^[1-9][0-9]*$/
const BUNDLE = new Set(['image', 'update'])
const UPDATE_SUFFIX: Record<string, string> = { full: 'micaupd', root: 'root.micaupd', kernel: 'kernel.micaupd' }
const UPSTREAM_COLUMNS: Record<string, number> = { image: 5, source: 6, git: 5 }
const REPOSITORY = /^[a-z0-9][a-z0-9-]*$/
const RELEASE = /^[0-9]{8}-[0-9]{4}$/
const SCOPED = new Set(['mica-build'])
const COMPONENT = new Set(['kernel', 'uboot', 'firmware'])
const SCOPE = /^[a-z0-9][a-z0-9-]*$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const ARCH = new Set(['amd64', 'arm64'])
const PLATFORM = new Set(['index', 'amd64', 'arm64', '386'])
const NAME = /^[a-z0-9][a-z0-9.+-]*$/
const UPSTREAM_NAME = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/
const UPSTREAM_REFERENCE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]+)?\/[a-z0-9._/-]+(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/
const VERSION = /^[A-Za-z0-9.+~:-]+$/
const REFERENCE = /^(?<registry>ghcr\.io\/micaoss|local)\/(?<repository>[a-z0-9][a-z0-9-]*)(?::(?<tag>[A-Za-z0-9._-]+))?@sha256:(?<digest>[0-9a-f]{64})$/

export type Row = string[]
export type Pin = Record<string, string | null>
export type Records = Record<string, [Pin, Row[]]>

function textOf(path: string): string {
  const data = readFileSync(path)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  }
  catch {
    throw new Refused('encoding', path)
  }
  if (!text.endsWith('\n') || text.includes('\r')) throw new Refused('encoding', path)
  return text
}

function linesOf(path: string, header: string): Row[] {
  const lines = textOf(path).slice(0, -1).split('\n')
  if (lines[0] !== header) throw new Refused('header', path)
  const rows: Row[] = []
  for (const line of lines.slice(1)) {
    if (line === '' || line.endsWith('\t') || line.startsWith(' ')) throw new Refused('encoding', `${path}: ${JSON.stringify(line)}`)
    if (line.startsWith('#')) continue
    rows.push(line.split('\t'))
  }
  return rows
}

function field(ok: unknown, detail: string): void {
  if (!ok) throw new Refused('field-value', detail)
}

// rpartition('.'): (before the last dot, the rest); ('', value) when there is no dot.
function rpartition(value: string): [string, string] {
  const i = value.lastIndexOf('.')
  return i < 0 ? ['', value] : [value.slice(0, i), value.slice(i + 1)]
}
// partition('.'): (before the first dot, the rest); (value, '') when there is no dot.
function partition(value: string, sep: string): [string, string] {
  const i = value.indexOf(sep)
  return i < 0 ? [value, ''] : [value.slice(0, i), value.slice(i + sep.length)]
}

function checkUpstreamImage(row: Row): void {
  field(UPSTREAM_NAME.test(row[2]!) && PLATFORM.has(row[3]!), row.join('\t'))
  if (!row[4]!.includes('@sha256:')) throw new Refused('reference-digest', row[4])
  if (row[4]!.startsWith('ghcr.io/micaoss/') || row[4]!.startsWith('local/')) throw new Refused('reference-upstream', row[4])
  field(UPSTREAM_REFERENCE.test(row[4]!), row[4]!)
}

// Byte-wise ordering of a key, as Python compares the encoded tuples.
function compareKeys(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const x = a[i]!, y = b[i]!
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; continue }
    const c = Buffer.compare(Buffer.from(String(x)), Buffer.from(String(y)))
    if (c !== 0) return c
  }
  return 0
}
function isSorted(keys: (number | string)[][]): boolean {
  for (let i = 1; i < keys.length; i++) if (compareKeys(keys[i - 1]!, keys[i]!) > 0) return false
  return true
}

/** The rows of a valid release lock; refuses at the first rule it breaks (1.5). */
export function checkLock(path: string): Row[] {
  const rows = linesOf(path, '# mica-lock v1')
  for (const row of rows) {
    if (!(row[0]! in KIND_COLUMNS)) throw new Refused('kind-unknown', row[0])
    if (row.length !== KIND_COLUMNS[row[0]!]) throw new Refused('column-count', row.join('\t'))
  }
  if (rows.length === 0 || rows[0]![0] !== 'release' || rows.filter(r => r[0] === 'release').length !== 1) throw new Refused('release-row', path)
  const [, repository, releaseField, commit] = rows[0]! as [string, string, string, string]
  const [scope, release] = rpartition(releaseField)
  field(REPOSITORY.test(repository) && (RELEASE.test(release) || release === 'offline') && COMMIT.test(commit)
    && (scope === '' || SCOPE.test(scope)), rows[0]!.join('\t'))
  if ((scope !== '') !== SCOPED.has(repository)) throw new Refused('release-scope', rows[0]!.join('\t'))
  if (scope === INDEX_SCOPE && repository !== 'mica-build') throw new Refused('index-scope', rows[0]!.join('\t'))
  const indexLock = repository === 'mica-build' && scope === INDEX_SCOPE
  if (rows.some(r => INDEX_KINDS.has(r[0]!)) !== indexLock || (indexLock && !rows.some(r => r[0] === 'index'))) throw new Refused('index-scope', path)
  if (rows.some(r => (r[0] === 'product' && (r[1] === INDEX_SCOPE || r[2] === INDEX_SCOPE)) || (r[0] === 'board' && r[1] === INDEX_SCOPE))) throw new Refused('index-scope', path)
  if (indexLock && rows.some(r => !INDEX_ALLOWED.has(r[0]!) || (r[0] === 'input' && !BUILD_INPUT.test(r[1]!)))) throw new Refused('index-only-inputs', path)
  if (indexLock) {
    const inputs = rows.filter(r => r[0] === 'input').map(r => r[1]!)
    if (rows.some(r => r[0] === 'index' && !inputs.includes(r[2]!))
      || rows.some(r => (r[0] === 'origin' || r[0] === 'built') && !inputs.includes(r[1]!))
      || inputs.some(i => rows.filter(r => r[0] === 'origin' && r[1] === i).length !== 1 || !rows.some(r => r[0] === 'built' && r[1] === i)))
      throw new Refused('index-input', path)
  }
  // The release each indexed product comes from: the release of its index row's input.
  const inputRelease = new Map(rows.filter(r => r[0] === 'input').map(r => [r[1]!, r[2]!]))
  const productRelease = new Map(rows.filter(r => r[0] === 'index').map(r => [r[1]!, inputRelease.get(r[2]!)]))
  const registry = release === 'offline' ? 'local' : 'ghcr.io/micaoss'

  const reference = (value: string, expected = repository): string => {
    if (!value.includes('@sha256:')) throw new Refused('reference-digest', value)
    const m = REFERENCE.exec(value)
    if (!m) throw new Refused(value.startsWith('ghcr.io/micaoss/') || value.startsWith('local/') ? 'field-value' : 'reference-registry', value)
    if (m.groups!.registry !== registry) throw new Refused('reference-registry', value)
    if (m.groups!.repository !== expected) throw new Refused('reference-repository', value)
    return m.groups!.tag ?? ''
  }

  const keys = new Set<string>(), pools = new Set<string>(), sortKeys: (number | string)[][] = []
  for (const row of rows.slice(1)) {
    const kind = row[0]!
    let key: string[]
    if (kind === 'image') {
      if (row[1] === 'upstream') { checkUpstreamImage(row) }
      else if (REPOSITORY.test(row[1]!)) {
        field(NAME.test(row[2]!) && PLATFORM.has(row[3]!), row.join('\t'))
        reference(row[4]!, row[1]!)
        if (row[1] !== repository) throw new Refused('image-source', row.join('\t'))
      }
      else { throw new Refused('image-source', row.join('\t')) }
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'pool') {
      field(ARCH.has(row[1]!), row.join('\t'))
      reference(row[2]!)
      key = [row[1]!]
      pools.add(row[1]!)
    }
    else if (kind === 'package') {
      field(NAME.test(row[1]!) && ARCH.has(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!), row.join('\t'))
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'board') {
      field(NAME.test(row[1]!) && COMPONENT.has(row[2]!) && ARCH.has(row[3]!), row.join('\t'))
      reference(row[4]!)
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'input') {
      const [name, inputScope] = partition(row[1]!, '.')
      field(REPOSITORY.test(name) && (inputScope === '' || SCOPE.test(inputScope))
        && (RELEASE.test(row[2]!) || row[2] === 'offline') && SHA256.test(row[3]!), row.join('\t'))
      if ((inputScope !== '') !== SCOPED.has(name)) throw new Refused('release-scope', row.join('\t'))
      key = [row[1]!]
    }
    else if (kind === 'origin') {
      field(BUILD_INPUT.test(row[1]!) && COMMIT.test(row[2]!), row.join('\t'))
      key = [row[1]!]
    }
    else if (kind === 'built') {
      const [builtName, builtScope] = partition(row[2]!, '.')
      if (!(BUILD_INPUT.test(row[1]!) && REPOSITORY.test(builtName) && (builtScope === '' || SCOPE.test(builtScope))
        && (builtScope !== '') === SCOPED.has(builtName) && builtName !== 'mica-build'
        && (RELEASE.test(row[3]!) || row[3] === 'offline') && SHA256.test(row[4]!)))
        throw new Refused('index-built-form', row.join('\t'))
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'index') {
      field(SCOPE.test(row[1]!) && BUILD_INPUT.test(row[2]!), row.join('\t'))
      key = [row[1]!]
    }
    else if (kind === 'product') {
      field(SCOPE.test(row[1]!) && SCOPE.test(row[2]!) && PROFILE.has(row[3]!) && GENERATION.test(row[4]!)
        && row.slice(5, 8).every(v => SHA256.test(v)), row.join('\t'))
      key = [row[1]!]
    }
    else if (kind === 'bundle') {
      field(SCOPE.test(row[1]!) && BUNDLE.has(row[2]!), row.join('\t'))
      const tag = reference(row[3]!)
      if (indexLock) {
        const pr = productRelease.get(row[1]!)
        if (pr === undefined || tag !== `${row[2]}.${row[1]}.${pr}`) throw new Refused('index-product-source', row.join('\t'))
      }
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'asset') {
      let assetRelease: string | undefined = release
      if (indexLock) {
        assetRelease = productRelease.get(row[1]!)
        if (assetRelease === undefined || !row[4]!.startsWith(`mica-${row[1]}-${assetRelease}.`)) throw new Refused('index-product-source', row.join('\t'))
      }
      const prefix = `mica-${row[1]}-${assetRelease}.`
      field(SCOPE.test(row[1]!) && BUNDLE.has(row[2]!) && SHA256.test(row[5]!) && row[4]!.startsWith(prefix)
        && (row[2] === 'image' ? NAME.test(row[3]!) : row[4] === prefix + (UPDATE_SUFFIX[row[3]!] ?? '\n')), row.join('\t'))
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'upstream') {
      const roots = row[6]!.split(',')
      field(NAME.test(row[1]!) && ARCH.has(row[2]!) && VERSION.test(row[3]!) && SHA256.test(row[4]!)
        && row[5]!.startsWith('https://') && roots.every(r => NAME.test(r))
        && JSON.stringify(roots) === JSON.stringify([...new Set(roots)].sort()), row.join('\t'))
      key = [row[1]!, row[2]!]
    }
    else if (kind === 'apt') {
      field(row[1]!.startsWith('https://') && row[2] && row[3] && row[4]!.startsWith('/'), row.join('\t'))
      key = []
    }
    else if (kind === 'data') {
      field(NAME.test(row[1]!) && NAME.test(row[2]!) && SHA256.test(row[3]!), row.join('\t'))
      key = [row[1]!]
    }
    else { throw new Refused('release-row', row.join('\t')) }
    const full = JSON.stringify([kind, ...key])
    if (keys.has(full)) throw new Refused('duplicate-key', row.join('\t'))
    keys.add(full)
    sortKeys.push([KIND_ORDER.indexOf(kind), ...key])
  }
  if (repository !== 'mica-system-base' && rows.some(r => BASE_ONLY.has(r[0]!))) throw new Refused('base-only-kind', path)
  if (repository !== 'mica-build' && rows.some(r => BUILD_ONLY.has(r[0]!))) throw new Refused('build-only-kind', path)
  if (indexLock) {
    const products = new Set(rows.filter(r => r[0] === 'product').map(r => r[1]!))
    const indexed = new Set(productRelease.keys())
    if (products.size !== indexed.size || [...products].some(p => !indexed.has(p))) throw new Refused('index-product-source', path)
  }
  const products = new Set(rows.filter(r => r[0] === 'product').map(r => r[1]!))
  const bundles = new Set(rows.filter(r => r[0] === 'bundle').map(r => `${r[1]}\t${r[2]}`))
  if (rows.some(r => (r[0] === 'bundle' || r[0] === 'asset') && !products.has(r[1]!))) throw new Refused('bundle-without-product', path)
  if (rows.some(r => r[0] === 'asset' && !bundles.has(`${r[1]}\t${r[2]}`))) throw new Refused('asset-without-bundle', path)
  if (rows.some(r => r[0] === 'bundle' && r[2] === 'update' && !rows.some(a => a[0] === 'asset' && a[1] === r[1] && a[2] === 'update' && a[3] === 'full')))
    throw new Refused('update-full', path)
  if (rows.some(r => r[0] === 'package' && !pools.has(r[2]!))) throw new Refused('package-without-pool', path)
  // A board's components (mica-build): the kernel is required, uboot and firmware are the board's to have.
  for (const board of new Set(rows.filter(r => r[0] === 'board').map(r => r[1]!)))
    if (!rows.some(r => r[0] === 'board' && r[1] === board && r[2] === 'kernel')) throw new Refused('board-components', path)
  // The NAME is the key, so two rows may not name one FILE either: a consumer that fetched by name would get one
  // asset for two data.
  const files = rows.filter(r => r[0] === 'data').map(r => r[2]!)
  if (files.length !== new Set(files).size) throw new Refused('data-file', path)
  if (!isSorted(sortKeys)) throw new Refused('sort-order', path)
  return rows
}

export function checkUpstream(path: string): Row[] {
  const rows = linesOf(path, '# mica-lock v1')
  for (const row of rows) {
    if (row[0] === 'release') throw new Refused('upstream-release-row', path)
    if (!(row[0]! in UPSTREAM_COLUMNS)) throw new Refused('kind-unknown', row[0])
    if (row.length !== UPSTREAM_COLUMNS[row[0]!]) throw new Refused('column-count', row.join('\t'))
  }
  const keys = new Set<string>(), sortKeys: (number | string)[][] = []
  const order = Object.keys(UPSTREAM_COLUMNS)
  for (const row of rows) {
    const kind = row[0]!
    let key: string[]
    if (kind === 'image') {
      if (row[1] !== 'upstream') throw new Refused('image-source', row.join('\t'))
      checkUpstreamImage(row)
      key = [row[1]!, row[2]!, row[3]!]
    }
    else if (kind === 'source') {
      field(NAME.test(row[1]!) && (ARCH.has(row[2]!) || row[2] === 'all') && VERSION.test(row[3]!)
        && SHA256.test(row[4]!) && row[5]!.startsWith('https://'), row.join('\t'))
      key = [row[1]!, row[2]!]
    }
    else {
      field(NAME.test(row[1]!) && row[2]!.startsWith('https://') && row[3] && COMMIT.test(row[4]!), row.join('\t'))
      key = [row[1]!]
    }
    const full = JSON.stringify([kind, ...key])
    if (keys.has(full)) throw new Refused('duplicate-key', row.join('\t'))
    keys.add(full)
    sortKeys.push([order.indexOf(kind), ...key])
  }
  if (!isSorted(sortKeys)) throw new Refused('sort-order', path)
  return rows
}

function pairsOf(lines: string[]): [string, string | null][] {
  return lines.map(line => line.includes('=') ? [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] : [line, null])
}

export function readPin(path: string): Pin {
  const lines = textOf(path).slice(0, -1).split('\n')
  if (lines[0] !== '# mica-pin v1') throw new Refused('header', path)
  const pairs = pairsOf(lines.slice(1))
  const keys = pairs.map(([k]) => k)
  const values: Pin = Object.fromEntries(pairs)
  const offline = values.RELEASE === 'offline'
  const scoped = 'SCOPE' in values
  const expected = ['REPOSITORY', ...(scoped ? ['SCOPE'] : []), 'RELEASE', 'SHA256SUMS', ...(offline ? ['CHECKOUT'] : [])]
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Refused('pin-format', path)
  field(REPOSITORY.test(values.REPOSITORY ?? '') && SHA256.test(values.SHA256SUMS ?? '')
    && (offline || RELEASE.test(values.RELEASE ?? '')) && (!scoped || SCOPE.test(values.SCOPE ?? '')), path)
  if (offline) field(isAbsolute(values.CHECKOUT ?? ''), path)
  return values
}

/**
 * A vectors.pin (section 9.2): exactly REPOSITORY then COMMIT, under a header of its own.
 *
 * COMMENT LINES AFTER THE HEADER ARE VALID AND CARRY NOTHING THE GATE ACTS ON. That allowance is not decoration: a
 * repository that must pin a commit carrying a known defect names the defect there, because removing the pin does
 * not remove the artefact -- unpinned, the copy carries the same bytes UNVERIFIABLY. A named defect under a gate
 * beats an unnamed one under none.
 */
export function checkVectorsPin(path: string): Pin {
  const lines = textOf(path).slice(0, -1).split('\n')
  if (lines[0] !== '# mica-vectors-pin v1') throw new Refused('header', path)
  const pairs = pairsOf(lines.slice(1).filter(line => !line.startsWith('#')))
  if (JSON.stringify(pairs.map(([k]) => k)) !== JSON.stringify(['REPOSITORY', 'COMMIT'])) throw new Refused('pin-format', path)
  const values: Pin = Object.fromEntries(pairs)
  // The FULL commit, never a short one: this file is read by a gate that fetches the vectors at that commit, not by
  // a person reading it back.
  field(REPOSITORY.test(values.REPOSITORY ?? '') && /^[0-9a-f]{40}$/.test(values.COMMIT ?? ''), path)
  return values
}

/** {input: (pin values, lock rows)} of a valid locks/ directory (section 4); an input is <repository>[.<scope>]. */
export function checkPins(directory: string, mode: string): Records {
  const pinsDir = join(directory, 'pins')
  const pins = existsSync(pinsDir) ? readdirSync(pinsDir).filter(f => f.endsWith('.pin')).map(f => f.slice(0, -4)).sort() : []
  const locks = readdirSync(directory).filter(f => f.endsWith('.lock') && f !== 'upstream.lock').map(f => f.slice(0, -5)).sort()
  const records: Record<string, Pin> = {}
  for (const name of pins) {
    const values = readPin(join(pinsDir, name + '.pin'))
    const [repository, scope] = partition(name, '.')
    if (values.REPOSITORY !== repository) throw new Refused('name-mismatch', name)
    if ((values.SCOPE ?? '') !== scope) throw new Refused('scope-mismatch', name)
    if (('SCOPE' in values) !== SCOPED.has(repository)) throw new Refused('release-scope', name)
    records[name] = values
  }
  for (const name of pins) if (!locks.includes(name)) throw new Refused('pin-without-lock', name)
  for (const name of locks) if (!pins.includes(name)) throw new Refused('lock-without-pin', name)
  const result: Records = {}
  for (const [name, values] of Object.entries(records)) {
    let rows: Row[]
    try {
      rows = checkLock(join(directory, name + '.lock'))
    }
    catch (e) {
      if (e instanceof Refused) throw new Refused('lock-invalid', `${name}.lock: ${e.rule} ${e.detail}`)
      throw e
    }
    if (rows[0]![1] !== values.REPOSITORY) throw new Refused('lock-invalid', `${name}.lock names ${rows[0]![1]}`)
    const [scope, release] = rpartition(rows[0]![2]!)
    if (scope !== (values.SCOPE ?? '')) throw new Refused('scope-mismatch', name)
    if (release !== values.RELEASE) throw new Refused('release-mismatch', name)
    if ('CHECKOUT' in values && mode === 'ci') throw new Refused('checkout-in-ci', name)
    result[name] = [values, rows]
  }
  return result
}

export function mode(): string {
  return process.env.CI || process.env.GITHUB_ACTIONS ? 'ci' : 'local'
}

/** Every input of a locks/ directory, checked; the default is this tree's locks/ (or MICA_LOCKS_DIR). */
export function inputs(locks = LOCKS): Records {
  const result = checkPins(locks, mode())
  const upstream = join(locks, 'upstream.lock')
  if (existsSync(upstream)) checkUpstream(upstream)
  return result
}

/** Every row of one kind, each prefixed with its input, in input order; `upstream.lock` names locks/upstream.lock. */
export function rows(kind: string, input?: string, locks = LOCKS): Row[] {
  let records = inputs(locks)
  if (input === 'upstream.lock') {
    const path = join(locks, 'upstream.lock')
    records = { 'upstream.lock': [{}, existsSync(path) ? checkUpstream(path) : []] }
  }
  const out: Row[] = []
  for (const repository of Object.keys(records).sort()) {
    if (input !== undefined && repository !== input) continue
    for (const row of records[repository]![1]) if (row[0] === kind) out.push([repository, ...row.slice(1)])
  }
  return out
}

class Exit extends Error {}

export function image(selector: string, records: Records): string {
  const [source, rest] = partition(selector, ':')
  const [name, platform] = partition(rest, '@')
  if (!source || !name) throw new Exit(`locks: error: '${selector}' is not <source>:<name>[@<platform>]`)
  let found: Row[]
  if (source === 'upstream') {
    found = Object.values(records).flatMap(([, lock]) => lock.filter(r => r[0] === 'image' && r[1] === 'upstream' && r[2] === name))
    found = found.filter(r => !platform || r[3] === platform)
  }
  else {
    found = Object.entries(records).filter(([n]) => partition(n, '.')[0] === source)
      .flatMap(([, [, lock]]) => lock.filter(r => r[0] === 'image' && r[1] === source && r[2] === name && r[3] === (platform || 'index')))
  }
  const references = [...new Set(found.map(r => r[4]!))].sort()
  if (references.length !== 1) {
    throw new Exit(`locks: error: ${references.length} image row(s) for ${selector} in locks/`
      + (references.length === 0 ? '; upstream images come only from the upstream rows of locks/mica-build-env.lock' : ''))
  }
  return references[0]!
}

async function verify(records: Records, locks: string): Promise<void> {
  for (const repository of Object.keys(records).sort()) {
    const [values, lockRows] = records[repository]!
    if ('CHECKOUT' in values) throw new Refused('checkout-in-ci', `${repository}: an offline pin names no published release`)
    const base = RELEASES.replace('{repository}', values.REPOSITORY!).replace('{release}', lockRows[0]![2]!)
    const response = await fetch(base + 'SHA256SUMS', { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Exit(`locks: error: ${base}SHA256SUMS: HTTP ${response.status}`)
    const sums = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(sums).digest('hex') !== values.SHA256SUMS)
      throw new Exit(`locks: error: SHA256SUMS of ${repository} ${values.RELEASE} does not hash to the pinned ${values.SHA256SUMS}`)
    const listing = sums.toString().split('\n').filter(l => l !== '').map(line => line.split(/ {2}(.*)/s).filter((_, i) => i < 2))
    const lock = readFileSync(join(locks, repository + '.lock'))
    const expected = [[createHash('sha256').update(lock).digest('hex'), values.REPOSITORY + '.lock']]
    if (JSON.stringify(listing) !== JSON.stringify(expected))
      throw new Exit(`locks: error: SHA256SUMS of ${repository} ${values.RELEASE} does not list exactly locks/${repository}.lock as committed`)
    console.log(`locks: ${repository} ${values.RELEASE}: SHA256SUMS ${values.SHA256SUMS!.slice(0, 12)} lists locks/${repository}.lock, verified`)
  }
}

const USAGE = readFileSync(new URL(import.meta.url)).toString().split('\n').filter(l => l.startsWith('//')).slice(0, 23).map(l => l.slice(3)).join('\n')

export async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  const fileCommands = new Set(['lock', 'upstream', 'pins', 'vectors-pin'])
  try {
    if (argv.length === 2 && command === 'lock') { checkLock(argv[1]!) }
    else if (argv.length === 2 && command === 'upstream') { checkUpstream(argv[1]!) }
    else if (argv.length === 3 && command === 'pins') { checkPins(argv[1]!, argv[2]!) }
    else if (argv.length === 2 && command === 'vectors-pin') { checkVectorsPin(argv[1]!) }
    else if (argv.length === 1 && command === 'check') {
      const records = inputs()
      console.log('locks: locks/ is valid: ' + Object.keys(records).sort().map(r => `${r} ${records[r]![0].RELEASE}`).join(', '))
      return 0
    }
    else if (argv.length === 2 && command === 'release') {
      const records = inputs()
      const named = Object.keys(records).filter(n => n === argv[1] || partition(n, '.')[0] === argv[1])
      if (named.length === 0) throw new Exit(`locks: error: locks/ holds no input ${argv[1]}`)
      const commits = [...new Set(named.map(n => records[n]![1][0]![3]!))].sort()
      if (commits.length !== 1) throw new Exit(`locks: error: the inputs ${named.sort().join(', ')} name ${commits.length} commits; name one input <repository>.<scope>`)
      console.log(named.sort().map(n => records[n]![1][0]![2]).join(',') + '\t' + commits[0])
      return 0
    }
    else if (argv.length === 2 && command === 'checkout') {
      const records = inputs()
      const checkouts = [...new Set(Object.entries(records).filter(([n]) => partition(n, '.')[0] === argv[1]).map(([, [v]]) => v.CHECKOUT ?? ''))].sort()
      if (checkouts.length !== 1 || checkouts[0] === '') throw new Exit(`locks: error: ${argv[1]} has no one offline pin CHECKOUT in locks/ (found ${checkouts.length})`)
      console.log(checkouts[0])
      return 0
    }
    else if (argv.length === 2 && command === 'image') {
      console.log(image(argv[1]!, inputs()))
      return 0
    }
    else if ((argv.length === 2 || argv.length === 3) && command === 'rows') {
      for (const row of rows(argv[1]!, argv[2])) console.log(row.join('\t'))
      return 0
    }
    else if (argv.length === 2 && command === 'pin') {
      const records = inputs()
      if (!(argv[1]! in records)) throw new Exit(`locks: error: locks/ holds no input ${argv[1]}`)
      for (const [key, value] of Object.entries(records[argv[1]!]![0])) console.log(`${key}=${value}`)
      return 0
    }
    else if (argv.length === 1 && command === 'verify') {
      await verify(inputs(), LOCKS)
      return 0
    }
    else { throw new Exit(USAGE) }
  }
  catch (e) {
    if (e instanceof Refused) {
      console.error(`locks: refused ${e.rule}` + (e.detail ? `: ${e.detail}` : ''))
      if (fileCommands.has(command ?? '')) console.log(`refused ${e.rule}`)
      return 1
    }
    if (e instanceof Exit) { console.error(e.message); return 1 }
    throw e
  }
  if (fileCommands.has(command ?? '')) console.log('valid')
  return 0
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
