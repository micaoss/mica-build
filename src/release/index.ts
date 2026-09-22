// The Mica version index (mica.<YYYYMMDD-HHMM>): its lock and mica-index.json. Called by tools/release.sh index.
//
//   bun src/cli.ts release-index lock <history.tsv> <products.tsv> <stamp> <commit> <full|incremental> <out lock> <out entering.tsv>
//       history.tsv: <release label> TAB <lock path> TAB <SHA256SUMS path>, newest first (tools/release.sh history);
//           an index's mica-index.json sits beside its lock
//       products.tsv: <product> TAB <board> TAB <profile> TAB <features> TAB <publish 0|1>
//       full: the newest scoped release of the history carrying each published product. incremental: the entries of
//       the newest index of the history carried unread, a newer scoped release of the history entering or replacing
//       entries, and the entry of a product no longer published dropped. A previous index bounds the stamp and the
//       generations either way. entering.tsv: <product> TAB <release label> of every entry not carried.
//       Refusals exit 3 naming their cause, a stamp not later than every reference and the previous index exits 4,
//       and an incremental index into which nothing enters and from which nothing is dropped exits 5.
//   bun src/cli.ts release-index json <lock> <history.tsv> <entering.tsv> <products.tsv> <boards.tsv> <layers.tsv> <assets.tsv> <downloads base> <mirrors.list|-> <out json>
//       boards.tsv: <board> TAB <arch> TAB <release target 0|1>
//       layers.tsv: <bundle reference> TAB <manifest path>, of the entering entries
//       assets.tsv: <release label> TAB <file> TAB <size>, of the entering entries
//       The previous index's mica-index.json is first proved to be its lock's; a carried entry is its entry there.
//       mirrors.list holds one absolute https prefix per line, in the order a reader should try them; each file's
//       mirrors are derived as <prefix>/<scope>/<stamp>/<file> and the member is omitted where there is none.
//
// The port of tools/release-index.py (deleted 2026-09-22), refusal for refusal and byte for byte: the lock's row
// order and the canonical JSON (mica:docs/design/mica-index.md section 2) are what a consumer verifies.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const KIND_ORDER = ['release', 'input', 'origin', 'built', 'index', 'product', 'bundle', 'asset']
const KEY_WIDTH: Record<string, number> = { input: 1, origin: 1, built: 2, index: 1, product: 1, bundle: 2, asset: 3 }
const LAYER_FIELDS = ['size', 'compression', 'uncompressedSha256', 'uncompressedSize']

class Refusal extends Error {
  constructor(message: string, readonly code = 3) { super(message) }
}
function refuse(message: string, code = 3): never {
  throw new Refusal(`release-index: ${message}`, code)
}

type Row = string[]
type Json = Record<string, unknown>
type Release = { label: string, rows: Row[], lock: string, sums: string }

/**
 * The committed mirror prefixes, in file order: a preference list, never sorted (mica-index.md 3.1).
 *
 * A line is the whole prefix an asset's <scope>/<stamp>/<file> is appended to, not a host with a path this
 * emitter knows: mica-res moved its download host and dropped a path segment on 2026-09-18, and a prefix in a
 * committed file makes that one line of this repository rather than a change here and in the spec.
 */
function mirrorBases(path: string): string[] {
  if (path === '-' || !existsSync(path)) return []
  const bases = readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(b => b && !b.startsWith('#'))
  for (const b of bases)
    if (!b.startsWith('https://') || b.replace(/\/+$/, '') !== b) refuse(`${path}: ${pyRepr(b)} is no absolute https base without a trailing slash`)
  if (new Set(bases).size !== bases.length) refuse(`${path}: a base is named twice; each mirror appears once`)
  return bases
}

// Python's repr of a str: single quotes unless the string holds a single quote and no double quote.
function pyRepr(s: string): string {
  const q = s.includes('\'') && !s.includes('"') ? '"' : '\''
  const body = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
  return q + (q === '\'' ? body.replace(/'/g, '\\\'') : body) + q
}

/** The mirrors of one file, derived and never looked up; the member is omitted where the list is empty. */
export function mirrorsOf(bases: string[], label: string, file: string, url: string): string[] {
  const [scope, stamp] = splitLabel(label)
  const entries = bases.map(base => `${base}/${scope}/${stamp}/${file}`)
  if (entries.some(e => e === url)) refuse(`${file}: a mirror equals its url ${url}, which is the source the reader already has`)
  return entries
}

function splitLabel(label: string): [string, string] {
  const i = label.indexOf('.')
  return i < 0 ? [label, ''] : [label.slice(0, i), label.slice(i + 1)]
}

function rowsOf(path: string): Row[] {
  return readFileSync(path, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'))
}
function tsv(path: string): Row[] {
  return readFileSync(path, 'utf8').split('\n').filter(line => line).map(line => line.split('\t'))
}
type Product = { product: string, board: string, profile: string, features: string[], publish: boolean }
function productsOf(path: string): Product[] {
  return tsv(path).map(([product, board, profile, features, publish]) =>
    ({ product: product!, board: board!, profile: profile!, features: (features ?? '').split(/\s+/).filter(f => f), publish: publish === '1' }))
}
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}
/** The stamp of a release tag <scope>.<YYYYMMDD-HHMM>; a scope holds no dot. */
function stampOf(label: string): string {
  return splitLabel(label)[1]
}
function historyOf(path: string): [Release[], Release | undefined] {
  const history = tsv(path).map(([label, lockPath, sums]) => ({ label: label!, rows: rowsOf(lockPath!), lock: lockPath!, sums: sums! }))
  const indexes = history.filter(h => h.label.startsWith('mica.'))
  return [history.filter(h => !h.label.startsWith('mica.')), indexes[0]]
}
/** The scoped release label that the input <name> of an index lock names. */
function inputLabel(rows: Row[], name: string): string {
  return splitLabel(name)[1] + '.' + rows.find(r => r[0] === 'input' && r[1] === name)![2]
}
// Python's str comparison of two ASCII stamps and the byte-wise sort of keys.
function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function lock(historyPath: string, productsPath: string, stamp: string, commit: string, mode: string, out: string, enteringOut: string): void {
  const [scoped, previous] = historyOf(historyPath)
  const published = productsOf(productsPath).filter(p => p.publish).map(p => p.product)
  // product -> (label, source): a source is a scoped release, or the previous index for a carried entry.
  const entries = new Map<string, [string, Release]>(), carried = new Set<string>(), dropped: string[] = []
  if (mode === 'incremental') {
    if (previous === undefined) refuse('an incremental index needs a previous index')
    for (const r of previous.rows) {
      if (r[0] !== 'index') continue
      if (published.includes(r[1]!)) {
        entries.set(r[1]!, [inputLabel(previous.rows, r[2]!), previous])
        carried.add(r[1]!)
      }
      else { dropped.push(r[1]!) }
    }
  }
  for (const product of published) {
    for (const release of scoped) {
      if (release.rows.some(r => r[0] === 'product' && r[1] === product)) {
        const have = entries.get(product)
        if (have === undefined || cmpBytes(stampOf(release.label), stampOf(have[0])) > 0) {
          entries.set(product, [release.label, release])
          carried.delete(product)
        }
        break
      }
    }
  }
  if (entries.size === 0) {
    // No scoped release exists yet (the tag form changed, or nothing is released): there is nothing to index,
    // which is not a refusal -- the caller returns without cutting one.
    refuse('no published product has a scoped release; there is nothing to index', 5)
  }
  const byScope = new Map<string, string>()
  for (const product of [...entries.keys()].sort(cmpBytes)) {
    const label = entries.get(product)![0]
    const scope = splitLabel(label)[0]
    if (!byScope.has(scope)) byScope.set(scope, label)
    if (byScope.get(scope) !== label) refuse(`products of the scope ${scope} come from two releases, ${byScope.get(scope)} and ${label}; one input names one release of a scope`)
  }
  if (previous) {
    const before = new Map(previous.rows.filter(r => r[0] === 'product').map(r => [r[1]!, parseInt(r[4]!, 10)]))
    for (const product of [...entries.keys()].sort(cmpBytes)) {
      const [label, source] = entries.get(product)!
      const generation = parseInt(source.rows.find(r => r[0] === 'product' && r[1] === product)![4]!, 10)
      if (before.has(product) && generation < before.get(product)!)
        refuse(`${product}: generation ${generation} of ${label} is lower than ${before.get(product)} in the previous index ${previous.label}`)
    }
  }
  const stamps = [...entries.values()].map(([label]) => stampOf(label))
  if (previous) stamps.push(stampOf(previous.label))
  const newest = stamps.reduce((a, b) => (cmpBytes(b, a) > 0 ? b : a))
  if (!(cmpBytes(stamp, newest) > 0)) refuse(`the stamp ${stamp} is not later than ${newest}`, 4)
  if (mode === 'incremental' && dropped.length === 0 && carried.size === entries.size && [...entries.keys()].every(p => carried.has(p)))
    refuse(`nothing enters or leaves the previous index ${previous!.label}`, 5)
  const lines: Row[] = [['release', 'mica-build', `mica.${stamp}`, commit]]
  // dict(entries.values()): label -> source, in first-insertion order of the label, last value wins (the same).
  const byLabel = new Map<string, Release>()
  for (const [label, source] of entries.values()) byLabel.set(label, source)
  for (const [label, source] of byLabel) {
    const name = 'mica-build.' + splitLabel(label)[0]
    if (source === previous) { lines.push(...previous!.rows.filter(r => ['input', 'origin', 'built'].includes(r[0]!) && r[1] === name)) }
    else {
      lines.push(['input', name, stampOf(label), sha256(source.sums)])
      lines.push(['origin', name, source.rows[0]![3]!])
      lines.push(...source.rows.filter(r => r[0] === 'input').map(r => ['built', name, ...r.slice(1)]))
    }
  }
  for (const [product, [label, source]] of entries) {
    lines.push(['index', product, 'mica-build.' + splitLabel(label)[0]])
    lines.push(...source.rows.filter(r => ['product', 'bundle', 'asset'].includes(r[0]!) && r[1] === product))
  }
  const trusts = new Map<string, string>()
  for (const r of lines) {
    if (r[0] !== 'built') continue
    const k = `${r[2]}\t${r[3]}`
    if (!trusts.has(k)) trusts.set(k, r[4]!)
    if (trusts.get(k) !== r[4]) refuse(`the input ${r[2]} ${r[3]} has the trust hash ${trusts.get(k)} in one release and ${r[4]} in another`)
  }
  const [head, ...body] = lines
  body.sort((a, b) => {
    const ka = [KIND_ORDER.indexOf(a[0]!), ...a.slice(1, 1 + KEY_WIDTH[a[0]!]!)], kb = [KIND_ORDER.indexOf(b[0]!), ...b.slice(1, 1 + KEY_WIDTH[b[0]!]!)]
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      if (i >= ka.length) return -1
      if (i >= kb.length) return 1
      const x = ka[i]!, y = kb[i]!
      if (typeof x === 'number' && typeof y === 'number') { if (x !== y) return x - y; continue }
      const c = cmpBytes(String(x), String(y))
      if (c !== 0) return c
    }
    return 0
  })
  writeFileSync(out, '# mica-lock v1\n' + [head!, ...body].map(r => r.join('\t') + '\n').join(''))
  writeFileSync(enteringOut, [...entries.keys()].sort(cmpBytes).filter(p => !carried.has(p)).map(p => `${p}\t${entries.get(p)![0]}\n`).join(''))
  for (const product of [...dropped].sort(cmpBytes)) console.error(`release-index: ${product} is no longer published; its entry is dropped`)
}

type Item = Json & { file: string, url: string, kind: string, sha256: string }
type Entry = Json & { product: string, release: string, bundles: Record<string, string>, images: Item[], updates: Item[] }

/** Everything of mica-index.json the lock alone determines; the layer fields of a product's files are null. */
function lockParts(rows: Row[], lockSha: string, downloads: string, bases: string[]): [Json, Json[], Json[], Record<string, Entry>] {
  const release = rows[0]!
  const inputs = new Map<string, Json>(), releases: Json[] = []
  const inputNames = rows.filter(r => r[0] === 'input').map(r => r[1]!).sort((a, b) => cmpBytes(inputLabel(rows, a), inputLabel(rows, b)))
  for (const name of inputNames) {
    const ids: string[] = []
    for (const r of rows) {
      if (r[0] !== 'built' || r[1] !== name) continue
      const [repository, scope] = splitLabel(r[2]!)
      // The id keeps its slash: it joins a built name to a release, it is no git tag (mica-index.md 3.1).
      const entry: Json = { id: `${r[2]}/${r[3]}`, repository }
      if (scope) entry.scope = scope
      inputs.set(entry.id as string, { ...entry, release: r[3], trust: r[4] })
      ids.push(entry.id as string)
    }
    releases.push({
      release: inputLabel(rows, name), trust: rows.find(r => r[0] === 'input' && r[1] === name)![3],
      commit: rows.find(r => r[0] === 'origin' && r[1] === name)![2], inputs: ids.sort(cmpBytes),
    })
  }
  const products: Record<string, Entry> = {}
  for (const indexRow of rows.filter(r => r[0] === 'index')) {
    const product = indexRow[1]!, label = inputLabel(rows, indexRow[2]!)
    const [, , board, profile, generation, deployment, kernel, rootfs] = rows.find(r => r[0] === 'product' && r[1] === product)!
    const bundles = Object.fromEntries(['image', 'update'].map(kind => [kind, rows.find(r => r[0] === 'bundle' && r[1] === product && r[2] === kind)![3]!]))
    const entry: Entry = { product, board, profile, generation: parseInt(generation!, 10), deployment, kernel, rootfs, release: label, bundles, images: [], updates: [] }
    for (const [, , kindType, kind, file, digest] of rows.filter(r => r[0] === 'asset' && r[1] === product)) {
      const url = `${downloads}/${label}/${file}`
      const item: Item = { kind: kind!, file: file!, url, sha256: digest! }
      const mirrors = mirrorsOf(bases, label, file!, url)
      // Member order is the shape's: kind, file, url, [mirrors], sha256, size, ...
      const ordered: Item = { kind: kind!, file: file!, url } as Item
      if (mirrors.length > 0) ordered.mirrors = mirrors
      ordered.sha256 = item.sha256; ordered.size = null
      if (kindType === 'image') {
        Object.assign(ordered, { compression: null, uncompressedSha256: null, uncompressedSize: null })
        entry.images.push(ordered)
      }
      else {
        const requires: Json = { generationBelow: parseInt(generation!, 10) }
        if (kind === 'root') requires.kernel = kernel
        if (kind === 'kernel') requires.rootfs = rootfs
        ordered.requires = requires
        entry.updates.push(ordered)
      }
    }
    entry.images.sort((a, b) => cmpBytes(a.kind, b.kind))
    entry.updates.sort((a, b) => cmpBytes(a.kind, b.kind))
    products[product] = entry
  }
  const header: Json = { schema: 'mica/index/v1', version: stampOf(release[2]!), commit: release[3], lock: { file: 'mica-build.lock', sha256: lockSha } }
  return [header, [...inputs.keys()].sort(cmpBytes).map(i => inputs.get(i)!), releases, products]
}

/** One file's entry with its mirrors derived afresh, keeping the member's place right after url. */
function remirrored(item: Item, bases: string[], label: string): Item {
  const out: Json = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === 'mirrors') continue
    out[key] = value
    if (key === 'url') {
      const mirrors = mirrorsOf(bases, label, item.file, item.url)
      if (mirrors.length > 0) out.mirrors = mirrors
    }
  }
  return out as Item
}

/**
 * An entry reduced to what the lock alone determines: the layer reads and the mirrors are dropped.
 *
 * Mirrors are NOT lock-determined -- they are derived from this checkout's mirrors.list -- so a predecessor's
 * are never compared against this commit's derivation. Comparing them would refuse the first cut after any
 * change to mirrors.list, and a base moving is a normal operational event, not a release failure. A
 * predecessor's mirrors are only checked for being well formed (checkMirrors), and a carried entry has its
 * own re-derived (remirrored), so a stale or tampered member cannot travel into a new index either way.
 */
function withoutLayerFields(entry: Entry): Json {
  const drop = new Set([...LAYER_FIELDS, 'mirrors'])
  const strip = (items: Item[]) => items.map(i => Object.fromEntries(Object.entries(i).filter(([k]) => !drop.has(k))))
  return { ...entry, images: strip(entry.images), updates: strip(entry.updates) }
}

/** A predecessor entry's mirrors, checked for form alone: absolute https, non-empty, unique, never its url. */
function checkMirrors(label: string, entry: Entry): void {
  for (const item of [...entry.images, ...entry.updates]) {
    if (!('mirrors' in item)) continue
    const mirrors = item.mirrors
    if (!Array.isArray(mirrors) || mirrors.length === 0) refuse(`the previous index ${label}: ${item.file} carries an empty mirrors member, which is omitted instead`)
    if (mirrors.some(m => typeof m !== 'string' || !m.startsWith('https://'))) refuse(`the previous index ${label}: ${item.file} carries a mirror that is no absolute https URL`)
    if (new Set(mirrors).size !== mirrors.length) refuse(`the previous index ${label}: ${item.file} names one mirror twice`)
    if (mirrors.includes(item.url)) refuse(`the previous index ${label}: ${item.file} names its own url as a mirror, which is the source the reader already has`)
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

/** The previous index's product entries, once its mica-index.json is proved to be its lock's. */
function previousEntries(previous: Release, downloads: string, bases: string[]): Record<string, Entry> {
  const label = previous.label
  let listed: Record<string, Entry>, consistent: boolean
  try {
    const document = JSON.parse(readFileSync(join(dirname(previous.lock), 'mica-index.json'), 'utf8')) as Json
    const [header, inputs, releases, products] = lockParts(previous.rows, sha256(previous.lock), downloads, bases)
    const docProducts = document.products as Entry[]
    listed = Object.fromEntries(docProducts.map(p => [p.product, p]))
    consistent = Object.entries(header).every(([k, v]) => canonical(document[k]) === canonical(v))
      && canonical(document.inputs) === canonical(inputs) && canonical(document.releases) === canonical(releases)
      && canonical(docProducts.map(p => p.product)) === canonical(Object.keys(products).sort(cmpBytes))
      && Object.keys(products).every(p => canonical(withoutLayerFields(listed![p]!)) === canonical(withoutLayerFields(products[p]!)))
  }
  catch (error) {
    if (error instanceof Refusal) throw error
    return refuse(`the previous index ${label}: its mica-index.json cannot be read against its lock (${String(error)})`)
  }
  if (!consistent) refuse(`the previous index ${label}: its mica-index.json does not match its mica-build.lock`)
  for (const entry of Object.values(listed)) checkMirrors(label, entry)
  return listed
}

function render(lockPath: string, historyPath: string, enteringPath: string, productsPath: string, boardsPath: string, layersPath: string,
  assetsPath: string, downloads: string, mirrorsPath: string, out: string): void {
  const rows = rowsOf(lockPath)
  const bases = mirrorBases(mirrorsPath)
  const [, previous] = historyOf(historyPath)
  const carriedEntries = previous ? previousEntries(previous, downloads, bases) : {}
  const entering = new Map(tsv(enteringPath).map(([p, l]) => [p!, l!]))
  const manifests = new Map(tsv(layersPath).map(([reference, path]) => [reference!, JSON.parse(readFileSync(path!, 'utf8')) as Json]))
  const sizes = new Map(tsv(assetsPath).map(([label, file, size]) => [`${label}\t${file}`, parseInt(size!, 10)]))
  const [header, inputs, releases, products] = lockParts(rows, sha256(lockPath), downloads, bases)
  for (const [product, entry] of Object.entries(products)) {
    if (!entering.has(product)) {
      if (carriedEntries[product]?.release !== entry.release) refuse(`${product}: its entry of ${entry.release} is neither entering nor carried from the previous index`)
      // A carried entry keeps every field it was read with, except its mirrors, which are DERIVED and so are
      // re-derived here: an entry carried from an index cut before this base was committed would otherwise
      // keep no mirrors while an entering one has them, and --full, which re-derives every entry, would
      // disagree with the index it is verifying.
      const carried: Entry = { ...carriedEntries[product]! }
      for (const kindType of ['images', 'updates'] as const) carried[kindType] = carried[kindType].map(item => remirrored(item, bases, carried.release))
      products[product] = carried
      continue
    }
    for (const [kindType, items] of [['image', entry.images], ['update', entry.updates]] as const) {
      for (const item of items) {
        const file = item.file, digest = item.sha256
        const reference = entry.bundles[kindType]!
        if (!manifests.has(reference)) refuse(`${product}: its ${kindType} bundle ${reference} was not read`)
        const layers = (manifests.get(reference)!.layers as Json[]).filter(layer => layer.digest === 'sha256:' + digest)
        if (layers.length !== 1) refuse(`${file}: the ${kindType} bundle of ${product} holds no single layer sha256:${digest}`)
        if (!sizes.has(`${entry.release}\t${file}`)) refuse(`${file}: no asset of release ${entry.release} was read`)
        const size = sizes.get(`${entry.release}\t${file}`)!
        if (layers[0]!.size !== size) refuse(`${file}: the release asset is ${size} bytes and its layer ${layers[0]!.size}`)
        item.size = size
        if (kindType === 'image') {
          const annotations = (layers[0]!.annotations ?? {}) as Record<string, string>
          if (annotations['mica.compression'] === 'gzip')
            Object.assign(item, { compression: 'gzip', uncompressedSha256: annotations['mica.uncompressed-sha256'], uncompressedSize: parseInt(annotations['mica.uncompressed-size']!, 10) })
          else Object.assign(item, { compression: 'none', uncompressedSha256: digest, uncompressedSize: size })
        }
      }
    }
  }
  const boards = tsv(boardsPath).map(([board, arch, target]) => ({ board: board!, arch: arch!, releaseTarget: target === '1' }))
  const document: Json = { ...header }
  if (previous) document.previous = { release: previous.label, trust: sha256(previous.sums) }
  const catalogueProducts = productsOf(productsPath).map(p => ({ ...p, indexed: p.product in products })).sort((a, b) => cmpBytes(a.product, b.product))
  Object.assign(document, {
    inputs, releases, products: Object.keys(products).sort(cmpBytes).map(p => products[p]!),
    catalogue: { boards: boards.sort((a, b) => cmpBytes(a.board, b.board)), products: catalogueProducts },
  })
  // Canonical JSON (mica:docs/design/mica-index.md section 2): keys in the order of the shape, built above.
  writeFileSync(out, canonical(document) + '\n')
}

export function main(argv: string[]): number {
  try {
    if (argv.length === 8 && argv[0] === 'lock' && (argv[5] === 'full' || argv[5] === 'incremental')) {
      lock(argv[1]!, argv[2]!, argv[3]!, argv[4]!, argv[5], argv[6]!, argv[7]!)
      return 0
    }
    if (argv.length === 11 && argv[0] === 'json') {
      render(argv[1]!, argv[2]!, argv[3]!, argv[4]!, argv[5]!, argv[6]!, argv[7]!, argv[8]!, argv[9]!, argv[10]!)
      return 0
    }
    refuse('usage: release-index lock ... | json ...', 2)
  }
  catch (e) {
    if (e instanceof Refusal) { console.error(e.message); return e.code }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
