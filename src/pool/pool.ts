// The package pool: the package rows of locks/ and this tree's own built archives, fetch and index.
//
//   bun src/cli.ts pool rows [--arch <amd64|arm64>]
//       every pinned archive as a row: package, version, architecture, sha256, repository, commit, file;
//       and every archive of this tree's own producers (tools/deb/producers.sh: the board and radio
//       packages, built by make board-pool) that is in _out/debs/<arch>/pool at its declared version,
//       as a row of repository mica-build at the tree's HEAD commit, its sha256 the archive's
//   bun src/cli.ts pool own [--arch <amd64|arm64>]
//       only the rows of this tree's own archives, in the same columns; no registry is read
//   bun src/cli.ts pool fetch --arch <amd64|arm64> [--packages "<p> ..."] [--check]
//       download and verify the pinned archives into _out/debs/<arch>/pool
//       (--check reads the pool manifests only)
//   bun src/cli.ts pool index --arch <amd64|arm64>
//       Packages, SHA256SUMS and manifest.txt over _out/debs/<arch>/pool
//
//   reads   locks/<repository>.lock (src/locks/locks.ts, which checks every lock and pin first): the
//           release row (the commit), the pool row of each architecture and the package rows.
//           A package is the layer of its pool manifest whose digest is the row's sha256; the
//           layer's title, <package>_<version>_<architecture>.deb, gives the archive's
//           architecture (the pool's or all) and must name the row's package and version.
//           The manifest is read by digest (src/pool/oci.ts) and must be the
//           application/vnd.mica.pool of that repository and architecture; it carries no
//           release or commit, so one pool digest may be tagged by several releases.
//           The commit column is the lock's release row; an archive carries none.
//   writes  _out/debs/<arch>/pool/*.deb, _out/debs/<arch>/{Packages,SHA256SUMS,manifest.txt},
//           _out/cache/pool/<sha256>.deb (the download cache; a cached archive is hashed again)
//
// A reader reads only the location its lock names: a refused token, 404, transport failure, wrong identity or
// hash mismatch stops it, with no fallback. Every archive is also read for its control fields, which must
// equal the row. MICA_POOL_DIR overrides _out/debs. The port of tools/pool.sh (deleted 2026-09-22), message
// for message: the control fields are read by src/pool/deb.ts on the host where the shell ran dpkg-deb in
// the base image, and the index (dpkg-scanpackages) still runs there, through stages/pool/index.sh.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { controlFields, controlText } from './deb.ts'
import { blob, manifest as ociManifest } from './oci.ts'
import { resolve as resolveImage } from '../locks/from.ts'
import { inputs, rows as lockRows, type Records } from '../locks/locks.ts'

export class PoolError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, '../..')
const POOL_ROOT = process.env.MICA_POOL_DIR || join(REPO_ROOT, '_out/debs')
const CACHE = process.env.MICA_POOL_CACHE || join(REPO_ROOT, '_out/cache/pool')

/** package, version, architecture, sha256, repository, commit, file */
export type Row = [string, string, string, string, string, string, string]

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(argv: string[], options: { stdin?: string, cwd?: string } = {}): { code: number, out: string, err: string } {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin), cwd: options.cwd })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

/** The tree's HEAD, the provenance of every own row; a tree whose HEAD cannot be read refuses rather than stamps zeros. */
function ownCommit(): string {
  const r = run(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD'])
  if (r.code !== 0) throw new PoolError(`the tree's HEAD could not be read for the own rows: ${(r.out + r.err).trim()}`)
  const commit = r.out.trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new PoolError(`the tree's HEAD is not a commit id: ${commit}`)
  return commit
}

/** One row per archive of this tree's own producers that is built into the wanted pools, at its declared version. */
export function ownRows(want?: string, poolRoot = POOL_ROOT): Row[] {
  const commit = ownCommit()
  const producers = run(['bash', join(REPO_ROOT, 'tools/deb/producers.sh')])
  if (producers.code !== 0) throw new PoolError(`tools/deb/producers.sh failed:\n${producers.err.trimEnd()}`)
  const out: Row[] = []
  for (const line of producers.out.split('\n').filter(l => l !== '')) {
    const [producer, , arches, packages] = line.split(/\s+/) as [string, string, string, string]
    const v = run(['bash', join(REPO_ROOT, 'tools/deb/producers.sh'), '--version-for', producer])
    const version = v.out.split(/\s+/)[0] ?? ''
    if (v.code !== 0 || version === '') throw new PoolError(`no declared version of the producer ${producer}`)
    const list = arches.split(',')
    const debArch = list.includes('all') ? 'all' : ''
    for (const a of ['amd64', 'arm64']) {
      if (want !== undefined && a !== want) continue
      const arch = debArch || a
      if (arch !== 'all' && !list.includes(a)) continue
      for (const p of packages.split(',')) {
        const deb = join(poolRoot, a, 'pool', `${p}_${version}_${arch}.deb`)
        if (!existsSync(deb)) continue
        out.push([p, version, arch, sha256File(deb), 'mica-build', commit, `${p}_${version}_${arch}.deb`])
      }
    }
  }
  return out
}

type Manifest = { artifactType?: string, annotations?: Record<string, string>, layers?: { digest: string, mediaType: string, annotations?: Record<string, string> }[] }

/** One row per package row of the wanted pools, joined with its pool manifest, then the tree's own. */
export async function rows(want?: string, records: Records = inputs()): Promise<Row[]> {
  const release = new Map(lockRows('release', undefined, undefined, records).map(r => [r[0]!, r[3]!]))
  const packages = lockRows('package', undefined, undefined, records)
  const joined: [string, string, string, string, string, string, string, string][] = []
  for (const [input, arch, ref] of lockRows('pool', undefined, undefined, records) as [string, string, string][]) {
    if (want !== undefined && arch !== want) continue
    // An input is <repository>[.<scope>]; the pool and its archives name the repository.
    const repository = input.split('.')[0]!
    const commit = release.get(input) ?? ''
    let m: Manifest
    try { m = JSON.parse(readFileSync(await ociManifest(ref), 'utf8')) as Manifest }
    catch (e) { throw new PoolError(`the ${arch} pool of ${repository} could not be read (${e instanceof Error ? e.message : String(e)})`) }
    if (m.artifactType !== 'application/vnd.mica.pool' || m.annotations?.['mica.source-repo'] !== repository || m.annotations?.['mica.arch'] !== arch)
      throw new PoolError(`${ref} is not the ${arch} pool of ${repository}`)

    for (const [i, n, a, v, s] of packages as [string, string, string, string, string][]) {
      if (i !== input || a !== arch) continue
      const layers = (m.layers ?? []).filter(l => l.digest === 'sha256:' + s && l.mediaType === 'application/vnd.mica.deb')
      if (layers.length !== 1) throw new PoolError(`the ${arch} pool of ${repository} carries no archive layer sha256:${s} for ${n} ${v}`)
      const title = layers[0]!.annotations?.['org.opencontainers.image.title'] ?? ''
      if (title !== `${n}_${v}_${arch}.deb` && title !== `${n}_${v}_all.deb`)
        throw new PoolError(`layer sha256:${s} of the ${arch} pool of ${repository} is titled ${title}, not ${n}_${v}_${arch}.deb or _all.deb`)

      const fileArch = title.slice(0, -'.deb'.length).split('_').at(-1)!
      joined.push([n, v, fileArch, s, repository, commit, title, input])
    }
  }
  // ONE PACKAGE IS ONE ROW, AND THE KEY IS ITS IDENTITY: name, architecture and digest. The input that pins it
  // and that input's release commit are provenance. Two inputs pinning the same bytes is legitimate and
  // permanent (every board that ships a radio publishes the shared `Architecture: all` archives itself), and
  // those rows collapse to one, keeping the provenance of the input whose name sorts first. Two inputs pinning
  // the same name and architecture at DIFFERENT digests is a naming defect, refused naming both.
  joined.sort((x, y) => { const a = x.join('\t'), b = y.join('\t'); return a < b ? -1 : a > b ? 1 : 0 })
  const seen = new Map<string, { row: Row, digest: string, input: string }>()
  const order: string[] = []
  for (const r of joined) {
    const key = `${r[0]}\t${r[2]}`
    const row: Row = [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]
    const prior = seen.get(key)
    if (prior === undefined) { seen.set(key, { row, digest: r[3], input: r[7] }); order.push(key); continue }
    if (prior.digest !== r[3]) {
      throw new PoolError(`${r[0]} is pinned twice for ${r[2]} at two digests: sha256:${prior.digest} by ${prior.input} and sha256:${r[3]} by ${r[7]}.\n`
        + '       One package name covers two archives, which is a naming defect, not a duplication: give the one that\n'
        + '       differs its own name and its own producer, as a board publishes its own radio package beside the shared one.')
    }
    if (r[7] < prior.input) { prior.input = r[7]; prior.row = row }
  }
  return [...order.map(k => seen.get(k)!.row), ...ownRows(want)]
}

/** The archive of one row into the cache, verified; its cached path. */
async function obtain(sha: string, repository: string, pool: string, file: string, records: Records): Promise<string> {
  const cached = join(CACHE, `${sha}.deb`)
  if (existsSync(cached) && sha256File(cached) === sha) return cached
  // Every pool of the repository lives in its one registry repository (ghcr.io/micaoss/<repository> or local/<repository>).
  const ref = lockRows('pool', undefined, undefined, records).find(r => (r[0] === repository || r[0]!.startsWith(repository + '.')) && r[1] === pool)?.[2] ?? ''
  mkdirSync(CACHE, { recursive: true })
  try { await blob(ref.split(/[:@]/)[0]!, sha, `${cached}.part`) }
  catch (e) { rmSync(`${cached}.part`, { force: true }); throw new PoolError(`reading ${file} from ${ref} failed (${e instanceof Error ? e.message : String(e)})`) }
  renameSync(`${cached}.part`, cached)
  return cached
}

function archArg(arch: string | undefined): string {
  if (arch !== 'amd64' && arch !== 'arm64') throw new PoolError('--arch must be amd64 or arm64')
  return arch
}

export async function fetchPool(arch: string, packages: string[], check: boolean): Promise<string> {
  const records = inputs()
  // The imported rows: this tree's own archives are built into the pool (make board-pool), not fetched.
  const all = (await rows(arch, records)).filter(r => r[4] !== 'mica-build')
  let wanted = all
  if (packages.length > 0) {
    for (const p of packages) if (!all.some(r => r[0] === p)) throw new PoolError(`no ${arch} package row for ${p} in locks/`)
    wanted = all.filter(r => packages.includes(r[0]))
  }
  if (check) return `pool: ${wanted.length} ${arch} archive(s) are layers of their pinned pool manifests`
  const pool = join(POOL_ROOT, arch, 'pool')
  const fetched: [string, Row][] = []
  for (const r of wanted) fetched.push([await obtain(r[3], r[4], arch, r[6], records), r])
  mkdirSync(pool, { recursive: true })
  for (const [path, [name, version, a, , repository]] of fetched) {
    const f = path.slice(CACHE.length + 1)
    const fields = controlFields(await controlText(path))
    const p = fields.Package, v = fields.Version, ar = fields.Architecture, r = fields['Mica-Source-Repo']
    if (p !== name || v !== version || ar !== a) throw new PoolError(`${f} says Package ${p ?? '?'}, Version ${v ?? '?'}, Architecture ${ar ?? '?'}; locks/ says ${name} ${version} ${a}`)
    if (r !== undefined && r !== '' && r !== repository) throw new PoolError(`${name} ${version} says Mica-Source-Repo ${r}; locks/ says ${repository}`)
    for (const other of readdirSync(pool))
      if (other.startsWith(name + '_') && other.endsWith('.deb') && other.split('_').length === 3 && other !== `${name}_${version}_${a}.deb`) rmSync(join(pool, other))

    copyFileSync(path, join(pool, `${name}_${version}_${a}.deb`))
  }
  return `pool: ${wanted.length} ${arch} archive(s) verified into ${pool.startsWith(REPO_ROOT + '/') ? pool.slice(REPO_ROOT.length + 1) : pool}`
}

export async function index(arch: string): Promise<string> {
  const dist = join(POOL_ROOT, arch)
  if (!existsSync(join(dist, 'pool')) || !readdirSync(join(dist, 'pool')).some(f => f.endsWith('.deb'))) throw new PoolError(`${dist}/pool holds no archive; fetch first`)
  const records = inputs()
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.pool.'))
  try {
    writeFileSync(join(work, 'rows'), (await rows(arch, records)).map(r => r.join('\t') + '\n').join(''))
    const image = resolveImage('mica-build-env:base', records)
    // mica-build-side: container-block -- dpkg-scanpackages and dpkg-deb run in mica-build-env:base (stages/pool/index.sh).
    const r = Bun.spawnSync(['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${dist}:/dist`, '-v', `${work}:/work:ro`,
      '-v', `${join(REPO_ROOT, 'stages/pool/index.sh')}:/index.sh:ro`, '-w', '/dist', '-e', `ARCH=${arch}`, image, 'bash', '/index.sh'], { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) throw new PoolError(`indexing ${dist} failed (see above)`)
  }
  finally { rmSync(work, { recursive: true, force: true }) }
  return `pool: ${dist.startsWith(REPO_ROOT + '/') ? dist.slice(REPO_ROOT.length + 1) : dist} indexed`
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv
    let arch: string | undefined, packages = '', check = false
    for (let i = 0; i < rest.length;) {
      if (rest[i] === '--arch') { arch = rest[i + 1] ?? ''; i += 2 }
      else if (rest[i] === '--packages') { packages = rest[i + 1] ?? ''; i += 2 }
      else if (rest[i] === '--check') { check = true; i += 1 }
      else { throw new PoolError(`unknown argument: ${rest[i]}`) }
    }
    if (cmd === 'rows' || cmd === 'own') {
      if (arch !== undefined) archArg(arch)
      const out = (cmd === 'rows' ? await rows(arch) : ownRows(arch)).map(r => r.join('\t') + '\n').join('')
      await Bun.write(Bun.stdout, out)
    }
    else if (cmd === 'fetch') { console.log(await fetchPool(archArg(arch), packages.split(/\s+/).filter(p => p !== ''), check)) }
    else if (cmd === 'index') { console.log(await index(archArg(arch))) }
    else { throw new PoolError('usage: pool rows [--arch A] | own [--arch A] | fetch --arch A [--packages "..."] [--check] | index --arch A') }
    return 0
  }
  catch (e) {
    if (e instanceof PoolError) { console.error(`pool: error: ${e.message}`); return 1 }
    if (e instanceof Error && (e.constructor.name === 'Exit' || e.constructor.name === 'Refused' || e.constructor.name === 'OciError')) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
