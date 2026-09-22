// The source lineage record: its schema, its canonical bytes and its reader. The pack stage verifies the
// record on the way in (compose.ts) inside the pack-tools container, where only src/rootfs/runtime is mounted,
// so this module imports nothing outside it; the writer, which reads the pool archives and the checkout, is
// src/rootfs/lineage.ts (`bun src/cli.ts lineage`).
//
// The port of rootfs/runtime/source-lineage.py (deleted 2026-09-22), rule for rule and message for message; the
// record it reads is the Python's canonical bytes (pyjson.ts).
import { lstatSync, readFileSync } from 'node:fs'
import { cmpStr, kinds, sha256File } from './fsx.ts'
import { compact, parse, type Value } from './pyjson.ts'

export const SCHEMA = 'mica/source-lineage/v1'
export const LOCK_COLUMNS = ['package', 'version', 'architecture', 'sha256', 'source_repo', 'source_commit'] as const
type Obj = { [key: string]: Value }

export class LineageError extends Error {}

export function require(ok: unknown, message: string): asserts ok {
  if (!ok) throw new LineageError('source lineage: ' + message)
}

export function keys(value: Value, names: string): Obj {
  const wanted = names.split(' ')
  require(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === wanted.length && wanted.every(n => n in value), 'unknown or missing fields')
  return value as Obj
}

/** A bounded, regular JSON input, read with json.loads's duplicate-key refusal. */
export function load(path: string): Value {
  const st = lstatSync(path, { bigint: true })
  require(kinds.isReg(st.mode) && !kinds.isLnk(st.mode) && st.size <= 16n * 1024n * 1024n, 'bounded regular input required')
  return parse(readFileSync(path, 'utf8'), { duplicate: (key) => { throw new LineageError('source lineage: duplicate key: ' + key) } })
}

export function canonical(value: Value): Uint8Array {
  return new TextEncoder().encode(compact(value) + '\n')
}

export function sha(path: string): string {
  return sha256File(path)
}

export function hexId(value: Value, length = 64): string {
  require(typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value), 'malformed digest')
  return value
}

export function relativePath(value: Value): string {
  require(typeof value === 'string' && value !== '' && !value.startsWith('/')
    && value.split('/').every(p => p !== '' && p !== '.' && p !== '..')
    && !/[\x00-\x1f\x7f]/.test(value), 'unsafe relative path')
  return value
}

export function natural(value: Value): void {
  require((typeof value === 'bigint' && value >= 0n && value <= 0xffffffffn) || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff), 'invalid epoch')
}

export function packageName(value: Value): string {
  require(typeof value === 'string' && /^[a-z0-9][a-z0-9+.-]+$/.test(value), 'package name')
  return value
}

export function repoName(value: Value): string {
  require(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), 'source repository name')
  return value
}

/** A package's declared Debian version. */
export function packageVersion(version: Value): string {
  require(typeof version === 'string' && /^[0-9][A-Za-z0-9.+~-]*$/.test(version), 'package version: ' + String(version))
  return version
}

export type LockRow = { package: string, version: string, architecture: string, sha256: string, source_repo: string, source_commit: string }

/** The package rows of one pool (tools/pool.sh rows --arch: package, version, architecture, sha256, repository, commit, file), sorted. */
export function lockRows(path: string, arch: string): LockRow[] {
  const rows = new Map<string, LockRow>()
  for (const line of readFileSync(path, 'utf8').split('\n').filter(l => l !== '')) {
    const fields = line.split('\t')
    require(fields.length === 7, 'pool row: ' + line)
    const [name, version, architecture, sha256, repository, commit, file] = fields as [string, string, string, string, string, string, string]
    packageName(name); repoName(repository); hexId(sha256); hexId(commit, 40)
    packageVersion(version)
    require(architecture === arch || architecture === 'all', 'pool row architecture: ' + name)
    require(file === `${name}_${version}_${architecture}.deb`, 'pool row file name: ' + name)
    require(!rows.has(name), 'a package has two rows in one pool: ' + name)
    rows.set(name, { package: name, version, architecture, sha256, source_repo: repository, source_commit: commit })
  }
  require(rows.size > 0, 'no pool rows in ' + path)
  return [...rows.keys()].sort(cmpStr).map(n => rows.get(n)!)
}

export type PoolPackage = { package: string, version: string, architecture: string, archive: string, sha256: string, control_sha256: string, source_repo: string, source_commit: string }

export type Lineage = Obj & { lock: LockRow[], unlocked: string[], pool: { files: Record<string, string>, packages: PoolPackage[] }, root_epoch: bigint | number, package_source: Obj, composition_source: Obj }

export function validate(record: Value, arch: string, epoch: bigint): Lineage {
  const r = keys(record, 'schema package_source composition_source architecture root_epoch pool lock unlocked')
  require(r.schema === SCHEMA && r.architecture === arch, 'schema/architecture mismatch')
  require(arch === 'amd64' || arch === 'arm64', 'invalid architecture')
  natural(r.root_epoch!); require(BigInt(r.root_epoch as bigint | number) === epoch, 'root epoch mismatch')
  const p = keys(r.package_source!, 'commit tree epoch version')
  const c = keys(r.composition_source!, 'commit tree epoch')
  for (const source of [p, c]) { hexId(source.commit!, 40); hexId(source.tree!, 40); natural(source.epoch!) }
  require(p.commit === c.commit && p.tree === c.tree && BigInt(p.epoch as bigint | number) === BigInt(c.epoch as bigint | number), 'package and composition source differ')
  require(typeof p.version === 'string' && new RegExp(`^[0-9][A-Za-z0-9.~]*\\+git${(p.commit as string).slice(0, 12)}-1$`).test(p.version), 'tree version/source commit')
  require(Array.isArray(r.lock), 'lock rows')
  const locked = new Map<string, Obj>()
  for (const rowValue of r.lock) {
    const row = keys(rowValue, LOCK_COLUMNS.join(' '))
    packageName(row.package!); repoName(row.source_repo!); hexId(row.sha256!); hexId(row.source_commit!, 40)
    packageVersion(row.version!)
    require(row.architecture === arch || row.architecture === 'all', 'lock row architecture: ' + row.package)
    require(!locked.has(row.package as string), 'duplicate lock row: ' + row.package)
    locked.set(row.package as string, row)
  }
  const lockNames = (r.lock as Obj[]).map(x => x.package as string)
  require(JSON.stringify(lockNames) === JSON.stringify([...locked.keys()].sort(cmpStr)), 'lock rows unsorted')
  const unlocked = r.unlocked
  require(Array.isArray(unlocked) && JSON.stringify(unlocked) === JSON.stringify([...new Set(unlocked as string[])].sort(cmpStr)) && (unlocked as string[]).every(n => locked.has(n)), 'unlocked names')
  const pool = keys(r.pool!, 'files packages')
  require(pool.files !== null && typeof pool.files === 'object' && !Array.isArray(pool.files) && Array.isArray(pool.packages) && pool.packages.length > 0, 'empty lineage pool')
  for (const [path, digest] of Object.entries(pool.files as Obj)) { relativePath(path); hexId(digest) }
  const expected = new Set(['Packages', 'SHA256SUMS', 'manifest.txt'])
  const names = new Set<string>()
  for (const rowValue of pool.packages as Value[]) {
    const row = keys(rowValue, 'package version architecture archive sha256 control_sha256 source_repo source_commit')
    packageName(row.package!); require(!names.has(row.package as string), 'duplicate package')
    names.add(row.package as string)
    require(row.architecture === arch || row.architecture === 'all', 'package architecture: ' + row.package)
    require(typeof row.archive === 'string' && /^pool\/[^/]+\.deb$/.test(row.archive), 'archive path')
    hexId(row.sha256!); hexId(row.control_sha256!); repoName(row.source_repo!); hexId(row.source_commit!, 40)
    require((pool.files as Obj)[row.archive as string] === row.sha256 && !expected.has(row.archive as string), 'pool archive mismatch')
    expected.add(row.archive as string)
    require(locked.has(row.package as string), 'archive not in the lock: ' + row.package)
    if (!(unlocked as string[]).includes(row.package as string))
      require(LOCK_COLUMNS.every(k => row[k] === locked.get(row.package as string)![k]), 'locked archive differs from the lock: ' + row.package)
  }
  const fileNames = new Set(Object.keys(pool.files as Obj))
  require(fileNames.size === expected.size && [...expected].every(f => fileNames.has(f)), 'lineage pool membership')
  require([...locked.keys()].every(n => names.has(n)), 'locked archive missing from the pool')
  return r as Lineage
}
