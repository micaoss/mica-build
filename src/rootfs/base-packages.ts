// The Debian packages mica-system-base pins for later stages: the upstream rows of locks/mica-system-base.lock.
//
//   bun src/cli.ts base-packages check
//       rootfs/packages/presets.json names only packages the upstream rows list
//   bun src/cli.ts base-packages fetch --arch A
//       every row of that architecture into _out/cache/debian/<sha256>.deb, hashed and read for its control
//       fields (kept beside it as <sha256>.control), which must be the row's
//   bun src/cli.ts base-packages select --arch A --packages "<local package> ..."
//       the rows those local packages need on the Base root, as TSV: package, version, Debian architecture,
//       sha256, url, and the local packages that need it
//
// locks/mica-system-base.lock is the lock of the pinned mica-system-base release, committed unchanged
// (src/locks/locks.ts checks its rows). These packages are never in the Base root; a product installs the
// ones its selection needs, and this tree pins none of them itself.
//
// THE ROOTS. Each row names the roots of Base's upstream.pkgs it is pinned for; a package is in a root's
// closure exactly when that root is listed. `select` reads the Depends and Pre-Depends of the selected
// archives (the pool index): a dependency the Base root's dpkg status or the pool does not satisfy must be a
// root, and the whole closure of every such root is installed. A dependency that is neither is refused by
// name: such a package is proposed for Base's upstream.pkgs. The selected rows' own dependencies are then
// checked against the Base root and the selection, so a closure that does not install is refused here
// rather than in dpkg. The port of tools/base-packages.sh (deleted 2026-09-23), embedded Python included,
// message for message; the archives' control fields are read by src/pool/deb.ts on the host where the
// shell ran dpkg-deb in the base image.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as resolveImage } from '../locks/from.ts'
import { inputs, rows as lockRows, type Records } from '../locks/locks.ts'
import { controlFields, controlText } from '../pool/deb.ts'
import { REPO_ROOT } from '../pool/producers.ts'

export class BasePackagesError extends Error {}

const CACHE = join(REPO_ROOT, '_out/cache/debian')
const STATUS_CACHE = join(REPO_ROOT, '_out/cache/base-status')

function die(message: string): never {
  throw new BasePackagesError(`base-packages: error: ${message}`)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function archArg(arch: string): string {
  if (arch !== 'amd64' && arch !== 'arm64') die('--arch must be amd64 or arm64')
  return arch
}

/** package, architecture, version, sha256, url, roots */
export type Row = [string, string, string, string, string, string]

/** Every upstream row of the Base lock, as checked by the lock reader; of one architecture when given. */
export function rows(arch = '', records: Records = inputs()): Row[] {
  return (lockRows('upstream', 'mica-system-base', undefined, records) as string[][])
    .filter(r => arch === '' || r[2] === arch)
    .map(r => [r[1]!, r[2]!, r[3]!, r[4]!, r[5]!, r[6]!])
}

/** rootfs/packages/presets.json names only packages the upstream rows list. */
export function check(records: Records = inputs()): string {
  const all = rows('', records)
  if (all.length === 0) die('locks/mica-system-base.lock has no upstream row')
  const presetsPath = join(REPO_ROOT, 'rootfs/packages/presets.json')
  const presets = JSON.parse(readFileSync(presetsPath, 'utf8')) as unknown
  const unit = /^[A-Za-z0-9@_.-]+\.(service|socket|timer|path)$/
  const shape = presets !== null && typeof presets === 'object' && !Array.isArray(presets) && Object.values(presets as Record<string, unknown>).every((v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    const keys = Object.keys(v as object).sort()
    if (keys.join(',') !== 'system,user') return false
    const { system, user } = v as { system: unknown, user: unknown }
    return Array.isArray(system) && Array.isArray(user) && [...system, ...user].every(u => typeof u === 'string' && unit.test(u))
  })
  if (!shape) die(`${presetsPath} is not {<package>: {system: [<unit> ...], user: [<unit> ...]}}`)
  for (const p of Object.keys(presets as object))
    if (!all.some(r => r[0] === p)) die(`${presetsPath} presets units of ${p}, which no upstream row of locks/mica-system-base.lock lists`)

  return `base-packages: rootfs/packages/presets.json names only upstream rows of locks/mica-system-base.lock (${all.length} rows)`
}

/** Where an archive's control fields are kept beside it: <sha256>.control, the name the selector reads and the
 * cache pruner keeps. The one spelling of it, since the port wrote <sha256>.deb.control and read <sha256>.control,
 * which a cache restored from before the port hid (f471ec9 until 2026-09-25). */
export function controlPath(sha: string, cache = CACHE): string {
  return join(cache, `${sha}.control`)
}

/** Every row of the architecture into the cache, hashed and read for its control fields. */
export async function fetchRows(arch: string, records: Records = inputs()): Promise<string> {
  archArg(arch)
  mkdirSync(CACHE, { recursive: true })
  const list = rows(arch, records)
  for (const [name, , version, sha, url] of list) {
    const cached = join(CACHE, `${sha}.deb`)
    if (!existsSync(cached) || sha256File(cached) !== sha) {
      let status = 0
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(1800000) })
          status = r.status
          if (r.status >= 500 && attempt < 3) { await Bun.sleep(1000 * (attempt + 1)); continue }
          await Bun.write(`${cached}.part`, r)
          break
        }
        catch { status = 0; if (attempt < 3) { await Bun.sleep(1000 * (attempt + 1)); continue } }
      }
      if (status !== 200) { rmSync(`${cached}.part`, { force: true }); die(`downloading ${url} answered ${status === 0 ? '000' : status} (000: not reached)`) }
      if (sha256File(`${cached}.part`) !== sha) { rmSync(`${cached}.part`, { force: true }); die(`${url} hashes to other bytes than the pinned ${sha}`) }
      renameSync(`${cached}.part`, cached)
    }
    // The control fields, read on the host where the shell ran dpkg-deb in the base image.
    const text = await controlText(cached)
    const f = controlFields(text)
    if (`${f.Package}\t${f.Version}` !== `${name}\t${version}` || !(f.Architecture === arch || f.Architecture === 'all')) die(`${sha}.deb is ${f.Package}\t${f.Version} ${f.Architecture}; the lock says ${name} ${version} ${arch}`)
    writeFileSync(`${controlPath(sha)}.part`, text)
    renameSync(`${controlPath(sha)}.part`, controlPath(sha))
  }
  return `base-packages: ${list.length} ${arch} upstream archive(s) of locks/mica-system-base.lock verified into ${CACHE.slice(REPO_ROOT.length + 1)}`
}

type Fields = Record<string, string>

/** The paragraphs of a control-format text (a dpkg status, a Packages index), as the shell's Python read them. */
function paragraphs(text: string): Fields[] {
  const out: Fields[] = []
  for (const block of text.trim().split('\n\n')) {
    const fields: Fields = {}
    let key: string | undefined
    for (const line of block.split('\n')) {
      if ((line.startsWith(' ') || line.startsWith('\t')) && key !== undefined) { fields[key] += ' ' + line.trim() }
      else if (line.includes(': ') || line.endsWith(':')) {
        const i = line.indexOf(':')
        key = line.slice(0, i); fields[key] = line.slice(i + 1).trim()
      }
    }
    if (Object.keys(fields).length > 0) out.push(fields)
  }
  return out
}

/** The alternatives of every group of a relationship field: names without versions or architectures. */
function names(field: string): string[][] {
  return field.split(',').filter(g => g.trim() !== '').map(g => g.split('|').map(alt => alt.trim().split(/\s+/)[0]!.split(':')[0]!))
}

function provides(fields: Fields): Set<string> {
  return new Set([fields.Package!, ...names(fields.Provides ?? '').map(p => p[0]!)])
}

function depends(fields: Fields): string[][] {
  return names(`${fields['Pre-Depends'] ?? ''},${fields.Depends ?? ''}`)
}

/** The Base root's dpkg status, read out of its platform manifest without running it. */
function baseStatus(arch: string, records: Records): string {
  const ref = resolveImage(`mica-system-base:rootfs@${arch}`, records)
  const status = join(STATUS_CACHE, ref.slice(ref.lastIndexOf('@') + 1))
  if (!existsSync(status) || readFileSync(status).length === 0) {
    mkdirSync(STATUS_CACHE, { recursive: true })
    const created = Bun.spawnSync(['docker', 'create', '--label', 'ai-agent=true', '--platform', `linux/${arch}`, ref, '/bin/true'], { stdout: 'pipe', stderr: 'pipe' })
    if (created.exitCode !== 0) die(`docker create ${ref} failed: ${created.stderr.toString().trim()}`)
    const cid = created.stdout.toString().trim()
    const copied = Bun.spawnSync(['docker', 'cp', `${cid}:/var/lib/dpkg/status`, `${status}.part`], { stdout: 'pipe', stderr: 'pipe' })
    Bun.spawnSync(['docker', 'rm', cid], { stdout: 'pipe', stderr: 'pipe' })
    if (copied.exitCode !== 0) die(`docker cp of the Base root's dpkg status failed: ${copied.stderr.toString().trim()}`)
    renameSync(`${status}.part`, status)
  }
  return readFileSync(status, 'utf8')
}

/** The rows the local packages need on the Base root: package, version, Debian architecture, sha256, url, needers. */
export function select(arch: string, packages: string[], records: Records = inputs()): string[] {
  archArg(arch)
  const index = join(REPO_ROOT, '_out/debs', arch, 'Packages')
  if (!existsSync(index) || readFileSync(index).length === 0) die(`${index} does not exist; index the pool first (bash bin/bun.sh src/cli.ts pool index --arch ${arch})`)
  const satisfied = new Set<string>()
  for (const p of paragraphs(baseStatus(arch, records))) if ((p.Status ?? '').endsWith(' installed')) for (const n of provides(p)) satisfied.add(n)
  const local = new Map(paragraphs(readFileSync(index, 'utf8')).map(p => [p.Package!, p]))
  const lock = new Map<string, { control: Fields, version: string, sha: string, url: string, roots: Set<string> }>()
  for (const [name, , version, sha, url, roots] of rows(arch, records)) {
    const control = paragraphs(readFileSync(controlPath(sha), 'utf8'))[0]!
    lock.set(name, { control, version, sha, url, roots: new Set(roots.split(',')) })
  }
  const allRoots = new Set<string>()
  for (const row of lock.values()) for (const r of row.roots) allRoots.add(r)
  for (const name of packages) if (!local.has(name)) die(`${name} is not in the pool index ${index}`)
  const base = new Set(satisfied)
  // The roots the selected archives need: a dependency neither the Base root nor the pool satisfies.
  const needed = new Map<string, Set<string>>(), missing: string[] = []
  for (const name of packages) {
    for (const group of depends(local.get(name)!)) {
      if (group.some(alt => base.has(alt) || local.has(alt))) continue
      const root = group.find(alt => allRoots.has(alt))
      if (root === undefined) { missing.push(`${name} needs ${group.join(' | ')}`); continue }
      if (!needed.has(root)) needed.set(root, new Set())
      needed.get(root)!.add(name)
    }
  }
  if (missing.length > 0) die(`neither the Base root, the pool nor a root of the upstream rows of locks/mica-system-base.lock provides: ${[...new Set(missing)].sort().join('; ')}. Propose such a package for the upstream.pkgs of mica-system-base`)
  // The closure of every needed root, each row with the local packages it is installed for.
  const chosen = new Map<string, Set<string>>()
  for (const [alt, row] of lock) {
    for (const root of row.roots) {
      if (!needed.has(root)) continue
      if (!chosen.has(alt)) chosen.set(alt, new Set())
      for (const n of needed.get(root)!) chosen.get(alt)!.add(n)
    }
  }
  // The closure installs: every dependency of a chosen row is on the Base root, in the pool or chosen.
  const installed = new Set(base)
  for (const name of packages) for (const p of provides(local.get(name)!)) installed.add(p)
  for (const alt of chosen.keys()) for (const p of provides(lock.get(alt)!.control)) installed.add(p)
  const unmet: string[] = []
  for (const alt of chosen.keys()) for (const group of depends(lock.get(alt)!.control)) if (!group.some(dep => installed.has(dep) || local.has(dep))) unmet.push(`${alt} needs ${group.join(' | ')}`)
  if (unmet.length > 0) die(`the closures of the roots ${[...needed.keys()].sort().join(', ')} in locks/mica-system-base.lock do not install on the Base root: ${unmet.sort().join('; ')}`)
  return [...chosen.keys()].sort().map((alt) => {
    const row = lock.get(alt)!
    return [alt, row.version, row.control.Architecture ?? '', row.sha, row.url, [...chosen.get(alt)!].sort().join(',')].join('\t')
  })
}

export async function main(argv: string[]): Promise<number> {
  try {
    const cmd = argv[0] ?? ''
    let arch = '', packages = ''
    for (let i = 1; i < argv.length;) {
      if (argv[i] === '--arch') { arch = argv[i + 1] ?? ''; i += 2 }
      else if (argv[i] === '--packages') { packages = argv[i + 1] ?? ''; i += 2 }
      else { die(`unknown argument: ${argv[i]}`) }
    }
    if (cmd === 'check') console.log(check())
    else if (cmd === 'fetch') console.log(await fetchRows(arch))
    else if (cmd === 'select') await Bun.write(Bun.stdout, select(arch, packages.split(/\s+/).filter(p => p !== '')).map(l => l + '\n').join(''))
    else die('usage: base-packages check | fetch --arch A | select --arch A --packages "..."')
    return 0
  }
  catch (e) {
    if (e instanceof BasePackagesError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
