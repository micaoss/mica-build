// Compose a product's root: the squashfs + dm-verity root image the signed root component takes.
//
//   MICA_PRODUCT=<name> MICA_VERSION=<stamp> [MICA_ROOTFS_NO_CACHE=0|1] bun src/cli.ts compose
//
// THE PRODUCT IS THE ONE INPUT. products/<name>/product.env says which board, which profile, which features and
// components; src/product/product.ts reads and validates it against the fetched board bundle. The variables that
// used to decide these things -- MICA_BOARD, MICA_PROFILE, WITH_MICAD, WITH_CONTAINERS, MICA_ROOTFS_WITHOUT,
// MICA_ROOTFS_COMPONENTS, MICA_META_DIR -- are refused by name: an image is a product, declared before the build,
// not a combination of switches reconstructed after it.
//
// There is deliberately no ROOT_PASSWORD here. A Mica OS rootfs is a signed, byte-identical squashfs and the pack
// stage fails any build whose factory shadow carries a usable hash, so a baked Mica OS root password is
// unbuildable by design, not merely discouraged. Dev root access on Mica OS is the transient password set at
// runtime through micad (SetTransientRootPassword; cleared on the next boot by mica-shadow-reconcile) plus the
// serial console, whose root account stays locked until that password is set. See mica:docs/design/access.md
// section 4.1.
//
// Outputs (all under _out/products/<name>/build/). The first four are consumed by the image assembler:
//   rootfs-verity.img: squashfs-zstd with the verity hash tree appended, padded to a whole MiB
//   rootfs-verity.env: verity parameters, strict KEY=value
//   boot-cmdline-a.txt, boot-cmdline-b.txt: the kernel append line per slot
// The rest are records rather than assembler inputs:
//   rootfs-report.txt: package list + installed size
//   pkg-logs/: dpkg.log, alternatives.log and apt/, taken out of /var/log by the finalizer
//   factory-root.oci: the packed root as an OCI image archive; `docker load -i` it
//   factory-root.txt: what that archive is -- ref, platform, size, sha256
//   rootfs-stages.txt: the Dockerfiles as built, in order, each with its content hash. Written by the driver;
//     it records which files ran, not what the image is made of
//   rootfs-packages.txt: the local packages installed, with the version, architecture, archive sha256, source,
//     source repository and source commit of each, read out of the pool index. PLAN-036 section 4's durable
//     composition record, and the one that says what this image is made of
// rootfs/README.md, "Outputs", is the table version of this.
//
// HOW THE ROOT IS ASSEMBLED, and there is one answer. stages/compose/*.Dockerfile: the Base root of the pinned
// mica-system-base release (locks/mica-system-base.lock), one dpkg transaction adding the selected archives of
// the imported pool `make os-pool` fetches, and then the finalizer -- 90-pack.Dockerfile beside it, which closes
// the root, does the tree surgery, runs the assertions, builds the squashfs, appends the verity tree and writes
// both export surfaces. The composer INSTALLS; it never compiles: everything below either reads the pool
// `make os-pool` wrote or asks the resolver which packages this build's inputs select, and every refusal names
// the make target that produces what is missing.
//
// The port of rootfs/build.sh (deleted 2026-09-23), refusal for refusal and record for record: the product,
// the resolver, the public-meta validator, the pool rows, the lineage writer, the Base packages helper, the
// pool index, the image resolver, the source checkout and the mica-podman reader run in-process; the stages
// driver and the smoke run are the two commands of src/cli.ts they always were.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs, FromError, resolve as fromResolve } from '../locks/from.ts'
import { Exit, inputs, Refused } from '../locks/locks.ts'
import { checkout, SourceError } from '../locks/source.ts'
import { check as podmanPoolCheck, PodmanPoolError } from '../pool/podman-pool.ts'
import { index as poolIndex, PoolError, rows as poolRows } from '../pool/pool.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { product, ProductError, products, plainValue } from '../product/product.ts'
import { BasePackagesError, fetchRows, select } from './base-packages.ts'
import { create as lineageCreate } from './lineage.ts'
import { resolve, ResolveError } from './resolve.ts'
import { pyError } from './runtime/fsx.ts'
import { canonical } from './runtime/lineage.ts'
import { type Value } from './runtime/pyjson.ts'
import { PublicMetaError, validatePublicMeta } from './validate-public-meta.ts'

export class BuildError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

const CLI = join(REPO_ROOT, 'src/cli.ts')
const RETIRED = ['MICA_BOARD', 'MICA_PROFILE', 'WITH_MICAD', 'WITH_CONTAINERS', 'MICA_ROOTFS_WITHOUT', 'MICA_ROOTFS_COMPONENTS', 'MICA_META_DIR']

function fail(message: string, code = 1): never {
  throw new BuildError(`error: ${message}`, code)
}

const words = (s: string) => s.split(/[ \t\n]+/).filter(w => w !== '')

/**
 * The driver's cache switch. Cold reproducibility checks need a cache-independent route through the same stages
 * driver as an ordinary build; the driver implements --no-cache, and this opt-in only bridges the composer to it
 * and keeps normal developer builds cached by default.
 */
export function cacheArgs(value: string | undefined): string[] {
  if (value === undefined || value === '0') return []
  if (value === '1') return ['--no-cache']
  fail(`MICA_ROOTFS_NO_CACHE is '${value}'; it must be exactly 0 or 1`)
}

export type DriverInputs = {
  board: string, platform: string, dest: string, builder: string, fromArgs: string[], baseRootfsImage: string,
  arch: string, radios: string, profile: string, veritySalt: string, squashfsTime: string, squashfsCompression: string, product: string,
}

/**
 * What the driver is handed: the board, the platform, the context, the output directory, the two pinned base
 * images, the values the composition reads and the values the finalizer reads. The driver ENFORCES this list
 * rather than trusting it: an --arg no file declares is refused (src/image/stages.ts, unusedArgs), because docker
 * only warns about an unused --build-arg and a warning scrolls past in a build this size. VERITY_UUID is
 * deliberately absent: the pack formats with --no-superblock and the UUID lived in that superblock. No --without
 * either: the decline list reaches the image through the RESOLUTION, which names fewer packages.
 */
export function driverArgs(p: DriverInputs): string[] {
  return [
    '--board', p.board,
    '--platform', p.platform,
    '--context', REPO_ROOT,
    '--dest', p.dest,
    '--builder', p.builder,
    ...p.fromArgs,
    '--arg', `MICA_IMAGE_BASE_ROOTFS=${p.baseRootfsImage}`,
    '--arg', `MICA_ARCH=${p.arch}`,
    '--arg', `MICA_RADIOS=${p.radios}`,
    '--arg', `MICA_BOARD=${p.board}`,
    '--arg', `MICA_PROFILE=${p.profile}`,
    '--arg', `VERITY_SALT=${p.veritySalt}`,
    '--arg', `SQUASHFS_TIME=${p.squashfsTime}`,
    '--arg', `SQUASHFS_COMPRESSION=${p.squashfsCompression}`,
    '--arg', `SOURCE_DATE_EPOCH=${p.squashfsTime}`,
    '--source-date-epoch', p.squashfsTime,
    '--stages-dir', join(REPO_ROOT, 'stages/compose'),
    '--arg', `COMPOSE_DIR=_out/products/${p.product}/build/compose`,
  ]
}

/** The names of the `--arg` values the composer supplies (src/image/stages.test.ts pairs them with stages/compose). */
export function driverArgNames(): string[] {
  const args = driverArgs({ board: 'b', platform: 'p', dest: 'd', builder: 'x', fromArgs: [], baseRootfsImage: 'i', arch: 'a', radios: '', profile: 'dev', veritySalt: 's', squashfsTime: '0', squashfsCompression: 'zstd', product: 'n' })
  return args.flatMap((a, i) => (args[i - 1] === '--arg' ? [a.slice(0, a.indexOf('='))] : []))
}

/** The stages driver's command line: the cache switch first, then everything the composition decided. */
export function driverCommand(cache: string[], args: string[]): string[] {
  return ['build-rootfs', ...cache, ...args]
}

/** The value of `KEY=` in a generated KEY=value file, the last line winning, as the assembler reads it. */
function envGet(file: string, key: string): string {
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith(`${key}=`))
  return lines.length === 0 ? '' : lines.at(-1)!.slice(key.length + 1)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function say(line: string): void {
  console.log(line)
}

/** The buildx builder: BUILDX_BUILDER's when named, else `default` when it reaches the platform, else the mica-<arch> container builder. */
function chooseBuilder(named: string | undefined, arch: string, platform: string): string {
  if (named !== undefined && named !== '') {
    say(`note: using the builder BUILDX_BUILDER names (${named})`)
    return named
  }
  const inspect = Bun.spawnSync(['docker', 'buildx', 'inspect', 'default'], { stdout: 'pipe', stderr: 'pipe' })
  if (inspect.stdout.toString().includes(platform)) return 'default'
  const builder = `mica-${arch}`
  say(`note: the 'default' builder cannot reach ${platform} on this host; using the docker-container builder '${builder}', which bundles its own emulator, and passing the composition to the finalizer by OCI layout`)
  if (Bun.spawnSync(['docker', 'buildx', 'inspect', builder], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) {
    const created = Bun.spawnSync(['docker', 'buildx', 'create', '--name', builder, '--driver', 'docker-container'], { stdout: 'pipe', stderr: 'inherit' })
    if (created.exitCode !== 0) fail(`docker buildx create ${builder} failed (see above)`)
  }
  return builder
}

/** Run a src/cli.ts command with its output shown and kept, for the hint a failure earns. */
async function cliRun(args: string[], env: Record<string, string | undefined>): Promise<{ code: number, log: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } as Record<string, string> })
  const chunks: string[] = []
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk).toString())
      process.stdout.write(chunk)
    }
  }
  await Promise.all([pump(proc.stdout), pump(proc.stderr)])
  return { code: await proc.exited, log: chunks.join('') }
}

/** The Debian rows of the Base root for this architecture (upstream.tsv): the source rows of the Base source's
 * locks/upstream.lock that packages.tsv selects for a consumer other than upstream-<root>. */
export function baseRootRows(baseSource: string, arch: string): string[] {
  const consumers = new Map<string, string>()
  for (const line of readFileSync(join(baseSource, 'packages.tsv'), 'utf8').split('\n')) {
    if (line.startsWith('#') || line === '') continue
    const f = line.split('\t')
    consumers.set(f[0]!, f[1] ?? '')
  }
  const out: string[] = []
  for (const line of readFileSync(join(baseSource, 'locks/upstream.lock'), 'utf8').split('\n')) {
    const f = line.split('\t')
    if (f[0] !== 'source' || (f[2] !== arch && f[2] !== 'all') || !consumers.has(f[1]!)) continue
    const c = consumers.get(f[1]!)!
    if (!c.split(',').some(x => !x.startsWith('upstream-'))) continue
    out.push([f[1], f[3], f[2] === 'all' ? 'all' : arch, f[4], f[5], c].join('\t'))
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const PRESET_HEAD = [
  '# Keep tty1 idle for the boot logo. A disabled template remains startable;',
  '# logind reserves tty2 and starts its authenticated getty when Alt+F2 is pressed.',
  'disable getty@.service',
  '# No filesystem this image mounts is remote: fstab carries DATA, its binds',
  '# and tmpfs, and nothing is _netdev. 90-systemd.preset enables this target,',
  '# and its enablement link is one systemd postinst writes with no package and',
  '# no deb-systemd-helper record behind it -- so without a rule here it leaves',
  '# the image as an unexplained drop rather than as a decision.',
  'disable remote-fs.target',
]

/** The preset lines of rootfs/packages/presets.json: every unit a later-stage package's maintainer script would enable, disabled. */
export function presets(which: 'system' | 'user'): string[] {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'rootfs/packages/presets.json'), 'utf8')) as Record<string, Record<'system' | 'user', string[]>>
  return [...new Set(Object.values(doc).flatMap(p => p[which]))].sort().map(u => `disable ${u}`)
}

/** The composition, end to end, under the caller's environment. */
export async function compose(env: Record<string, string | undefined>): Promise<void> {
  for (const retired of RETIRED) {
    if (env[retired] !== undefined && env[retired] !== '')
      fail(`${retired} is set. It no longer selects anything: the product (MICA_PRODUCT=<name>, products/<name>/product.env) declares the board, the profile, the features, the components and the public manifest, and a switch beside it would be a second statement of one of them`)
  }
  const cache = cacheArgs(env['MICA_ROOTFS_NO_CACHE'])
  const productName = env['MICA_PRODUCT'] ?? ''
  if (productName === '') fail(`MICA_PRODUCT is not set. A root is composed for a product; the products are: ${products().map(p => `${p} `).join('')}`)
  // The product reader refuses by name -- an unknown product, an unfetched board, a feature the board lacks -- so
  // nothing is re-checked here.
  const p = product(productName)
  const board = p.board
  const layoutEnv = join(p.boardDir, 'board.env')
  // One composition per product: its root, record, inventory and build fact.
  const outDir = join(REPO_ROOT, '_out/products', productName, 'build')
  const profile = p.profile
  const factorySeeded = p.provisioning === '' ? 0 : 1
  say(`product: ${productName} -- board ${board}, profile ${profile}, features: ${p.features === '' ? '(none, the minimal image)' : p.features}${p.components === '' ? '' : `, components: ${p.components}`}`)

  // Every layout constant is read from the board's board.env, out of the fetched board bundle. The architecture
  // is a board fact and is deliberately not derived from the board name.
  const arch = plainValue(layoutEnv, 'MICA_ARCH')
  if (arch === '') fail(`${layoutEnv} sets no MICA_ARCH. The architecture is a board fact and is deliberately not derived from the board name -- two arm64 boards and one amd64 board share nothing in their names that says so, and a name-based guess would be a guess. Without it this build would choose a package pool and a docker platform for a board that has not said which it is`)
  const platform = `linux/${arch}`
  const sizeBudgetMb = p.sizeBudgetMb
  if (sizeBudgetMb === '') fail(`${layoutEnv} sets no BOARD_SIZE_BUDGET_MB. Without a budget the root can grow past its slot and the first sign would be an image that does not fit`)
  if (plainValue(layoutEnv, 'BOARD_CMDLINE_ARGS') === '') fail(`${layoutEnv} sets no BOARD_CMDLINE_ARGS. The kernel command line would carry no console= at all, so the board would boot with nowhere to print why it did not`)
  // FILE_MTIME is the touch(1) form (@epoch); mksquashfs wants bare seconds. One instant, two consumers: this
  // value is also the driver's --source-date-epoch, which buildkit stamps into the OCI export of the packed
  // root -- the squashfs and the OCI image are two encodings of one tree.
  const squashfsTime = plainValue(layoutEnv, 'FILE_MTIME').replace(/^@/, '')
  // How the root is squashed is the board's: its kernel is what reads it. zstd unless the board says xz, which the
  // boards sized for small flash do (mica:docs/plan/20260926-0930-mini-images-on-128-mb.md).
  const squashfsCompression = plainValue(layoutEnv, 'ROOTFS_COMPRESSION') || 'zstd'
  if (squashfsCompression !== 'zstd' && squashfsCompression !== 'xz') fail(`${layoutEnv} sets ROOTFS_COMPRESSION=${squashfsCompression}; it is zstd or xz`)
  const veritySalt = plainValue(layoutEnv, 'VERITY_SALT')

  mkdirSync(outDir, { recursive: true })

  // Validate the package pool before anything long starts.
  const poolDir = join(REPO_ROOT, '_out/debs', arch)
  const poolRefusal = (why: string): never => fail(`${why}\n       The rootfs composer installs from _out/debs/<arch>; it does not build a package.\n       Fetch the locked archives, build the rest and index both with: make os-pool`)
  if (!existsSync(poolDir)) poolRefusal(`${poolDir} does not exist, so there is no ${arch} package pool to compose from.`)
  for (const f of ['Packages', 'SHA256SUMS', 'manifest.txt']) {
    if (!existsSync(join(poolDir, f)) || statSync(join(poolDir, f)).size === 0)
      poolRefusal(`${poolDir}/${f} is missing or empty, so the pool carries no usable index. APT takes an empty Packages file without complaint, so this would install none of this repository's own packages and report success.`)
  }
  if (!existsSync(join(poolDir, 'pool'))) poolRefusal(`${poolDir}/pool does not exist, so the index beside it describes archives that are not there.`)
  const poolDebs = readdirSync(join(poolDir, 'pool')).filter(f => f.endsWith('.deb') && statSync(join(poolDir, 'pool', f)).isFile())
  if (poolDebs.length === 0) poolRefusal(`${poolDir}/pool holds no .deb at all.`)

  // STALE, sense 1: the index does not describe the archives beside it. pool index writes SHA256SUMS over exactly
  // the pool it indexed, so a mismatch means an archive was rebuilt or removed afterwards.
  const sums = readFileSync(join(poolDir, 'SHA256SUMS'), 'utf8').split('\n').filter(l => l !== '')
  const verifies = sums.every((l) => {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(l)
    return m !== null && existsSync(join(poolDir, m[2]!)) && sha256(join(poolDir, m[2]!)) === m[1]
  })
  if (!verifies) poolRefusal(`${poolDir}/SHA256SUMS does not verify against the archives beside it, so the index and the pool have come apart.`)
  if (sums.length !== poolDebs.length) poolRefusal(`${poolDir}/pool holds ${poolDebs.length} archive(s) and SHA256SUMS lists ${sums.length}. sha256sum -c only checks the listed ones, so an archive the index has never seen would be installable and unrecorded.`)
  // STALE, sense 2: an archive is newer than the index over it -- is there any archive the index has not seen.
  const manifestTime = statSync(join(poolDir, 'manifest.txt')).mtimeMs
  const newer = poolDebs.filter(f => statSync(join(poolDir, 'pool', f)).mtimeMs > manifestTime)
  if (newer.length > 0) poolRefusal(`these archives are newer than ${poolDir}/manifest.txt, so the pool was rebuilt without being re-indexed: ${newer.map(f => `${f} `).join('')}`)

  // STALE, sense 3. Every archive in the pool is a row of pool rows: a package row of locks/, at the locked
  // version and sha256, from the locked source repository, its source commit the release row of that lock -- or
  // one of this tree's own board packages at its declared version. Anything else is refused, naming the archive.
  // The rule is implemented ONCE, in src/rootfs/lineage.ts, which also writes the lineage record the release
  // gate re-verifies. MICA_POOL_UNLOCKED="<pkg> ..." waives the digest check for named IMPORTED packages -- the
  // local development loop; the waiver is announced here, recorded in the lineage record and in
  // rootfs-packages.txt, and src/image/release-manifest.ts refuses such an image in the candidate and stable
  // channels.
  const unlocked = words(env['MICA_POOL_UNLOCKED'] ?? '')
  if (unlocked.length > 0) {
    say(`note: MICA_POOL_UNLOCKED waives the lock digest check for:${unlocked.map(u => ` ${u}`).join('')}`)
    say('      this root is a development root; the release gate refuses it outside the development channel')
  }
  const lineageStage = join(outDir, 'source-lineage.json')
  const rowsPath = join(outDir, 'pool-rows.tsv')
  try { writeFileSync(rowsPath, (await poolRows(arch)).map(r => `${r.join('\t')}\n`).join('')) }
  catch (e) {
    if (!(e instanceof PoolError || e instanceof Exit || e instanceof Refused)) throw e
    console.error(e instanceof PoolError ? `pool: error: ${e.message}` : e.message)
    poolRefusal(`the package rows of locks/ for ${arch} could not be read (see above).`)
  }
  let lockedN = 0
  try {
    const record = await lineageCreate(REPO_ROOT, poolDir, arch, BigInt(squashfsTime), rowsPath, unlocked)
    writeFileSync(lineageStage, canonical(record as unknown as Value))
    lockedN = record.lock.length
  }
  catch (e) {
    if (!(e instanceof Error)) throw e
    console.error(`source lineage refused: ${pyError(e)}`)
    poolRefusal(`the ${arch} pool did not pass the two-class rule (see the refusal above).`)
  }
  say(`pool: ${poolDir}, ${poolDebs.length} archive(s), ${lockedN} imported by the lock${unlocked.length > 0 ? `, unlocked:${unlocked.map(u => ` ${u}`).join('')}` : ''}`)

  // --- the composition's inputs: the package pool, the resolution, the context ---
  const composeStage = join(outDir, 'compose')
  const packagesRecord = join(outDir, 'rootfs-packages.txt')
  rmSync(composeStage, { recursive: true, force: true })
  // Removed first: a record left by a previous build would describe the package set of an image this run did
  // not produce, and a run that dies before the record is written would leave it looking current.
  rmSync(packagesRecord, { force: true })

  // WHAT TO INSTALL. The resolver takes every input as an ARGUMENT and deliberately re-derives nothing.
  const resolved = await resolve({ board, boardDir: join(p.boardDir, 'manifests'), features: p.features, components: p.components })
  if (resolved.length === 0) fail('the resolver selected no package')

  // Every resolved package has to BE in the pool, refused here rather than inside the composition: APT would
  // report "unable to locate package", which names the package and not the producer that was never built.
  const manifestRows = readFileSync(join(poolDir, 'manifest.txt'), 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'))
  const poolNames = new Set(manifestRows.map(r => r[0]!))
  const missing = resolved.filter(n => !poolNames.has(n))
  if (missing.length > 0) {
    const lockNames = new Set(readFileSync(rowsPath, 'utf8').split('\n').filter(l => l !== '').map(l => l.split('\t')[0]!))
    fail(`the resolution names package(s) the ${arch} pool does not contain:${missing.map(m => ` ${m}`).join('')}\n${missing.map(m => (lockNames.has(m)
      ? `       ${m} is a package row of locks/: make os-pool fetches it`
      : `       ${m} is a package row of no lock, which the resolver should already have refused`)).join('\n')}`)
  }

  // Only the unchanged validated public set enters the composition: the product's meta/ (its public factory
  // manifest), and the GENERATED marker of the signing workspace when the keys are development-grade. Validated
  // before a byte of it is staged.
  validatePublicMeta(p.metaDir)
  const metaStage = join(composeStage, 'meta-public')
  mkdirSync(join(metaStage, 'usr/share/mica/meta/updates'), { recursive: true })
  writeFileSync(join(metaStage, 'usr/share/mica/meta/updates/manifest.json'), readFileSync(join(p.metaDir, 'updates/manifest.json')), { mode: 0o644 })
  // THE PRODUCT, in the root: what this image is, for the verifier to scope its register by and for anything on
  // the device that asks. Beside profile.conf, in the read-only root, because it describes the image.
  mkdirSync(join(metaStage, 'usr/lib/mica'), { recursive: true })
  writeFileSync(join(metaStage, 'usr/lib/mica/product.conf'), `PRODUCT=${productName}\nBOARD=${board}\nPROFILE=${profile}\nFEATURES="${p.features}"\nCOMPONENTS="${p.components}"\n`, { mode: 0o644 })
  const generated = join(env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta'), 'GENERATED')
  if (existsSync(generated) && statSync(generated).size > 0) writeFileSync(join(metaStage, 'usr/share/mica/meta/GENERATED'), readFileSync(generated), { mode: 0o644 })

  writeFileSync(join(composeStage, 'source-lineage.json'), readFileSync(lineageStage))
  writeFileSync(join(composeStage, 'packages.txt'), resolved.map(n => `${n}\n`).join(''))
  say(`compose: ${resolved.length} package(s) resolved for ${productName} (${board}/${profile})`)
  for (const n of resolved) say(`  ${n}`)

  // The builder is NAMED rather than inherited -- BUILDX_BUILDER wins, because a caller who names a builder has
  // made a decision. With nothing named, `default` is the docker driver on every docker installation, and it
  // reaches linux/<arch> exactly when the host has binfmt registered for it; otherwise the mica-<arch>
  // docker-container builder, whose buildkit image bundles the emulators. The driver hands one file's output to
  // the next by OCI layout on any builder that is not the docker driver (src/image/stages-cli.ts, chainMode).
  const builder = chooseBuilder(env['BUILDX_BUILDER'], arch, platform)

  // The pack tools image and the Base root, resolved out of locks/ before a long build starts rather than at the
  // FROM line that consumes them; the driver takes `--arg KEY=VALUE` where docker takes `--build-arg`.
  const records = inputs()
  const fromArgs = buildArgs(['MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim', 'MICA_IMAGE_BUILD_BASE=mica-build-env:base'], records).map(a => (a === '--build-arg' ? '--arg' : a))
  const baseRootfsImage = fromResolve(`mica-system-base:rootfs@${arch}`, records)
  checkout('mica-system-base')
  const baseSource = join(REPO_ROOT, '_out/src/mica-system-base')

  const args = driverArgs({ board, platform, dest: outDir, builder, fromArgs, baseRootfsImage, arch, radios: p.radios, profile, veritySalt, squashfsTime, squashfsCompression, product: productName })

  // THE TWO EXPORT DIRECTORIES, EMPTIED FIRST (PLAN-086 S2). `-o type=local` MERGES into its destination: both
  // of these are sets whose membership is the point -- boot/ is every boot input this root carried and debug/ is
  // one .build-id/<id>.debug per binary that was stripped -- so a file left behind by a previous build is a boot
  // blob no image was assembled from, or debug information for a binary this image does not ship.
  rmSync(join(outDir, 'boot'), { recursive: true, force: true })
  rmSync(join(outDir, 'debug'), { recursive: true, force: true })

  say(`rootfs: composing ${board} on ${baseRootfsImage}`)
  // The Debian rows of the Base root for this architecture, in the form the composition and the runtime selector
  // read; the packages pinned only for later stages (upstream-<root>) are never in the Base root.
  const upstream = baseRootRows(baseSource, arch)
  if (upstream.length === 0) fail(`${baseSource}/locks/upstream.lock and packages.tsv name no ${arch} row of the Base root, so it could not be checked`)
  writeFileSync(join(composeStage, 'upstream.tsv'), upstream.map(l => `${l}\n`).join(''))
  // The Debian packages mica-system-base pins for later stages that this selection needs, fetched and verified,
  // and the units their maintainer scripts would enable, preset disabled in every root (presets.json).
  say(await fetchRows(arch, records))
  say(await poolIndex(arch))
  const extra = select(arch, resolved, records)
  writeFileSync(join(composeStage, 'extra.tsv'), extra.map(l => `${l}\n`).join(''))

  // *** WHAT THIS DEVICE SAYS ON SOMEBODY ELSE'S NETWORK. *** resolved's compiled-in default for MulticastDNS is
  // `yes`; Debian's drop-in turning it off is dropped by this composition. The global makes the UNNAMED case fail
  // safe (an interface nobody anticipated is silent); the per-interface drop-in states what eth* already
  // resolves to, so the shipped behaviour is declared rather than inherited from networkd's default. A drop-in
  // beside 80-dhcp.network rather than an edit of it: that file is mica-system's. LLMNR IS LEFT ALONE: resolved
  // takes the MORE RESTRICTIVE of the global and per-link settings (measured on a booted guest), so a global `no`
  // would take eth0 with it -- a user's decision, not a composition's.
  writeFileSync(join(composeStage, 'resolved-mdns.conf'), '[Resolve]\nMulticastDNS=no\n', { mode: 0o644 })
  // Inert today (the global above binds) and kept on purpose: the only written record of what eth* resolved to,
  // load-bearing the moment somebody sets the global back to `yes`.
  writeFileSync(join(composeStage, 'network-mdns.conf'), '[Network]\nMulticastDNS=no\n', { mode: 0o644 })

  // *** WHO THIS IMAGE IS, WRITTEN BY THE THING THAT COMPOSES IT. *** /etc/issue and /usr/lib/os-release name the
  // product. MICA_VERSION is the release when this is a release build and the tree's stamp otherwise, the same
  // expression the signed components use, so the console and os-release cannot disagree with what was signed.
  const version = env['MICA_VERSION'] ?? ''
  if (version === '') fail('MICA_VERSION is not set. The composition writes the product identity into /etc/issue and /usr/lib/os-release, and an identity with an empty version is the defect this exists to repair. Both entry points supply one: src/product/build.ts passes the release name or the tree\'s version stamp, and make os-rootfs derives it the same way. Reaching this means the composer was invoked directly with an empty environment')
  writeFileSync(join(composeStage, 'issue'), `Mica OS ${version} (${productName}) \\n \\l\nBoard: ${board}  Profile: ${profile}\n`)
  writeFileSync(join(composeStage, 'os-release'), `NAME="Mica OS"\nID=mica\nPRETTY_NAME="Mica OS ${version} (${productName})"\nVERSION_ID="${version}"\nIMAGE_ID=${productName}\nIMAGE_VERSION="${version}"\n`)

  // THE ONE RULE HERE THAT IS NOT ABOUT AN UPSTREAM PACKAGE. presets.json is keyed by package; tty1 is a product
  // decision and has no package to be keyed by, so it is written here. IT CHANGES NO BEHAVIOUR: all four boards
  // are already tty1-idle, on cx3576 by its board package's preset and on the other three by an accident the
  // composer's unowned-link drop produces -- the day the composer keeps unowned enablement links, three boards
  // would get a login prompt on top of the boot logo, and this rule is what says the policy instead. 40 sorts
  // ahead of systemd's 90-systemd.preset, and the first rule matching a unit wins.
  writeFileSync(join(composeStage, 'system.preset'), [...PRESET_HEAD, ...presets('system')].map(l => `${l}\n`).join(''))
  writeFileSync(join(composeStage, 'user.preset'), presets('user').map(l => `${l}\n`).join(''))
  say(`compose: ${extra.length} upstream package(s) beyond the Base root: ${extra.map(l => `${l.split('\t')[0]} `).join('')}`)

  // TWO DOCKERFILES, not one build. The driver sequences the *.Dockerfile files in --stages-dir in numeric order,
  // handing each one's image to the next: 10-compose installs the resolved package set, and 90-pack closes and
  // packs what it produced. The driver decides only the order, the tags and which argument reaches which file.
  const run = await cliRun(driverCommand(cache, args), {})
  if (run.code !== 0) {
    if (/exec format error/i.test(run.log)) {
      console.error('')
      console.error(`hint: the builder '${builder}' could not execute ${platform}. On the default builder that means`)
      console.error(`      ${arch} emulation is not registered on this host (docker run --privileged --rm`)
      console.error(`      tonistiigi/binfmt --install ${arch}); on a docker-container builder, that a stage's`)
      console.error('      base was resolved at the wrong architecture -- mica:docs/design/build-harness.md section 5.1.')
    }
    throw new BuildError('', 1)
  }

  // THE COMPOSITION RECORD, the durable statement of what this image is made of (PLAN-036 section 4). Written
  // only after the build succeeded: a list of packages a failed build would have installed is a list of
  // intentions. EVERY COLUMN IS READ OUT OF THE POOL INDEX, which pool index generated by asking dpkg-deb about
  // each archive; the one column not in the index is the source, and every archive is imported, so it is the
  // lock. Deliberately NOT staged into the image: inside it would be a second copy of facts dpkg's own database
  // carries at the point the finalizer purges it.
  const record = [
    `# The local packages composed into the ${board} root, one per line.`,
    `# Read out of ${poolDir}/manifest.txt, which src/cli.ts pool index`,
    '# generated from the archives themselves; never from a list kept by hand.',
    '#',
    `#product\t${productName}`, `#board\t${board}`, `#profile\t${profile}`,
    `#features\t${p.features === '' ? '(none)' : p.features}`, `#components\t${p.components === '' ? '(none)' : p.components}`,
    `#factory-seeded\t${factorySeeded}`, `#pool\t_out/debs/${arch}, ${lockedN} imported by locks/`,
    `#unlocked\t${unlocked.length === 0 ? '(none)' : unlocked.join(' ')}`,
    '#package\tversion\tarchitecture\tsha256\tsource\tsource-repo\tsource-commit',
    ...resolved.flatMap(n => manifestRows.filter(r => r[0] === n).map(r => [r[0], r[1], r[2], r[4], 'lock', r[6], r[7]].join('\t'))),
  ]
  writeFileSync(packagesRecord, record.map(l => `${l}\n`).join(''))
  const recorded = record.filter(l => !l.startsWith('#')).length
  if (recorded !== resolved.length) fail(`${packagesRecord} records ${recorded} package(s) and ${resolved.length} were resolved and installed. The record is read out of the pool index by name, so a short one means a name the index does not carry -- and a composition record that silently omits a package is worse than none`)
  say('')
  say(`=== rootfs-packages.txt (${recorded} package(s)) ===`)
  process.stdout.write(readFileSync(packagesRecord))

  const verityEnv = join(outDir, 'rootfs-verity.env')
  const img = join(outDir, 'rootfs-verity.img')
  const report = join(outDir, 'rootfs-report.txt')
  const factoryRootOci = join(outDir, 'factory-root.oci')

  // The OCI export, asserted here as well as in the driver: this checks that a build which reported success left
  // one at all -- a chain built by something OTHER than the current driver dropping its output into the same
  // directory, where a stale or absent archive would be handed to the smoke runner as this build's root.
  if (!existsSync(factoryRootOci) || statSync(factoryRootOci).size === 0)
    fail(`${factoryRootOci} is missing or empty after a build that reported success.\n       the smoke run executes the self-built binaries inside this image; with no\n       image there is nothing to execute them in, and an image that ships them unexecuted\n       looks exactly like one whose smoke run passed.`)
  if (Bun.spawnSync(['tar', '-tf', factoryRootOci, 'index.json'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0)
    fail(`${factoryRootOci} has no index.json, so it is not an OCI image layout.\n       Whatever wrote it did not write what \`docker load\` reads.`)

  // Read the pack stage's output the same way the assembler does: by parsing KEY=value, never by sourcing.
  for (const key of ['VERITY_ROOT_HASH', 'VERITY_SALT', 'VERITY_DATA_BLOCKS', 'VERITY_HASH_START_BLOCK', 'VERITY_DATA_BLOCK_SIZE', 'VERITY_HASH_BLOCK_SIZE', 'VERITY_HASH_ALGO', 'VERITY_DATA_SECTORS', 'SQUASHFS_BYTES', 'IMAGE_BYTES'])
    if (envGet(verityEnv, key) === '') fail(`${key} missing from ${verityEnv}`)
  if (envGet(verityEnv, 'VERITY_SALT') !== veritySalt) fail('pack stage salt does not match the pinned VERITY_SALT')
  const imageBytes = envGet(verityEnv, 'IMAGE_BYTES')
  const imgBytes = statSync(img).size
  if (String(imgBytes) !== imageBytes || imgBytes % 4096 !== 0 || imgBytes === 0) fail(`${img} is ${imgBytes} bytes, not a non-zero 4096-byte multiple matching IMAGE_BYTES=${imageBytes}`)

  const totalLine = readFileSync(report, 'utf8').split('\n').find(l => l.startsWith('TOTAL_MB'))
  const totalMb = totalLine === undefined ? '' : (words(totalLine)[1] ?? '')
  if (totalMb === '') fail(`TOTAL_MB missing from ${report}`)
  if (Number(totalMb) > Number(sizeBudgetMb)) fail(`installed size ${totalMb} MB exceeds budget ${sizeBudgetMb} MB`)
  say(`installed size: ${totalMb} MB (budget ${sizeBudgetMb} MB)`)

  // The smoke run, and it is part of the build. A wrong-arch, missing-soname or version-skewed binary must fail
  // the build, so every self-built binary is executed inside the base rootfs before an image ships it: an image
  // that ships them unexecuted looks exactly like one whose smoke run passed. Here rather than in the callers
  // because two make targets, the CI deep lane and anyone running this directly would be four copies to keep in
  // step. No skip and no opt-out: a flag that turned this off would make "the build passed" mean two things.
  // When the daemon cannot execute the platform, the runner executes inside the builder named here -- the one
  // that just built the root -- and says which executor it used.
  say('')
  say('=== smoke: executing the self-built binaries inside the root just packed ===')
  // The engine's pins the register reads, out of the pinned mica-podman archive of this pool.
  say(await podmanPoolCheck())
  const smoke = Bun.spawnSync([process.execPath, CLI, 'smoke', '--product', productName, '--builder', builder], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, MICA_PRODUCT: productName } })
  if (smoke.exitCode !== 0) throw new BuildError('', smoke.exitCode)
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 0) fail('usage: MICA_PRODUCT=<name> MICA_VERSION=<stamp> bun src/cli.ts compose', 2)
    await compose(process.env)
    return 0
  }
  catch (e) {
    if (e instanceof BuildError) {
      if (e.message !== '') console.error(e.message)
      return e.code
    }
    // Each in-process module's refusal, worded as its own command line prints it.
    if (e instanceof PoolError) { console.error(`pool: error: ${e.message}`); return 1 }
    if (e instanceof SourceError) { console.error(`source: error: ${e.message}`); return 1 }
    if (e instanceof FromError) { console.error(`from: error: ${e.message}`); return 1 }
    if (e instanceof PublicMetaError) { console.error(e.message); return e.code }
    if (e instanceof ProductError || e instanceof ResolveError || e instanceof BasePackagesError || e instanceof PodmanPoolError || e instanceof Exit || e instanceof Refused) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
