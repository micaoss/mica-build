// The smoke runner: execute every self-built artifact inside the root that ships
// it and require the version it reports to be the one mica-podman:upstream.lock
// or the crate manifest pins. Execution and version
// identity, not behaviour; the QEMU boot tests and the ldd/NEEDED checks keep
// functional coverage. Everything below takes an `Exec`, so the suite reaches
// every verdict from the failing side with fabricated output and no image,
// daemon or build. The verdicts are pass, fail, `unclaimed` -- a conclusion
// nobody reached, kept for the next artifact this tree builds and cannot yet
// ask -- and `executor-limited`, the one case where a non-zero exit is a
// statement about the emulated executor rather than about the artifact; both
// are exercised in smoke.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { machine } from 'node:os'
import { join } from 'node:path'
import { parsePackageInventory } from './installed-packages.ts'
import { ARTIFACTS, artifactsForPackages, pinCoverageFaults, unclaimedFaults, type Artifact, type ExecutorLimit } from './smoke-register.ts'
import type { Pin } from './smoke-pins.ts'
import { readProductEnv, productBuildDir } from './product-env.ts'
import { REPO_ROOT } from './paths.ts'

/** One executed command, and everything the runner is allowed to know about it. */
export interface ExecResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  /**
   * The budget, when the budget is what ended it.
   *
   * A process the watchdog kills answers 137 -- 128 plus SIGKILL's 9 -- and that
   * number is indistinguishable from a program that chose to exit 137, so every
   * message built from the status alone makes its reader decode a signal to
   * learn that the RUNNER ended this and not the program. It cost this campaign
   * a build: `docker load ... exited 137: Loaded image: localhost/mica-factory-root:uefi-x64`
   * is a kill reported beside docker's own success line, and the run was failed.
   * Carrying the budget out beside the status is what lets a message say `the
   * watchdog killed it after N ms` in words.
   */
  readonly timedOutAfterMs?: number
}

/**
 * Run one command inside the factory root.
 *
 * The argv is the absolute path of the binary in the image followed by its
 * arguments -- not a shell line. The factory root is `FROM scratch` with no
 * ENTRYPOINT, no CMD and no PATH, so a bare `crun` would not resolve, and the
 * installed path is the thing under test anyway.
 */
export type Exec = (argv: readonly string[]) => Promise<ExecResult>

export type Verdict = 'pass' | 'fail' | 'unclaimed' | 'executor-limited'

/**
 * Which executor ran the argv.
 *
 * `native` is `docker run` of an image of this host's own platform, on its own
 * kernel; `emulated` is `docker run` of another platform, which the host's
 * binfmt_misc hands to qemu-user (the privileged runner registers linux/arm64
 * this way); `buildkit` is the fallback `smokeRun` falls back to when the daemon
 * cannot execute the image's platform at all, where every instruction runs under
 * qemu-user inside the builder. Native and the other two are not interchangeable
 * -- a program that needs a syscall the emulator does not implement fails under
 * emulation and not natively -- so the route is carried into `judge`, which is
 * the only place allowed to soften a verdict because of it.
 */
export type ExecRoute = 'native' | 'emulated' | 'buildkit'

/** The route `docker run` of `platform` takes on this host: native for the host's own platform, emulated otherwise. */
export function dockerRoute(platform: string): 'native' | 'emulated' {
  const host: Record<string, string> = { x86_64: 'amd64', aarch64: 'arm64' }
  return platform === `linux/${host[machine()] ?? machine()}` ? 'native' : 'emulated'
}

/**
 * An `Exec` that says which executor it is.
 *
 * The route travels ON the executor rather than beside it. A parallel variable
 * -- "we switched to buildkit, so also set route" -- is two statements of one
 * fact that agree until one of them is edited, and the one that would be edited
 * is the one no test can reach without an arm64 host. Tagging the function makes
 * the two inseparable: `buildkitExec` cannot be handed to the runner without its
 * route, and a suite that fabricates an executor can tag it the same way.
 */
export type RoutedExec = Exec & { readonly route?: ExecRoute }

/**
 * Which executor this is, defaulting to the strict reading.
 *
 * An untagged function is `native`: a caller that hands the runner a bare
 * `Exec` gets the route under which every non-zero exit is a failure, so the
 * softer reading is never something a caller can fall into by omission.
 */
export function execRoute(exec: Exec): ExecRoute {
  return (exec as RoutedExec).route ?? 'native'
}

export interface SmokeResult {
  readonly name: string
  readonly path: string
  readonly kind: 'version' | 'exec' | 'unclaimed'
  readonly verdict: Verdict
  readonly message: string
  /**
   * The long form, printed below the table rather than in the row.
   *
   * Only `unclaimed` carries one: the measured reason the artifact has no
   * version contract. It is separate from `message` because a paragraph inside
   * a column destroys the table's one property -- twelve conclusions read at a
   * glance -- and buries the reason a check was not run.
   */
  readonly detail?: string
}

/**
 * A pin's file, relative to the repository root.
 *
 * NOT `basename`: four of the twelve read a `Cargo.toml`, and
 * `micad:mqttd/Cargo.toml` and `micad:broker/Cargo.toml` are different files with
 * the same last component, so a row saying "in Cargo.toml" would not tell a
 * reader which one to edit. Absolute paths carry a worktree prefix that differs
 * per checkout and turns every line into noise.
 */
export function pinSource(file: string): string {
  return file.startsWith(REPO_ROOT + '/') ? file.slice(REPO_ROOT.length + 1) : file
}

/**
 * Every version-shaped token on a line, by maximal munch.
 *
 * One tokeniser, not twelve parsers: the ten artifacts that answer print ten
 * different sentences, measured in the real uefi-x64 factory root --
 *
 *   tool 1.13            podman version 5.8.6   5.8.6
 *   crun version 1.29.1  conmon version 2.2.1   netavark 2.1.0
 *   aardvark-dns 2.1.0   tini version 0.2.1_catatonit
 *   mica-mqttd 0.1.0      mica-mqtt-broker 0.1.0
 *
 * -- and a per-artifact regex fails open when upstream reflows one: no token
 * read looks like no mismatch. A value read from the pin file can only mismatch.
 */
export function versionTokens(line: string): string[] {
  // Maximal munch is the point, not an implementation detail: greedy
  // `[0-9]+(?:\.[0-9]+)+` takes the run of digits and dots whole, so the next
  // character cannot be a digit and `1.29.10` cannot satisfy a pin of `1.29.1`.
  // A right-hand `(?![.0-9])` is therefore redundant -- removing it changed no
  // test -- and it is harmful: on `crun version 1.29.1.` it rejects the greedy
  // match, backtracking finds nothing shorter, and the line yields no token at
  // all, which this runner reports as "reports NO version at all" and turns red
  // for a binary that printed the right version and ended with a full stop. The
  // left guard is load-bearing: without it a token can start in the middle of a
  // longer run, so `11.29.1` would offer `1.29.1` and a version-skewed binary
  // would report as agreeing with its pin.
  // A Debian revision is part of the token (`micad 0.1.0-1`), so a package version is compared whole.
  return [...line.matchAll(/(?<![.0-9])[0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z+~]+(?:\.[0-9A-Za-z+~]+)*)?/g)].map(m => m[0])
}

/** The first non-empty line of stdout -- where all ten artifacts print it. */
export function firstLine(stdout: string): string {
  for (const line of stdout.split('\n'))
    if (line.trim() !== '') return line.trim()

  return ''
}

/**
 * What a non-zero exit means, from the status and what came back with it.
 *
 * Measured against docker 29.7.2 in exactly the shape `dockerArgv` produces --
 * no shell, because the artifact IS the container's init, so a failure to exec
 * it surfaces as a `docker run` failure rather than as a shell's 126. The
 * `docker run` convention (127 not found, 126 cannot be invoked) gets the first
 * two of these wrong:
 *
 *   wrong-arch ELF          255  `exec <path>: exec format error`
 *   missing soname          127  `<path>: error while loading shared libraries:
 *     libselinux.so.1: cannot open shared object file`
 *   present, mode 000       126  `docker: ... exec: "<path>": permission denied.`
 *   path genuinely absent   127  `docker: ... exec: "<path>": stat <path>: no
 *     such file or directory.`
 *   program ran and refused      its own status
 *
 * `preflight` records the same `status 255` with `exec format error` for the
 * arm64 wall. Pure, so every branch is reachable from the suite; a fabricated
 * `ExecResult` lets a test pick the status it then asserts the diagnosis of, so
 * `src/verify/smoke-negative.ts` also drives the three negative cases through
 * a real container against a real mutated root.
 */
export function diagnose(outcome: ExecResult): string {
  // First, because a killed process's status is not its answer. `--version` is
  // milliseconds and the budget is a fuse, so reaching it says the host or the
  // binary stopped making progress; either way the number beside it is SIGKILL's
  // and naming it as one is what keeps the next reader from decoding 137.
  if (outcome.timedOutAfterMs !== undefined) {
    return `the watchdog killed it after ${outcome.timedOutAfterMs} ms -- this status is the SIGKILL `
      + 'the runner sent when its budget ran out, not the program\'s own answer'
  }
  // 127 is ambiguous and is split by text, not left to the status: ld.so exits
  // 127 after printing `error while loading shared libraries`, and docker exits
  // 127 when the path is not there at all. The fallback names both possibilities
  // rather than picking one.
  const said = `${outcome.stdout}\n${outcome.stderr}`
  if (/error while loading shared libraries/i.test(said)) {
    return 'the file is there and the dynamic loader could not resolve it -- a shared library it '
      + 'NEEDs is not in this root, so the binary never reached main'
  }
  // A host with a qemu-user binfmt handler registered for the other architecture
  // runs a foreign ELF through qemu, and qemu, not the kernel, refuses one whose
  // header names an architecture it does not emulate for this interpreter.
  if (/exec format error|Invalid ELF image for this architecture/i.test(said)) {
    return 'the file could not be executed AT ALL -- the kernel refused the image with ENOEXEC. '
      + 'A wrong-architecture binary is this, and so is a host with no emulator registered for '
      + 'the image\'s platform; `preflight` rules out the second before any artifact is judged, '
      + 'so at this point it is the binary'
  }
  if (outcome.status === 127) {
    return 'the path does not exist in the factory root -- either this register names it wrongly, '
      + 'or the install script stopped putting it there'
  }
  if (outcome.status === 126) {
    return 'the path exists and could not be invoked -- measured, this is what a file with no '
      + 'executable bit produces; the pack stage normalises modes, so a mode this runner cannot '
      + 'execute is a question about 90-pack rather than about the binary'
  }
  if (outcome.status === 255) {
    return 'the container could not be started on this path at all, and not for a reason named '
      + 'above -- read the stderr; `docker run` failing to exec its init reports 255'
  }
  return 'the program ran and refused'
}

/**
 * Whether this failure is the one the entry declared the EXECUTOR cannot avoid.
 *
 * Three conjuncts, all required, and each of them is what keeps this from
 * becoming a way for a red run to go green:
 *
 *   route     Only an emulated route (qemu-user through binfmt, or the buildkit
 *             fallback). The native route runs the
 *             binary on this host's kernel, where nothing is being emulated and
 *             a non-zero exit is the artifact's own answer; softening it there
 *             would delete the check on the only host that can really run it.
 *   declared  Only an entry that carries an `executorLimit`. There is no global
 *             pattern: an entry that declares nothing can never reach this
 *             verdict, so the category cannot spread to a binary nobody
 *             measured, and adding a member is an edit to the register.
 *   exact     The status AND the stderr, both. `includes` on stderr and not on
 *             `stdout + stderr`, because the signature was measured on stderr
 *             and a binary that PRINTS that sentence on stdout while failing
 *             some other way is a different event.
 *
 * Exported so the suite can drive each conjunct from the failing side.
 */
export function executorLimitMatch(
  artifact: Artifact,
  outcome: ExecResult,
  route: ExecRoute,
): ExecutorLimit | undefined {
  const limit = artifact.executorLimit
  if (limit === undefined || route === 'native') return undefined
  if (outcome.status !== limit.status) return undefined
  return outcome.stderr.includes(limit.stderrIncludes) ? limit : undefined
}

/**
 * Decide one artifact from what its invocation actually did.
 *
 * Pure, so every branch is reachable from the suite with a fabricated
 * `ExecResult` -- including the two that a healthy tree can never produce.
 *
 * `route` is which executor produced `outcome`, and it defaults to `native` --
 * the strict reading. It is consulted for one thing only: an entry that declared
 * an `executorLimit` and hit it exactly, under emulation, is `executor-limited`
 * rather than `fail`. See `executorLimitMatch` for why all three conjuncts are
 * required.
 */
export function judge(
  artifact: Artifact,
  pin: Pin,
  outcome: ExecResult,
  route: ExecRoute = 'native',
): SmokeResult {
  const { name, path, contract } = artifact
  const base = { name, path } as const

  if (contract.kind === 'unclaimed') {
    return {
      ...base,
      kind: 'unclaimed',
      verdict: 'unclaimed',
      message:
        `NOT EXECUTED, no version asserted. ${pinSource(pin.file)} pins ${pin.key}=${pin.recorded}, `
        + `so it would have to report ${pin.expected}; nothing asked it.`,
      detail: contract.why,
    }
  }

  if (outcome.status !== 0) {
    const limit = executorLimitMatch(artifact, outcome, route)
    if (limit !== undefined) {
      return {
        ...base,
        kind: contract.kind,
        verdict: 'executor-limited',
        message:
          `EXECUTED under the ${route} executor and exited ${outcome.status} the one way this `
          + `register entry declares this executor cannot avoid: ${limit.why}. `
          + `stderr=${JSON.stringify(firstLine(outcome.stderr))}. `
          + `Nothing was asserted about the version, and this is NOT a pass: on the native route the `
          + `same outcome is a FAIL, and any other status or stderr is a FAIL here too.`,
      }
    }
    return {
      ...base,
      kind: contract.kind,
      verdict: 'fail',
      message:
        `exited ${outcome.status}, expected 0 (${diagnose(outcome)}). `
        + `stdout=${JSON.stringify(firstLine(outcome.stdout))} `
        + `stderr=${JSON.stringify(firstLine(outcome.stderr))}`,
    }
  }

  if (contract.kind === 'exec')
    return { ...base, kind: 'exec', verdict: 'pass', message: `executed, exit 0 (exec-only; no version asserted)` }

  const line = firstLine(outcome.stdout)
  const tokens = versionTokens(line)
  if (tokens.includes(pin.expected)) {
    // `[said: ...]` on every version row: a runner that asserts a thing must still show what it read.
    const version
      = `exit 0, reports ${pin.expected} == ${pin.key}=${pin.recorded} in ${pinSource(pin.file)} `
        + `[said: ${JSON.stringify(line)}]`
    return { ...base, kind: 'version', verdict: 'pass', message: version }
  }
  return {
    ...base,
    kind: 'version',
    verdict: 'fail',
    message:
      `exit 0 but reports ${tokens.length === 0 ? 'NO version at all' : tokens.join(', ')}, `
      + `and ${pinSource(pin.file)} pins ${pin.key}=${pin.recorded} (expected ${pin.expected}). `
      + `Its --version line was ${JSON.stringify(line)}. `
      + `Either the pin was bumped without rebuilding the artifact, or the artifact was built `
      + `from something other than the pin.`,
  }
}

/** Run one artifact, or decline to. */
export async function checkArtifact(
  artifact: Artifact,
  exec: Exec,
  route: ExecRoute = 'native',
): Promise<SmokeResult> {
  const pin = artifact.pin()
  if (artifact.contract.kind === 'unclaimed') {
    // Not invoked, and that is a decision rather than an omission. micad's only
    // invocation provisions a device and apid's never returns; running them to
    // produce a `fail` would trade a clear "nobody asked" for a 25-second hang
    // and a mutated /var, and would report the artifact as broken when what is
    // missing is the question.
    return judge(artifact, pin, { status: 0, stdout: '', stderr: '' }, route)
  }
  return judge(artifact, pin, await exec([artifact.path, ...artifact.contract.argv]), route)
}

export interface Conclusion {
  readonly conclusion: 'PASS' | 'FAIL' | 'INCOMPLETE'
  readonly exitCode: number
  readonly counts: {
    readonly pass: number
    readonly fail: number
    readonly unclaimed: number
    /** Decided, exit 0, and NOT a pass -- see `executorLimitMatch`. Printed even when zero. */
    readonly executorLimited: number
    readonly total: number
  }
  readonly line: string
}

/**
 * The run's verdict, and the vacuity guard that makes it evidence.
 *
 * `expected` is the register's size, and a run that concluded a different
 * number of things is a failure whatever those conclusions were. Without it a
 * runner that threw away half its work would print `RESULT: PASS (6/6)` and
 * look exactly like one that checked everything -- the same shape as the shell
 * lint that reported `RESULT: PASS (0/0 checks)` because its counters died in a
 * subshell, and as `bin/bun.sh src/cli.ts`'s own `Ran 0 tests` guard.
 */
export function conclude(results: readonly SmokeResult[], expected: number): Conclusion {
  const counts = {
    pass: results.filter(r => r.verdict === 'pass').length,
    fail: results.filter(r => r.verdict === 'fail').length,
    unclaimed: results.filter(r => r.verdict === 'unclaimed').length,
    executorLimited: results.filter(r => r.verdict === 'executor-limited').length,
    total: results.length,
  }

  // One spelling of the counts for all three conclusions, built once. Until the
  // executor-limited verdict arrived the three lines carried three copies of the
  // same four numbers with the FAIL and INCOMPLETE ones hard-coding `0 fail`
  // where they knew it; a fifth number added to two of three copies is exactly
  // how a reader ends up translating between two summaries. Every number is
  // printed on every line, zero as zero: an unstated count is a count a reader
  // assumes, and `1 executor-limited` on a green line is the whole point of the
  // verdict -- a run that softened one conclusion must say how many.
  const summary
    = `${counts.pass} pass, ${counts.executorLimited} executor-limited, ${counts.fail} fail, `
      + `${counts.unclaimed} unclaimed, of ${counts.total}`

  // The names, not just the number: "2 unclaimed" is a count a reader stops
  // seeing, and "micad, apid" is something they can act on. This run's steady
  // state is non-zero, so the names go on the RESULT line itself and not only
  // in the table above it.
  const named = (verdict: Verdict): string =>
    results.filter(r => r.verdict === verdict).map(r => r.name).join(', ')
  // The same argument the UNCLAIMED clause makes, for the same reason: the
  // count says how much was softened, the names say what. Absent when there is
  // nothing to name, so a clean run does not carry an empty clause.
  const limited = counts.executorLimited > 0 ? ` EXECUTOR-LIMITED: ${named('executor-limited')}.` : ''
  if (expected <= 0 || counts.total !== expected) {
    return {
      conclusion: 'FAIL',
      exitCode: 1,
      counts,
      line:
        `RESULT: FAIL (${counts.total} conclusions from a register of ${expected}). `
        + `A smoke run that reached a different number of artifacts than it was asked to reach has `
        + `not measured what its counts say it measured, and ${expected <= 0 ? 'an EMPTY register concludes nothing at all while exiting 0' : 'the missing ones are invisible in a green summary'}.`,
    }
  }
  if (counts.fail > 0) {
    return {
      conclusion: 'FAIL',
      exitCode: 1,
      counts,
      line:
        `RESULT: FAIL (${summary}). `
        + `FAILED: ${named('fail')}.`
        + (counts.unclaimed > 0 ? ` UNCLAIMED: ${named('unclaimed')}.` : '')
        + limited,
    }
  }
  if (counts.unclaimed > 0) {
    return {
      conclusion: 'INCOMPLETE',
      exitCode: 1,
      counts,
      line:
        `RESULT: INCOMPLETE (${summary}).${limited} `
        + `UNCLAIMED: ${named('unclaimed')}. `
        + `Nothing failed and not everything was asked. An unclaimed artifact is not a pass and is `
        + `not a skip: the smoke contract requires a reported version from every one of them, and this run `
        + `exits non-zero so that a gate cannot be held by a summary with holes in it.`,
    }
  }
  return {
    conclusion: 'PASS',
    exitCode: 0,
    counts,
    // The same numbers FAIL and INCOMPLETE print, in the same order, from the
    // same string: a second spelling on the green line would make a reader
    // translate between it and the red one, and `0 unclaimed` and
    // `0 executor-limited` are exactly the numbers that would go unstated on the
    // line that matters most.
    line: `RESULT: PASS (${summary})${limited}`,
  }
}

// The image, and the one place that decides how a binary is executed.

/** What `_out/<board>/factory-root.txt` says the archive beside it is. */
export interface FactoryRootRecord {
  readonly ref: string
  readonly platform: string
  readonly archive: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * `_out/products/<product>/build` -- where rootfs/build.sh composed the
 * product: the factory root, its record, the package inventory, the build
 * fact. One composition per product, so two products of one board never
 * overwrite each other's root.
 */
export function outDir(product: string): string {
  return productBuildDir(product)
}

/**
 * Read a `key<TAB>value` record as data.
 *
 * Tab-separated, exactly as `ociRecord` in src/image/stages.ts writes it and
 * as `micad:hack/build-deb.sh` writes `_out/micad-build-<arch>.txt`, parsed rather
 * than sourced. Comment lines are skipped by having no tab, which is why
 * `# Load it with: docker load -i ...` cannot become a key -- a reader that
 * split on whitespace would have made one. One reader for both records, because
 * two parsers for one file format agree right up until a value or a comment
 * acquires a tab; the same argument smoke-pins.ts makes about not writing a
 * second `upstream.lock` parser.
 */
export function parseTabRecord(text: string): Map<string, string> {
  const kv = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    kv.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim())
  }
  return kv
}

export function parseFactoryRootRecord(text: string, path: string): FactoryRootRecord {
  const kv = parseTabRecord(text)
  const need = (k: string): string => {
    const v = kv.get(k)
    if (v === undefined || v === '') {
      throw new Error(
        `${path} carries no ${k}. It is written by src/image/stages.ts's ociRecord beside the `
        + `archive it describes; a record missing a field was produced by something else, and the `
        + `smoke run would then be executing an image nobody in this tree named.`,
      )
    }
    return v
  }
  const bytes = Number(need('bytes'))
  if (!Number.isInteger(bytes) || bytes <= 0)
    throw new Error(`${path} says bytes=${kv.get('bytes')}, which is not a positive integer.`)

  return { ref: need('ref'), platform: need('platform'), archive: need('archive'), sha256: need('sha256'), bytes }
}

/**
 * Where the two files live for a board.
 *
 * `dir` is a parameter for `shippedBoards(dir)`'s reason: the refusal below has
 * to be reachable from a test, and a guard that can only fire on a host that has
 * never built an image is green here and red there for reasons that have nothing
 * to do with the code.
 */
export function factoryRootPaths(
  board: string,
  dir: string,
): { readonly record: string, readonly archive: string } {
  return { record: join(dir, 'factory-root.txt'), archive: join(dir, 'factory-root.oci') }
}

/**
 * Read the record, refusing loudly when the build has not been run.
 *
 * A missing image is a refusal, not a skip. `make os-verify-cx3576` on a tree
 * with no image refuses before running a single check, and that is the behaviour
 * to copy: a runner that skipped when it found nothing to smoke would report the
 * same green on a tree that had never built an image as on one whose artifacts
 * all passed.
 */
export function readFactoryRoot(
  board: string,
  dir: string,
): FactoryRootRecord & { readonly archivePath: string } {
  const { record, archive } = factoryRootPaths(board, dir)
  if (!existsSync(record) || !existsSync(archive)) {
    throw new Error(
      `${board}: ${existsSync(record) ? archive : record} does not exist.\n`
      + `       The smoke run executes the self-built binaries INSIDE the packed root, and that root\n`
      + `       is exported by stages/compose/90-pack.Dockerfile's \`factory-root\` target. Build it\n`
      + `       with: make os-rootfs PRODUCT=<product> (a product on ${board})\n`
      + `       This refuses rather than skipping: a skip reports the same green as a pass, and an\n`
      + `       image that ships its binaries unexecuted is exactly what this check exists to end.`,
    )
  }
  const parsed = parseFactoryRootRecord(readFileSync(record, 'utf8'), record)
  return { ...parsed, archivePath: archive }
}

/** `_out/<board>/rootfs-stages.txt` -- what the driver recorded about the build. */
export const STAGE_MANIFEST_NAME = 'rootfs-stages.txt'

/**
 * Read explicit feature declines from the resolved package manifest. A declined
 * feature is an input choice, not a missing-binary failure; the caller applies
 * its declared composition policy before running the binary register.
 */
export function declinedFeatures(text: string): string[] {
  for (const line of text.split('\n')) {
    const m = /^#\s*declined:\s*(.*)$/.exec(line)
    if (m === null) continue
    const body = m[1]!.trim()
    // `# declined: (none -- every feature stage in the directory was built)`.
    // The parenthesis is the driver's way of saying "asked for, and nothing was
    // declined" as opposed to "nobody wrote it down"; stageManifest's own
    // comment says why both statements exist and why they must not look alike.
    if (body === '' || body.startsWith('(')) return []
    return body.split(/\s+/).filter(f => f !== '')
  }
  throw new Error(
    `the stage manifest carries no \`# declined:\` line. src/image/stages.ts's stageManifest `
    + `writes one on every build, naming the feature stages left out -- or saying in parentheses `
    + `that none were. A manifest without it was written by something else, and the smoke run `
    + `cannot tell a full-featured root from one built without its container engine.`,
  )
}

/**
 * Run one program with a budget, and hand back everything it did.
 *
 * Exported so `src/smoke-negative.ts` drives `docker build`
 * through the same seam the runner drives `docker run` through -- a second
 * spawn helper would be a second set of decisions about timeouts and about what
 * counts as output, agreeing with this one until one of them was edited.
 */
export async function capture(argv: readonly string[], timeoutMs: number): Promise<ExecResult> {
  const proc = Bun.spawn(argv as string[], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  // A budget, not a courtesy. `apid --version` starts an HTTPS server and never
  // returns -- measured, rc=124 against 25s -- so an unbounded wait here is a
  // smoke run that hangs instead of concluding. The shipped register does not
  // invoke apid, but a register entry added later could, and a harness whose
  // worst case is "forever" cannot be put in front of a build.
  let watchdogFired = false
  const timer = setTimeout(() => {
    watchdogFired = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    // Recorded only when the kill is what decided the status. The timer and the
    // process can land in the same tick, and a program that had already exited 0
    // when the signal arrived did its work -- calling that a timeout would be the
    // same false alarm this field exists to end, from the other side.
    if (watchdogFired && status !== 0) return { status, stdout, stderr, timedOutAfterMs: timeoutMs }
    return { status, stdout, stderr }
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * What one invocation gets, split by the two different things that spend it.
 *
 * A `docker run` of an artifact is two jobs in one wait: the daemon has to
 * START a container, and then the program has to RUN. They fail for unrelated
 * reasons -- a wedged daemon is a statement about the host, a program that
 * never answers is a statement about the binary -- and until now they shared
 * one 30s number and one message, so a build could only be told `/bin/true
 * exited 137` and left to decode a signal into a cause.
 *
 * The 30s was indefensible for the same reason the load budget's was, and NOT
 * because it was small: it was sized against an idle host. Measured here
 * (docker 29.7.2, containerd image store, 8 cores) on the shipped uefi-x64 factory
 * root, `docker run --rm --network none <root> /bin/true` -- the preflight's
 * exact argv, and a program that cannot be slow for any reason of its own --
 *
 *   quiet host, 10 runs         330, 330, 582, 666, 652, 608, 630, 646, 666, 718 ms
 *   3 concurrent docker builds  8582, 1603, 857, 942, 1185, 1010, 967, 667,
 *   + 16 spinners, 12 runs      675, 646, 680, 588 ms
 *
 * -- so a start costs ~0.65s on a quiet host and the FIRST start after the
 * daemon gets busy costs 8.6s, 13x the quiet median and 26x the quiet best. The
 * distribution's tail is not proportional to its middle: it is a queue behind
 * whatever else the daemon is committing, and the campaign has the measurement
 * that matters at the far end -- a `/bin/true` killed at 30s while two sibling
 * rootfs builds ran. A number chosen as a multiple of the idle case is a number
 * that tail crosses, whatever multiple is chosen.
 *
 * So the budget is sized against the two jobs separately, and the part that
 * cannot be predicted is MEASURED rather than guessed. `preflight` already runs
 * `/bin/true` before anything is concluded; that run is a measurement of what a
 * container start costs on this host under the load it has right now, and
 * `execTimeoutMs` sizes every later invocation from it. On a quiet host the
 * floor wins and the answer is a flat 150s; on a host where a start really did
 * cost 8.6s the multiplier wins and the artifacts get 167s. That is the same
 * argument LOAD_TIMEOUT_BYTES_PER_MS makes with bytes: a budget that answers
 * the same on an idle host and a swamped one is the constant again under
 * another name.
 */
export const EXEC_STARTUP_BUDGET_MS = 120_000
/**
 * What the program itself may take once it is running.
 *
 * This is the old 30s, and it keeps that value for the one job it can actually
 * be sized against: every `--version` in the register answers in milliseconds,
 * and the failure it guards is a program that does not answer at all -- `apid
 * --version` starts an HTTPS server and never returns, measured rc=124 against
 * 25s. A binary that has not printed a version line in 30s of running is not
 * going to.
 */
export const EXEC_PROGRAM_BUDGET_MS = 30_000
/**
 * How much slower than its own measurement a start is allowed to get.
 *
 * 16, from the spread this host actually showed between a quiet start (0.65s
 * median) and the first start after the daemon got busy (8.6s): 13x. The
 * measurement is taken seconds before the artifacts run, so the risk it does
 * not cover is load ARRIVING in between; a multiple just above the worst spread
 * measured is what covers that without turning the fuse into an afternoon.
 */
export const EXEC_STARTUP_SLACK = 16

/**
 * The budget for one invocation, given what a container start just cost.
 *
 * `startupMs` is `preflight`'s own elapsed time. The floor is what a run that
 * measured nothing gets, and it is also what a quiet host gets: a start that
 * cost 0.65s does not justify shrinking the fuse to 10s, because the next start
 * is queued behind whatever the daemon does next.
 */
export function execTimeoutMs(startupMs: number): number {
  return Math.max(EXEC_STARTUP_BUDGET_MS, Math.ceil(startupMs * EXEC_STARTUP_SLACK)) + EXEC_PROGRAM_BUDGET_MS
}

/**
 * The fuse for a call nobody measured a start for: `tar`, `docker image
 * inspect`, `docker buildx inspect`. Both parts, because such a call is a
 * daemon round trip plus work of its own -- `extractLayout` untars 250 MB under
 * it.
 */
export const EXEC_TIMEOUT_MS = EXEC_STARTUP_BUDGET_MS + EXEC_PROGRAM_BUDGET_MS

/**
 * What `docker load` gets, as a function of what it has to ingest.
 *
 * A constant is the wrong SHAPE for this budget, and raising the 30s one would
 * have been the same defect postponed: what a load costs is the bytes it reads,
 * and `factory-root.txt` already records how many that is.
 *
 * The 30s was EXEC_TIMEOUT_MS, shared with `crun --version`. It killed a
 * COMPLETED load of the 250 MB factory root twice in one day, both times with
 * docker's own success line in the captured output --
 *   `docker load -i .../factory-root.oci exited 137: Loaded image: localhost/mica-factory-root:uefi-x64`
 * -- and each time it cost a full gate run: the builds did not fail, the
 * watchdog did. What makes that number indefensible is not that it is small but
 * what it was sized against: the archive it killed loads in 2.1s against a warm
 * daemon, so 30s looks like 14x of headroom, and host load alone crosses it.
 * Measured here on the same host (docker 29.7.2, containerd image store), the
 * same 250,083,328 bytes: 4.3s warm, 20.3s cold and quiet, and 48.2s cold while
 * two sibling rootfs builds ran -- past the fuse, on the load this repository
 * normally carries. A fuse sized for a warm daemon turns host load into a red
 * build that names nothing about the cause.
 *
 * 1 MB/s is the quiet-host cold measurement divided by twelve -- the order of
 * magnitude a loaded host actually costs -- and, being a rate, it SCALES: a root that grows
 * to 1 GB gets four times the budget instead of re-acquiring this defect on the
 * day it grows. The floor covers the part that is not bytes (daemon round
 * trips, an archive small enough that the rate alone would give it
 * milliseconds). For the shipped 250 MB root the two come to ~310s, the same
 * order as BUILDKIT_EXEC_TIMEOUT_MS: a fuse against `forever`, not a deadline
 * anyone is expected to meet.
 */
export const LOAD_TIMEOUT_FLOOR_MS = 60_000
/** One millisecond of budget per this many bytes of archive -- 1 MB/s. */
export const LOAD_TIMEOUT_BYTES_PER_MS = 1_000

export function loadTimeoutMs(bytes: number): number {
  return LOAD_TIMEOUT_FLOOR_MS + Math.ceil(bytes / LOAD_TIMEOUT_BYTES_PER_MS)
}

const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json'

/** `linux/arm64/v8` and `linux/arm64` are one platform for this comparison. */
function platformKey(platform: string): string {
  return platform.split('/').slice(0, 2).join('/')
}

/**
 * The manifest digest the archive's own index names for this platform.
 *
 * Counted rather than searched: the message says how many manifests the index
 * carries, how many of those are images and how many of THOSE are for the
 * platform the record claims, because "found one" and "found the only one"
 * differ exactly when a producer starts attaching attestations. src/image/stages.ts
 * exports with `--provenance=false --sbom=false`, so today that count is 1.
 */
export function parseArchiveIndex(text: string, platform: string, path: string): string {
  const index = JSON.parse(text) as {
    manifests?: readonly { mediaType?: string, digest?: string, platform?: { os?: string, architecture?: string } }[]
  }
  const manifests = index.manifests ?? []
  const images = manifests.filter(m => m.mediaType === OCI_MANIFEST_MEDIA_TYPE)
  const wanted = images.filter(m =>
    m.platform === undefined || platformKey(`${m.platform.os}/${m.platform.architecture}`) === platformKey(platform))
  const digest = wanted.length === 1 ? wanted[0]!.digest : undefined
  if (digest === undefined || digest === '') {
    throw new Error(
      `${path} lists ${manifests.length} manifest(s), ${images.length} of them images and ${wanted.length} `
      + `of those for ${platform}; exactly one is needed to say which image this archive IS.`,
    )
  }
  return digest
}

/** The config digest the manifest names -- the other thing a daemon may call the image. */
export function parseArchiveManifest(text: string, path: string): string {
  const manifest = JSON.parse(text) as { config?: { digest?: string } }
  const digest = manifest.config?.digest
  if (digest === undefined || digest === '')
    throw new Error(`${path} names no config digest, so the archive does not say what image it carries.`)

  return digest
}

/** `sha256:abc...` -> `blobs/sha256/abc...`, the member an OCI layout tar carries it as. */
export function blobMember(digest: string): string {
  const sep = digest.indexOf(':')
  if (sep <= 0 || sep === digest.length - 1)
    throw new Error(`'${digest}' is not an <algorithm>:<hex> digest, so no blob in the archive answers to it.`)

  return `blobs/${digest.slice(0, sep)}/${digest.slice(sep + 1)}`
}

/**
 * The digests a daemon may know this archive's image by, read out of the
 * ARCHIVE and not out of the daemon.
 *
 * Two of them, because the two image stores disagree about what an image ID is:
 * with the containerd store (docker 29's default, measured here) `docker image
 * inspect --format {{.Id}}` answers the MANIFEST digest, and with the classic
 * store it answers the CONFIG digest. Both are computed from bytes this
 * worktree wrote, so neither can be made to name another worktree's root by a
 * tag moving underneath this run.
 *
 * It costs nothing next to the load it follows: tar seeks a regular file rather
 * than reading it, measured at 4 ms to pull index.json out of the end of a
 * 250 MB archive.
 */
export async function archiveImageDigests(
  record: FactoryRootRecord & { readonly archivePath: string },
  run: (argv: readonly string[], timeoutMs: number) => Promise<ExecResult> = capture,
): Promise<readonly string[]> {
  const member = async (name: string): Promise<string> => {
    const r = await run(['tar', '-xOf', record.archivePath, name], EXEC_TIMEOUT_MS)
    if (r.status !== 0)
      throw new Error(`tar could not read ${name} out of ${record.archivePath}: exited ${r.status} ${r.stderr.trim()}`)

    return r.stdout
  }
  const manifest = parseArchiveIndex(await member('index.json'), record.platform, `${record.archivePath}:index.json`)
  const config = parseArchiveManifest(await member(blobMember(manifest)), `${record.archivePath}:${manifest}`)
  return [manifest, config]
}

/** The image the run will address, and what that identity was taken from. */
export interface LoadedFactoryRoot {
  /** The name the archive carries. For messages; nothing is addressed by it. */
  readonly ref: string
  /** The image ID every `docker run` of this smoke run uses. */
  readonly id: string
  /** `content`: the daemon was asked for the archive's own digest. `tag`: it was not able to answer that. */
  readonly source: 'content' | 'tag'
}

/** The daemon's ID for a reference, or undefined if it holds no such image. */
async function inspectId(
  reference: string,
  run: (argv: readonly string[], timeoutMs: number) => Promise<ExecResult>,
): Promise<string | undefined> {
  const r = await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', reference], EXEC_TIMEOUT_MS)
  const id = r.stdout.trim()
  return r.status === 0 && id !== '' ? id : undefined
}

/** A valid OCI image that the daemon's archive loader cannot accept. */
export class OciArchiveLoadUnsupported extends Error {}

/**
 * Load the archive, every run, and hand back the IMAGE -- not the tag.
 *
 * Load rather than trust a tag. A tag is daemon state: it says what is currently
 * loaded, and `localhost/mica-factory-root:uefi-x64` may name a root some other
 * worktree on this host built an hour ago. `rootfs/build.sh` guards the
 * same seam from the other side -- "a stale or absent archive would be handed to
 * the smoke runner as this build's root". Loading is idempotent and costs ~2s on
 * the real 250 MB export because the layers are already content-addressed.
 *
 * Loading is not enough, though, and that is the second thing this does. The tag
 * stays daemon-global for as long as the run lasts, and this campaign has two
 * and three worktrees loading `:uefi-x64` at once; a sibling's load between this
 * function and the first `docker run` would hand the register somebody else's
 * root and produce a full page of verdicts about it. So the return value is the
 * daemon's ID for the digest the ARCHIVE names, and every later invocation
 * addresses that: an ID is content, and a tag moving cannot follow it.
 *
 * The fallback to the tag exists so this is never WORSE than what it replaced.
 * The two known image stores are covered by the two digests, and a store that
 * names images a third way would otherwise turn every smoke run on that host
 * into a refusal about the runner. It says which of the two happened, because
 * "resolved by content" and "resolved through a global tag" are different
 * statements about how much this run's verdicts can be trusted.
 *
 * `run` takes the budget per call: the load's is a function of the archive
 * (`loadTimeoutMs`), and the inspects beside it are the ordinary fuse.
 */
export async function loadFactoryRoot(
  record: FactoryRootRecord & { readonly archivePath: string },
  run: (argv: readonly string[], timeoutMs: number) => Promise<ExecResult> = capture,
  log: (line: string) => void = () => {},
): Promise<LoadedFactoryRoot> {
  const loaded = await run(['docker', 'load', '-i', record.archivePath], loadTimeoutMs(record.bytes))

  // A load that failed on its own says so and stops here, unchanged. A load the
  // WATCHDOG ended is a different claim -- it says the runner ran out of
  // patience, which is not evidence that the work was not done -- and is
  // answered below by asking the daemon what it holds.
  if (loaded.status !== 0 && loaded.timedOutAfterMs === undefined) {
    const reason = loaded.stderr.trim() || loaded.stdout.trim()
    const message = `docker load -i ${record.archivePath} exited ${loaded.status}: ${reason}`
    if (reason.includes('invalid archive: does not contain a manifest.json')) {
      // The classic image store expects a Docker archive. Confirm this is a
      // readable OCI image before allowing the existing BuildKit executor.
      await archiveImageDigests(record, run)
      throw new OciArchiveLoadUnsupported(message)
    }
    throw new Error(message)
  }

  let digests: readonly string[] = []
  try {
    digests = await archiveImageDigests(record, run)
  }
  catch (e) {
    log(
      `verify smoke: ${record.archive} does not say which image it carries `
      + `(${String((e as Error).message ?? e)})`,
    )
  }
  let id: string | undefined
  for (const digest of digests) {
    id = await inspectId(digest, run)
    if (id !== undefined) break
  }

  if (loaded.timedOutAfterMs !== undefined) {
    // The killed-but-done case, which is the one that failed a healthy build.
    // What matters is not whether the process lived to exit 0 but whether the
    // daemon holds the image the archive describes, and that is a question about
    // content: the digest came out of this worktree's own file. Answered from
    // the tag it would be worthless -- a stale `:uefi-x64` from an hour ago answers
    // it just as well.
    if (id !== undefined) {
      log(
        `verify smoke: the watchdog killed \`docker load -i ${record.archivePath}\` after `
        + `${loaded.timedOutAfterMs} ms, and the daemon nevertheless holds ${id}, the image this `
        + `archive describes by digest. The kill decided nothing; continuing with that image.`,
      )
      return { ref: record.ref, id, source: 'content' }
    }
    throw new Error(
      `the watchdog killed \`docker load -i ${record.archivePath}\` after ${loaded.timedOutAfterMs} ms, `
      + `and the daemon does not hold the image the archive describes, so there is nothing to execute.\n`
      + `       It said: ${loaded.stderr.trim() || loaded.stdout.trim() || '(nothing)'}\n`
      + `       The budget is ${LOAD_TIMEOUT_FLOOR_MS} ms plus one per ${LOAD_TIMEOUT_BYTES_PER_MS} bytes `
      + `of the recorded ${record.bytes}-byte archive, so a load that exceeds it is not a big archive but `
      + `a stalled one: look at the host before re-running.`,
    )
  }

  if (id !== undefined) return { ref: record.ref, id, source: 'content' }

  const tagged = await inspectId(record.ref, run)
  if (tagged === undefined) {
    throw new Error(
      `docker load -i ${record.archivePath} exited 0 and the daemon then had no image at ${record.ref}, `
      + `nor at either digest the archive names (${digests.join(', ') || 'none could be read'}).`,
    )
  }
  log(
    `verify smoke: ${record.ref} resolved through the TAG to ${tagged}; this daemon answers to `
    + `neither digest the archive names, so this run cannot prove the image is the one it loaded.`,
  )
  return { ref: record.ref, id: tagged, source: 'tag' }
}

/**
 * The positive control, run before anything is concluded about any artifact.
 *
 * `/bin/true` is coreutils' and the packed root keeps coreutils by decision
 * (90-pack.Dockerfile says why). If it does not exit 0, NOTHING in this image can
 * be executed here, and all twelve would come back `fail` about the artifact --
 * twelve wrong diagnoses of one condition. This is where the arm64 wall is
 * caught: on a host with no binfmt_misc, `docker run` of an arm64 image answers
 * `exec /bin/true: exec format error` with status 255, measured on this host
 * against a pulled upstream arm64v8/busybox, so the measurement is about the host
 * and not our export. Refusing here, naming the platform and the remedy, is the
 * same shape as `os-verify-cx3576` refusing on a tree with no image.
 *
 * It also MEASURES, and that is why it hands back a number. `/bin/true` returns
 * immediately, so its elapsed time is what starting a container costs on this
 * host right now -- see `execTimeoutMs`, which sizes every later invocation from
 * it. The measurement is free: this run happens either way.
 */
export async function preflight(exec: Exec, platform: string): Promise<number> {
  const startedAt = Date.now()
  const r = await exec(['/bin/true'])
  const elapsedMs = Date.now() - startedAt
  if (r.status === 0) return elapsedMs
  // A budget that ran out HERE is the one failure this control can attribute
  // without guessing: `/bin/true` cannot be slow for a reason of its own, so
  // nothing was spent running it and all of it was spent starting the
  // container. That is a question about this host's daemon and not about the
  // root, and it must not be reported as `/bin/true exited 137` -- a status
  // that reads as the program's own answer and sends the reader to decode a
  // signal number. It cost this campaign a green chain build, killed at 30s
  // while two sibling builds ran.
  if (r.timedOutAfterMs !== undefined) {
    throw new Error(
      `the factory root's container did not START within ${r.timedOutAfterMs} ms, so nothing was executed.\n`
      + `       The watchdog killed it; the status beside it is that SIGKILL and not /bin/true's answer.\n`
      + `       ${r.stderr.trim() || r.stdout.trim() || '(it said nothing)'}\n`
      + `       /bin/true returns immediately, so none of that budget was the program running: it was\n`
      + `       spent starting the container. Measured on this daemon, a start costs ~0.65s quiet and\n`
      + `       8.6s while three builds run, so a budget of this size means the daemon is not making\n`
      + `       progress -- look at what else is running on the host before re-running. This is NOT\n`
      + `       evidence that the root or any artifact in it is broken.`,
    )
  }
  const formatError = /exec format error/i.test(r.stderr + r.stdout)
  throw new Error(
    `the factory root cannot execute anything on this host: /bin/true exited ${r.status}.\n`
    + `       ${r.stderr.trim() || r.stdout.trim()}\n`
    + (formatError
      ? `       The image declares ${platform} and this host cannot run it. Register the emulator --\n`
      + `         docker run --privileged --rm tonistiigi/binfmt --install <arch>\n`
      + `       -- and re-run. Producing this image needs no emulation (90-pack's factory-root stage\n`
      + `       is FROM scratch and executes nothing); EXECUTING what is in it does, which is the\n`
      + `       whole of what this runner does.\n`
      : '')
    + `       Refused here rather than per artifact: without this control every one of the register's\n`
    + `       entries would come back failed, and twelve failures about twelve binaries would be\n`
    + `       twelve wrong diagnoses of one condition.`,
  )
}

/**
 * The exact command one invocation becomes.
 *
 * Separated from `dockerExec` so the suite can assert the argv without a daemon:
 * `--network none` and `--rm` are decisions, and a decision that only exists
 * inside a function nothing can observe is one nobody can check has survived an
 * edit.
 */
export function dockerArgv(ref: string, argv: readonly string[]): string[] {
  return [
    'docker',
    'run',
    '--rm',
    // No network. `podman --version` needs none, and a smoke runner that could
    // reach a registry is one whose result could depend on a registry. It also
    // keeps apid-shaped binaries -- anything that binds a port -- off the host's
    // network if a later register entry runs one.
    '--network',
    'none',
    ref,
    ...argv,
  ]
}

/**
 * The real seam: one container per invocation, inside the loaded factory root.
 *
 * `run` is a parameter for the same reason `loadFactoryRoot`'s is: the budget
 * an invocation is given is a decision, and a decision that only exists inside
 * a closure nothing can observe is one no test can watch survive an edit. The
 * default is the fuse for a run that measured no start; `smokeRun` passes
 * `execTimeoutMs(preflight's measurement)`.
 */
export function dockerExec(
  ref: string,
  timeoutMs: number = EXEC_TIMEOUT_MS,
  run: (argv: readonly string[], timeoutMs: number) => Promise<ExecResult> = capture,
  route: 'native' | 'emulated' = 'native',
): RoutedExec {
  // Tagged with the route the caller derived from the image's platform
  // (`dockerRoute`): `native` runs on the host's own kernel, so a non-zero exit
  // is the binary's answer; `emulated` runs a foreign platform under the host's
  // qemu-user. See `RoutedExec`.
  return Object.assign((argv: readonly string[]) => run(dockerArgv(ref, argv), timeoutMs), { route })
}

// The buildkit executor. Same seam, same register, same judging: only the
// thing that runs the binary changes. A docker-container builder bundles its
// own emulators, so a host whose daemon cannot execute the factory root's
// platform can still execute every artifact inside it -- each run is one
// throwaway build whose RUN is the argv and whose output is the three files
// `judge` reads. It is slower than `docker run` by the cost of a build per
// artifact, which is why it is the fallback and not the default.

export interface BuildkitExecOptions {
  /** The factory root's reference, as the archive's index names it. */
  readonly ref: string
  /** The archive extracted as an OCI layout directory. */
  readonly layout: string
  /** A buildx builder that can execute `platform`. */
  readonly builder: string
  readonly platform: string
  /** Where each run's Dockerfile and output go. Default: <repo>/tmp/. */
  readonly scratch?: string
  readonly timeoutMs?: number
}

/**
 * A build imports the layout on its first run and executes under emulation on
 * every run; the docker route's budget is not the right figure, and no
 * measurement of a container start on this host predicts what qemu-user costs.
 */
export const BUILDKIT_EXEC_TIMEOUT_MS = 300_000

function shellQuote(word: string): string {
  return `'${word.replaceAll('\'', `'\\''`)}'`
}

/**
 * The throwaway Dockerfile: run the argv in the root, off the network, and
 * carry its status, stdout and stderr out as three files. The RUN's own
 * status is the `echo`'s, so a failing artifact is a file that says so and
 * not a build that failed -- a build failure is reserved for the case the
 * root cannot execute anything, which `preflight` reads as such.
 */
export function buildkitDockerfile(ref: string, argv: readonly string[]): string {
  return [
    `FROM ${ref} AS run`,
    `RUN --network=none mkdir -p /mica-smoke && ( ${argv.map(shellQuote).join(' ')} ) >/mica-smoke/stdout 2>/mica-smoke/stderr; echo $? >/mica-smoke/status`,
    'FROM scratch',
    'COPY --from=run /mica-smoke/ /',
    '',
  ].join('\n')
}

export function buildkitArgv(opts: BuildkitExecOptions, dockerfileDir: string, outDir: string): string[] {
  return [
    'docker',
    'buildx',
    'build',
    '--builder',
    opts.builder,
    '--platform',
    opts.platform,
    '--build-context',
    `${opts.ref}=oci-layout://${opts.layout}`,
    // Every run executes: a cached RUN would be a smoke test that ran once.
    '--no-cache',
    '--progress=plain',
    '--output',
    `type=local,dest=${outDir}`,
    dockerfileDir,
  ]
}

export function buildkitExec(
  opts: BuildkitExecOptions,
  run: (argv: readonly string[]) => Promise<ExecResult> = argv =>
    capture(argv, opts.timeoutMs ?? BUILDKIT_EXEC_TIMEOUT_MS),
): RoutedExec {
  const scratch = opts.scratch ?? join(REPO_ROOT, 'tmp')
  // Tagged `buildkit`: every instruction inside this builder runs under
  // qemu-user, which is the fact `judge` needs to read an artifact's declared
  // executor limitation. See `RoutedExec`.
  return Object.assign(async (argv: readonly string[]) => {
    mkdirSync(scratch, { recursive: true })
    const dir = mkdtempSync(join(scratch, 'smoke-buildkit-'))
    try {
      const dockerfileDir = join(dir, 'df')
      const outDir = join(dir, 'out')
      mkdirSync(dockerfileDir)
      await Bun.write(join(dockerfileDir, 'Dockerfile'), buildkitDockerfile(opts.ref, argv))
      const built = await run(buildkitArgv(opts, dockerfileDir, outDir))
      const statusFile = join(outDir, 'status')
      if (built.status !== 0 || !existsSync(statusFile)) {
        // The convention `diagnose` reads: 255 with the stderr is "the
        // executor could not run this at all", which for a build is the
        // truth -- the root did not get as far as the argv.
        return { status: 255, stdout: built.stdout, stderr: built.stderr }
      }
      const status = Number.parseInt(readFileSync(statusFile, 'utf8').trim(), 10)
      return {
        status: Number.isNaN(status) ? 255 : status,
        stdout: readFileSync(join(outDir, 'stdout'), 'utf8'),
        stderr: readFileSync(join(outDir, 'stderr'), 'utf8'),
      }
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, { route: 'buildkit' as const })
}

/** `mica-<arch>` -- the container builder rootfs/build.sh and the package builds create for a cross build. */
export function containerBuilderFor(platform: string): string {
  return `mica-${platform.split('/')[1] ?? platform}`
}

async function builderExists(name: string): Promise<boolean> {
  const r = await capture(['docker', 'buildx', 'inspect', name], EXEC_TIMEOUT_MS)
  return r.status === 0
}

/** Extract the factory-root archive (an OCI tar) into a layout directory buildx can take as a context. */
export async function extractLayout(archive: string, dir: string): Promise<string> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const r = await capture(['tar', '-x', '-C', dir, '-f', archive], EXEC_TIMEOUT_MS)
  if (r.status !== 0 || !existsSync(join(dir, 'index.json')))
    throw new Error(`could not extract ${archive} into an OCI layout at ${dir}: ${r.stderr.trim() || `tar exited ${r.status}`}`)

  return dir
}

export interface SmokeRunOptions {
  /** The product whose composition (`_out/products/<product>/build`) is smoked. */
  readonly product: string
  /** The product's board; read from its recipe when not given. */
  readonly board?: string
  readonly artifacts?: readonly Artifact[]
  /**
   * The packages the root carries, which decide the artifacts executed. Read
   * from the product's `rootfs-packages.txt` when the CLI drives its own exec;
   * a caller with its own exec over a real root passes them.
   */
  readonly packages?: ReadonlySet<string>
  /**
   * Which `upstream.lock` files coverage is checked against.
   *
   * A parameter for the same reason `artifacts` is: a suite that drove a
   * two-artifact register against the shipped pin files would get ten coverage
   * faults about artifacts it was not testing, and the only way out would be to
   * weaken the coverage check for everybody.
   */
  readonly files?: readonly string[]
  /**
   * Which artifacts are authorised to be `unclaimed`.
   *
   * A parameter for the same reason `artifacts` and `files` are: the refusal
   * has to be reachable from a test, and a guard that can only fire when the
   * shipped register is wrong is a guard nobody has ever run.
   */
  readonly allowUnclaimed?: readonly string[]
  /** Supplied by the suite; the CLI builds a dockerExec. */
  readonly exec?: Exec
  /** Skip `docker load`; the suite has no archive to load. */
  readonly load?: boolean
  readonly log?: (line: string) => void
  /**
   * The buildx builder to execute inside when the daemon cannot execute the
   * platform. Default: `mica-<arch>` if such a builder exists.
   */
  readonly builder?: string
  /**
   * Which executor a supplied `exec` stands for, when it carries no tag.
   *
   * Only meaningful together with `exec`, and only for a bare function: the
   * executors this file builds are `RoutedExec`s that say what they are, and
   * the runner reads the route off the one it chose. It exists so the suite can
   * reach the emulated route's verdicts from a fabricated outcome, without an
   * arm64 host, an image or a builder -- the same argument `exec` itself makes.
   * Omitted, an untagged executor is `native`, the strict reading, so a caller
   * cannot get the softer one by forgetting to say anything.
   */
  readonly route?: ExecRoute
}

/**
 * One board, end to end: coverage, image, control, twelve conclusions, verdict.
 *
 * The order is the argument. Coverage first, because a register that has fallen
 * behind its pin files makes every conclusion after it a statement about the
 * wrong set. The control second, because a host that cannot execute the image
 * turns every artifact red for one reason that has nothing to do with any of
 * them. Only then the artifacts.
 */
export async function smokeRun(opts: SmokeRunOptions): Promise<{ results: SmokeResult[], conclusion: Conclusion }> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const board = opts.board ?? readProductEnv(opts.product).board
  const packageRecord = join(outDir(opts.product), 'rootfs-packages.txt')
  const packages = opts.packages ?? (opts.exec === undefined
    ? parsePackageInventory(readFileSync(packageRecord, 'utf8'), 7)
    : undefined)
  // Two lists: the REGISTER, judged for coverage against the pins (every
  // pinned version has an artifact that reads it), and the artifacts this
  // root CARRIES, which are what is executed -- a product that selected no
  // container engine ships no podman, and a run that demanded it would refuse
  // every minimal image.
  const register = opts.artifacts ?? ARTIFACTS
  const artifacts = opts.artifacts ?? (packages === undefined ? ARTIFACTS : artifactsForPackages(packages))

  // Who may go unasked, before what may go unexecuted. Both are questions about
  // the register rather than about the image, and both are answered before a
  // container starts -- a run that executed eleven things and then discovered
  // its twelfth was silently excused has already produced the output somebody
  // would quote.
  const unclaimed = unclaimedFaults(register, opts.allowUnclaimed)
  if (unclaimed.length > 0) {
    throw new Error(
      `the smoke register marks artifacts unclaimed that nothing authorised, so nothing was executed:\n`
      + unclaimed.map(f => `         ${f.file}: ${f.message}`).join('\n'),
    )
  }

  const faults = opts.files === undefined
    ? pinCoverageFaults(register)
    : pinCoverageFaults(register, opts.files)
  if (faults.length > 0) {
    const lines = faults.map(f => `         ${f.file}: ${f.message}`).join('\n')
    throw new Error(
      `the smoke register and the version pins disagree, so nothing was executed:\n${lines}`,
    )
  }

  let exec = opts.exec
  if (exec === undefined) {
    const record = readFactoryRoot(board, outDir(opts.product))
    log(`verify smoke: ${board} ${record.ref} (${record.platform}, ${record.bytes} bytes, sha256 ${record.sha256})`)

    // The register is scoped to the packages the product installed
    // (artifactsForPackages): a minimal product carries the floor and its
    // board package and nothing selectable, so what is executed is what it
    // ships. What is excused is said, by package, rather than left to be
    // inferred from a shorter list; an empty register is refused, because a
    // run that executed nothing is the green nobody would read.
    const owners = ['micad', 'mica-mqttd', 'mica-mqtt-broker', 'mica-deploy', 'mica-podman']
    const absent = owners.filter(p => !packages?.has(p))
    if (absent.length > 0) log(`verify smoke: ${packageRecord} carries no ${absent.join(', ')}; their artifacts are not in this root and are not executed`)
    if (artifacts.length === 0) throw new Error(`smoke has nothing to execute: no artifact of the register is owned by a package in ${packageRecord}`)

    // The image, by ID, for every invocation from here on. `record.ref` names
    // it only in messages: the tag is daemon-global and another worktree on this
    // host loading its own `:uefi-x64` mid-run would otherwise re-point what these
    // containers execute. See loadFactoryRoot.
    try {
      let image = record.ref
      if (opts.load !== false) {
        const loaded = await loadFactoryRoot(record, capture, log)
        image = loaded.id
        log(
          `verify smoke: executing image ${loaded.id}, identified by `
          + `${loaded.source === 'content' ? `the digest ${record.archive} carries` : `the tag ${loaded.ref}`}`,
        )
      }
      // Measure container startup before assigning the per-program budget.
      const control = dockerExec(image, EXEC_STARTUP_BUDGET_MS, capture, dockerRoute(record.platform))
      const startupMs = await preflight(control, record.platform)
      const budget = execTimeoutMs(startupMs)
      log(
        `verify smoke: a container start measured ${startupMs} ms on this host, so each invocation `
        + `gets ${budget} ms (${EXEC_STARTUP_BUDGET_MS} ms of start or ${EXEC_STARTUP_SLACK}x the `
        + `measurement, whichever is larger, plus ${EXEC_PROGRAM_BUDGET_MS} ms for the program)`,
      )
      exec = dockerExec(image, budget, capture, dockerRoute(record.platform))
    }
    catch (e) {
      // Only an unsupported OCI load or platform can select another executor.
      // Corrupt archives and other load/start failures remain hard failures.
      const said = String((e as Error).message ?? e)
      const unsupportedOci = e instanceof OciArchiveLoadUnsupported
      const builder = opts.builder ?? (await builderExists(containerBuilderFor(record.platform))
        ? containerBuilderFor(record.platform)
        : undefined)
      if ((!unsupportedOci && !/exec format error/i.test(said)) || builder === undefined) throw e
      const layout = await extractLayout(record.archivePath, join(outDir(opts.product), 'factory-root.layout'))
      const limitation = unsupportedOci ? 'load OCI archives' : `execute ${record.platform}`
      log(`verify smoke: this host cannot ${limitation}; executing inside buildkit on builder '${builder}' (${layout})`)
      exec = buildkitExec({ ref: record.ref, layout, builder, platform: record.platform })
      await preflight(exec, record.platform)
    }
  }

  // Read off the executor that was actually chosen, not tracked alongside the
  // choice. `opts.route` is only for a fabricated executor that carries no tag.
  const route = opts.route ?? execRoute(exec)

  const results: SmokeResult[] = []
  for (const artifact of artifacts) results.push(await checkArtifact(artifact, exec, route))
  return { results, conclusion: conclude(results, artifacts.length) }
}
