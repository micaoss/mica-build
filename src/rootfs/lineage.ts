// Record the package pool a root is composed from: the writer half of the source lineage.
//
//   bun src/cli.ts lineage --composition-source DIR --pool DIR --arch amd64|arm64 --epoch N --rows pool-rows.tsv [--unlocked "p q"] --output source-lineage.json
//
// Every archive of the pool is a package row of the pool (as src/cli.ts pool rows --arch prints it), at the locked
// version, sha256 and source repository; its source commit is the release row of the lock that pins it, or this
// tree's commit for the archives it builds. MICA_POOL_UNLOCKED names imported packages whose digest check is
// waived for local development; the waiver is recorded in the lineage record, in the image's identity file, and
// src/image/release-manifest.ts refuses such an image outside the development channel.
//
// The port of rootfs/runtime/source-lineage.py (deleted 2026-09-22), rule for rule and message for message; the
// record it writes is the Python's canonical bytes (pyjson.ts). The archive reads are src/pool/deb.ts's, where the
// Python ran dpkg-deb. The record's shape and its reader (validate) live in runtime/lineage.ts, which the pack
// stage runs inside the pack-tools container with nothing but this tree's src/rootfs/runtime mounted.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { controlTar, controlText } from '../pool/deb.ts'
import { version as treeVersion } from '../release/version.ts'
import { cmpStr, kinds, lstatBig, pyError } from './runtime/fsx.ts'
import { type Value } from './runtime/pyjson.ts'
import { canonical, hexId, LineageError, lockRows, packageName, repoName, require, SCHEMA, sha, validate, type Lineage, type LockRow, type PoolPackage } from './runtime/lineage.ts'

type Obj = { [key: string]: Value }

function command(args: string[], cwd?: string): Buffer {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 60000, maxBuffer: 1 << 30 })
  if (r.error) throw r.error
  if (r.status !== 0) throw new LineageError(`Command '${JSON.stringify(args).replace(/"/g, '\'')}' returned non-zero exit status ${r.status}.`)
  return r.stdout
}

function git(root: string, ...args: string[]): Buffer {
  return command(['git', '-C', root, ...args])
}

/** Every blob of the commit, and every submodule as a `commit` entry (mode 160000). */
function tree(root: string, commit: string): Map<string, { mode: string, blob: string }> {
  const result = new Map<string, { mode: string, blob: string }>()
  for (const entry of git(root, 'ls-tree', '-rz', commit).toString('utf8').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    const [mode, kind, blob] = entry.slice(0, tab).split(' ') as [string, string, string]
    require((kind === 'blob' && ['100644', '100755', '120000'].includes(mode)) || (kind === 'commit' && mode === '160000'), 'unsupported Git object')
    result.set(entry.slice(tab + 1), { mode, blob })
  }
  return result
}

/** The checkout's commit, tree and epoch -- after proving the checkout IS that tree. */
export function identity(root: string): { commit: string, tree: string, epoch: bigint } {
  require(existsSync(root) && lstatSync(root).isDirectory(), 'source checkout missing')
  require(git(root, 'status', '--porcelain', '--untracked-files=all').length === 0, 'dirty source checkout')
  const commit = git(root, 'rev-parse', 'HEAD').toString().trim()
  const real = realpathSync(root)
  for (const [name, entry] of tree(root, commit)) {
    const path = join(root, name)
    const parent = realpathSync(dirname(path))
    require(parent === real || parent.startsWith(real + '/'), 'checkout parent escapes source')
    require(entry.mode !== '160000', 'submodule in the tree: ' + name)
    const st = lstatBig(path)
    const mode = kinds.isLnk(st.mode) ? '120000' : (st.mode & 0o111n) !== 0n ? '100755' : '100644'
    require(kinds.isReg(st.mode) || kinds.isLnk(st.mode), 'unsupported checkout node')
    const data = mode === '120000' ? Buffer.from(readlinkSync(path)) : readFileSync(path)
    const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
    require(mode === entry.mode && blob === entry.blob, 'checkout bytes/mode changed: ' + name)
  }
  return {
    commit: hexId(commit, 40), tree: hexId(git(root, 'rev-parse', 'HEAD^{tree}').toString().trim(), 40),
    epoch: BigInt(git(root, 'show', '-s', '--format=%ct', 'HEAD').toString().trim()),
  }
}
async function fieldsOf(archive: string): Promise<Record<string, string>> {
  const fields: Record<string, string> = {}
  let key: string | undefined
  for (const line of (await controlText(archive)).split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      require(key !== undefined, 'control continuation')
      fields[key!] += '\n' + line
    }
    else if (line) {
      const i = line.indexOf(': ')
      const k = i < 0 ? line : line.slice(0, i), v = i < 0 ? '' : line.slice(i + 2)
      require(!(k in fields), 'duplicate control field')
      key = k; fields[k] = v
    }
  }
  return fields
}

/** Every archive of the pool, checked against its lock row, with the three index files. */
export async function poolIdentity(pool: string, arch: string, lock: LockRow[], unlocked: string[]): Promise<{ files: Record<string, string>, packages: PoolPackage[] }> {
  require(arch === 'amd64' || arch === 'arm64', 'invalid architecture')
  const locked = new Map(lock.map(row => [row.package, row]))
  for (const name of unlocked) require(locked.has(name), 'MICA_POOL_UNLOCKED names ' + name + ', which the lock does not import')
  const files: Record<string, string> = {}
  const debs = existsSync(join(pool, 'pool')) ? readdirSync(join(pool, 'pool')).filter(f => f.endsWith('.deb')).sort(cmpStr) : []
  for (const f of debs) files['pool/' + f] = sha(join(pool, 'pool', f))
  require(Object.keys(files).length > 0, 'empty pool')
  for (const name of ['Packages', 'SHA256SUMS', 'manifest.txt']) {
    const st = existsSync(join(pool, name)) ? lstatBig(join(pool, name)) : undefined
    require(st !== undefined && kinds.isReg(st.mode), 'missing pool index')
    files[name] = sha(join(pool, name))
  }
  const sums = new Map<string, string>()
  for (const line of readFileSync(join(pool, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l !== '')) {
    const m = /^([a-f0-9]{64}) {2}(pool\/[^/]+\.deb)$/.exec(line)
    require(m !== null && !sums.has(m[2]!), 'invalid or duplicate pool checksum')
    sums.set(m[2]!, m[1]!)
  }
  const poolFiles = Object.entries(files).filter(([k]) => k.startsWith('pool/'))
  require(sums.size === poolFiles.length && poolFiles.every(([k, v]) => sums.get(k) === v), 'archive checksum membership')
  const indexed = new Map<string, Record<string, string>>()
  for (const paragraph of readFileSync(join(pool, 'Packages'), 'utf8').trim().split('\n\n')) {
    const fields: Record<string, string> = {}
    for (const line of paragraph.split('\n')) {
      if (line.startsWith(' ') || line.startsWith('\t')) continue
      const i = line.indexOf(': ')
      const key = i < 0 ? line : line.slice(0, i), value = i < 0 ? '' : line.slice(i + 2)
      require(!(key in fields), 'duplicate package index field')
      fields[key] = value
    }
    const name = fields.Filename!
    require(sums.has(name) && !indexed.has(name) && fields.SHA256 === sums.get(name), 'package index digest/membership')
    indexed.set(name, fields)
  }
  require(indexed.size === sums.size && [...sums.keys()].every(k => indexed.has(k)), 'package index archive set')
  const manifest: string[][] = []
  for (const line of readFileSync(join(pool, 'manifest.txt'), 'utf8').split('\n')) if (line && !line.startsWith('#')) manifest.push(line.split('\t'))
  const packages: PoolPackage[] = []
  const manifestMtime = lstatBig(join(pool, 'manifest.txt')).mtimeNs
  for (const name of [...sums.keys()].sort(cmpStr)) {
    const archive = join(pool, name)
    const st = lstatBig(archive)
    require(kinds.isReg(st.mode), 'regular archive required')
    require(st.mtimeNs <= manifestMtime, 'stale pool index')
    const control = await controlTar(archive)
    const fields = await fieldsOf(archive)
    const [p, v, a] = [fields.Package!, fields.Version!, fields.Architecture!]
    packageName(p)
    require(a === arch || a === 'all', 'archive architecture: ' + p)
    const repo = repoName(fields['Mica-Source-Repo'] ?? '')
    require((['Package', 'Version', 'Architecture'] as const).every(k => indexed.get(name)![k] === fields[k]), 'archive control/index mismatch: ' + p)
    require(locked.has(p), 'archive not in the lock: ' + p)
    const row = locked.get(p)!
    const commit = row.source_commit
    if (!unlocked.includes(p)) { // the waiver: present, recorded, not compared
      require(v === row.version && a === row.architecture && sums.get(name) === row.sha256, 'locked archive differs from the lock: ' + p)
      require(repo === row.source_repo, 'locked archive source repository differs from the lock: ' + p)
    }
    const matching = manifest.filter(r => r.length === 8 && r[0] === p && r[1] === v && r[2] === a && r[4] === sums.get(name) && r[5] === name && r[6] === repo && r[7] === commit)
    require(matching.length === 1, 'manifest/control membership: ' + p)
    packages.push({ package: p, version: v, architecture: a, archive: name, sha256: sums.get(name)!, control_sha256: createHash('sha256').update(control).digest('hex'), source_repo: repo, source_commit: commit })
  }
  require(manifest.length === packages.length && new Set(packages.map(p => p.package)).size === packages.length, 'mixed/duplicate pool')
  const present = new Set(packages.map(p => p.package))
  for (const row of lock) require(present.has(row.package), 'locked archive missing from the pool: ' + row.package)
  const sortedFiles: Record<string, string> = {}
  for (const k of Object.keys(files).sort(cmpStr)) sortedFiles[k] = files[k]!
  return { files: sortedFiles, packages }
}

export async function create(compositionRoot: string, pool: string, arch: string, epoch: bigint, rowsPath: string, unlocked: string[]): Promise<Lineage> {
  const c = identity(compositionRoot)
  const version = treeVersion(compositionRoot)
  const lock = lockRows(rowsPath, arch)
  const unlockedSorted = [...new Set(unlocked)].sort(cmpStr)
  const poolRecord = await poolIdentity(pool, arch, lock, unlockedSorted)
  const record: Value = {
    schema: SCHEMA, package_source: { ...c, version }, composition_source: { ...c }, architecture: arch, root_epoch: epoch,
    pool: poolRecord as unknown as Value, lock: lock as unknown as Value, unlocked: unlockedSorted,
  }
  return validate(record, arch, epoch)
}

export async function main(argv: string[]): Promise<number> {
  const a: Record<string, string> = { unlocked: '' }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!, v = argv[i + 1]
    if (!k.startsWith('--') || v === undefined) { console.error(`source lineage refused: unrecognized argument ${k}`); return 1 }
    a[k.slice(2).replace(/-/g, '_')] = v
  }
  for (const n of ['composition_source', 'pool', 'arch', 'epoch', 'rows', 'output'])
    if (!(n in a)) { console.error(`source lineage refused: the following argument is required: --${n.replace(/_/g, '-')}`); return 1 }

  try {
    const record = await create(a.composition_source!, a.pool!, a.arch!, BigInt(a.epoch!), a.rows!, a.unlocked!.split(/\s+/).filter(s => s))
    writeFileSync(a.output!, canonical(record as unknown as Value))
    console.log((record.package_source as Obj).version)
    return 0
  }
  catch (e) {
    if (e instanceof LineageError || (e instanceof Error && ('code' in e || e instanceof SyntaxError || e instanceof TypeError || e instanceof RangeError))) {
      console.error(`source lineage refused: ${pyError(e)}`)
      return 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
