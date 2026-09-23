// Publish one board's archives as its pool artifact: the release's board.
//
//   bun src/cli.ts pool-publish [--pool <dir>]
//
//   reads   <pool>/<arch>/pool/<package>_*.deb   (default pool: _out/debs) for every package
//           boards/boards.tsv lists for the board, at the board's architecture
//   writes  <registry>/<this repository>:pool.<board>.<arch>.<YYYYMMDD-HHMM>, one layer per archive
//           (application/vnd.mica.deb, titled with the archive's name and annotated with its producer's inputs
//           hash as mica.inputs, src/pool/package-inputs.ts), and only the manifest annotations
//           mica.source-repo and mica.arch; the pool and package rows of the release lock (LOCK_ROWS)
//
// A pool manifest carries nothing about the release, so a pool whose archives are the published ones (the
// version guard holds an unchanged version to its published bytes) is the published manifest under a new tag.
//
// The release is the tag <board>.<YYYYMMDD-HHMM> HEAD carries (MICA_RELEASE_TAG names it); an `all` archive
// the board lists is a layer of its pool. Refused: a checkout that is not a clean release, a listed package
// without exactly one archive, an archive not at its producer's declared version, archives from another
// repository. A tag that already exists must hold exactly the manifest this build pushes (its digest); the
// manifest and every blob are read back anonymously. The port of tools/deb/publish.sh (deleted 2026-09-22),
// message for message.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { controlFields, controlText } from './deb.ts'
import { hash as inputsHash } from './package-inputs.ts'
import { discover, producer as findProducer, version, REPO_ROOT } from './producers.ts'
import { LOCK_ROWS, Oci, poolAnnotations, registryLoad, registryToken, releaseLoad, repoName, type Layer } from './registry.ts'

export class PublishError extends Error {}

function boardsSh(...args: string[]): string {
  const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'tools/boards.sh'), ...args], { stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new PublishError(`error: tools/boards.sh ${args.join(' ')} failed (see above)`)
  return r.stdout.toString()
}

export async function publish(poolRoot = join(REPO_ROOT, '_out/debs')): Promise<string> {
  const reg = registryLoad()
  const repo = repoName()
  const token = registryToken(reg, true)
  const oci = new Oci(reg, token), anonymous = new Oci(reg, '')
  const release = releaseLoad()
  const board = release.board
  const arches = [boardsSh('arch', board).trim()]
  const all = discover()

  // The rows describe exactly what this run published.
  mkdirSync(LOCK_ROWS, { recursive: true })
  writeFileSync(join(LOCK_ROWS, 'pool.tsv'), ''); writeFileSync(join(LOCK_ROWS, 'package.tsv'), '')
  const poolRows: string[] = [], packageRows: string[] = []
  let published = 0, present = 0
  const artifact = oci.repo(repo)
  for (const a of arches) {
    const pool = join(poolRoot, a, 'pool')
    if (!existsSync(pool)) throw new PublishError(`error: ${pool} does not exist; build the pool first (make board-pool POOL_BOARD=${board})`)
    boardsSh('pool-has', board, pool)
    const packages = boardsSh('packages', board).split('\n').filter(l => l !== '')
    const debs = packages.map(p => readdirSync(pool).filter(f => f.startsWith(`${p}_`) && f.endsWith('.deb')).map(f => join(pool, f))).flat().sort()

    // Refusals first, so a run publishes all or nothing.
    const inputs = new Map<string, string>(), declared = new Map<string, string>()
    for (const line of boardsSh('producers', board).split('\n').filter(l => l !== '')) {
      const p = findProducer(line.split(' ')[0]!, all)
      const buildArch = p.arches.includes('all') ? 'all' : p.arches.includes(a) ? a : ''
      if (buildArch === '') continue
      const h = inputsHash(p, buildArch), v = version(p).version
      for (const pkg of p.packages) { inputs.set(pkg, h); declared.set(pkg, v) }
    }
    const layers: Layer[] = []
    for (const deb of debs) {
      const n = deb.slice(deb.lastIndexOf('/') + 1)
      const f = controlFields(await controlText(deb))
      const pkg = f.Package ?? '', v = f.Version ?? '', r = f['Mica-Source-Repo'] ?? ''
      if (!inputs.has(pkg)) throw new PublishError(`error: no producer of ${board} declares ${pkg}`)
      if (v !== declared.get(pkg)) throw new PublishError(`error: ${n} is versioned ${v}, and its producer declares ${declared.get(pkg)} (version.env). Rebuild the pool`)
      if (r !== repo) throw new PublishError(`error: ${n} says Mica-Source-Repo: ${r || '(none)'}, and this checkout is ${repo}. Only this repository's own archives are published under its artifacts`)
      layers.push({ file: deb, mediaType: 'application/vnd.mica.deb', title: n, inputs: inputs.get(pkg)! })
    }

    // The manifest is release-independent (poolAnnotations, layers in name order), so a pool whose archives did
    // not change is the same manifest and this release's tag lands on the published digest.
    const ref = oci.tag('pool', board, a, release.stamp)
    const line = await oci.publish(artifact, ref, 'application/vnd.mica.pool', poolAnnotations(repo, a), layers)
    const digest = line.slice(line.indexOf(' ') + 1)
    if (line.startsWith('pushed')) { published += debs.length; console.log(`pool-publish: ${debs.length} archive(s) pushed as ${reg.host}/${artifact}:${ref} (${digest})`) }
    else { present += debs.length; console.log(`pool-publish: ${reg.host}/${artifact}:${ref} already holds this pool (${digest})`) }

    // Public, always: a private package is a consumer's 401 later. Read back with no credential: the tag
    // resolves to this manifest, every blob to its bytes.
    await oci.requirePublic(artifact, ref)
    const back = await anonymous.manifestGet(artifact, ref)
    if (back.status !== 200 || `sha256:${createHash('sha256').update(back.body).digest('hex')}` !== digest) throw new PublishError(`error: ${reg.host}/${artifact}:${ref} does not read back anonymously as ${digest} (HTTP ${back.status})`)
    poolRows.push(`${a}\t${ref}\t${digest}\n`)
    for (const deb of debs) {
      const n = deb.slice(deb.lastIndexOf('/') + 1)
      const sha = createHash('sha256').update(readFileSync(deb)).digest('hex')
      const blob = await anonymous.blobGet(artifact, `sha256:${sha}`)
      if (blob.status !== 200) throw new PublishError(`error: reading ${n} back anonymously from ${reg.host}/${artifact} answered HTTP ${blob.status}; the registry does not serve what it accepted`)
      const got = createHash('sha256').update(blob.body).digest('hex')
      if (got !== sha) throw new PublishError(`error: the registry serves ${n} with sha256 ${got}, and the archive here is ${sha}`)
      const f = controlFields(await controlText(deb))
      packageRows.push(`${f.Package}\t${a}\t${f.Version}\t${sha}\n`)
    }
  }
  writeFileSync(join(LOCK_ROWS, 'pool.tsv'), poolRows.join(''))
  writeFileSync(join(LOCK_ROWS, 'package.tsv'), packageRows.join(''))
  return `pool-publish: ${published} archive(s) pushed, ${present} already present, all read back at their digests; ${reg.host}/${artifact}:pool.${board}.<arch>.${release.stamp}`
}

export async function main(argv: string[]): Promise<number> {
  try {
    let poolRoot = join(REPO_ROOT, '_out/debs')
    for (let i = 0; i < argv.length;) {
      if (argv[i] === '--pool') { poolRoot = argv[i + 1] ?? ''; if (poolRoot === '') throw new PublishError('error: --pool takes a directory'); i += 2 }
      else { throw new PublishError('usage: pool-publish [--pool <dir>]') }
    }
    console.log(await publish(poolRoot))
    return 0
  }
  catch (e) {
    if (e instanceof PublishError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['RegistryError', 'ProducersError', 'PackageInputsError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
