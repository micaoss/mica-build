import { loadBoardFacts } from './board-facts.ts'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { authenticateDeployment, canonicalJson, componentId, type VerityImage } from './components.ts'
import { authenticateFirmware } from './firmware.ts'
import { isFactoryImageFilename } from './image-name.ts'
import { REPO_ROOT } from './paths.ts'

const FILES = {
  'update.micaupd': 'update', 'firmware.json': 'firmware-manifest',
  'firmware.bin': 'firmware', 'package-manifest.tsv': 'packages', 'baked-meta.json': 'meta',
  'development-marker.txt': 'development-marker', 'board-evidence.json': 'evidence',
  'rootfs-report.runtime.json': 'runtime-report', 'builder-images.json': 'build-inputs', 'sbom.cdx.json': 'sbom', 'licenses.json': 'licenses',
  'provenance.json': 'provenance', 'release-notes.md': 'notes', 'SHA256SUMS': 'checksums',
} as const
function releaseFiles(image: string): Record<string, string> {
  return { [image]: 'image', ...FILES }
}
const CHANNELS = ['development', 'candidate', 'stable'] as const
export type ReleaseChannel = typeof CHANNELS[number]
type Source = { commit: string, dirty: boolean }
type Artifact = { filename: string, role: string, bytes: number, sha256: string }
export interface ReleaseManifest {
  schema: 'mica/release/v1'
  board: string
  version: string
  channel: ReleaseChannel
  profile: 'dev' | 'prod'
  source: Source
  bootAssurance: string
  developmentDomains: string[]
  artifacts: Artifact[]
}
export interface ReleaseInputs {
  out: string, board: ReleaseManifest['board'], version: string, channel: ReleaseChannel,
  profile: ReleaseManifest['profile'], source: Source, builderImages: Record<string, string>,
  image: string, update: string, firmware: string, packages: string, meta: string,
  runtimeReport: string, notes: string, evidence: string, keys: string[],
  /** locks/ of the tree the release is assembled from; the record's lock rows must equal its package rows for the board's architecture. */
  lock?: string,
}
const OFFER = 'Source code for the packages in this inventory, including any modifications, is available on request from the distributor of this image; cite the source commit recorded beside this statement.'
function requireValue(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid release: ${message}`)
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  const record = value as Record<string, unknown>
  requireValue(Object.keys(record).sort().join() === [...fields].sort().join(), 'unknown or missing fields')
  return record
}
function regular(path: string) {
  const stat = lstatSync(path)
  requireValue(stat.isFile(), `regular file required: ${path}`)
  return stat
}
function read(path: string, limit = 16 * 1048576): string {
  requireValue(regular(path).size <= limit, `bounded record exceeded: ${path}`)
  return readFileSync(path, 'utf8')
}
export function fileSha256(path: string): string {
  regular(path)
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1048576)
  try {
    for (;;) { const n = readSync(fd, buffer); if (!n) break; hash.update(buffer.subarray(0, n)) }
    return hash.digest('hex')
  } finally { closeSync(fd) }
}
function measure(dir: string, filename: string, role: string): Artifact {
  const path = join(dir, filename)
  return { filename, role, bytes: regular(path).size, sha256: fileSha256(path) }
}
function json(dir: string, filename: string, value: unknown) {
  writeFileSync(join(dir, filename), `${JSON.stringify(value, null, 2)}\n`)
}
function sums(artifacts: Artifact[]): string {
  return artifacts.filter(a => a.role !== 'checksums').map(a => `${a.sha256}  ${a.filename}\n`).join('')
}
function manifest(value: unknown): ReleaseManifest {
  const m = object(value, ['schema', 'board', 'version', 'channel', 'profile', 'source', 'bootAssurance', 'developmentDomains', 'artifacts'])
  requireValue(m.schema === 'mica/release/v1', 'unsupported schema')
  requireValue(typeof m.board === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(m.board), 'unsupported board')
  requireValue(typeof m.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(m.version), 'invalid version')
  requireValue(CHANNELS.includes(m.channel as ReleaseChannel) && ['dev', 'prod'].includes(m.profile as string), 'channel or profile')
  const source = object(m.source, ['commit', 'dirty'])
  requireValue(typeof source.commit === 'string' && /^[a-f0-9]{40}$/.test(source.commit) && typeof source.dirty === 'boolean', 'source identity')
  requireValue(['I1', 'I2', 'I3', 'I4'].includes(m.bootAssurance as string), 'boot assurance')
  requireValue(Array.isArray(m.developmentDomains) && m.developmentDomains.every(d => ['boot', 'verity', 'updates'].includes(d))
    && new Set(m.developmentDomains).size === m.developmentDomains.length, 'development domains')
  requireValue(Array.isArray(m.artifacts) && m.artifacts.length === Object.keys(FILES).length + 1, 'artifact count')
  const seen = new Set<string>()
  const roles = new Set<string>()
  for (const value of m.artifacts) {
    const a = object(value, ['filename', 'role', 'bytes', 'sha256'])
    requireValue(typeof a.filename === 'string' && typeof a.role === 'string'
      && (a.role === 'image' ? isFactoryImageFilename(a.filename, m.board as string)
        : Object.hasOwn(FILES, a.filename) && FILES[a.filename as keyof typeof FILES] === a.role)
      && !seen.has(a.filename) && !roles.has(a.role), 'artifact filename or role')
    seen.add(a.filename)
    roles.add(a.role)
    requireValue(Number.isSafeInteger(a.bytes) && (a.bytes as number) >= 0
      && typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256), 'artifact digest or length')
  }
  return value as ReleaseManifest
}
function domains(marker: string): string[] {
  if (marker === '') return []
  const match = /^DEVELOPMENT-GRADE\nDOMAINS=((?:boot|verity|updates)(?: (?:boot|verity|updates))*)\n$/.exec(marker)
  requireValue(match, 'malformed development marker')
  const result = match[1]!.split(' ')
  requireValue(new Set(result).size === result.length, 'duplicate development marker domain')
  return result.sort()
}
function evidence(value: unknown, board: string): string {
  const e = object(value, ['schemaVersion', 'board', 'revision', 'bootAssurance', 'qualification', 'evidenceRefs', 'physicalBoundaries'])
  requireValue(e.schemaVersion === 2 && e.board === board, 'evidence board or schema')
  for (const field of ['revision', 'qualification']) requireValue(typeof e[field] === 'string' && (e[field] as string).trim(), `evidence ${field}`)
  const levels: Record<string, string[]> = {
    I1: ['verity-root'], I2: ['verity-root', 'ab-fallback', 'update-negative'],
    I3: ['verity-root', 'ab-fallback', 'update-negative', 'vendor-boot-capability', 'signature-negative'],
    I4: ['verity-root', 'ab-fallback', 'update-negative', 'vendor-boot-capability', 'signature-negative'],
  }
  requireValue(typeof e.bootAssurance === 'string' && Object.hasOwn(levels, e.bootAssurance), 'evidence assurance')
  requireValue(Array.isArray(e.evidenceRefs) && e.evidenceRefs.length > 0, 'evidence references')
  const classes = new Set<string>()
  for (const value of e.evidenceRefs) {
    const ref = object(value, ['class', 'ref'])
    requireValue(typeof ref.class === 'string' && levels.I4!.includes(ref.class)
      && typeof ref.ref === 'string' && ref.ref.trim(), 'evidence reference')
    classes.add(ref.class)
  }
  requireValue(levels[e.bootAssurance]!.every(c => classes.has(c)), 'evidence below claimed assurance')
  const boundary = object(e.physicalBoundaries, ['jtag', 'serialConsole', 'recoveryPath'])
  requireValue(Object.values(boundary).every(v => typeof v === 'string' && v.trim()), 'evidence physical boundaries')
  return e.bootAssurance
}
function packages(text: string) {
  const seen = new Set<string>()
  const rows = text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const fields = line.split('\t')
    requireValue(fields.length === 3 && fields.every(f => f && !/[\x00-\x20]/.test(f)), 'package inventory row')
    const [name, version, architecture] = fields as [string, string, string]
    const identity = `${name}:${architecture}`
    requireValue(!seen.has(identity), 'duplicate package'); seen.add(identity)
    return { name, version, architecture }
  })
  requireValue(rows.some(r => r.name.startsWith('mica')), 'empty MICA package inventory')
  return rows.sort((a, b) => `${a.name}:${a.architecture}`.localeCompare(`${b.name}:${b.architecture}`))
}
type NativePackage = {
  package: string, version: string, architecture: string, archive_sha256: string,
  archive: string, source: { package: string, version: string },
}
const RUNTIME_RECORD_LIMIT = 128 * 1048576
function record(value: unknown): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'runtime object required')
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  requireValue(Array.isArray(value), 'runtime array required')
  return value
}
function digest(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'runtime digest')
}
function natural(value: unknown): asserts value is number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= 0, 'runtime non-negative integer')
}
function runtimePath(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.startsWith('/') && posix.normalize(value) === value
    && (value === '/' || !value.endsWith('/')) && !/[\x00-\x1f\x7f]/.test(value), 'runtime canonical path')
}
function same(actual: unknown, expected: unknown, label: string) {
  requireValue(canonicalJson(actual) === canonicalJson(expected), `runtime ${label} differs`)
}
function runtimeNode(value: unknown, extra: string[] = [], hardlinks = true) {
  const n = record(value)
  requireValue(['file', 'directory', 'symlink'].includes(n.type as string), 'runtime node type')
  object(n, ['type', 'mode', 'uid', 'gid', 'mtime_ns', 'xattrs', ...extra,
    ...(n.type === 'file' ? ['size', 'sha256', ...(hardlinks ? ['hardlink'] : [])] : []),
    ...(n.type === 'symlink' ? ['target'] : []), ...(Object.hasOwn(n, 'runtime_link') ? ['runtime_link'] : [])])
  for (const k of ['mode', 'uid', 'gid']) natural(n[k])
  requireValue((n.mode as number) <= 0o7777, 'runtime mode')
  requireValue(typeof n.mtime_ns === 'string' && /^-?\d+$/.test(n.mtime_ns), 'runtime nanosecond timestamp')
  for (const [name, v] of Object.entries(record(n.xattrs))) requireValue(name && typeof v === 'string' && /^(?:[a-f0-9]{2})*$/.test(v), 'runtime xattr')
  if (n.type === 'file') { natural(n.size); digest(n.sha256); if (hardlinks) runtimePath(n.hardlink) }
  if (n.type === 'symlink') requireValue(typeof n.target === 'string' && n.target && !/[\x00-\x1f\x7f]/.test(n.target), 'runtime symlink target')
  if (Object.hasOwn(n, 'runtime_link')) {
    const link = object(n.runtime_link, ['path', 'target', 'generator', 'ordering', 'test', 'requires'])
    requireValue(n.type === 'symlink' && n.target === link.target && n.path === link.path, 'runtime link contract')
    for (const k of ['generator', 'ordering', 'test']) requireValue(typeof link[k] === 'string' && link[k], 'runtime link producer')
    for (const path of array(link.requires)) runtimePath(path)
  }
  return n
}
function runtimePackage(value: unknown, arch: string): NativePackage {
  const p = object(value, ['package', 'version', 'architecture', 'archive_sha256', 'archive', 'source'])
  requireValue(typeof p.package === 'string' && /^[a-z0-9][a-z0-9+.-]*$/.test(p.package)
    && typeof p.version === 'string' && p.version && !/[\x00-\x20]/.test(p.version)
    && [arch, 'all'].includes(p.architecture as string), 'runtime native package identity')
  digest(p.archive_sha256)
  requireValue(typeof p.archive === 'string' && p.archive && !/[\x00-\x20]/.test(p.archive), 'runtime archive reference')
  const source = object(p.source, ['package', 'version'])
  requireValue(Object.values(source).every(v => typeof v === 'string' && v && !/[\x00-\x20]/.test(v)), 'runtime source identity')
  return p as NativePackage
}
function readRuntime(path: string): Record<string, unknown> {
  requireValue(typeof path === 'string' && path, 'runtime report is required')
  requireValue(regular(path).size <= RUNTIME_RECORD_LIMIT, 'runtime report exceeds bounded record')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path))
  // Preserve nanoseconds exactly; copying the original report preserves its raw
  // bytes. JSON numbers otherwise round configured timestamps in JavaScript.
  const value: unknown = JSON.parse(text, (key, v: unknown, context?: { source: string }) => {
    if (key !== 'mtime_ns') return v
    requireValue(typeof v === 'number' && context && /^-?\d+$/.test(context.source), 'runtime timestamp encoding')
    return context.source
  })
  const stack: { keys: Set<string> | null, next: boolean }[] = []
  for (const token of text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g) ?? []) {
    const parent = stack.at(-1)
    if (token === '{' || token === '[') stack.push({ keys: token === '{' ? new Set() : null, next: true })
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ',' && parent) parent.next = true
    else if (token.startsWith('"') && parent?.keys && parent.next) {
      const key = JSON.parse(token) as string
      requireValue(!parent.keys.has(key), 'runtime duplicate JSON key')
      parent.keys.add(key); parent.next = false
    }
  }
  return object(value, ['architecture', 'consumers', 'inputs', 'files', 'external_inputs', 'provenance', 'measurements'])
}
const LOCK_COLUMNS = ['package', 'version', 'architecture', 'sha256', 'source_repo', 'source_commit'] as const
type LockRow = Record<typeof LOCK_COLUMNS[number], string>
// A package's declared Debian version; it carries no commit or release (mica:docs/decisions/2026-09-15-package-versions.md).
const packageVersion = (version: unknown) => requireValue(typeof version === 'string' && /^[0-9][A-Za-z0-9.+~-]*$/.test(version), 'package version')
/**
 * The package rows of a locks/ directory for one pool, read through this
 * repository's tools/locks.py (rows package, rows release), as lock rows
 * without the archive's Debian architecture, which only the pool manifest names.
 */
export function treeLockRows(locks: string, arch: string): Omit<LockRow, 'architecture'>[] {
  const rows = (kind: string) => {
    const r = spawnSync('python3', [join(REPO_ROOT, 'tools/locks.py'), 'rows', kind], { encoding: 'utf8', env: { ...process.env, MICA_LOCKS_DIR: locks } })
    requireValue(r.status === 0, `tree lock ${locks}: ${r.stderr.trimEnd()}`)
    return r.stdout.split('\n').filter(line => line !== '').map(line => line.split('\t'))
  }
  const commits = new Map(rows('release').map(f => [f[0]!, f[3]!]))
  // One archive pinned by several scoped locks of its repository (a package two boards ship) is one row, as
  // tools/pool.sh rows reads it.
  const unique = new Map(rows('package').filter(f => f[2] === arch)
    .map(f => ({ package: f[1]!, version: f[3]!, sha256: f[4]!, source_repo: f[0]!.split('.')[0]!, source_commit: commits.get(f[0]!)! }))
    .map(row => [canonicalJson(row), row] as const))
  return [...unique.values()].sort((a, b) => a.package.localeCompare(b.package))
}
export function sourceLineage(value: unknown, source: Source, arch: string, capture: Record<string, unknown>) {
  const l = object(value, ['schema', 'package_source', 'composition_source', 'architecture', 'root_epoch', 'pool', 'lock', 'unlocked'])
  requireValue(l.schema === 'mica/source-lineage/v1' && l.architecture === arch, 'runtime lineage schema/architecture')
  const p = object(l.package_source, ['commit', 'tree', 'epoch', 'version'])
  const c = object(l.composition_source, ['commit', 'tree', 'epoch'])
  for (const identity of [p, c]) {
    for (const key of ['commit', 'tree']) requireValue(typeof identity[key] === 'string' && /^[a-f0-9]{40}$/.test(identity[key] as string), 'runtime lineage Git identity')
    natural(identity.epoch); requireValue((identity.epoch as number) <= 0xffffffff, 'runtime lineage source epoch')
  }
  natural(l.root_epoch); requireValue((l.root_epoch as number) <= 0xffffffff, 'runtime lineage root epoch')
  requireValue(c.commit === source.commit && !source.dirty, 'runtime lineage composition source')
  requireValue(p.commit === c.commit && p.tree === c.tree && p.epoch === c.epoch, 'runtime lineage package/composition source differ')
  requireValue(typeof p.version === 'string' && new RegExp(`^[0-9][A-Za-z0-9.~]*\\+git${(p.commit as string).slice(0, 12)}-1$`).test(p.version), 'runtime lineage package version/source')
  // The lock rows the composer read, and the waiver it was given.
  const locked = new Map<string, LockRow>()
  for (const value of array(l.lock)) {
    const row = object(value, [...LOCK_COLUMNS])
    for (const key of LOCK_COLUMNS) requireValue(typeof row[key] === 'string', 'runtime lineage lock row')
    const r = row as LockRow
    requireValue(/^[a-z0-9][a-z0-9+.-]+$/.test(r.package) && [arch, 'all'].includes(r.architecture) && !locked.has(r.package), 'runtime lineage lock row')
    digest(r.sha256); requireValue(/^[a-f0-9]{40}$/.test(r.source_commit) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.source_repo), 'runtime lineage lock row identity')
    packageVersion(r.version)
    locked.set(r.package, r)
  }
  same(array(l.lock).map(v => record(v).package), [...locked.keys()].sort(), 'runtime lineage lock order')
  const unlocked = array(l.unlocked).map(v => { requireValue(typeof v === 'string' && locked.has(v), 'runtime lineage unlocked name'); return v })
  same(unlocked, [...new Set(unlocked)].sort(), 'runtime lineage unlocked order/set')
  const pool = object(l.pool, ['files', 'packages']), files = record(pool.files)
  for (const [name, sha] of Object.entries(files)) {
    requireValue(['Packages', 'SHA256SUMS', 'manifest.txt'].includes(name) || /^pool\/[^/]+\.deb$/.test(name), 'runtime lineage pool path')
    digest(sha)
  }
  const expected = new Set(['Packages', 'SHA256SUMS', 'manifest.txt']), names = new Set<string>()
  requireValue(Array.isArray(pool.packages) && pool.packages.length > 0, 'runtime lineage empty pool')
  const packages = pool.packages.map(value => {
    const row = object(value, ['package', 'version', 'architecture', 'archive', 'sha256', 'control_sha256', 'source_repo', 'source_commit'])
    requireValue(typeof row.package === 'string' && /^[a-z0-9][a-z0-9+.-]+$/.test(row.package) && !names.has(row.package), 'runtime lineage package name/set')
    names.add(row.package)
    requireValue([arch, 'all'].includes(row.architecture as string), 'runtime lineage package architecture')
    requireValue(typeof row.archive === 'string' && /^pool\/[^/]+\.deb$/.test(row.archive) && !expected.has(row.archive), 'runtime lineage archive')
    expected.add(row.archive); digest(row.sha256); digest(row.control_sha256)
    requireValue(typeof row.source_repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.source_repo) && typeof row.source_commit === 'string' && /^[a-f0-9]{40}$/.test(row.source_commit), 'runtime lineage package source')
    same(files[row.archive], row.sha256, 'runtime lineage archive digest')
    // Re-checked over the record: every archive is its lock row (unless waived); this tree builds no package.
    const lock = locked.get(row.package)
    requireValue(lock !== undefined, `runtime lineage archive not in the lock: ${row.package}`)
    if (!unlocked.includes(row.package)) for (const key of LOCK_COLUMNS) same(row[key], lock![key], `runtime lineage locked archive ${row.package}`)
    return row as Record<string, unknown> & LockRow & { archive: string, control_sha256: string }
  })
  same(Object.keys(files).sort(), [...expected].sort(), 'runtime lineage pool membership')
  for (const name of locked.keys()) requireValue(names.has(name), `runtime lineage locked archive missing from the pool: ${name}`)
  for (const name of ['Packages', 'SHA256SUMS', 'manifest.txt']) same(capture[name], files[name], 'runtime lineage pool capture')
  same(capture['source-lineage.json'], createHash('sha256').update(canonicalJson(value) + '\n').digest('hex'), 'runtime lineage capture bytes')
  return { record: value, packages, rootEpoch: l.root_epoch as number, lock: [...locked.values()], unlocked }
}
function shippedRuntime(path: string, inventory: string, arch: string, root: VerityImage, meta: string, marker: string, source: Source) {
  const report = readRuntime(path)
  requireValue(report.architecture === arch, 'runtime architecture differs')
  const p = object(report.provenance, ['build_packages', 'shipped_packages', 'files', 'configured_sha256', 'capture_sha256', 'source_lineage'])
  const buildPackages = array(p.build_packages).map(v => runtimePackage(v, arch))
  const byPackage = new Map(buildPackages.map(v => [v.package, v]))
  requireValue(byPackage.size === buildPackages.length && byPackage.size > 0, 'runtime duplicate or empty build packages')
  const consumers = array(report.consumers)
  requireValue(consumers.length > 0 && new Set(consumers).size === consumers.length
    && consumers.every(c => typeof c === 'string' && byPackage.has(c)), 'runtime selected consumers')
  const selected = object(report.inputs, ['inventory_sha256', 'selection_sha256', 'rules_sha256', 'ownership_sha256'])
  const capture = record(p.capture_sha256)
  for (const [name, sha] of Object.entries(capture)) {
    requireValue(name && !name.startsWith('/') && posix.normalize(name) === name
      && !name.split('/').some(part => part === '.' || part === '..' || !part) && !/[\x00-\x1f\x7f]/.test(name), 'runtime capture path')
    digest(sha)
  }
  digest(p.configured_sha256)
  same(capture['configured.json'], p.configured_sha256, 'configured capture')
  for (const [name, field] of [['manifest.tsv', 'inventory_sha256'], ['selected.pkgs', 'selection_sha256'], ['runtime-rules.json', 'rules_sha256']] as const) {
    digest(selected[field]); same(capture[name], selected[field], `${name} capture`)
  }
  for (const name of ['sources.tsv', 'upstream.tsv', 'Packages']) digest(capture[name])
  const lineage = sourceLineage(p.source_lineage, source, arch, capture)
  for (const row of buildPackages) {
    const match = lineage.packages.find(p => p.package === row.package)
    if (match || row.archive.startsWith('pool/')) {
      requireValue(match, 'runtime lineage missing installed package')
      for (const key of ['version', 'architecture', 'archive'] as const) same(row[key], match[key], 'runtime lineage installed package')
      same(row.archive_sha256, match.sha256, 'runtime lineage installed archive')
    }
  }
  requireValue((report.consumers as string[]).every(name => lineage.packages.some(p => p.package === name)), 'runtime lineage selected package missing')
  const ownership = record(selected.ownership_sha256)
  for (const [name, sha] of Object.entries(ownership)) { digest(sha); same(capture[`info/${name}`], sha, 'native ownership capture') }
  for (const name of byPackage.keys()) requireValue(Object.keys(ownership).filter(f => f === `${name}.list` || f === `${name}:${arch}.list` || f === `${name}:all.list`).length === 1, 'runtime unique native ownership')
  const files = new Map<string, Record<string, unknown>>()
  const origins = new Set<string>()
  const provenance = record(p.files)
  for (const value of array(report.files)) {
    const n = runtimeNode(value, ['path', 'origins', 'reasons'])
    runtimePath(n.path); requireValue(!files.has(n.path), 'runtime duplicate file path')
    files.set(n.path, n)
    requireValue(array(n.reasons).length > 0 && array(n.reasons).every(r => typeof r === 'string' && r), 'runtime file selection reason')
    const owners: NativePackage[] = [], generators: string[] = []
    for (const value of array(n.origins)) {
      const origin = record(value)
      if (Object.hasOwn(origin, 'generated')) {
        object(origin, ['generated']); requireValue(typeof origin.generated === 'string' && origin.generated, 'runtime generated origin')
        generators.push(origin.generated)
      } else {
        object(origin, ['package', 'version', 'architecture'])
        const owner = byPackage.get(origin.package as string)
        requireValue(owner, 'runtime unknown file owner')
        same(origin, { package: owner.package, version: owner.version, architecture: owner.architecture }, 'file owner')
        owners.push(owner); if (n.type !== 'directory') origins.add(owner.package)
      }
    }
    requireValue(owners.length + generators.length > 0 && (n.type === 'directory' || owners.length <= 1)
      && new Set(owners).size === owners.length && new Set(generators).size === generators.length, 'runtime ambiguous or missing file origin')
    const f = record(provenance[n.path])
    object(f, ['configured', 'final', 'archives', 'generators', ...(Object.hasOwn(f, 'debug') ? ['debug'] : [])])
    const { origins: _origins, reasons: _reasons, ...final } = n
    same(f.final, final, 'final file metadata')
    same(f.archives, owners, 'file archive/source provenance'); same(f.generators, generators, 'generated provenance')
    if (f.configured !== null) runtimeNode(f.configured)
    else requireValue(generators.length > 0, 'runtime uncaptured file has no producer')
    if (Object.hasOwn(f, 'debug')) {
      const debug = runtimeNode(f.debug, ['build_id', 'path', 'bytes_before'], false)
      requireValue(n.type === 'file' && debug.type === 'file' && typeof debug.build_id === 'string'
        && /^[a-f0-9]{3,}$/.test(debug.build_id) && debug.path === `.build-id/${debug.build_id.slice(0, 2)}/${debug.build_id.slice(2)}.debug`, 'runtime debug counterpart mapping')
      natural(debug.bytes_before); requireValue(debug.bytes_before >= (n.size as number) && (debug.size as number) > 0, 'runtime debug counterpart sizes')
    }
  }
  same([...Object.keys(provenance)].sort(), [...files.keys()].sort(), 'per-file provenance set')
  requireValue(files.get('/')?.type === 'directory', 'runtime root directory')
  const groups = new Map<string, Record<string, unknown>>()
  for (const [path, n] of files) {
    requireValue(path === '/' || files.get(posix.dirname(path))?.type === 'directory', 'runtime parent directory')
    if (n.type === 'file') {
      const primary = files.get(n.hardlink as string)
      requireValue(primary?.type === 'file' && primary.hardlink === n.hardlink, 'runtime hardlink group')
      for (const field of ['sha256', 'size', 'mode', 'uid', 'gid', 'mtime_ns', 'xattrs']) same(n[field], primary[field], 'hardlink metadata')
      groups.set(n.hardlink as string, n)
    }
  }
  const shippedPackages = array(p.shipped_packages).map(v => runtimePackage(v, arch))
  same(shippedPackages.map(v => v.package).sort(), [...origins].sort(), 'shipped contributor set')
  for (const pkg of shippedPackages) same(pkg, byPackage.get(pkg.package), 'shipped archive/source identity')
  same(packages(inventory), shippedPackages.map(p => ({ name: p.package, version: p.version, architecture: p.architecture }))
    .sort((a, b) => `${a.name}:${a.architecture}`.localeCompare(`${b.name}:${b.architecture}`)), 'shipped inventory')
  const retainedFile = (path: string) => {
    for (let links = 0; links < 40; links++) {
      const parts = path.split('/').filter(Boolean)
      let prefix = '', changed = false
      for (let i = 0; i < parts.length; i++) {
        prefix += '/' + parts[i]
        const n = files.get(prefix)
        requireValue(n, `runtime missing resource: ${prefix}`)
        if (n.type === 'symlink') {
          path = posix.resolve(posix.dirname(prefix), n.target as string, ...parts.slice(i + 1)); changed = true; break
        }
      }
      if (!changed) { const n = files.get(path)!; requireValue(n.type === 'file', 'runtime resource is not a file'); return n }
    }
    throw new Error('Invalid release: runtime resource symlink cycle')
  }
  for (const [path, bytes] of [['/usr/share/mica/manifest.tsv', inventory], ['/usr/share/mica/meta/updates/manifest.json', meta]] as const) {
    const n = retainedFile(path)
    same(n.sha256, createHash('sha256').update(bytes).digest('hex'), path.includes('/meta/') ? 'public metadata' : 'inventory bytes')
  }
  const markerPath = '/usr/share/mica/meta/GENERATED'
  if (marker) same(retainedFile(markerPath).sha256, createHash('sha256').update(marker).digest('hex'), 'public metadata marker')
  else requireValue(!files.has(markerPath), 'runtime unexpected public metadata marker')
  const licenses = shippedPackages.map(p => {
    const resource = retainedFile(`/usr/share/doc/${p.package}/copyright`)
    requireValue((resource.size as number) > 0, 'runtime empty copyright resource')
    return { name: p.package, version: p.version, architecture: p.architecture, source: p.source,
      archiveSha256: p.archive_sha256, resources: [{ path: resource.path, sha256: resource.sha256 }] }
  })
  const measurements = object(report.measurements, ['apparent_file_bytes', 'unique_file_bytes', 'allocated_file_bytes',
    'unique_file_inodes', 'directories', 'symlinks', 'runtime_allocation', 'rss', 'fresh_image_comparison', 'squashfs', 'verity_image', 'boot_payload'])
  same([measurements.runtime_allocation, measurements.rss, measurements.fresh_image_comparison, measurements.boot_payload],
    ['pending B7 guest evidence', 'pending B7 guest evidence', 'pending B7 granted image builds',
      'independent signed kernel component; pending B7 matching artifact inputs'], 'measurement evidence')
  const values = [...files.values()]
  for (const [key, expected] of Object.entries({ apparent_file_bytes: values.reduce((sum, n) => sum + (n.type === 'file' ? n.size as number : 0), 0),
    unique_file_bytes: [...groups.values()].reduce((sum, n) => sum + (n.size as number), 0), unique_file_inodes: groups.size,
    directories: values.filter(n => n.type === 'directory').length, symlinks: values.filter(n => n.type === 'symlink').length })) same(measurements[key], expected, 'measurement')
  natural(measurements.allocated_file_bytes)
  const image = object(measurements.verity_image, ['bytes', 'sha256', 'geometry'])
  same({ bytes: image.bytes, sha256: image.sha256 }, root.image, 'signed root image')
  const sq = object(measurements.squashfs, ['bytes', 'sha256']); digest(sq.sha256)
  same(sq.bytes, root.verity.hashOffset, 'SquashFS extent')
  same(image.geometry, { VERITY_ROOT_HASH: root.rootHash, VERITY_SALT: root.verity.salt, VERITY_HASH_ALGO: root.verity.algorithm,
    VERITY_DATA_BLOCK_SIZE: String(root.verity.dataBlockSize), VERITY_HASH_BLOCK_SIZE: String(root.verity.hashBlockSize),
    VERITY_DATA_BLOCKS: String(root.verity.dataBlocks), VERITY_HASH_START_BLOCK: String(root.verity.hashOffset / root.verity.hashBlockSize),
    VERITY_DATA_SECTORS: String(root.verity.hashOffset / 512), SQUASHFS_BYTES: String(root.verity.hashOffset), IMAGE_BYTES: String(root.image.bytes) }, 'signed verity geometry')
  array(report.external_inputs)
  for (const row of files.values()) same(row.mtime_ns, String(BigInt(lineage.rootEpoch) * 1000000000n), 'runtime lineage root epoch')
  return { buildPackages, shippedPackages, sourceLineage: lineage.record, lock: lineage.lock, unlocked: lineage.unlocked, files: provenance, measurements, licenses }
}

function derived(dir: string, m: Omit<ReleaseManifest, 'artifacts'>, image: string, root: VerityImage) {
  const files = releaseFiles(image)
  const inventory = read(join(dir, 'package-manifest.tsv'))
  const rows = packages(inventory)
  const runtime = shippedRuntime(join(dir, 'rootfs-report.runtime.json'), inventory, loadBoardFacts(m.board).arch, root, read(join(dir, 'baked-meta.json')), read(join(dir, 'development-marker.txt')), m.source)
  const images: unknown = JSON.parse(read(join(dir, 'builder-images.json')))
  requireValue(images !== null && typeof images === 'object' && !Array.isArray(images)
    && Object.keys(images).length > 0 && Object.entries(images).every(([k, v]) => /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._/:-]*@(index|amd64|arm64|386)$/.test(k) && typeof v === 'string' && v), 'builder image records')
  requireValue(m.channel === 'development' || runtime.unlocked.length === 0, 'unlocked packages cannot use customer channels')
  return {
    'sbom.cdx.json': { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
      metadata: { component: { type: 'operating-system', name: `mica-${m.board}`, version: m.version },
        properties: [{ name: 'mica:source-commit', value: m.source.commit }, { name: 'mica:source-dirty', value: String(m.source.dirty) }, { name: 'mica:source-offer', value: OFFER }] },
      components: rows.map(r => ({ type: 'library', name: r.name, version: r.version, properties: [{ name: 'mica:architecture', value: r.architecture }, { name: 'mica:archive-sha256', value: runtime.shippedPackages.find(p => p.package === r.name)!.archive_sha256 }] })) },
    'licenses.json': { schemaVersion: 1, statement: OFFER, source: m.source, packages: runtime.licenses },
    'provenance.json': { schema: 'mica/provenance/v1', source: m.source, board: m.board, version: m.version, profile: m.profile, builderImages: images, runtime: { sourceLineage: runtime.sourceLineage, lock: runtime.lock, unlocked: runtime.unlocked, buildPackages: runtime.buildPackages, shippedPackages: runtime.shippedPackages, files: runtime.files, measurements: runtime.measurements },
      inputs: [image, 'update.micaupd', 'firmware.json', 'firmware.bin', 'package-manifest.tsv', 'rootfs-report.runtime.json', 'baked-meta.json', 'development-marker.txt', 'board-evidence.json', 'builder-images.json', 'release-notes.md'].map(filename => measure(dir, filename, files[filename]!)) },
  }
}
/** Authenticate every MICAUPD1 object using bounded reads, without unpacking it. */
export function verifyArchive(path: string, keys: readonly string[]) {
  regular(path)
  const fd = openSync(path, 'r')
  const exact = (length: number) => {
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < length) { const n = readSync(fd, bytes, offset, length - offset, null); requireValue(n > 0, 'truncated update archive'); offset += n }
    return bytes
  }
  try {
    requireValue(exact(8).toString() === 'MICAUPD1', 'update archive format')
    const size = exact(4).readUInt32BE(); requireValue(size > 0 && size <= 16384, 'update envelope length')
    const deployment = authenticateDeployment(exact(size).toString('utf8'), keys)
    const objects = new Map<string, number>()
    for (const a of [deployment.kernel.boot.artifact, deployment.kernel.support.image, deployment.kernel.support.signature, deployment.rootfs.content.image, deployment.rootfs.content.signature]) {
      requireValue(!objects.has(a.sha256) || objects.get(a.sha256) === a.bytes, 'conflicting object lengths')
      objects.set(a.sha256, a.bytes)
    }
    requireValue(exact(4).readUInt32BE() === objects.size, 'update object count')
    for (const [sha, bytes] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
      requireValue(exact(64).toString() === sha && exact(8).readBigUInt64BE() === BigInt(bytes), 'update object header')
      const hash = createHash('sha256')
      for (let remaining = bytes; remaining > 0;) { const count = Math.min(65536, remaining); hash.update(exact(count)); remaining -= count }
      requireValue(hash.digest('hex') === sha, 'update object digest')
    }
    requireValue(readSync(fd, Buffer.alloc(1)) === 0, 'trailing update archive bytes')
    return deployment
  } finally { closeSync(fd) }
}
export function gateRelease(dir: string, keys: readonly string[]) {
  const m = manifest(JSON.parse(read(join(dir, 'manifest.json'))))
  const image = m.artifacts.find(a => a.role === 'image')!.filename
  requireValue(readdirSync(dir).sort().join() === ['manifest.json', ...Object.keys(releaseFiles(image))].sort().join(), 'release file set differs')
  for (const a of m.artifacts) {
    const measured = measure(dir, a.filename, a.role)
    requireValue(measured.bytes === a.bytes && measured.sha256 === a.sha256, `artifact digest or length: ${a.filename}`)
  }
  requireValue(read(join(dir, 'SHA256SUMS')) === sums(m.artifacts), 'checksum list differs')
  requireValue(read(join(dir, 'release-notes.md')).trim(), 'empty release notes')
  const meta = JSON.parse(read(join(dir, 'baked-meta.json'))) as Record<string, unknown>
  requireValue(meta.schema === 'mica/meta/v1' && !Object.hasOwn(meta, 'trust'), 'current baked defaults required')
  const developmentDomains = domains(read(join(dir, 'development-marker.txt')))
  requireValue(canonicalJson(developmentDomains) === canonicalJson(m.developmentDomains), 'development marker differs')
  requireValue(m.channel === 'development' || developmentDomains.length === 0, 'development keys cannot use customer channels')
  requireValue(evidence(JSON.parse(read(join(dir, 'board-evidence.json'))), m.board) === m.bootAssurance, 'evidence assurance differs')
  const runtime = record(readRuntime(join(dir, 'rootfs-report.runtime.json')).provenance)
  const lineage = sourceLineage(runtime.source_lineage, m.source, loadBoardFacts(m.board).arch, record(runtime.capture_sha256))
  requireValue(m.channel === 'development' || lineage.unlocked.length === 0, 'unlocked packages cannot use customer channels')
  const deployment = verifyArchive(join(dir, 'update.micaupd'), keys)
  requireValue(deployment.board === m.board && deployment.version === m.version, 'update board or version differs')
  const firmware = authenticateFirmware(read(join(dir, 'firmware.json'), 16384), keys, loadBoardFacts(m.board))
  requireValue(firmware.board === m.board, 'firmware board differs')
  requireValue(regular(join(dir, 'firmware.bin')).size === firmware.artifact.bytes
    && fileSha256(join(dir, 'firmware.bin')) === firmware.artifact.sha256, 'firmware digest or length')
  for (const [name, expected] of Object.entries(derived(dir, m, image, deployment.rootfs.content))) {
    requireValue(canonicalJson(JSON.parse(read(join(dir, name), name === 'provenance.json' ? RUNTIME_RECORD_LIMIT : undefined))) === canonicalJson(expected), `derived record differs: ${name}`)
  }
  return { manifest: m, deploymentId: componentId(deployment), firmwareId: firmware.id, artifactsChecked: m.artifacts.length }
}
export function assembleRelease(inputs: ReleaseInputs) {
  requireValue(!existsSync(inputs.out), 'output exists')
  const image = basename(inputs.image)
  requireValue(isFactoryImageFilename(image, inputs.board), 'factory image filename must contain the board and UTC build time')
  requireValue(read(inputs.notes).trim(), 'empty release notes')
  packages(read(inputs.packages))
  const hasMarker = lstatSync(join(inputs.meta, 'GENERATED'), { throwIfNoEntry: false }) !== undefined
  const marker = hasMarker ? read(join(inputs.meta, 'GENERATED')) : ''
  requireValue(!hasMarker || marker.length > 0, 'empty development marker')
  const developmentDomains = domains(marker)
  requireValue(inputs.channel === 'development' || developmentDomains.length === 0, 'development keys cannot use customer channels')
  const bootAssurance = evidence(JSON.parse(read(inputs.evidence)), inputs.board)
  const deployment = verifyArchive(inputs.update, inputs.keys)
  requireValue(deployment.board === inputs.board && deployment.version === inputs.version, 'update board or version differs')
  // The release target is the gate's question (release-cli releaseBoard); a
  // non-publication board still assembles its acceptance release here.
  const facts = loadBoardFacts(inputs.board)
  const arch = facts.arch
  const runtime = shippedRuntime(inputs.runtimeReport, read(inputs.packages), arch, deployment.rootfs.content, read(join(inputs.meta, 'updates/manifest.json')), marker, inputs.source)
  requireValue(inputs.channel === 'development' || runtime.unlocked.length === 0, 'unlocked packages cannot use customer channels')
  // The package rows the tree holds at the source commit are the rows the
  // composer must have read: a release whose imports differ from locks/ was
  // composed from another tree's imports, whatever its stamp says.
  if (inputs.lock !== undefined) {
    same(runtime.lock.map(({ architecture: _, ...row }) => row), treeLockRows(inputs.lock, arch), 'release lock differs from the tree lock')
  }
  const m: ReleaseManifest = { schema: 'mica/release/v1', board: inputs.board, version: inputs.version, channel: inputs.channel,
    profile: inputs.profile, source: inputs.source, bootAssurance, developmentDomains, artifacts: [] }
  const files = { [image]: inputs.image, 'update.micaupd': inputs.update, 'firmware.json': join(inputs.firmware, 'firmware.json'),
    'firmware.bin': join(inputs.firmware, facts.firmware.format === 'efi' ? facts.firmware.loaderName : facts.firmware.binName), 'package-manifest.tsv': inputs.packages,
    'rootfs-report.runtime.json': inputs.runtimeReport, 'baked-meta.json': join(inputs.meta, 'updates/manifest.json'), 'board-evidence.json': inputs.evidence, 'release-notes.md': inputs.notes }
  for (const path of Object.values(files)) regular(path)
  mkdirSync(inputs.out)
  for (const [name, path] of Object.entries(files)) copyFileSync(path, join(inputs.out, name))
  // Retain the installed marker bytes; domains() still enforces channel policy.
  writeFileSync(join(inputs.out, 'development-marker.txt'), marker)
  json(inputs.out, 'builder-images.json', inputs.builderImages)
  for (const [name, value] of Object.entries(derived(inputs.out, m, image, deployment.rootfs.content))) json(inputs.out, name, value)
  m.artifacts = Object.entries(releaseFiles(image)).filter(([name]) => name !== 'SHA256SUMS').map(([name, role]) => measure(inputs.out, name, role))
  writeFileSync(join(inputs.out, 'SHA256SUMS'), sums(m.artifacts))
  m.artifacts.push(measure(inputs.out, 'SHA256SUMS', 'checksums'))
  json(inputs.out, 'manifest.json', m)
  return gateRelease(inputs.out, inputs.keys)
}
