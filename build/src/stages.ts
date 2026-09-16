// The rootfs assembly files, as data.
//
// rootfs/compose/ holds the numbered Dockerfiles that build the root, in
// numeric order, each FROM the local image tag the previous one was written to:
// 10-compose installs the resolved package set, 90-pack closes and packs it.
// This module turns that directory into a plan -- which file, which tag, which
// build arguments, which one exports the artifact -- and refuses a directory
// that cannot be built in sequence. It runs nothing: src/stages-cli.ts is the
// only file that invokes docker, so everything decided here is a pure function
// tested without a daemon.
//
// The file list is the directory. There is no list anywhere else, deliberately:
// a file added to the tree but not to a list would silently never run.
// build-env's frontend check and tests/shell-pipefail-lint.sh derive their
// file sets the same way. Adding a step is adding a file.

import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { REPO_ROOT } from './paths.ts'

// This lives in build because build orchestration does, and it duplicates
// nothing: the board model stays the single copy in verify/src/board.ts.

export const STAGES_DIR: string = join(REPO_ROOT, 'rootfs', 'compose')

/** The argument every stage but the first declares, and the driver supplies. */
export const PREV_ARG = 'MICA_STAGE_PREV'

/** What a stage file is, once read. */
export interface StageFile {
  /** The numeric prefix: 10, 20, 90. Orders the chain. */
  readonly order: number
  /** The whole stem: `10-base`, `90-pack`. Names the tag and the report line. */
  readonly name: string
  readonly path: string
  /** Every ARG the file declares, except PREV_ARG, in first-seen order. */
  readonly declaredArgs: readonly string[]
  /**
   * Those of them declared with an EMPTY default -- `ARG X=`, `ARG X=""`.
   *
   * Kept apart from declaredArgs because the two kinds of default behave
   * differently when nobody supplies a value, and only one of them is
   * survivable. unsuppliedArgs says which and why.
   */
  readonly emptyDefaultArgs: readonly string[]
  /** Does it declare `ARG MICA_STAGE_PREV`? */
  readonly declaresPrev: boolean
  /** Does it open a stage `FROM ${MICA_STAGE_PREV}`? */
  readonly fromsPrev: boolean
  /** The named build targets it defines: `FROM x AS certs` -> `certs`. */
  readonly targets: readonly string[]
  /** sha256 of the file, so the manifest records WHICH stage was built. */
  readonly sha256: string
}

export interface StageFault {
  readonly path: string
  readonly message: string
}

export class StageChainError extends Error {
  readonly faults: readonly StageFault[]
  constructor(faults: readonly StageFault[]) {
    super(faults.map((f) => `${f.path}: ${f.message}`).join('\n'))
    this.name = 'StageChainError'
    this.faults = faults
  }
}

// `10-base.Dockerfile` -> order 10, name `10-base`. The number is what orders
// the chain, so a file whose name does not carry one is not a stage and is
// refused rather than sorted alphabetically among the ones that do.
const STAGE_NAME = /^(\d+)-([A-Za-z0-9][A-Za-z0-9-]*)\.Dockerfile$/

// `ARG NAME` and `ARG NAME=value`, leading space tolerated. Docker's parser is
// case-insensitive on the instruction; a lowercase `arg` would be a real
// declaration and invisible to a case-sensitive pattern.
const ARG_LINE = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/i
// The default text of an `ARG NAME=...` line. A SECOND pattern rather than a
// group added to the one above, so that a spelling this does not understand
// still yields the name: an ARG that fell out of ARG_LINE would fall out of
// declaredArgs too, and then be refused as a stray on the way in.
const ARG_DEFAULT = /^\s*ARG\s+[A-Za-z_][A-Za-z0-9_]*=(.*)$/i
// `FROM ${MICA_STAGE_PREV}`, optionally with `AS closed`. The brace form
// only: `FROM $MICA_STAGE_PREV` also expands, but one spelling in one place is
// the difference between a check and a guess about which spellings exist.
const FROM_PREV = new RegExp(`^\\s*FROM\\s+(?:--\\S+\\s+)*\\$\\{${PREV_ARG}\\}(?:\\s|$)`, 'i')
// `FROM x AS y`, with the flags where docker actually puts them -- BEFORE the
// image, not after. The first version of this pattern allowed them only after,
// so `FROM --platform=$BUILDPLATFORM ${IMAGE} AS pack` matched nothing and the
// pack target went unseen. It was caught by attributing the 34 scripts to their
// stages with the same expression and getting `closed` for every pack-*.sh.
const FROM_AS = /^\s*FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+([A-Za-z0-9._-]+))?\s*$/i

/**
 * The default an `ARG NAME=...` line declares, with one layer of surrounding
 * quotes taken off the way the Dockerfile parser takes it off: `ARG X=""`
 * declares the empty string, not two quote characters. `undefined` for a line
 * that declares no default at all.
 */
function argDefault(line: string): string | undefined {
  const m = ARG_DEFAULT.exec(line)
  if (!m) return undefined
  const raw = m[1]!.trim()
  const quoted = raw.length >= 2
    && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  return quoted ? raw.slice(1, -1) : raw
}

/**
 * Read one stage file. Parsing only -- what makes a chain valid is auditChain.
 */
export function readStageFile(path: string, text: string): StageFile {
  const file = basename(path)
  const m = STAGE_NAME.exec(file)
  if (!m) {
    throw new StageChainError([
      {
        path,
        message: `is not named <number>-<name>.Dockerfile, so nothing puts it in order. The chain is built in numeric order and a file with no number would be sorted among the ones that have them by accident`,
      },
    ])
  }
  const declaredArgs: string[] = []
  const emptyDefaultArgs: string[] = []
  const targets: string[] = []
  let declaresPrev = false
  let fromsPrev = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    const arg = ARG_LINE.exec(line)
    if (arg) {
      const name = arg[1]!
      if (name === PREV_ARG) declaresPrev = true
      else {
        if (!declaredArgs.includes(name)) declaredArgs.push(name)
        // ANY declaration with an empty default is enough. A name declared
        // twice, once bare and once `=""`, is unsupplied-safe in one stage and
        // silently empty in the other, and the silent one is the one that
        // decides what the build asserts.
        if (argDefault(line) === '' && !emptyDefaultArgs.includes(name)) emptyDefaultArgs.push(name)
      }
      continue
    }
    if (FROM_PREV.test(line)) fromsPrev = true
    const as = FROM_AS.exec(line)
    if (as?.[1]) targets.push(as[1])
  }
  return {
    order: Number(m[1]),
    name: `${m[1]}-${m[2]}`,
    path,
    declaredArgs,
    emptyDefaultArgs,
    declaresPrev,
    fromsPrev,
    targets,
    sha256: new Bun.CryptoHasher('sha256').update(text).digest('hex'),
  }
}

/**
 * A stage entry's path as DOCKER will have to open it.
 *
 * A symlink is how one file is shared by two directories, and it is how
 * rootfs/compose reached the chain's 90-pack finalizer while both paths
 * existed. NO ENTRY IN THIS REPOSITORY IS A SYMLINK TODAY: the chain is gone
 * and the finalizer is a real file beside 10-compose. The resolution is kept
 * because the reason it exists is a property of buildx rather than of that one
 * arrangement, and it is exercised by its own test against a fixture.
 *
 * The path recorded here is handed to `docker buildx build -f`. That does NOT
 * open the file locally: buildx transfers the dockerfile as a filtered
 * mini-context of its own and the frontend opens it on the other side, so a
 * symlink arrives as a symlink and its target, one directory up, is outside
 * what was transferred. Measured on this host against buildx 0.32.2, on the
 * docker-container AND the default docker driver alike:
 *
 *   #2 transferring dockerfile: 114B done
 *   ERROR: failed to solve: failed to read dockerfile:
 *          open probe.Dockerfile: no such file or directory
 *
 * 114 bytes is the tar entry for the LINK, not the 42 bytes of the file it
 * names. Handing docker the resolved path is what makes sharing a stage file
 * work; the same build with -f pointing at the target succeeds unchanged.
 *
 * Resolved only when the entry IS a symlink, so a regular stage file's path is
 * the one the caller asked about -- a blanket realpath would also rewrite every
 * fault message's path when the repository itself sits under a symlinked
 * parent, which is a different thing from what this fixes.
 */
function stagePath(dir: string, entry: string): string {
  const full = join(dir, entry)
  return lstatSync(full).isSymbolicLink() ? realpathSync(full) : full
}

/** Read every stage file in a directory, in chain order. */
export function discoverStages(dir: string = STAGES_DIR): StageFile[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (cause) {
    throw new StageChainError([
      { path: dir, message: `cannot be read, so the chain has no stages: ${String(cause)}` },
    ])
  }
  // statSync and not lstatSync in the filter: it follows the link, so a symlink
  // to a stage file is a stage file and a symlink to a directory is not.
  const stages = entries
    .filter((e) => e.endsWith('.Dockerfile'))
    .filter((e) => statSync(join(dir, e)).isFile())
    .map((e) => stagePath(dir, e))
    .map((p) => readStageFile(p, readFileSync(p, 'utf8')))
  stages.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return stages
}

// `31-feature-containers` -> `containers`. A stage whose name matches this is
// one a build may DECLINE; every other stage is the floor, the read-only-root
// wiring, the board or the pack, and declining any of those is not a smaller
// image, it is a broken one.
const FEATURE_NAME = /^\d+-feature-([A-Za-z0-9][A-Za-z0-9-]*)$/

/** The feature a stage names, or undefined if it is not a feature stage. */
export function featureOf(stage: StageFile): string | undefined {
  return FEATURE_NAME.exec(stage.name)?.[1]
}

/**
 * The chain with named features left out -- "stage selection". This replaces `--build-arg WITH_CONTAINERS=0`, and the difference is not
 * spelling: a WITH_* argument reached the build and every RUN and script that
 * cared had to test it -- five copies for the container engine, four for micad,
 * each an independent chance to build an image with the engine installed and
 * its assertions skipped. Here the decision is made once, before docker starts,
 * and a declined feature is a file that is not built. It refuses a name it
 * cannot find, which is the point of the function: `--without contaners`
 * silently matching nothing would build the full image and report success, a
 * switch observed only in the position that changes nothing. It also refuses to
 * drop a non-feature stage, because `--without base` is a request for an image
 * with no operator account and no trust anchors.
 */
export function selectStages(
  stages: readonly StageFile[],
  without: readonly string[],
): StageFile[] {
  const faults: StageFault[] = []
  const features = new Map<string, StageFile>()
  for (const s of stages) {
    const f = featureOf(s)
    if (f) features.set(f, s)
  }
  const known = [...features.keys()].sort()
  const drop = new Set<string>()
  for (const name of without) {
    const hit = features.get(name)
    if (hit) {
      drop.add(hit.name)
      continue
    }
    const other = stages.find((s) => s.name === name || s.name.endsWith(`-${name}`))
    faults.push({
      path: STAGES_DIR,
      message: other
        ? `was asked to leave out '${name}', which is ${basename(other.path)} -- not a feature stage. Only <number>-feature-<name> stages may be declined; the rest are the floor, the read-only-root wiring, the board and the pack, and a chain missing one of those does not build a smaller image, it builds a broken one`
        : `was asked to leave out the feature '${name}' and no stage here is named <number>-feature-${name}. The features are: ${known.length > 0 ? known.join(', ') : '(none)'}. A name that matched nothing would build the FULL image and exit 0, so it is refused instead`,
    })
  }
  if (faults.length > 0) throw new StageChainError(faults)
  return stages.filter((s) => !drop.has(s.name))
}

/**
 * Everything that makes an ordered list of files a buildable chain.
 *
 * Each of these has a failure it exists for, and none of them is a style rule:
 * a duplicate number makes the build order depend on readdir, a missing
 * MICA_STAGE_PREV makes a stage build against whatever FROM was typed instead of
 * against its predecessor, and a first stage that declares one would be a stage
 * expecting a predecessor it can never have.
 */
export function auditChain(
  stages: readonly StageFile[],
  terminalTarget: string,
  ociTarget: string,
): StageFault[] {
  const faults: StageFault[] = []
  if (stages.length === 0) {
    return [
      {
        path: STAGES_DIR,
        message:
          'holds no *.Dockerfile at all. An empty chain builds nothing and exits 0, which is the shape of green this tree keeps finding; it is a failure here',
      },
    ]
  }
  if (stages.length === 1) {
    faults.push({
      path: stages[0]!.path,
      message:
        'is the only stage in the directory. A chain of one is a single-file build wearing the chain\'s clothes -- if that is genuinely what this is now, delete the driver rather than leaving it looking like it sequences something',
    })
  }
  const byOrder = new Map<number, StageFile[]>()
  for (const s of stages) {
    const seen = byOrder.get(s.order)
    if (seen) seen.push(s)
    else byOrder.set(s.order, [s])
  }
  for (const [order, group] of byOrder) {
    if (group.length > 1) {
      faults.push({
        path: group.map((g) => basename(g.path)).join(', '),
        message: `share the number ${order}, so which of them runs first is whatever order the directory happened to be read in. Give them distinct numbers`,
      })
    }
  }
  // Two stages naming the SAME feature. Distinct numbers, so the duplicate-number
  // fault above cannot see it -- and the consequence is worse than an ordering
  // question: `--without <that feature>` would drop one of them, leave the other
  // in the chain, and report success. A switch that half-fires is the shape of
  // green this whole campaign is about.
  const byFeature = new Map<string, StageFile[]>()
  for (const s of stages) {
    const f = featureOf(s)
    if (!f) continue
    const seen = byFeature.get(f)
    if (seen) seen.push(s)
    else byFeature.set(f, [s])
  }
  for (const [feature, group] of byFeature) {
    if (group.length > 1) {
      faults.push({
        path: group.map((g) => basename(g.path)).join(', '),
        message: `both name the feature '${feature}'. Their numbers differ, so the chain builds -- but \`--without ${feature}\` would drop one of them, leave the other in the image, and exit 0 reporting the feature declined`,
      })
    }
  }
  stages.forEach((s, i) => {
    const first = i === 0
    if (first && s.declaresPrev) {
      faults.push({
        path: s.path,
        message: `is the first stage and declares ARG ${PREV_ARG}. There is no previous stage to name, so the build would resolve it to the empty string and fail at FROM with a message about an invalid image reference`,
      })
    }
    if (!first && !s.declaresPrev) {
      faults.push({
        path: s.path,
        message: `does not declare ARG ${PREV_ARG}. Without it the driver has no way to hand this stage its predecessor, and the file would be built against whatever base its own FROM names -- a stage chain in which one link is not linked`,
      })
    }
    if (!first && !s.fromsPrev) {
      faults.push({
        path: s.path,
        message: `declares ARG ${PREV_ARG} but no stage in it opens \`FROM \${${PREV_ARG}}\`. The argument would be passed, accepted and ignored, and the stage would build on something else entirely while the chain reported it as linked`,
      })
    }
  })
  const last = stages[stages.length - 1]!
  if (!last.targets.includes(terminalTarget)) {
    faults.push({
      path: last.path,
      message: `is the last stage and defines no \`AS ${terminalTarget}\` target. That target is what the driver exports to the output directory; without it the build would export the last stage's whole filesystem instead of the artifact surface`,
    })
  }
  // The second export surface, audited exactly as the first one is and for a
  // sharper reason. A missing `artifact` target fails the build at
  // once -- the assembler has no rootfs-verity.img to read. A missing
  // `factory-root` target would only mean that nothing was ever executed
  // before the image shipped, which is precisely the state M7 exists to end and
  // which looks, from the outside, exactly like a build that smoke-tested
  // everything and found nothing wrong.
  if (!last.targets.includes(ociTarget)) {
    faults.push({
      path: last.path,
      message: `is the last stage and defines no \`AS ${ociTarget}\` target. That target is the packed root exported as an OCI image, and it is what the smoke runner executes the self-built binaries inside; without it there is nothing to run them in, and a build that ships them unexecuted is indistinguishable from one that ran them all and passed`,
    })
  }
  return faults
}

/** One stage's build, fully decided. */
export interface StageBuild {
  readonly name: string
  readonly path: string
  /** The local image tag this stage is written to, and the next one starts FROM. */
  readonly tag: string
  /** The tag of the previous stage, or undefined for the first. */
  readonly prevTag?: string
  /** Only the arguments this file declares, and only those the caller supplied. */
  readonly buildArgs: Readonly<Record<string, string>>
  /** The last stage exports instead of tagging. */
  readonly terminal: boolean
}

export interface ChainOptions {
  readonly board: string
  readonly supplied: Readonly<Record<string, string>>
  readonly tagRepo?: string
  readonly terminalTarget?: string
  readonly ociTarget?: string
}

export const DEFAULT_TAG_REPO = 'mica-rootfs-stage'
export const DEFAULT_TERMINAL_TARGET = 'artifact'

/**
 * The terminal stage's SECOND target: the packed root as an OCI image.
 *
 * `artifact` exports files -- rootfs-verity.img, the boot pair,
 * the factory /var -- for the image assembler to consume. This one exports the
 * root itself, in the form a container runtime takes, so that the eleven
 * self-built binaries in it can be EXECUTED before the image ships them.
 */
export const DEFAULT_OCI_TARGET = 'factory-root'

/**
 * The OCI archive, written into --dest beside the other artifacts.
 *
 * A file and not merely a loaded tag, because the two answer different
 * questions and only one of them is durable. A tag is daemon state: it says
 * what is currently loaded, it is gone when the store is pruned, and it cannot
 * be hashed. This is an OCI-layout tar -- `docker load -i` puts it back, and
 * its sha256 is what makes "does this export reproduce" a measurement rather
 * than an assurance. Measured on this host, two cold builds of one tree produce
 * a byte-identical archive; see ociExport for the three flags that took.
 */
export const OCI_ARCHIVE_NAME = 'factory-root.oci'

/** The record written beside the archive: what was exported, and from where. */
export const OCI_RECORD_NAME = 'factory-root.txt'

/**
 * The image reference stamped into the archive, so `docker load` names it.
 *
 * Board-scoped for the same reason the stage tags are: two boards can be in
 * flight at once, and an arm64 root loaded over an amd64 one under a shared
 * name would smoke-test the wrong architecture and say nothing about it.
 */
export function factoryRootRef(board: string, repo = 'localhost/mica-factory-root'): string {
  return `${repo}:${board}`
}

/**
 * A supplied argument no stage declares.
 *
 * This is refused rather than passed. Docker accepts an unused --build-arg with
 * a warning, and the warning scrolls past in a build that prints thousands of
 * lines -- so a VERITY_SALT the pack stage stopped declaring would reach the
 * image as veritysetup's random default, and the first sign would be an image
 * that differs on every build for a reason nobody could name.
 */
export function unusedArgs(
  stages: readonly StageFile[],
  supplied: Readonly<Record<string, string>>,
): string[] {
  const declared = new Set<string>()
  for (const s of stages) for (const a of s.declaredArgs) declared.add(a)
  return Object.keys(supplied)
    .filter((k) => !declared.has(k))
    .sort()
}

/**
 * An argument a stage declares with an empty default and nobody supplies.
 *
 * The converse of unusedArgs, and the direction nothing else can see. Measured
 * on this daemon against buildkit, one Dockerfile, three ARGs, no --build-arg:
 *
 *   ARG NO_DEFAULT       -> ABSENT from the RUN environment. A script that
 *                           reads it dies under `set -u` and the build stops.
 *   ARG EMPTY_DEFAULT="" -> PRESENT and empty. Indistinguishable, to every
 *                           reader, from a value somebody chose to be empty.
 *   ARG REAL_DEFAULT=x   -> PRESENT as `x`, which is what the file says it is.
 *
 * Only the middle case is refused here. The first is already guarded loudly by
 * `set -u`, and in the third the default IS the value -- rootfs/compose's
 * VERITY_HASH_ALGO and the two verity block sizes are declared exactly that way
 * and are deliberately never supplied.
 *
 * The middle case is not hypothetical. pack-assert-var-disposable.sh reads
 * BOARD_RADIOS to decide whether /var/lib/bluetooth is precious state. Were
 * rootfs/build.sh to stop supplying it, `ARG BOARD_RADIOS=""` would
 * apply, the script would read an empty radio list WITHOUT ERROR, and the
 * disposability assertion would quietly stop requiring the bluetooth mount unit
 * on a board that has one -- a check that keeps passing by examining less. No
 * green result in this repository could show it: uefi-x64 legitimately composes
 * BOARD_RADIOS="", so the symptom is invisible on the only board this host
 * builds.
 *
 * SUPPLYING AN EMPTY STRING IS NOT THIS. `--arg BOARD_RADIOS=` is uefi-x64 saying it
 * has no radios, and it is a decision that was made; this is about the value
 * nobody was asked for.
 */
export function unsuppliedArgs(
  stages: readonly StageFile[],
  supplied: Readonly<Record<string, string>>,
): string[] {
  const missing = new Set<string>()
  for (const s of stages) for (const a of s.emptyDefaultArgs) if (!(a in supplied)) missing.add(a)
  return [...missing].sort()
}

export function planChain(stages: readonly StageFile[], opts: ChainOptions): StageBuild[] {
  const repo = opts.tagRepo ?? DEFAULT_TAG_REPO
  const target = opts.terminalTarget ?? DEFAULT_TERMINAL_TARGET
  const faults = auditChain(stages, target, opts.ociTarget ?? DEFAULT_OCI_TARGET)
  if (faults.length > 0) throw new StageChainError(faults)
  const stray = unusedArgs(stages, opts.supplied)
  if (stray.length > 0) {
    throw new StageChainError([
      {
        path: STAGES_DIR,
        message: `was handed ${stray.join(', ')}, which no stage declares. docker would accept each as an unused --build-arg and warn, and that warning scrolls past in a build this size -- so the value would simply not reach the image`,
      },
    ])
  }
  const missing = unsuppliedArgs(stages, opts.supplied)
  if (missing.length > 0) {
    throw new StageChainError([
      {
        path: STAGES_DIR,
        message: `declares ${missing.join(', ')} with an EMPTY default and was handed no value. An ARG with no default at all is absent from the RUN environment, so a reader of it dies under \`set -u\`; an empty default reaches the build as an empty string instead, and every reader takes that for a value somebody chose. Supply it -- \`--arg NAME=\` is how a board says the answer is genuinely nothing -- or give the ARG a default that IS the value`,
      },
    ])
  }
  return stages.map((s, i) => ({
    name: s.name,
    path: s.path,
    tag: `${repo}:${opts.board}-${s.name}`,
    prevTag: i === 0 ? undefined : `${repo}:${opts.board}-${stages[i - 1]!.name}`,
    buildArgs: Object.fromEntries(
      s.declaredArgs.filter((a) => a in opts.supplied).map((a) => [a, opts.supplied[a]!]),
    ),
    terminal: i === stages.length - 1,
  }))
}

/**
 * Where one stage's OCI layout is written in layout mode: under `layoutDir`,
 * named for the tag the next stage's `FROM ${MICA_STAGE_PREV}` will say, with
 * the two characters a directory name cannot carry replaced -- the same
 * spelling tools/from.sh --contexts= uses for the builder images.
 */
export function layoutOf(layoutDir: string, tag: string): string {
  return join(layoutDir, tag.replaceAll(/[:/]/g, '-'))
}

/**
 * The argv for one stage's `docker buildx build`, everything after the
 * subcommand. Built here rather than in the CLI so the exact command line is a
 * value a test can read -- the flags that decide where the image goes are the
 * ones a chain gets wrong.
 */
export function buildArgv(
  build: StageBuild,
  opts: {
    readonly context: string
    readonly platform: string
    readonly builder?: string
    readonly dest?: string
    readonly terminalTarget?: string
    /**
     * Build every stage from scratch, reading no layer cache.
     *
     * This exists for the GATE, not for convenience. rootfs/README.md's
     * determinism gate compares a chain build against a control of two COLD
     * builds -- and a chain whose stages came out of cache is not a cold build,
     * it is a replay of whichever run filled the cache. Without a flag the only
     * way to be cold is to prune the daemon's cache, which on a shared machine
     * takes every other build's cache with it.
     */
    readonly noCache?: boolean
    /**
     * Layout mode: chain the stages through OCI layouts under this directory
     * instead of through tags in the daemon's image store.
     *
     * A builder whose driver has its own content store -- docker-container,
     * remote -- cannot resolve `FROM <local tag>`, but it takes an OCI layout
     * as a named build context, and it can write one. So in this mode every
     * non-terminal stage exports `type=oci,tar=false` under its own tag's
     * name, and the next stage is handed that directory under the very tag
     * its FROM names. Nothing is loaded into the daemon. Measured on
     * 2026-08-30: two arm64 stages chained this way on the mica-arm64 builder
     * on a host with no binfmt, which is the case the mode exists for.
     */
    readonly layoutDir?: string
  },
): string[] {
  const argv = ['buildx', 'build']
  if (opts.noCache) argv.push('--no-cache')
  if (opts.builder) argv.push('--builder', opts.builder)
  argv.push('--platform', opts.platform, '-f', build.path)
  if (build.prevTag) argv.push('--build-arg', `${PREV_ARG}=${build.prevTag}`)
  if (build.prevTag && opts.layoutDir) {
    argv.push('--build-context', `${build.prevTag}=oci-layout://${layoutOf(opts.layoutDir, build.prevTag)}`)
  }
  for (const [k, v] of Object.entries(build.buildArgs)) argv.push('--build-arg', `${k}=${v}`)
  if (build.terminal) {
    if (!opts.dest) {
      throw new StageChainError([
        {
          path: build.path,
          message:
            'is the terminal stage and no output directory was given. It would build and be thrown away',
        },
      ])
    }
    argv.push('--target', opts.terminalTarget ?? DEFAULT_TERMINAL_TARGET)
    argv.push('--output', `type=local,dest=${opts.dest}`)
  } else if (opts.layoutDir) {
    // `tar=false` writes the layout as a directory, which is the one shape
    // `oci-layout://` takes; `name=` stamps the tag into its index so the
    // context is the image the next FROM names and not an anonymous manifest.
    argv.push('--output', `type=oci,dest=${layoutOf(opts.layoutDir, build.tag)},tar=false,name=${build.tag}`)
  } else {
    // --load, and not merely -t. With the docker driver -t already loads; with
    // any other it does not, and the next stage's FROM would resolve a tag that
    // is not in the image store. Asking for it explicitly costs nothing on the
    // driver that does it anyway and is the whole chain on one that does not.
    argv.push('-t', build.tag, '--load')
  }
  argv.push(opts.context)
  return argv
}

/** Everything the OCI export needs, as one value a test can read. */
export interface OciExport {
  /** Everything after `docker`, exactly as it will be spawned. */
  readonly argv: readonly string[]
  /** The environment additions -- SOURCE_DATE_EPOCH, which is not a flag. */
  readonly env: Readonly<Record<string, string>>
  /** Absolute path of the archive this writes. */
  readonly archive: string
  /** The reference stamped inside it. */
  readonly ref: string
}

// Seconds since the epoch, and nothing else. `@1577836800` is the touch(1)
// spelling boards/<board>/board.env uses for the same instant, and buildkit
// would take it as a malformed value -- silently, because SOURCE_DATE_EPOCH is
// read from the environment rather than parsed by a flag. rootfs/build.sh
// strips the `@` before passing it; this is what makes that a checked step
// rather than a convention.
const EPOCH_SECONDS = /^\d+$/

/**
 * The second build of the terminal stage: the packed root, as an OCI image.
 *
 * A second invocation and not a second --output, because buildkit exports one
 * target per build and these are two: `artifact` is the file surface the
 * assembler reads, `factory-root` is the root itself. Everything the two share
 * -- context, platform, build arguments, the `pack` stage that produced /rootfs
 * -- comes from the layer cache the first invocation just filled, so this costs
 * the export and not the build. Deliberately no --no-cache even when the chain
 * was built with it: `--no-cache` is for the determinism gate, where the chain
 * must not replay an earlier run's cache, and this invocation must be a replay
 * of the run that finished seconds ago. Passing it would rebuild all nine
 * stages and export a different root from the one the assembler is about to
 * consume -- two roots per build, differing for the reasons rootfs/README.md
 * records, with nothing to say which was smoke-tested.
 *
 * What makes it reproduce, measured on the real 250 MB export of the uefi-x64 root:
 *
 *   SOURCE_DATE_EPOCH is load-bearing, pinning the image config's `created`;
 *   without it two exports of one already-built root give two different
 *   archives.
 *
 *   rewrite-timestamp is load-bearing only when the layer is genuinely rebuilt,
 *   which is the case that matters and the one a convenient experiment misses:
 *   two cold rebuilds of the pack stage without it give two different archives,
 *   with it byte-identical and equal to the warm build's. From a warm cache it
 *   changes the bytes but both runs still agree, so measuring it warm would
 *   have "proved" it unnecessary. It also conflicts with loading -- buildkit
 *   refuses `rewrite-timestamp` together with `unpack`, which is what `--load`
 *   does -- so the export cannot both reproduce and land in the image store. It
 *   reproduces; `docker load -i` is the caller's step.
 *
 *   --provenance/--sbom are not load-bearing here and are kept anyway: omitting
 *   them gives the identical archive, because buildx 0.32.2 adds no attestation
 *   to a `type=oci` export. It does add one to a `--load`, which is where this
 *   was first seen, and the default has moved between buildx versions before.
 */
export function ociExport(
  build: StageBuild,
  opts: {
    readonly context: string
    readonly platform: string
    readonly board: string
    readonly dest: string
    readonly sourceDateEpoch: string
    readonly builder?: string
    readonly ociTarget?: string
    /** Layout mode, as for buildArgv: the predecessor arrives as an OCI layout. */
    readonly layoutDir?: string
  },
): OciExport {
  if (!build.terminal) {
    throw new StageChainError([
      {
        path: build.path,
        message: `is not the terminal stage, and only the terminal stage exports the factory root. Exporting an earlier link would give an image of a root that is missing every stage after it -- including, for ${DEFAULT_OCI_TARGET}, the binaries the smoke run exists to execute`,
      },
    ])
  }
  if (!EPOCH_SECONDS.test(opts.sourceDateEpoch)) {
    throw new StageChainError([
      {
        path: build.path,
        message: `was given SOURCE_DATE_EPOCH='${opts.sourceDateEpoch}', which is not a count of seconds. buildkit reads that name from the ENVIRONMENT, so a value it cannot parse is not an error -- it is a build that quietly stamps the wall clock into the image config and every layer entry, and reproduces on no two runs`,
      },
    ])
  }
  const target = opts.ociTarget ?? DEFAULT_OCI_TARGET
  const archive = join(opts.dest, OCI_ARCHIVE_NAME)
  const ref = factoryRootRef(opts.board)
  const argv = ['buildx', 'build']
  if (opts.builder) argv.push('--builder', opts.builder)
  argv.push('--platform', opts.platform, '-f', build.path)
  if (build.prevTag) argv.push('--build-arg', `${PREV_ARG}=${build.prevTag}`)
  if (build.prevTag && opts.layoutDir) {
    argv.push('--build-context', `${build.prevTag}=oci-layout://${layoutOf(opts.layoutDir, build.prevTag)}`)
  }
  for (const [k, v] of Object.entries(build.buildArgs)) argv.push('--build-arg', `${k}=${v}`)
  argv.push('--target', target, '--provenance=false', '--sbom=false')
  argv.push('--output', `type=oci,dest=${archive},name=${ref},rewrite-timestamp=true`)
  argv.push(opts.context)
  return { argv, env: { SOURCE_DATE_EPOCH: opts.sourceDateEpoch }, archive, ref }
}

/**
 * The record written beside the archive.
 *
 * NOT A BASELINE. The sha256 here says what this build produced, so that two
 * builds can be compared to each other; it is not a number anything is expected
 * to match, for the reason rootfs/README.md gives at length -- a cold rootfs
 * build does not reproduce itself, so a hash committed as an expectation is a
 * check that looks like coverage and is not. What DOES reproduce is this export
 * from one already-built root, and that is a property of the exporter, not of
 * the tree.
 */
export function ociRecord(fields: {
  readonly board: string
  readonly ref: string
  readonly platform: string
  readonly target: string
  readonly archive: string
  readonly bytes: number
  readonly sha256: string
  readonly sourceDateEpoch: string
}): string {
  return [
    `# The ${fields.board} factory root, exported as an OCI image by rootfs/compose/90-pack.Dockerfile.`,
    '# The root the self-built binaries are executed in before the image ships them.',
    `# Load it with: docker load -i ${fields.archive}`,
    '#',
    '# The sha256 is what this build produced, for comparison with another build.',
    '# It is NOT a baseline: a cold rootfs build does not reproduce itself, so the',
    '# root inside differs between trees for reasons rootfs/README.md enumerates.',
    `ref\t${fields.ref}`,
    `platform\t${fields.platform}`,
    `target\t${fields.target}`,
    `archive\t${basename(fields.archive)}`,
    `bytes\t${fields.bytes}`,
    `sha256\t${fields.sha256}`,
    `source-date-epoch\t${fields.sourceDateEpoch}`,
  ].join('\n') + '\n'
}

/**
 * The record of what was built, written beside the artifacts.
 *
 * The driver records the stage list per build. Which stages ran is not
 * derivable from the output afterwards -- an image built without a feature
 * stage looks like an image whose feature stage did nothing -- so it is written
 * down at the time. The declined features are recorded too: a `# declined:`
 * line naming nothing is not the same statement as no line at all, the first
 * saying the build was asked for every feature and the second that nobody wrote
 * it down. Both are printed, always, so an image with no container engine says
 * why on its own manifest.
 */
export function stageManifest(
  builds: readonly StageBuild[],
  stages: readonly StageFile[],
  declined: readonly string[] = [],
): string {
  const lines = [
    '# rootfs stage chain, as built. One line per stage, in build order.',
    `# declined: ${declined.length > 0 ? [...new Set(declined)].sort().join(' ') : '(none -- every feature stage in the directory was built)'}`,
    '# name\tcontent-hash\ttag',
  ]
  builds.forEach((b, i) => {
    lines.push(`${b.name}\t${stages[i]!.sha256}\t${b.terminal ? '(exported)' : b.tag}`)
  })
  return `${lines.join('\n')}\n`
}
