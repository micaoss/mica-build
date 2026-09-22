// Build the rootfs assembly, one Dockerfile at a time.
//
//   bash bin/bun.sh src/cli.ts build-rootfs --board uefi-x64 --dest _out/uefi-x64 \
//        --platform linux/amd64 --arg KEY=VALUE ...
//   bash bin/bun.sh src/cli.ts build-rootfs --board uefi-x64 --plan   (decide, run nothing)
// rootfs/build.sh stages the build context -- it cross-builds micad,
// renders the overlay, checks the repart definitions against the layout and
// computes every verity parameter -- and then calls this instead of running one
// `docker buildx build` over one Dockerfile. This adds two things: it decides
// the order and the tags (src/stages.ts, a pure function with its own tests),
// and it refuses the two ways a chain fails that a single file cannot. The
// build arguments, platform, context and output directory arrive from the
// caller unchanged, because a driver that recomputed them would be a second
// answer to a question build.sh answers.

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildArgv,
  DEFAULT_OCI_TARGET,
  DEFAULT_TERMINAL_TARGET,
  discoverStages,
  ociExport,
  ociRecord,
  OCI_RECORD_NAME,
  planChain,
  selectStages,
  stageManifest,
  StageChainError,
  STAGES_DIR,
  type StageBuild,
  type StageFile,
} from './stages.ts'
import { REPO_ROOT } from './paths.ts'

/** Written beside the artifacts: which stages ran, in which order, at what content. */
export const MANIFEST_NAME = 'rootfs-stages.txt'

interface Options {
  board: string
  dest: string | undefined
  platform: string
  context: string
  builder: string | undefined
  stagesDir: string
  terminalTarget: string
  ociTarget: string
  sourceDateEpoch: string | undefined
  planOnly: boolean
  noCache: boolean
  without: string[]
  args: Record<string, string>
}

function usage(): string {
  return [
    'usage: bash bin/bun.sh src/cli.ts build-rootfs --board NAME [--dest DIR] [--plan]',
    '                            [--platform linux/ARCH] [--context DIR]',
    '                            [--builder NAME] [--arg KEY=VALUE]...',
    '',
    'Builds rootfs/compose/*.Dockerfile in numeric order, each FROM the local',
    'image tag the previous one was written to. The last stage exports its',
    `\`${DEFAULT_TERMINAL_TARGET}\` target into --dest, and then its`,
    `\`${DEFAULT_OCI_TARGET}\` target as an OCI archive beside it -- the packed`,
    'root as an image, which is what the smoke runner executes the',
    'self-built binaries inside.',
    '',
    '  --board NAME     names the tags, so two boards can be in flight at once',
    '  --dest DIR       where the terminal stage exports. Required unless --plan',
    '  --platform P     linux/amd64, linux/arm64. Default: the host architecture',
    '  --context DIR    the docker build context. Default: the repository root',
    '  --builder NAME   buildx builder. Default: whichever is current. Its driver decides',
    '                   how stages chain: by tag on the docker driver, by OCI layout',
    '                   under <dest>/stages on any other (see chainMode)',
    '  --arg KEY=VALUE  a build argument, repeatable. Each is passed only to the',
    '                   stages that DECLARE it; one no stage declares is refused',
    '  --without NAME   leave out the <number>-feature-NAME stage, repeatable.',
    '                   This is the stage selection, and it replaced the',
    '                   WITH_* build args: a declined feature is a stage that is',
    '                   not built, not an argument every RUN inside it has to',
    '                   test. A NAME that matches no feature stage is refused --',
    '                   silently building the full image is the failure',
    '  --source-date-epoch N  seconds since the epoch, stamped into the OCI',
    '                   export so it reproduces. Required unless --plan: buildkit',
    '                   reads this from the ENVIRONMENT, so an absent value is',
    '                   not an error, it is the wall clock in every layer entry',
    '  --oci-target T   the terminal stage target exported as an OCI image.',
    `                   Default: ${DEFAULT_OCI_TARGET}`,
    '  --plan           print the chain and the exact command lines, run nothing',
    '  --no-cache       build every stage from scratch. For the determinism gate:',
    '                   a chain replayed out of cache is not a cold build. It does',
    '                   NOT reach the OCI export, which must replay the cache the',
    '                   chain just filled or it would export a second, different root',
  ].join('\n')
}

function hostPlatform(): string {
  return process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64'
}

export function parseArgs(argv: readonly string[]): Options {
  const o: Options = {
    board: '',
    dest: undefined,
    platform: hostPlatform(),
    context: REPO_ROOT,
    builder: undefined,
    stagesDir: STAGES_DIR,
    terminalTarget: DEFAULT_TERMINAL_TARGET,
    ociTarget: DEFAULT_OCI_TARGET,
    sourceDateEpoch: undefined,
    planOnly: false,
    noCache: false,
    without: [],
    args: {},
  }
  // An option whose value is the NEXT FLAG is the mistake that silently
  // verifies something nobody asked for -- `--board --plan` would take
  // '--plan' as a board name and then not plan. Refused for every option that
  // takes a value, the way parity-cli refuses it for --board.
  const value = (flag: string, next: string | undefined): string => {
    if (next === undefined || next.startsWith('--')) {
      throw new Error(
        `${flag} needs a value and the next argument is ${next === undefined ? 'nothing' : `'${next}'`}. Taken as the value it would name something nobody asked for`,
      )
    }
    return next
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') {
      console.log(usage())
      process.exit(0)
    }
    switch (a) {
      case '--board':
        o.board = value(a, argv[++i])
        break
      case '--dest':
        o.dest = value(a, argv[++i])
        break
      case '--platform':
        o.platform = value(a, argv[++i])
        break
      case '--context':
        o.context = value(a, argv[++i])
        break
      case '--builder':
        o.builder = value(a, argv[++i])
        break
      case '--stages-dir':
        o.stagesDir = value(a, argv[++i])
        break
      case '--target':
        o.terminalTarget = value(a, argv[++i])
        break
      case '--oci-target':
        o.ociTarget = value(a, argv[++i])
        break
      case '--source-date-epoch':
        o.sourceDateEpoch = value(a, argv[++i])
        break
      case '--plan':
        o.planOnly = true
        break
      case '--no-cache':
        o.noCache = true
        break
      case '--without':
        o.without.push(value(a, argv[++i]))
        break
      case '--arg': {
        const kv = value(a, argv[++i])
        const eq = kv.indexOf('=')
        if (eq <= 0) {
          throw new Error(
            `--arg ${kv} is not KEY=VALUE. An argument with no '=' would be passed to docker as a name whose value comes from the environment, which is not what any caller here means`,
          )
        }
        o.args[kv.slice(0, eq)] = kv.slice(eq + 1)
        break
      }
      default:
        throw new Error(`unknown option ${a}\n\n${usage()}`)
    }
  }
  if (!o.board) throw new Error(`--board is required.\n\n${usage()}`)
  if (!o.planOnly && !o.dest) {
    throw new Error(
      `--dest is required: the terminal stage has to export somewhere. Use --plan to decide the chain without building it.\n\n${usage()}`,
    )
  }
  // Refused here rather than defaulted, and that is the whole point of the
  // option. buildkit takes SOURCE_DATE_EPOCH from the environment; unset, it
  // does not complain, it stamps the wall clock into the image config and into
  // every entry of the exported layer. So an export with no epoch is not a
  // failure anyone sees -- it is an artifact that differs on every run, whose
  // first symptom is a determinism gate that has nothing to compare.
  if (!o.planOnly && o.sourceDateEpoch === undefined) {
    throw new Error(
      `--source-date-epoch is required: without it the OCI export of the factory root stamps the wall clock into its config and its layer, and no two builds of one tree agree. rootfs/build.sh passes the board's FILE_MTIME, which is the same instant the squashfs is pinned to.\n\n${usage()}`,
    )
  }
  return o
}

/**
 * The docker CLI to run, by this package's convention.
 *
 * src/toolbox.ts reads the same variable for the same reason: on the pinned-bun
 * route the host's client is bind-mounted at its own path and named in
 * MICA_BUILD_DOCKER, and a bare `docker` there is a different question ("is
 * /usr/bin on this image's PATH?") from the one the caller asked.
 */
export function dockerBin(): string {
  return process.env.MICA_BUILD_DOCKER || 'docker'
}

/**
 * The buildx driver behind a builder name, or undefined if it cannot be read.
 *
 * `docker buildx inspect` prints `Driver: docker` / `Driver: docker-container`
 * as its second field. Parsed rather than assumed because the answer decides
 * whether this chain can be built at all.
 */
export function parseDriver(inspectOutput: string): string | undefined {
  for (const line of inspectOutput.split('\n')) {
    const m = /^Driver:\s*(\S+)/.exec(line.trim())
    if (m) return m[1]
  }
  return undefined
}

/** How the chain is linked, decided by the builder's driver. */
export type ChainMode = 'tags' | 'layouts'

/**
 * Which way this driver can chain, or undefined when the driver is unknown.
 *
 * Measured, not read. On this host a docker-container builder handed a tag
 * that is in the local image store answered
 *
 *   ERROR: failed to solve: mica-probe:a: failed to resolve source metadata for
 *   docker.io/library/mica-probe:a: pull access denied, repository does not
 *   exist or may require authorization
 *
 * -- a message about Docker Hub, for an image that is right there -- while
 * the same two files on the default `docker` driver chain fine. Only the
 * `docker` driver reads the daemon's image store, so only it chains by tag.
 * Every other driver has a content store of its own, and those take an OCI
 * layout as a named build context: handed the previous stage that way, the
 * same docker-container builder chained two arm64 stages on a host with no
 * binfmt (2026-08-30). That is layout mode, and it is what lets
 * rootfs/build.sh use the emulator buildkit bundles instead of one the
 * host has to register.
 */
export function chainMode(driver: string | undefined): ChainMode | undefined {
  if (driver === undefined) return undefined
  return driver === 'docker' ? 'tags' : 'layouts'
}

/** Where layout mode keeps the stage layouts: beside the artifacts, per board. */
export const LAYOUT_DIR_NAME = 'stages'

function refuseUnreadable(builder: string | undefined, detail: string): string {
  return [
    `error: cannot read which driver the buildx builder ${builder ? `'${builder}'` : '(current)'} uses.`,
    `       ${detail}`,
    '       The driver decides how the chain is linked -- by tag in the image store on the',
    '       `docker` driver, by OCI layout on any other -- so this is decided before the first',
    '       stage rather than discovered mid-build.',
    '       If this is the pinned-bun container route: that image carries the docker CLI, the',
    '       daemon socket and -- since PLAN-080 backlog B5 -- the buildx plugin copied out of the',
    '       same pinned client image, so an absent buildx is no longer the expected answer here.',
    '       run.sh asserts `docker buildx version` in that image before this code runs, so if it',
    '       is missing, the image predates that COPY: remove localhost/mica-verify-bun:* and re-run.',
  ].join('\n')
}

async function run(
  argv: string[],
  label: string,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  const proc = Bun.spawn(argv, {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
    env: { ...process.env, ...env },
  })
  const code = await proc.exited
  if (code !== 0)
    throw new Error(`${label} exited ${code}`)
}

/**
 * What `docker buildx inspect` answered, in three cases rather than two.
 *
 * "The driver is not `docker`" and "`docker buildx` could not be run at all"
 * are different problems with different fixes, and collapsing them cost a
 * measurement: on the pinned-bun route this reported the driver as `unknown`,
 * which reads as a builder misconfiguration and is not one.
 */
type DriverProbe
  = | { readonly kind: 'driver', readonly name: string }
    | { readonly kind: 'unreadable', readonly detail: string }

async function inspectDriver(builder: string | undefined): Promise<DriverProbe> {
  const argv = [dockerBin(), 'buildx', 'inspect']
  if (builder) argv.push(builder)
  let out: string
  let err: string
  let code: number
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    ;[out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
  }
  catch (e) {
    return { kind: 'unreadable', detail: `${argv[0]} could not be started: ${String(e)}` }
  }
  const name = parseDriver(out)
  if (name) return { kind: 'driver', name }
  return {
    kind: 'unreadable',
    detail: `\`${argv.join(' ')}\` exited ${code} and printed no 'Driver:' line${err.trim() ? `: ${err.trim().split('\n')[0]}` : ''}`,
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let opts: Options
  try {
    opts = parseArgs(argv)
  }
  catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 1
  }

  const all = discoverStages(opts.stagesDir)
  let stages: StageFile[]
  let builds: StageBuild[]
  try {
    stages = selectStages(all, opts.without)
    builds = planChain(stages, {
      board: opts.board,
      supplied: opts.args,
      terminalTarget: opts.terminalTarget,
      ociTarget: opts.ociTarget,
    })
  }
  catch (e) {
    if (e instanceof StageChainError) {
      console.error(`error: ${opts.stagesDir} cannot be built in sequence:`)
      for (const f of e.faults) console.error(`  ${f.path}\n    ${f.message}`)
      return 1
    }
    throw e
  }

  if (opts.without.length > 0) {
    // Said out loud, every run, because a stage that is not built leaves no
    // trace in the image to distinguish it from a stage that did nothing.
    console.log(
      `rootfs: leaving out ${opts.without.map(w => `${w} (feature)`).join(', ')} -- `
      + `${all.length - stages.length} of ${all.length} stage(s) declined`,
    )
  }
  const lines = builds.map(
    (b, i) =>
      `  ${String(i + 1).padStart(2)}. ${b.name.padEnd(16)} ${b.terminal ? `-> ${opts.dest ?? '(no --dest)'}` : `-> ${b.tag}`}`,
  )
  console.log(`rootfs: ${builds.length} stages for ${opts.board} (${opts.platform})`)
  console.log(lines.join('\n'))

  // The mode comes from the builder's driver, for the plan as well as the
  // build: a plan that printed tag-mode commands for a builder that will chain
  // by layout would describe a build that cannot happen.
  const probe = await inspectDriver(opts.builder)
  if (probe.kind === 'unreadable') {
    console.error(refuseUnreadable(opts.builder, probe.detail))
    return 1
  }
  const mode = chainMode(probe.name)!
  const layoutDir = mode === 'layouts' ? join(opts.dest ?? '<dest>', LAYOUT_DIR_NAME) : undefined
  console.log(
    mode === 'tags'
      ? `rootfs: tag mode on builder ${opts.builder ?? '(current)'} (${probe.name} driver): each stage is a tag in the image store`
      : `rootfs: layout mode on builder ${opts.builder ?? '(current)'} (${probe.name} driver): each stage is an OCI layout under ${layoutDir}`,
  )

  if (opts.planOnly) {
    for (const b of builds) {
      console.log(
        `\n# ${b.name}\ndocker ${buildArgv(b, {
          context: opts.context,
          platform: opts.platform,
          builder: opts.builder,
          dest: opts.dest ?? '<dest>',
          terminalTarget: opts.terminalTarget,
          noCache: opts.noCache,
          layoutDir,
        }).join(' ')}`,
      )
    }
    // The OCI export is planned too, and with the same placeholders the stage
    // lines use. A --plan that stopped at the chain would describe a build
    // shorter than the one --plan exists to describe.
    const oci = ociExport(builds[builds.length - 1]!, {
      context: opts.context,
      platform: opts.platform,
      board: opts.board,
      builder: opts.builder,
      dest: opts.dest ?? '<dest>',
      sourceDateEpoch: opts.sourceDateEpoch ?? '0',
      ociTarget: opts.ociTarget,
      layoutDir,
    })
    console.log(
      `\n# ${builds[builds.length - 1]!.name} -- the factory root as an OCI image`
      + `\nSOURCE_DATE_EPOCH=${opts.sourceDateEpoch ?? '<source-date-epoch>'}`
      + ` docker ${oci.argv.join(' ')}`,
    )
    return 0
  }

  if (!existsSync(opts.context)) {
    console.error(
      `error: the build context ${opts.context} does not exist. Every stage is built against it and docker would report the miss once per stage`,
    )
    return 1
  }

  // Layout mode starts from an empty directory: a layout left by an earlier
  // run of a stage this run does not rebuild would otherwise be chained as if
  // it were this run's, with nothing to say so.
  if (layoutDir) {
    rmSync(layoutDir, { recursive: true, force: true })
    mkdirSync(layoutDir, { recursive: true })
  }

  for (const b of builds) {
    console.log(`\n=== rootfs stage ${b.name} ===`)
    await run(
      [
        dockerBin(),
        ...buildArgv(b, {
          context: opts.context,
          platform: opts.platform,
          builder: opts.builder,
          dest: opts.dest,
          terminalTarget: opts.terminalTarget,
          noCache: opts.noCache,
          layoutDir,
        }),
      ],
      `stage ${b.name}`,
    )
  }

  // The terminal stage a second time, for its other export surface. After the
  // loop rather than inside it because it is not a link in the chain: nothing
  // starts FROM it, and if it failed the chain would still have produced every
  // artifact the assembler needs. What would be missing is the ability to run
  // anything, which is why it is a failure here and not a warning.
  const terminal = builds[builds.length - 1]!
  const oci = ociExport(terminal, {
    context: opts.context,
    platform: opts.platform,
    board: opts.board,
    builder: opts.builder,
    dest: opts.dest!,
    sourceDateEpoch: opts.sourceDateEpoch!,
    ociTarget: opts.ociTarget,
    layoutDir,
  })
  console.log(`\n=== rootfs ${terminal.name} -> ${opts.ociTarget} (OCI) ===`)
  await run([dockerBin(), ...oci.argv], `${terminal.name} ${opts.ociTarget} export`, oci.env)

  // The record, written only after every stage succeeded: a manifest listing
  // stages that did not all build would be a list of intentions.
  const manifest = join(opts.dest!, MANIFEST_NAME)
  writeFileSync(manifest, stageManifest(builds, stages, opts.without))
  console.log(`\nrootfs: ${builds.length} stages built; chain recorded in ${manifest}`)

  // Hashed here and not by whoever wants the number later: this is the only
  // moment at which the file and the arguments that produced it are both in
  // hand. rootfs/README.md's gate compares two builds' archives, and a hash
  // taken from the artifact alone could not say which epoch or which platform
  // it was taken under.
  const archive = Bun.file(oci.archive)
  const bytes = archive.size
  if (bytes === 0) {
    console.error(
      `error: ${oci.archive} is empty or absent after the export reported success. An OCI archive of a ${bytes}-byte root is not something anything can be executed in`,
    )
    return 1
  }
  // Streamed, not read whole: the archive is the size of the root, and a
  // several-hundred-megabyte Uint8Array to produce 32 bytes is a cost with no
  // reason behind it.
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of archive.stream()) hasher.update(chunk)
  const sha256 = hasher.digest('hex')
  const record = join(opts.dest!, OCI_RECORD_NAME)
  writeFileSync(
    record,
    ociRecord({
      board: opts.board,
      ref: oci.ref,
      platform: opts.platform,
      target: opts.ociTarget,
      archive: oci.archive,
      bytes,
      sha256,
      sourceDateEpoch: opts.sourceDateEpoch!,
    }),
  )
  console.log(
    `rootfs: factory root exported to ${oci.archive}`
    + ` (${(bytes / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}...)`
    + `\nrootfs: load it with \`${dockerBin()} load -i ${oci.archive}\` -> ${oci.ref}`
    + `\nrootfs: export recorded in ${record}`,
  )
  return 0
}

if (import.meta.main)
  process.exit(await main(process.argv.slice(2)))
