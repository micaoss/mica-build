// The three negative tests: a wrong-arch binary, a missing-soname binary and a
// version-skewed binary, each REALLY made and each required to turn the smoke
// run red.
//
// Not unit tests. smoke.ts reaches every verdict from a fabricated `ExecResult`,
// which is what makes the red branches runnable with no image, daemon or build
// -- but a fabricated result is a statement the test wrote. M7b's map said 126
// meant "a wrong-architecture binary, or a dynamic loader that could not resolve
// it"; measured, wrong-arch is 255, an unresolvable loader is 127, and 126 is a
// mode bit, and the suite stayed green because it chose the numbers. So each
// case here makes the defect in a real image, from the real factory root, with
// the real self-built artifact, and drives the real `docker run` at it.
//
// Every mutation refuses to be a no-op: each Dockerfile asserts its own pre- and
// post-state and exits non-zero if either is not what the mutation requires, so
// a no-op fails the image build naming what it expected. Every case carries its
// positive control, the same artifact through the unmutated root in the same
// pass, and names the diagnosis it must NOT get.
//
// It does not build a rootfs: it reads the factory root the build exported,
// exactly as the smoke runner does, and refuses when there is none, because a
// skip reports the same green as a pass.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT } from './paths.ts'
import { readProductEnv } from './product-env.ts'
import { ARTIFACTS, type Artifact } from './smoke-register.ts'
import type { Pin } from './smoke-pins.ts'
import {
  capture,
  checkArtifact,
  dockerExec,
  EXEC_TIMEOUT_MS,
  loadFactoryRoot,
  preflight,
  readFactoryRoot,
  readMicadBuildFact,
  smokeRun,
  type BuildCommitFact,
  type ExecResult,
  outDir,
} from './smoke.ts'

/** How long an image build may take. One layer over a loaded root; seconds. */
export const BUILD_TIMEOUT_MS = 300_000

/**
 * One deliberately broken image, and what the runner must say about it.
 *
 * `mustNotSay` is not decoration. Each of the first two cases exists because the
 * shipped diagnosis named the wrong cause, and a case asserting only that the
 * verdict is `fail` would have passed against that diagnosis -- it was failing,
 * just about the wrong thing. Naming the misdiagnosis is what makes the case a
 * test of the message rather than of the exit code.
 */
export interface NegativeCase {
  /** Short name, printed and used in the image tag. */
  readonly name: string
  /** Which of the three defect shapes this case makes. */
  readonly clause: string
  /** The register entry it breaks. Everything else in the root is untouched. */
  readonly artifact: string
  /**
    * The mutation, as the body of a Dockerfile whose FROM is the factory root.
    *
    * It is handed the pin, so the version-skew case is not a special case
    * dispatched on the case's NAME. A name-keyed branch here would be a case
    * that silently stops being mutated the day somebody renames it -- and the
    * empty body that branch would then produce builds the UNMUTATED root, which
    * is the exact shape of a negative test that passes having tested nothing.
    * `runCase` refuses an empty body for the same reason, as a second net.
    */
  readonly mutation: (artifact: Artifact, pin: Pin) => string
  /** What the resulting failure must say. */
  readonly mustSay: RegExp
  /** The diagnosis it must NOT get, and why that one would be wrong. */
  readonly mustNotSay: RegExp
  readonly mustNotSayWhy: string
}

/** The version one patch above a pin: `1.29.1` -> `1.29.2`. */
export function skewedFrom(version: string): string {
  const parts = version.split('.')
  const last = parts[parts.length - 1]!
  const n = Number(last)
  if (!Number.isInteger(n)) {
    throw new Error(
      `cannot skew the version '${version}': its last component '${last}' is not a number, so this `
      + `case cannot construct a version that is DIFFERENT and still version-shaped. A skew that `
      + `produced the same string would be a case that passes without testing anything.`,
    )
  }
  parts[parts.length - 1] = String(n + 1)
  return parts.join('.')
}

/**
 * The three cases.
 *
 * Two of them break `crun` and one breaks `mica-deploy`, and that is chosen rather than
 * incidental: both are self-built, both are dynamically linked against this
 * root's own libraries, and `libgcc_s.so.1` -- measured in the x64
 * factory root -- is NEEDed by `/usr/bin/mica-deploy` and by nothing else the register
 * covers. So the missing-soname case fails exactly one artifact, and the run
 * that reports it says so.
 */
export const CASES: readonly NegativeCase[] = [
  {
    name: 'wrong-arch',
    clause: 'a deliberately wrong-arch binary fails the build',
    artifact: 'crun',
    // One byte. e_machine lives at offset 18 of every ELF header; 0x3E is
    // x86-64 and 0xB7 is AArch64. The binary is otherwise the real, working,
    // self-built crun -- so what the kernel refuses is the architecture and
    // nothing else. This is the exact path a genuinely cross-built binary
    // takes: binfmt_elf's elf_check_arch() rejects it with ENOEXEC before a
    // single instruction runs.
    //
    // NOT a truncated or corrupted file, deliberately. A corrupt binary fails
    // for a dozen reasons at once and proves nothing about which one was
    // caught; one byte is a mutation whose effect can only be the one named.
    mutation: a => `RUN set -eu; \\
    p='${a.path}'; \\
    set -- $(dd if="$p" bs=1 skip=18 count=1 status=none | od -An -tx1); \\
    before="$1"; \\
    [ "$before" = '3e' ] || { echo "REFUSING: e_machine at offset 18 of $p is 0x$before, not 0x3e (x86-64). This mutation would not be one." >&2; exit 1; }; \\
    printf '\\267' | dd of="$p" bs=1 seek=18 count=1 conv=notrunc status=none; \\
    set -- $(dd if="$p" bs=1 skip=18 count=1 status=none | od -An -tx1); \\
    after="$1"; \\
    [ "$after" = 'b7' ] || { echo "REFUSING: the write did not take; e_machine is 0x$after, wanted 0xb7." >&2; exit 1; }; \\
    [ "$before" != "$after" ] || { echo "REFUSING: the mutation changed nothing." >&2; exit 1; }; \\
    echo "mutated $p: e_machine 0x$before -> 0x$after (x86-64 -> AArch64)"`,
    mustSay: /could not be executed AT ALL|ENOEXEC/,
    mustNotSay: /the program ran and refused/,
    mustNotSayWhy:
      'it never ran -- the kernel refused the ELF image, so "the program ran and refused" sends a '
      + 'reader looking for an argument parser in a binary that reached no code at all. This is the '
      + 'diagnosis the shipped map gave it, because wrong-arch is 255 and 255 was the catch-all.',
  },
  {
    name: 'missing-soname',
    clause: 'a deliberately missing-soname binary fails the build',
    artifact: 'mica-deploy',
    // The library is REMOVED rather than the binary rewritten, because that is
    // the shape this actually takes in a build: an install stage stops copying a
    // dependency, or a feature stage that provided it is declined, and the
    // binary that NEEDs it is shipped unchanged. The path is DERIVED from ldd
    // rather than written down, so the case is not x86-only.
    //
    // `ldd` into a file and then grep it -- NOT `ldd ... | grep -q`. That
    // pipeline inverts its own answer under pipefail (grep exits at the first
    // match, ldd dies of SIGPIPE, the pipeline reports the producer's failure),
    // which is the footgun tests/shell-pipefail-lint.sh exists to police. It
    // would not fire here, and writing it anyway would be a pattern to copy.
    mutation: a => `RUN set -eu; \\
    p='${a.path}'; \\
    ldd "$p" > /tmp/needed.txt; \\
    lib="$(sed -n 's|.*=> \\(/[^ ]*libgcc_s[^ ]*\\).*|\\1|p' /tmp/needed.txt | head -1)"; \\
    [ -n "$lib" ] || { echo "REFUSING: $p does not NEED libgcc_s in this root, so removing it would mutate nothing. Its NEEDs are:" >&2; cat /tmp/needed.txt >&2; exit 1; }; \\
    [ -e "$lib" ] || { echo "REFUSING: $lib is not there to remove." >&2; exit 1; }; \\
    rm -f "$lib"; \\
    [ ! -e "$lib" ] || { echo "REFUSING: the removal did not take; $lib is still there." >&2; exit 1; }; \\
    rm -f /tmp/needed.txt; \\
    echo "mutated: removed $lib, which $p NEEDs"`,
    mustSay: /dynamic loader could not resolve it/,
    mustNotSay: /path does not exist in the factory root/,
    mustNotSayWhy:
      'the path is there -- what is missing is a library it NEEDs. That diagnosis sends a reader to '
      + 'the register and to the install script for a binary that is installed exactly where the '
      + 'register says. The shipped map gave it this one, because a missing soname and a missing '
      + 'path share exit status 127 and the map read only the status.',
  },
  {
    name: 'version-skew',
    clause: 'a deliberately version-skewed binary fails the build',
    artifact: 'crun',
    // The binary is skewed, not the pin, and that is which half of the loop this
    // case owns. The other half -- bump a pin without rebuilding -- is driven
    // end to end in smoke.test.ts. Moving the binary leaves the repository
    // alone: a negative test that edited a tracked versions.env would have to
    // put it back, and a test whose cleanup can fail is a test that can leave
    // the tree wrong.
    //
    // The expected pre-state is read from the pin by the caller and interpolated
    // here, so a legitimate version bump makes this mutation refuse by name
    // instead of quietly skewing from a stale constant.
    mutation: (a, pin) => versionSkewMutation(a, pin.expected, skewedFrom(pin.expected)),
    mustSay: /Either the pin was bumped without rebuilding the artifact/,
    mustNotSay: /exited/,
    mustNotSayWhy:
      'it exits 0. A version-skewed binary RUNS -- that is the whole reason this case exists '
      + 'separately from the other two: every exit-status check in the runner is satisfied by it, '
      + 'and only the version comparison is not.',
  },
]

/** The version-skew mutation, which needs the pin the caller resolved. */
export function versionSkewMutation(a: Artifact, expected: string, skewed: string): string {
  return `RUN set -eu; \\
    p='${a.path}'; \\
    real="$("$p" --version | head -1)"; \\
    case "$real" in *'${expected}'*) ;; *) echo "REFUSING: $p reports \\"$real\\", which does not contain the pinned ${expected}. Skewing from a version that is not there would test nothing." >&2; exit 1 ;; esac; \\
    printf '#!/bin/sh\\necho "crun version ${skewed}"\\n' > "$p"; \\
    chmod 755 "$p"; \\
    now="$("$p" --version)"; \\
    [ "$now" = 'crun version ${skewed}' ] || { echo "REFUSING: the shim did not take; $p now says \\"$now\\"." >&2; exit 1; }; \\
    [ "$now" != "$real" ] || { echo "REFUSING: the mutation changed nothing." >&2; exit 1; }; \\
    echo "mutated $p: reports ${skewed}, pin says ${expected}"`
}

export interface CaseOutcome {
  readonly name: string
  /** Did the negative test hold? Not the artifact's verdict, which must be `fail`. */
  readonly held: boolean
  readonly lines: readonly string[]
}

function artifactNamed(name: string): Artifact {
  const a = ARTIFACTS.find(x => x.name === name)
  if (a === undefined) {
    throw new Error(
      `no register entry is named '${name}'. This file names the artifacts it breaks, and a name `
      + `that matches nothing would build the UNMUTATED image and report a case that never ran.`,
    )
  }
  return a
}

/** `docker build` one mutated image. A no-op mutation fails HERE, by design. */
async function buildMutated(base: string, tag: string, body: string): Promise<ExecResult> {
  const ctx = mkdtempSync(join(REPO_ROOT, '_out', 'smoke-negative-'))
  try {
    writeFileSync(join(ctx, 'Dockerfile'), `FROM ${base}\n${body}\n`)
    // --network=none: the mutation touches only what is already in the root, and
    // a build that could reach a registry is a build whose result could depend
    // on one. --no-cache would be wrong here and is deliberately absent: the
    // layer is content-addressed on the Dockerfile text, and the text carries
    // the pin, so a cache hit is a hit on exactly this mutation of exactly this
    // base.
    return await capture(['docker', 'build', '--network=none', '-t', tag, ctx], BUILD_TIMEOUT_MS)
  } finally {
    rmSync(ctx, { recursive: true, force: true })
  }
}

async function removeImage(tag: string): Promise<void> {
  await capture(['docker', 'image', 'rm', '-f', tag], EXEC_TIMEOUT_MS)
}

/**
 * Drive one case: build the defect, run the artifact in it, and check the whole
 * run went red for that artifact and no other.
 *
 * Five things are asserted and each rules out a different way of passing
 * vacuously:
 *
 *   1. the image BUILT -- a mutation that changed nothing exits non-zero above;
 *   2. `preflight` still passes on the mutated image -- so the failure is
 *      attributable to the artifact and not to a host that cannot run the image
 *      at all, which is the one condition that turns everything red at once;
 *   3. the UNMUTATED artifact passes through the same runner in the same pass;
 *   4. the mutated artifact fails, SAYING the right thing and not the wrong one;
 *   5. the whole run concludes FAIL with exit 1 and exactly one failure, named.
 *
 * (5) is the clause's verb. `rootfs/build.sh` runs `run.sh --smoke` under
 * `set -e` as its last step, so a run that exits non-zero is a build that fails
 * -- and a mutation that turned the run red without moving the exit code would
 * satisfy every other assertion here.
 */
export async function runCase(
  c: NegativeCase,
  base: string,
  platform: string,
  product: string,
  board: string,
  build: BuildCommitFact,
  stamp: string,
): Promise<CaseOutcome> {
  const lines: string[] = []
  const say = (l: string): void => { lines.push(l) }
  const artifact = artifactNamed(c.artifact)
  const tag = `mica-smoke-negative:${c.name}-${stamp}`

  const body = c.mutation(artifact, artifact.pin())
  if (body === '') {
    return { name: c.name, held: false, lines: [`the case produced an EMPTY mutation, so the image would be the unmutated root`] }
  }

  try {
    // 1. the defect is really made
    const built = await buildMutated(base, tag, body)
    if (built.status !== 0) {
      say(`the mutated image did not build (docker build exited ${built.status}).`)
      say(`This is where a mutation that changed nothing lands: each one asserts its own`)
      say(`pre-state and post-state and refuses rather than producing an unmutated image.`)
      for (const l of (built.stderr + built.stdout).split('\n').filter(x => x.includes('REFUSING') || x.includes('error'))) say(`  ${l.trim()}`)
      return { name: c.name, held: false, lines }
    }
    const echoed = built.stdout.split('\n').concat(built.stderr.split('\n')).filter(l => l.includes('mutated'))
    for (const l of echoed) say(`mutation: ${l.trim()}`)

    const mutatedExec = dockerExec(tag)

    // 2. the image is still runnable, so the failure is about the artifact
    try {
      await preflight(mutatedExec, platform)
      say(`control: preflight passes on the MUTATED image -- /bin/true still exits 0, so what fails below is the artifact and not the image`)
    } catch (e) {
      say(`preflight failed on the mutated image: ${(e as Error).message.split('\n')[0]}`)
      say(`The mutation was supposed to break ONE artifact; it broke the image, and every`)
      say(`artifact would now be red for one reason that is nothing to do with any of them.`)
      return { name: c.name, held: false, lines }
    }

    // 3. the positive control, through the unmutated root
    const control = await checkArtifact(artifact, dockerExec(base), build)
    if (control.verdict !== 'pass') {
      say(`the POSITIVE CONTROL failed: ${artifact.name} does not pass in the UNMUTATED root either.`)
      say(`  ${control.message}`)
      say(`So a red below would not be about the mutation.`)
      return { name: c.name, held: false, lines }
    }
    say(`control: ${artifact.name} passes in the unmutated root -- ${control.message}`)

    // 4. the mutated artifact, and the diagnosis
    const broken = await checkArtifact(artifact, mutatedExec, build)
    say(`mutated: ${broken.verdict.toUpperCase()} ${artifact.name} -- ${broken.message}`)
    if (broken.verdict !== 'fail') {
      say(`EXPECTED fail. The defect was made and the runner did not notice it.`)
      return { name: c.name, held: false, lines }
    }
    if (!c.mustSay.test(broken.message)) {
      say(`the failure does not say ${c.mustSay}, so it fails for a reason nobody named.`)
      return { name: c.name, held: false, lines }
    }
    if (c.mustNotSay.test(broken.message)) {
      say(`the failure says ${c.mustNotSay}, which is the WRONG diagnosis: ${c.mustNotSayWhy}`)
      return { name: c.name, held: false, lines }
    }
    say(`diagnosis: says ${c.mustSay}, and does not say ${c.mustNotSay}`)

    // 5. the whole run, which is what a build path reads
    const run = await smokeRun({ product, board, exec: mutatedExec, buildCommit: build })
    const failed = run.results.filter(r => r.verdict === 'fail').map(r => r.name)
    if (run.conclusion.conclusion !== 'FAIL' || run.conclusion.exitCode === 0) {
      say(`the WHOLE RUN did not go red: ${run.conclusion.line}, exit ${run.conclusion.exitCode}.`)
      return { name: c.name, held: false, lines }
    }
    if (failed.join(' ') !== artifact.name) {
      say(`the run failed on ${failed.length === 0 ? 'nothing' : failed.join(', ')}, not on ${artifact.name} alone.`)
      say(`A mutation that takes other artifacts with it cannot show which defect was caught.`)
      return { name: c.name, held: false, lines }
    }
    say(`run: ${run.conclusion.line}, exit ${run.conclusion.exitCode} -- and the one failure is ${failed[0]}`)
    return { name: c.name, held: true, lines }
  } finally {
    await removeImage(tag)
  }
}

export interface NegativeRun {
  readonly outcomes: readonly CaseOutcome[]
  readonly conclusion: 'PASS' | 'FAIL'
  readonly exitCode: number
  readonly line: string
}

/**
 * Every case, against the board's real factory root.
 *
 * The vacuity guard is `conclude`'s, for `conclude`'s reason: a summary line is
 * invariant under a run that threw half its work away. `RESULT: PASS (3/3)`
 * reads identically whether three cases ran or the list was empty, so the count
 * is compared against the declared case list and an empty list is a failure
 * rather than a perfect score.
 */
export async function negativeRun(opts: {
  /** The product whose composition is broken three ways. */
  readonly product: string
  readonly board?: string
  readonly cases?: readonly NegativeCase[]
  readonly log?: (line: string) => void
}): Promise<NegativeRun> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const cases = opts.cases ?? CASES

  // The vacuity guard is first, before any image is read or loaded. `smokeRun`
  // orders its own guards the same way and says why: a run that got as far as
  // loading a 250 MB archive and starting a container before discovering it had
  // nothing to do has already spent the time and already printed the header a
  // reader would quote. It also means this refusal is reachable from the suite
  // without a daemon, which is where a guard against an emptied list has to be
  // reachable -- the one host that would otherwise exercise it is one that has
  // just built an image.
  if (cases.length === 0) {
    return {
      outcomes: [],
      conclusion: 'FAIL',
      exitCode: 1,
      line: 'RESULT: FAIL (an EMPTY case list concludes nothing; three negative tests are owed)',
    }
  }

  const board = opts.board ?? readProductEnv(opts.product).board
  const record = readFactoryRoot(board, outDir(opts.product))
  log(`verify negative: ${opts.product} on ${board} ${record.ref} (${record.platform}, ${record.bytes} bytes)`)
  // What the load RESOLVED, never `record.ref`. That tag is daemon-global and
  // this campaign runs two and three worktrees at once: a sibling loading its
  // own `:x64` between this load and the last case would make every mutation,
  // every positive control and every verdict here a statement about somebody
  // else's root -- and each case would still look like it held. It is the same
  // change `smokeRun` took, for the same reason; see loadFactoryRoot.
  const loaded = await loadFactoryRoot(record, capture, log)
  log(
    `verify negative: mutating image ${loaded.id}, identified by `
    + `${loaded.source === 'content' ? `the digest ${record.archive} carries` : `the tag ${loaded.ref}`}`,
  )
  await preflight(dockerExec(loaded.id), record.platform)
  log(`verify negative: the unmutated root executes on this host -- the controls below can be green`)

  const build = readMicadBuildFact(board, outDir(opts.product))
  log(
    build.commit === undefined
      ? `verify negative: build commit NOT ASSERTED -- ${build.source}`
      : `verify negative: build commit ${build.commit}, from ${build.source}`,
  )

  // The tag suffix is derived from the record rather than from a clock: two
  // runs against the same root reuse the same layer, and nothing here needs a
  // fresh name -- what it needs is a name that cannot collide with a DIFFERENT
  // root's mutated image left behind by another worktree on this host.
  const stamp = record.sha256.slice(0, 12)

  // The mutations are `docker build`s, and buildkit's `FROM` resolves a NAME:
  // measured on docker 29.7.2, `FROM sha256:<id>` is read as the repository
  // `docker.io/library/sha256:<id>` and the build dies of `pull access denied`,
  // and `FROM localhost/mica-factory-root@sha256:<id>` dies of `not found`. So
  // the ID is pinned into a name this run makes from it. That name is derived
  // from the archive's own sha256, so a sibling that writes it writes it for a
  // byte-identical root; the daemon-global `:x64` it replaces is the one another
  // worktree can re-point mid-run. Nothing removes it: it is a second name for a
  // healthy image, it is re-pointed rather than accumulated, and a `docker image
  // rm` of it could take the root out from under a sibling mid-build.
  const base = `mica-smoke-negative:base-${stamp}`
  const tagged = await capture(['docker', 'tag', loaded.id, base], EXEC_TIMEOUT_MS)
  if (tagged.status !== 0) {
    throw new Error(
      `could not name ${loaded.id} as ${base} (docker tag exited ${tagged.status}: `
      + `${tagged.stderr.trim() || tagged.stdout.trim()}), so the mutations below would have to be `
      + `built FROM the daemon-global ${record.ref} -- a name another worktree on this host can `
      + `re-point between now and the last case.`,
    )
  }
  log(`verify negative: ${loaded.id} is named ${base} for this run; every mutation is built FROM that`)

  const outcomes: CaseOutcome[] = []
  for (const c of cases) {
    log('')
    log(`── ${c.name} ── ${c.clause}`)
    log(`   breaks ${c.artifact}; everything else in the root is untouched`)
    const o = await runCase(c, base, record.platform, opts.product, board, build, stamp)
    for (const l of o.lines) log(`   ${l}`)
    log(`   ${o.held ? 'HELD' : 'DID NOT HOLD'}`)
    outcomes.push(o)
  }

  if (outcomes.length !== cases.length) {
    return {
      outcomes,
      conclusion: 'FAIL',
      exitCode: 1,
      line: `RESULT: FAIL (${outcomes.length} conclusions from a list of ${cases.length} cases)`,
    }
  }
  const held = outcomes.filter(o => o.held).length
  const ok = held === cases.length
  return {
    outcomes,
    conclusion: ok ? 'PASS' : 'FAIL',
    exitCode: ok ? 0 : 1,
    line: `RESULT: ${ok ? 'PASS' : 'FAIL'} (${held} of ${cases.length} negative tests held)`,
  }
}

