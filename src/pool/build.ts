// Build one producer's Debian packages for one architecture. Every producer is built by this driver and no
// other.
//
//   bun src/cli.ts pool-build --producer board@cx3576 --arch arm64
//   bun src/cli.ts pool-build --producer radio-wifi --arch all
//
//   -> _out/debs/<arch>/pool/<package>_<version>_<arch>.deb
//      (MICA_POOL_DIR=<dir> writes <dir>/<arch>/pool instead)
//
// Packaging runs at the target architecture through buildx; anything that is not packaging runs in the
// producer's PREPARE hook on the host. The packer image is the mica-build-env base image
// (locks/mica-build-env.lock), the packer stages/pool/pack.sh as the `packer` build context; the producer
// convention is tools/deb/README.md. The port of tools/deb/build.sh (deleted 2026-09-22), message for message.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'
import { discover, producer as findProducer, version, REPO_ROOT } from './producers.ts'

export class BuildError extends Error {}

const POOL_ROOT = process.env.MICA_POOL_DIR || join(REPO_ROOT, '_out/debs')

function run(argv: string[], options: { env?: Record<string, string>, inherit?: boolean } = {}): { code: number, out: string } {
  const r = Bun.spawnSync(argv, { stdout: options.inherit ? 'inherit' : 'pipe', stderr: options.inherit ? 'inherit' : 'pipe', stdin: 'ignore',
    env: options.env ? { ...process.env as Record<string, string>, ...options.env } : undefined })
  return { code: r.exitCode, out: options.inherit ? '' : (r.stdout?.toString() ?? '') + (r.stderr?.toString() ?? '') }
}

/** amd64 or arm64: what this host packs `all` archives on. */
export function hostArch(): string {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  throw new BuildError(`error: ${process.arch} is not an architecture the build-env images carry (amd64, arm64), so there is no container to pack in`)
}

/** The repository this checkout is, written as Mica-Source-Repo: MICA_SOURCE_REPO, else the basename of origin. */
export function sourceRepo(root = REPO_ROOT): string {
  let name = process.env.MICA_SOURCE_REPO ?? ''
  if (name === '') {
    const r = run(['git', '-C', root, 'remote', 'get-url', 'origin'])
    const url = r.code === 0 ? r.out.trim() : ''
    name = url.replace(/\/$/, '').replace(/^.*\//, '').replace(/^.*:/, '').replace(/\.git$/, '')
    if (url === '' || name === '') throw new BuildError(`error: ${root} has no 'origin' remote, so the archive's Mica-Source-Repo cannot be derived. Set MICA_SOURCE_REPO=<repository name> to say which repository this checkout is`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new BuildError(`error: the source repository name '${name}' (from ${process.env.MICA_SOURCE_REPO ? 'MICA_SOURCE_REPO' : 'origin'}) is not a plain repository name`)
  return name
}

/** The archives written, one path per package per pool. */
export function build(producerName: string, arch: string): string[] {
  if (run(['docker', '--version']).code !== 0) throw new BuildError('error: docker is required and not on PATH. The packaging runs in a container -- the host carries no dpkg -- which is what makes the packer a value locks/mica-build-env.lock records')
  const p = findProducer(producerName, discover())
  const producerDir = join(REPO_ROOT, p.dir)
  // A matrix producer's instance (<producer>@<instance>): the hook and the Dockerfile are told which instance
  // they build (MICA_DEB_INSTANCE, MICA_DEB_INSTANCE_ENV); the instance's values were beneath producer.env
  // when the discovery read it.
  const instance = p.name.includes('@') ? p.name.slice(p.name.indexOf('@') + 1) : ''
  const instanceEnv = p.instance === '' ? '' : join(REPO_ROOT, p.instance)
  if (!p.arches.includes(arch)) throw new BuildError(`error: the producer '${p.name}' declares ARCHES='${p.arches.join(' ')}' and was asked for --arch ${arch}. That architecture is not one it builds; ${p.dir}/producer.env is where that list lives`)
  // The declared version and SOURCE_DATE_EPOCH (version.env beside the control templates): nothing about the
  // checkout -- its commit, its time, a dirty tree -- reaches the archive, so a version names one set of
  // bytes for good.
  const declared = version(p)
  const repo = sourceRepo()
  const host = hostArch()
  // An `all` archive has no ELF: built once at the host architecture and exported to both pools from that
  // one build.
  const debArch = arch === 'all' ? 'all' : arch
  const platform = arch === 'all' ? host : arch
  const poolArches = arch === 'all' ? ['amd64', 'arm64'] : [arch]
  const words = (key: string) => (p.env[key] ?? '').split(/\s+/).filter(w => w !== '')

  // A small staging directory under the worktree, visible to the docker daemon.
  const stage = join(REPO_ROOT, 'tmp', `deb-${p.name}-${arch}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  // The PREPARE hook: runs on the host; what it leaves in ${MICA_DEB_STAGE} is the `bin` context.
  const prepare = p.env.PREPARE ?? ''
  if (prepare !== '') {
    // A file name beside producer.env, never a path.
    if (prepare.includes('/')) throw new BuildError(`error: ${p.dir}/producer.env names PREPARE=${prepare}, which is a path. A hook is a file name beside the producer.env that declares it`)
    const hook = join(producerDir, prepare)
    if (!existsSync(hook)) throw new BuildError(`error: ${p.dir}/producer.env names PREPARE=${prepare} and ${p.dir}/${prepare} does not exist. The hook is the producer's own half of its build; a named one that is absent means the payload is never produced and the pack below would stage nothing`)
    console.log(`pool-build: ${p.name} running PREPARE hook ${p.dir}/${prepare} for ${arch}`)
    const r = run(['bash', hook], { inherit: true, env: { MICA_DEB_REPO_ROOT: REPO_ROOT, MICA_DEB_PRODUCER: p.name, MICA_DEB_PRODUCER_DIR: producerDir, MICA_DEB_INSTANCE: instance,
      MICA_DEB_INSTANCE_ENV: instanceEnv, MICA_DEB_ARCH: arch, MICA_DEB_STAGE: stage, MICA_DEB_VERSION: declared.version, SOURCE_DATE_EPOCH: declared.epoch } })
    if (r.code !== 0) throw new BuildError(`error: the PREPARE hook ${p.dir}/${prepare} exited ${r.code} (see above)`)
    if (readdirSync(stage).length === 0) throw new BuildError(`error: the PREPARE hook ${p.dir}/${prepare} reported success and left ${stage} empty. That directory is the 'bin' build context this producer's Dockerfile copies from`)
  }

  // Builder: BUILDX_BUILDER if set, else `default` when it reaches the platform, else the `mica-<arch>`
  // docker-container builder. Never the ambient selection.
  let builder = process.env.BUILDX_BUILDER ?? ''
  if (builder !== '') { console.log(`note: using the builder BUILDX_BUILDER names (${builder})`) }
  else {
    const defaults = run(['docker', 'buildx', 'inspect', 'default']).out
    if (poolArches.length === 1 && defaults.includes(`linux/${platform}`)) { builder = 'default' }
    else {
      // The docker driver accepts one output, so an `all` producer needs a container builder.
      builder = `mica-${platform}`
      if (run(['docker', 'buildx', 'inspect', builder]).code !== 0 && run(['docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container']).code !== 0)
        throw new BuildError(`error: the buildx builder '${builder}' could not be created`)
    }
  }
  const inspect = run(['docker', 'buildx', 'inspect', builder]).out
  const driver = /^Driver:[ \t]*(.*)$/m.exec(inspect)?.[1]?.trim() ?? ''
  if (driver === '') throw new BuildError(`error: \`docker buildx inspect ${builder}\` names no driver: the builder does not exist or is not running (\`docker buildx ls\` lists what does)`)
  if (driver === 'docker' && !inspect.includes(`linux/${platform}`))
    throw new BuildError(`error: the buildx builder '${builder}' uses the docker driver and does not offer linux/${platform} on this host, so pack.sh would fail with 'exec format error'. Build on a ${platform} host (CI runs one job per architecture), or unset BUILDX_BUILDER and let this driver select the docker-container builder 'mica-${platform}'`)
  if (driver === 'docker' && poolArches.length > 1)
    throw new BuildError(`error: the buildx builder '${builder}' uses the docker driver, which accepts one --output per build, and the producer '${p.name}' is Architecture: all and writes ${poolArches.length} pools from one build. Unset BUILDX_BUILDER and let this driver select the docker-container builder`)

  // The packer image is always supplied (MICA_BUILD_BASE); FROM_IMAGES adds further bases as
  // <build-arg name>=mica-build-env:<image> or <build-arg name>=upstream:<name>.
  const fromEntries = ['MICA_BUILD_BASE=mica-build-env:base']
  for (const entry of words('FROM_IMAGES')) {
    if (entry.startsWith('MICA_BUILD_BASE=')) fromEntries[0] = entry
    else fromEntries.push(entry)
  }
  for (const entry of fromEntries) {
    const i = entry.indexOf('=')
    if (i <= 0 || i === entry.length - 1) throw new BuildError(`error: ${p.dir}/producer.env declares FROM_IMAGES entry '${entry}', which is not <build-arg name>=mica-build-env:<image> or <build-arg name>=upstream:<name>`)
  }
  const fromArgs = buildArgs(fromEntries, inputs())

  // pack.sh as the `packer` context, so edits apply without rebuilding the images.
  const ctxArgs = ['--build-context', `packer=${join(REPO_ROOT, 'stages/pool')}`]
  if (prepare !== '') ctxArgs.push('--build-context', `bin=${stage}`)
  for (const entry of words('BUILD_CONTEXTS')) {
    const i = entry.indexOf('='), name = entry.slice(0, i), path = entry.slice(i + 1)
    if (i <= 0 || path === '') throw new BuildError(`error: ${p.dir}/producer.env declares BUILD_CONTEXTS entry '${entry}', which is not <context name>=<repository-relative path>`)
    if (!existsSync(join(REPO_ROOT, path)) || !readdirSafe(join(REPO_ROOT, path)))
      throw new BuildError(`error: ${p.dir}/producer.env declares the build context '${name}=${path}', which is not a directory under ${REPO_ROOT}. buildx would resolve a missing local context as a remote one and fail naming neither`)
    ctxArgs.push('--build-context', `${name}=${join(REPO_ROOT, path)}`)
  }

  const argArgs = ['--build-arg', `MICA_DEB_VERSION=${declared.version}`, '--build-arg', `MICA_DEB_ARCH=${debArch}`, '--build-arg', `SOURCE_DATE_EPOCH=${declared.epoch}`,
    '--build-arg', `MICA_DEB_SOURCE_REPO=${repo}`, '--build-arg', `MICA_DEB_INSTANCE=${instance}`]
  for (const entry of words('BUILD_ARGS')) {
    // KEY=VALUE only: a bare KEY would take its value from the caller's environment.
    if (!entry.includes('=')) throw new BuildError(`error: ${p.dir}/producer.env declares BUILD_ARGS entry '${entry}', which is not KEY=VALUE`)
    argArgs.push('--build-arg', entry)
  }

  // The pool is shared: remove only this producer's previous archives.
  const outArgs: string[] = []
  for (const poolArch of poolArches) {
    const pool = join(POOL_ROOT, poolArch, 'pool')
    mkdirSync(pool, { recursive: true })
    for (const f of readdirSync(pool)) for (const pkg of p.packages) if (f.startsWith(`${pkg}_`) && f.endsWith('.deb')) rmSync(join(pool, f))
    outArgs.push('-o', `type=local,dest=${pool}`)
  }

  console.log(`pool-build: packing ${p.packages.join(' ')} ${declared.version} as ${debArch} from ${repo} at SOURCE_DATE_EPOCH ${declared.epoch} on builder '${builder}' (${driver}) into ${poolArches.join(' ')}`)
  const b = run(['docker', 'buildx', 'build', '--builder', builder, '--platform', `linux/${platform}`, ...fromArgs, ...ctxArgs, ...argArgs, '-f', join(producerDir, 'Dockerfile'), ...outArgs, producerDir], { inherit: true })
  if (b.code !== 0) throw new BuildError(`error: docker buildx build of ${p.name} for ${arch} exited ${b.code} (see above)`)

  const exported: string[] = []
  for (const poolArch of poolArches) for (const pkg of p.packages) exported.push(join(POOL_ROOT, poolArch, 'pool', `${pkg}_${declared.version}_${debArch}.deb`))
  // The archives are already exported, so a refusal withdraws this run's whole output from the pool rather
  // than leaving it for the index.
  const reject = (why: string): never => {
    for (const f of exported) rmSync(f, { force: true })
    throw new BuildError(`error: ${why} -- and the ${exported.length} archive(s) this run exported have been removed from the pool, because a package this driver refused must not be left where the index would list it. There is now no archive for ${p.packages.join(' ')}; rebuild once the cause is fixed`)
  }
  const missing = exported.filter(f => !existsSync(f)).map(f => f.slice(POOL_ROOT.length + 1))
  if (missing.length > 0) reject(`the export is missing: ${missing.join(' ')}`)
  // Both exports of an `all` build must be the same bytes.
  if (poolArches.length > 1) {
    for (const pkg of p.packages) {
      for (const poolArch of poolArches.slice(1)) {
        const a = join(POOL_ROOT, poolArches[0]!, 'pool', `${pkg}_${declared.version}_${debArch}.deb`), b2 = join(POOL_ROOT, poolArch, 'pool', `${pkg}_${declared.version}_${debArch}.deb`)
        if (Buffer.compare(readFileSync(a), readFileSync(b2)) !== 0) reject(`${pkg} was exported to the ${poolArches[0]} and ${poolArch} pools from ONE build and the two archives differ. An Architecture: all package is one archive that is a member of every pool`)
      }
    }
  }
  // ENABLEMENT is checked by the package gate over the whole pool, not here.
  rmSync(stage, { recursive: true, force: true })
  return exported
}

function readdirSafe(path: string): boolean {
  try { readdirSync(path); return true }
  catch { return false }
}

export async function main(argv: string[]): Promise<number> {
  try {
    let producer = '', arch = ''
    for (let i = 0; i < argv.length;) {
      if (argv[i] === '--producer') { producer = argv[i + 1] ?? ''; if (producer === '') throw new BuildError('error: --producer takes a producer name'); i += 2 }
      else if (argv[i] === '--arch') { arch = argv[i + 1] ?? ''; if (arch === '') throw new BuildError('error: --arch takes amd64, arm64 or all'); i += 2 }
      else { throw new BuildError('usage: pool-build --producer <name> --arch <amd64|arm64|all>') }
    }
    if (producer === '') throw new BuildError('error: --producer is required; there is no default producer, because a build that picked one would package a subset nobody asked for')
    if (arch === '') throw new BuildError('error: --arch is required; guessing the host\'s would silently produce packages of the wrong architecture for a board')
    for (const f of build(producer, arch)) console.log(f)
    return 0
  }
  catch (e) {
    if (e instanceof BuildError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['ProducersError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
