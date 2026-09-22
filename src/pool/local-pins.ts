// Pins for a local build: a sibling checkout's own pools stand in for its release.
//
//   bun src/cli.ts local-pins <repository> <checkout>
//
//   reads   <checkout>/_out/debs/<amd64|arm64>/{pool/*.deb,SHA256SUMS}   (the repository's own indexed build)
//   writes  <checkout>/_out/offline/{<repository>.lock,oci/,SHA256SUMS}  (its offline lock, mica:docs/design/release-lock.md 6)
//           locks/<repository>.lock and locks/pins/<repository>.pin  (the offline pin, section 7)
//
// THIS IS NEVER A RELEASE INPUT. An offline pin names its CHECKOUT, which locks.ts refuses under CI and
// tools/product-build.sh --release refuses. The composer binds a root to a clean commit, so a local build
// commits the lock and pin on a local branch of its own, which is never pushed.
//
// UNTIL THE PRODUCERS' `make offline` WRITES _out/offline/ ITSELF, this packs the checkout's indexed pools into
// that layout: one OCI image layout with a pool manifest per architecture (application/vnd.mica.pool, one
// application/vnd.mica.deb layer per archive titled with its file name), and a pool holding the package rows of
// those archives, as the releases publish them. The references are local/<repository>:<kind>.offline. A pool
// manifest carries only mica.source-repo and mica.arch; the lock's release row names the checkout's clean HEAD.
// The port of tools/local-pins.sh (deleted 2026-09-22), message for message; the archives' control fields are
// read by src/pool/deb.ts on the host, where the shell ran dpkg-deb in the base image.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { controlFields, controlText } from './deb.ts'
import { inputs, mode, rows } from '../locks/locks.ts'

export class LocalPinsError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, '../..')

function git(cwd: string, ...args: string[]): { ok: boolean, out: string } {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: r.exitCode === 0, out: r.stdout.toString() }
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** json.dumps(value, sort_keys=True, separators=(item, key)): compact for the manifests, the default (', ', ': ') for the index. */
function dumps(value: unknown, item = ',', key = ':'): string {
  if (Array.isArray(value)) return '[' + value.map(v => dumps(v, item, key)).join(item) + ']'
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + key + dumps(o[k], item, key)).join(item) + '}'
  }
  return JSON.stringify(value)
}
const compact = (value: unknown): string => dumps(value)

type Archive = { pool: string, file: string, name: string, version: string, arch: string }

export async function localPins(repository: string, checkoutArg: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(repository) || checkoutArg === '') throw new LocalPinsError('usage: local-pins <repository> <checkout>')
  if (mode() === 'ci') throw new LocalPinsError('an offline pin is never written under CI')
  if (process.env.MICA_BUN_ROUTE === 'container') throw new LocalPinsError('local-pins reads and writes a checkout outside this tree, which the container route of bin/bun.sh cannot see; run it with bun on the host')
  if (!existsSync(checkoutArg)) throw new LocalPinsError(`${checkoutArg} is not a directory`)
  const checkout = Bun.spawnSync(['sh', '-c', 'cd "$1" && pwd', 'sh', checkoutArg], { stdout: 'pipe' }).stdout.toString().trim()
  if (checkout === '') throw new LocalPinsError(`${checkoutArg} is not a directory`)
  if (checkout === REPO_ROOT) throw new LocalPinsError('the checkout is this tree')
  const head = git(checkout, 'rev-parse', 'HEAD')
  if (!head.ok) throw new LocalPinsError(`${checkout} is not a git checkout`)
  const commit = head.out.trim()
  if (git(checkout, 'status', '--porcelain').out !== '') throw new LocalPinsError(`${checkout} has uncommitted changes; an offline lock names a clean commit`)

  const own: Archive[] = []
  for (const pool of ['amd64', 'arm64']) {
    const debs = join(checkout, '_out/debs', pool)
    if (!existsSync(join(debs, 'pool'))) continue
    // The pool as its build indexed it: exactly the archives its SHA256SUMS lists, at those digests.
    if (!existsSync(join(debs, 'SHA256SUMS'))) throw new LocalPinsError(`${debs} has no SHA256SUMS; index the pool in ${checkout} first`)
    const listed: string[] = []
    for (const line of readFileSync(join(debs, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l !== '')) {
      const m = /^([0-9a-f]{64}) {2}(.*)$/.exec(line)
      if (m === null || !existsSync(join(debs, m[2]!)) || sha256(readFileSync(join(debs, m[2]!))) !== m[1]) throw new LocalPinsError(`${debs}/pool does not match its SHA256SUMS`)
      listed.push(m[2]!)
    }
    const present = readdirSync(join(debs, 'pool')).filter(f => f.endsWith('.deb')).map(f => 'pool/' + f).sort()
    if (JSON.stringify([...listed].sort()) !== JSON.stringify(present)) throw new LocalPinsError(`${debs}/pool holds other archives than its SHA256SUMS lists`)
    for (const file of present.map(p => p.slice('pool/'.length)).sort()) {
      const fields = controlFields(await controlText(join(debs, 'pool', file)))
      if (fields['Mica-Source-Repo'] !== repository) continue
      own.push({ pool, file, name: fields.Package ?? '', version: fields.Version ?? '', arch: fields.Architecture ?? '' })
    }
  }
  if (own.length === 0) throw new LocalPinsError(`${checkout}/_out/debs holds no archive whose Mica-Source-Repo is ${repository}`)
  for (const a of own) if (a.file !== `${a.name}_${a.version}_${a.arch}.deb`) throw new LocalPinsError(`${a.pool}/pool/${a.file} is not named ${a.name}_${a.version}_${a.arch}.deb`)

  // The offline layout: blobs, one pool manifest per architecture, the index, the lock and its SHA256SUMS.
  const out = join(checkout, '_out/offline')
  rmSync(out, { recursive: true, force: true })
  const blobs = join(out, 'oci/blobs/sha256')
  mkdirSync(blobs, { recursive: true })
  const blob = (data: Uint8Array | string): [string, number] => {
    const bytes = typeof data === 'string' ? Buffer.from(data) : data
    const digest = sha256(bytes)
    writeFileSync(join(blobs, digest), bytes)
    return [digest, bytes.length]
  }
  const [empty] = blob('{}')
  const index: unknown[] = []
  const manifest = (tag: string, artifact: string, layers: unknown[], annotations: Record<string, string>): string => {
    const body = compact({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType: artifact,
      config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: 'sha256:' + empty, size: 2 }, layers, annotations })
    const [digest, size] = blob(body)
    index.push({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: 'sha256:' + digest, size, annotations: { 'org.opencontainers.image.ref.name': tag } })
    return `local/${repository}:${tag}@sha256:${digest}`
  }
  const members: Record<string, [string, string, string, string, number][]> = { amd64: [], arm64: [] }
  const byKey = (a: Archive, b: Archive): number => { const x = `${a.pool}\t${a.file}`, y = `${b.pool}\t${b.file}`; return x < y ? -1 : x > y ? 1 : 0 }
  const sorted = [...own].sort(byKey)
  for (const a of sorted) {
    const [digest, size] = blob(readFileSync(join(checkout, '_out/debs', a.pool, 'pool', a.file)))
    members[a.pool]!.push([a.file, a.name, a.version, digest, size])
  }
  const pools: string[][] = [], packages: string[][] = []
  for (const arch of ['amd64', 'arm64']) {
    const m = members[arch]!
    if (m.length === 0) continue
    const layers = m.map(([f, , , d, n]) => ({ mediaType: 'application/vnd.mica.deb', digest: 'sha256:' + d, size: n, annotations: { 'org.opencontainers.image.title': f } }))
    pools.push(['pool', arch, manifest(`pool.${arch}.offline`, 'application/vnd.mica.pool', layers, { 'mica.source-repo': repository, 'mica.arch': arch })])
    for (const [, name, version, d] of m) packages.push(['package', name, arch, version, d])
  }
  packages.sort((a, b) => (a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : a[2]! < b[2]! ? -1 : a[2]! > b[2]! ? 1 : 0))
  const lock = [['release', repository, 'offline', commit], ...pools, ...packages]
  writeFileSync(join(out, 'oci/oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n')
  writeFileSync(join(out, 'oci/index.json'), dumps({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: index }, ', ', ': '))
  const text = '# mica-lock v1\n' + lock.map(r => r.join('\t') + '\n').join('')
  writeFileSync(join(out, `${repository}.lock`), text)
  writeFileSync(join(out, 'SHA256SUMS'), `${sha256(text)}  ${repository}.lock\n`)

  // The pin: a new offline build replaces every input of the repository, scoped or not.
  mkdirSync(join(REPO_ROOT, 'locks/pins'), { recursive: true })
  const sums = sha256(readFileSync(join(out, 'SHA256SUMS')))
  for (const f of readdirSync(join(REPO_ROOT, 'locks'))) if (f === `${repository}.lock` || (f.startsWith(`${repository}.`) && f.endsWith('.lock'))) rmSync(join(REPO_ROOT, 'locks', f))
  for (const f of readdirSync(join(REPO_ROOT, 'locks/pins'))) if (f === `${repository}.pin` || (f.startsWith(`${repository}.`) && f.endsWith('.pin'))) rmSync(join(REPO_ROOT, 'locks/pins', f))
  for (const f of readdirSync(out).filter(n => n.endsWith('.lock'))) {
    const name = f.slice(0, -'.lock'.length)
    writeFileSync(join(REPO_ROOT, 'locks', f), readFileSync(join(out, f)))
    const scope = name === repository ? '' : `SCOPE=${name.slice(repository.length + 1)}\n`
    writeFileSync(join(REPO_ROOT, 'locks/pins', `${name}.pin`), `# mica-pin v1\nREPOSITORY=${repository}\n${scope}RELEASE=offline\nSHA256SUMS=${sums}\nCHECKOUT=${checkout}\n`)
  }
  inputs()
  const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'tools/pool.sh'), 'rows'], { stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new LocalPinsError('tools/pool.sh rows failed over the new pin (see above)')
  const n = new Set(rows('package').filter(row => row[0] === repository || row[0]!.startsWith(repository + '.')).map(row => row[1])).size
  return `local-pins: ${n} package(s) of ${repository} pinned offline at ${commit} from ${checkout}/_out/offline (local only; never a release input)`
}

export async function main(argv: string[]): Promise<number> {
  try {
    console.log(await localPins(argv[0] ?? '', argv[1] ?? ''))
    return 0
  }
  catch (e) {
    if (e instanceof LocalPinsError) { console.error(`local-pins: error: ${e.message}`); return 1 }
    if (e instanceof Error && (e.constructor.name === 'Exit' || e.constructor.name === 'Refused')) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
