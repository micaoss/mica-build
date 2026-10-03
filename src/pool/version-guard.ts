// The package-version guard: a board's freshly built pool against the board's latest published release.
// Read-only; run after `make board-pool`, in CI and
// in a board release's build.
//
//   bun src/cli.ts version-guard --board <board> [--release <scope>.<YYYYMMDD-HHMM>]
//
//   reads   _out/debs/<arch>/pool/, the archives boards/boards.tsv lists for the board; the latest release other
//           than --release that published the board's pool (registry latestLockWith): its mica-build.lock and
//           its pool manifest (anonymously)
//
// For every package of the board, against that release's package row:
//   the same version   its producer's inputs hash (the producer's mica-inputs through mica-build-tools) must equal the published layer's
//                      mica.inputs ("inputs of <package> changed without a version bump"), and the archive built
//                      here must be byte for byte the published one, downloaded at its digest; the release then
//                      publishes those same bytes, and an unchanged pool keeps its digest
//   a higher version   built and published (a bump)
//   a lower version    refused
//   not published      built and published
// A previous archive that is missing or does not match its row is refused, never silently rebuilt. With no
// previous release, or one from before these rules (pool layers without mica.inputs), there is nothing to
// compare and every archive is built. A board's releases are scoped, which mica-build-tools' `pool guard`
// does not read (its design 3.3), so the guard is this tree's, on the library: the version order, the archive
// reader and the inputs hash are mica-build-tools'.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { controlFields, controlText, vercmp } from '@mica/build-tools'
import { board as findBoard, packages as boardPackages, producersOf } from '../boards/boards.ts'
import { discover, inputsOf, REPO_ROOT } from './producers.ts'
import { latestLockWith, manifestDigest, Oci, registryLoad, repoName } from './registry.ts'

export class VersionGuardError extends Error {}

type Manifest = { layers?: { digest: string, annotations?: Record<string, string> }[] }

export async function versionGuard(board: string, release = '', poolRoot = join(REPO_ROOT, '_out/debs')): Promise<string[]> {
  const out: string[] = []
  const say = (l: string) => { out.push(l); console.log(l) }
  const arch = findBoard(board).arch
  const pool = join(poolRoot, arch, 'pool')
  if (!existsSync(pool)) throw new VersionGuardError(`error: ${pool} does not exist; run make board-pool first`)
  const reg = registryLoad(), repo = repoName(), artifact = new Oci(reg, '').repo(repo)
  const anonymous = new Oci(reg, '')
  const latest = await latestLockWith(reg, repo, 'pool', board, arch, release)
  if (latest === undefined) { say(`version-guard: ${board} has no published release carrying its pool; every archive is built`); return out }
  const previous = latest.label
  const lockRows = latest.lock.split('\n').map(l => l.split('\t'))
  const reference = lockRows.find(r => r[0] === 'pool' && r[1] === arch)?.[2] ?? ''
  if (reference === '') throw new VersionGuardError(`error: mica-build.lock of ${previous} has no ${arch} pool row`)
  const digest = reference.slice(reference.lastIndexOf('@') + 1)
  const m = await anonymous.manifestGet(artifact, digest)
  if (m.status !== 200 || manifestDigest(m.body) !== digest) throw new VersionGuardError(`error: the pool ${reference} of ${previous} does not read anonymously at its digest (HTTP ${m.status})`)
  const manifest = JSON.parse(new TextDecoder().decode(m.body)) as Manifest
  if (!(manifest.layers ?? []).every(l => /^[0-9a-f]{64}$/.test(l.annotations?.['mica.inputs'] ?? ''))) {
    say(`version-guard: ${previous} predates the package-version rules (its pool layers carry no mica.inputs); every archive is built`)
    return out
  }

  const all = discover()
  const inputs = new Map<string, string>()
  for (const p of producersOf(board, all)) {
    const h = inputsOf(p, p.arches.includes('all') ? 'all' : arch)
    for (const pkg of p.packages) inputs.set(pkg, h)
  }
  let same = 0, bumped = 0, added = 0
  for (const pkg of boardPackages(board)) {
    const debs = readdirSync(pool).filter(f => f.startsWith(`${pkg}_`) && f.endsWith('.deb'))
    if (debs.length !== 1) throw new VersionGuardError(`error: ${pool} holds ${debs.length} archives of ${pkg}; build the pool with make board-pool`)
    const deb = join(pool, debs[0]!)
    const version = controlFields(await controlText(deb)).Version ?? ''
    const row = lockRows.find(r => r[0] === 'package' && r[1] === pkg && r[2] === arch)
    if (row === undefined) { added += 1; say(`version-guard: ${pkg} ${version}: not in ${previous}; built`); continue }
    const published = row[3]!, sha = row[4]!
    const c = vercmp(version, published)
    if (c === 1) { bumped += 1; say(`version-guard: ${pkg} ${published} -> ${version}: bumped; built`); continue }
    if (c === -1) throw new VersionGuardError(`error: ${pkg} is ${version} here, lower than ${published} in ${previous}; a version never goes back`)
    const layer = (manifest.layers ?? []).find(l => l.digest === `sha256:${sha}`)
    if (layer === undefined) throw new VersionGuardError(`error: ${pkg} ${published} (sha256 ${sha}) of ${previous}'s lock is no layer of its pool ${reference}`)
    const title = layer.annotations?.['org.opencontainers.image.title'] ?? '', publishedInputs = layer.annotations?.['mica.inputs'] ?? ''
    if (title !== debs[0]) throw new VersionGuardError(`error: the published layer of ${pkg} ${published} is titled ${title}, and this build names it ${debs[0]}`)
    if (publishedInputs !== inputs.get(pkg)) throw new VersionGuardError(`error: inputs of ${pkg} changed without a version bump: ${published} was published by ${previous} with inputs ${publishedInputs}, and they are ${inputs.get(pkg)} here. Bump its Version and Source-Date-Epoch in its control templates`)
    const blob = await anonymous.blobGet(artifact, `sha256:${sha}`)
    if (blob.status !== 200) throw new VersionGuardError(`error: ${title} of ${previous} does not download anonymously at sha256:${sha} (HTTP ${blob.status})`)
    if (createHash('sha256').update(blob.body).digest('hex') !== sha) throw new VersionGuardError(`error: ${title} of ${previous} downloads with another sha256 than its lock row ${sha}`)
    const here = readFileSync(deb)
    if (Buffer.compare(here, blob.body) !== 0) throw new VersionGuardError(`error: ${pkg} ${version} built here is not the published archive of ${previous} (sha256 ${createHash('sha256').update(here).digest('hex')} here, ${sha} published) although its inputs are unchanged; its bytes moved (a toolchain or upstream change), so bump its version`)
    same += 1
    say(`version-guard: ${pkg} ${version}: unchanged since ${previous}, byte-identical to the published archive`)
  }
  say(`version-guard: ${board} ${arch} against ${previous}: ${same} unchanged, ${bumped} bumped, ${added} new`)
  return out
}

export async function main(argv: string[]): Promise<number> {
  const usage = 'usage: version-guard --board <board> [--release <scope>.<YYYYMMDD-HHMM>]'
  try {
    let board = '', release = ''
    for (let i = 0; i < argv.length;) {
      if (argv[i] === '--board') { board = argv[i + 1] ?? ''; i += 2 }
      else if (argv[i] === '--release') { release = argv[i + 1] ?? ''; i += 2 }
      else { throw new VersionGuardError(`version-guard: error: ${usage}`) }
    }
    if (board === '') throw new VersionGuardError(`version-guard: error: ${usage}`)
    await versionGuard(board, release)
    return 0
  }
  catch (e) {
    if (e instanceof VersionGuardError) { console.error(e.message.replace(/^error: /, 'version-guard: error: ')); return 1 }
    if (e instanceof Error && ['RegistryError', 'ProducersError', 'PackageInputsError', 'BoardsError', 'ComponentError', 'ToolError', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
