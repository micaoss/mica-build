// The runner, driven from the failing side without a daemon, an image or a build.
//
// Everything here is reachable because the
// runner takes an `Exec` -- a function from argv to (status, stdout, stderr) --
// so the suite fabricates outcomes a healthy tree can never produce: a
// wrong-architecture refusal, a binary that is not where the register says, a
// version that does not match its pin. A harness that could only be exercised
// against a correct image would have no way to show that its RED branches work,
// and a check whose red branch has never run is a check nobody has run.
//
// The version loop is tested as a loop, not as a comparison: bumping a
// `upstream.lock` pin without rebuilding the artifact must turn the smoke run
// red, and the case below does exactly that -- one fixture file, one unchanged
// binary output, one edit to the pin, and the verdict flips. Asserting `judge`
// on two literals would test the comparison and say nothing about whether the
// pin is re-read from the file it lives in.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './paths.ts'
import { readPin, type Pin } from './smoke-pins.ts'
import { ARTIFACTS, type Artifact } from './smoke-register.ts'
import {
  archiveImageDigests,
  blobMember,
  capture,
  conclude,
  checkArtifact,
  diagnose,
  dockerArgv,
  loadFactoryRoot,
  OciArchiveLoadUnsupported,
  loadTimeoutMs,
  parseArchiveIndex,
  parseArchiveManifest,
  EXEC_TIMEOUT_MS,
  EXEC_PROGRAM_BUDGET_MS,
  EXEC_STARTUP_BUDGET_MS,
  EXEC_STARTUP_SLACK,
  execTimeoutMs,
  LOAD_TIMEOUT_BYTES_PER_MS,
  LOAD_TIMEOUT_FLOOR_MS,
  factoryRootPaths,
  firstLine,
  judge,
  parseFactoryRootRecord,
  pinSource,
  preflight,
  readFactoryRoot,
  smokeRun,
  declinedFeatures,
  dockerExec,
  dockerRoute,
  execRoute,
  versionTokens,
  type Exec,
  type ExecResult,
  type SmokeResult,
} from './smoke.ts'
import { buildkitArgv, buildkitDockerfile, buildkitExec } from './smoke.ts'

let SCRATCH = ''
beforeAll(() => {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  SCRATCH = mkdtempSync(join(REPO_ROOT, '_out', 'verify-smoke-'))
})
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

function scratch(): string {
  if (SCRATCH === '') throw new Error('the scratch directory was read before beforeAll created it')
  return SCRATCH
}

/** A textual mutation that refuses to be a no-op -- see checks-bootchain.test.ts. */
function mutate(text: string, from: string | RegExp, to: string): string {
  const after = text.replace(from as never, to)
  if (after === text) {
    throw new Error(
      `the mutation ${String(from)} -> '${to}' changed nothing; the fixture is unmutated and any `
      + `RED this case reports is about something else`,
    )
  }
  return after
}

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: '' })
const pin = (recorded: string, expected = recorded): Pin =>
  ({ recorded, expected, file: '/x/upstream.lock', key: 'thing' })

function versionArtifact(name = 'thing', path = '/usr/bin/thing', p: () => Pin = () => pin('v1.2.3', '1.2.3')): Artifact {
  return { name, path, pin: p, contract: { kind: 'version', argv: ['--version'] } }
}

// the tokeniser

describe('versionTokens -- one reader for ten different sentences', () => {
  // The ten real outputs, captured 2026-08-26 by running each binary inside the
  // uefi-x64 factory root built from this tree. These are the positive controls, and
  // they are measurements rather than guesses -- five of them are not in
  // /usr/bin, which is how the shapes came to be read off the real thing.
  const MEASURED: ReadonlyArray<readonly [string, string]> = [
    ['rauc 1.13', '1.13'],
    ['podman version 5.8.6', '5.8.6'],
    ['5.8.6', '5.8.6'],
    ['crun version 1.29.1', '1.29.1'],
    ['conmon version 2.2.1', '2.2.1'],
    ['netavark 2.1.0', '2.1.0'],
    ['aardvark-dns 2.1.0', '2.1.0'],
    ['tini version 0.2.1_catatonit', '0.2.1'],
    ['mica-mqttd 0.1.0', '0.1.0'],
    ['mica-mqtt-broker 0.1.0', '0.1.0'],
  ]

  test('every measured --version line yields its version', () => {
    // The search space, stated: ten lines, not an empty table that would make
    // the loop below vacuous.
    expect(MEASURED.length).toBe(10)
    for (const [line, want] of MEASURED) {
      expect(versionTokens(line)).toContain(want)
    }
  })

  // Maximal munch is the point. A `contains` over a substring would let a
  // 1.29.10 binary satisfy a 1.29.1 pin, which is a version skew reported as
  // agreement -- the exact failure the smoke run exists to catch.
  test('a longer version does not satisfy a shorter pin', () => {
    expect(versionTokens('crun version 1.29.10')).toEqual(['1.29.10'])
    expect(versionTokens('crun version 1.29.10')).not.toContain('1.29.1')
  })

  test('a prefixed version does not satisfy a shorter pin either', () => {
    expect(versionTokens('thing 11.29.1')).toEqual(['11.29.1'])
    expect(versionTokens('thing 11.29.1')).not.toContain('1.29.1')
  })

  test('a leading v is read through, because some tools print one', () => {
    expect(versionTokens('thing v1.2.3')).toEqual(['1.2.3'])
  })

  // The case a right-hand guard broke. The first version of versionTokens
  // carried `(?![.0-9])`, which greed already made redundant -- and which
  // rejected a version at the end of a sentence, yielding no token at all and
  // turning a correct binary red. Locked in here so the guard cannot come back.
  test('a version followed by a full stop is still a version', () => {
    expect(versionTokens('Built from crun version 1.29.1.')).toEqual(['1.29.1'])
    expect(versionTokens('thing 1.2.3, and more')).toEqual(['1.2.3'])
  })

  test('the LEFT guard is load-bearing: a token may not start inside a longer run', () => {
    // Without it, `11.29.1` offers `1.29.1` and a skewed binary reads as agreeing.
    expect(versionTokens('thing 11.29.1')).not.toContain('1.29.1')
    // ...and it blocks a dotted prefix too, e.g. a shared-object name.
    expect(versionTokens('libcrun.so.1.2.3')).toEqual([])
  })

  test('a hex commit hash is not mistaken for a version', () => {
    expect(versionTokens('commit: f0d911de5587342cfeb16473bf32ecdfeaf25957')).toEqual([])
  })

  test('a line with no dotted number yields nothing, rather than something wrong', () => {
    expect(versionTokens('conmon version')).toEqual([])
    expect(versionTokens('')).toEqual([])
    // Recorded behaviour, not an accident: a single-component version is not a
    // token. No pin in this tree is one; if one ever is, this run goes red with
    // "reports NO version at all" rather than passing by accident.
    expect(versionTokens('thing 5')).toEqual([])
  })

  test('several versions on one line are all offered', () => {
    expect(versionTokens('client 1.2.3, server 4.5.6')).toEqual(['1.2.3', '4.5.6'])
  })

  // micad and apid report the git commit alongside the crate version:
  // `micad <version> (<short-sha>)`, `-dirty` when the worktree is, `unknown`
  // when the value is absent. Nothing here hard-codes a `name X.Y.Z` shape, so
  // the parser should already take it -- and "should already" is exactly the
  // reasoning these cases exist to replace.
  test('a version line carrying a git short-sha yields the version and not the sha', () => {
    expect(versionTokens('micad 0.1.0 (abc1234)')).toEqual(['0.1.0'])
    expect(versionTokens('apid 0.1.0 (unknown)')).toEqual(['0.1.0'])
  })

  test('an ALL-DIGIT short sha is still not a version token', () => {
    // The case that would break a looser reader: a sha can be seven digits.
    // It has no dot, so it cannot form a token, and the version is unambiguous.
    expect(versionTokens('micad 0.1.0 (0123456)')).toEqual(['0.1.0'])
    expect(versionTokens('micad 0.1.0 (1234567-dirty)')).toEqual(['0.1.0'])
  })

  test('two-digit components survive the sha suffix', () => {
    expect(versionTokens('micad 0.10.0 (abc1234)')).toEqual(['0.10.0'])
  })

  // A measured limit, recorded rather than discovered later. If a crate ever
  // takes a pre-release version the pin and the output would BOTH carry the
  // suffix, the token would be the numeric head only, and this run would go
  // RED naming both sides -- visible, not a silent pass. Stated so M7d knows
  // the boundary without having to find it.
  test('a Debian revision is part of the token, so a package version is compared whole', () => {
    expect(versionTokens('micad 0.1.0-1')).toEqual(['0.1.0-1'])
    expect(judge(versionArtifact(), pin('0.1.0-1'), ok('micad 0.1.0-1')).verdict).toBe('pass')
    // The upstream part alone does not satisfy a package-version pin, nor the reverse.
    expect(judge(versionArtifact(), pin('0.1.0-1'), ok('micad 0.1.0')).verdict).toBe('fail')
    const r = judge(versionArtifact(), pin('0.1.0'), ok('micad 0.1.0-1'))
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('expected 0.1.0')
  })

  test('the reported line is carried into the PASS message', () => {
    const r = judge(versionArtifact(), pin('0.1.0-1'), ok('micad 0.1.0-1'))
    expect(r.verdict).toBe('pass')
    expect(r.message).toContain('micad 0.1.0-1')
  })
})

describe('firstLine', () => {
  test('takes the first non-empty line, trimmed', () => {
    expect(firstLine('\n\n  rauc 1.13  \nsecond\n')).toBe('rauc 1.13')
  })
  test('is empty for output that has none', () => {
    expect(firstLine('   \n\n')).toBe('')
  })
})

describe('pinSource', () => {
  test('is repo-relative, so four pin rows are four different files', () => {
    expect(pinSource(join(REPO_ROOT, 'locks', 'mica-core.lock'))).toBe('locks/mica-core.lock')
    expect(pinSource(join(REPO_ROOT, 'locks', 'mica-podman.lock'))).toBe('locks/mica-podman.lock')
  })
  test('leaves a path outside the repository alone rather than mangling it', () => {
    expect(pinSource('/elsewhere/upstream.lock')).toBe('/elsewhere/upstream.lock')
  })
})

// judge

describe('judge -- the version contract', () => {
  test('exit 0 and the pinned version passes, and says where the pin came from', () => {
    const r = judge(versionArtifact(), pin('v1.2.3', '1.2.3'), ok('thing 1.2.3'))
    expect(r.verdict).toBe('pass')
    expect(r.message).toContain('thing=v1.2.3')
  })

  test('exit 0 and the WRONG version fails, naming both sides', () => {
    const r = judge(versionArtifact(), pin('v1.2.3', '1.2.3'), ok('thing 1.2.4'))
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('1.2.4')
    expect(r.message).toContain('expected 1.2.3')
    expect(r.message).toMatch(/pin was bumped without rebuilding the artifact/)
  })

  test('exit 0 and NO version at all fails, and says so in those words', () => {
    const r = judge(versionArtifact(), pin('v1.2.3', '1.2.3'), ok('thing: no idea'))
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('NO version at all')
  })

  // Every diagnosis, against the status and text measured producing it. A
  // fabricated `ExecResult` lets a test choose the status whose diagnosis it
  // then asserts, so this table would otherwise agree with itself and with
  // nothing else: `diagnose`'s comment carries the measurement, and
  // src/smoke-negative.ts drives all three through a real container.
  //
  // The literals below are the MEASURED first lines, verbatim, not paraphrases.
  const WRONG_ARCH = { status: 255, stdout: '', stderr: 'exec /usr/bin/crun: exec format error\n' }
  const MISSING_SONAME = {
    status: 127,
    stdout: '',
    stderr: '/usr/bin/rauc: error while loading shared libraries: libjson-glib-1.0.so.0: '
      + 'cannot open shared object file: No such file or directory\n',
  }
  const ABSENT_PATH = {
    status: 127,
    stdout: '',
    stderr: 'docker: Error response from daemon: ... exec: "/usr/bin/nope": stat /usr/bin/nope: '
      + 'no such file or directory.\n',
  }
  const NOT_EXECUTABLE = {
    status: 126,
    stdout: '',
    stderr: 'docker: Error response from daemon: ... exec: "/usr/bin/crun": permission denied.\n',
  }

  test('a wrong-arch binary is ENOEXEC at 255, and is NOT reported as the program refusing', () => {
    const r = judge(versionArtifact(), pin('1.2.3'), WRONG_ARCH)
    expect(r.verdict).toBe('fail')
    expect(r.message).toMatch(/could not be executed AT ALL/)
    expect(r.message).toMatch(/ENOEXEC/)
    // The regression this replaced: 255 fell through to the catch-all.
    expect(r.message).not.toMatch(/the program ran and refused/)
  })

  test('a wrong-arch binary on a host with a qemu-user handler for that architecture is the same refusal', () => {
    // Measured on an x86-64 host with qemu-aarch64 registered through binfmt_misc: the AArch64-marked
    // x86-64 crun reaches qemu, which refuses the x86-64 interpreter it names.
    const r = judge(versionArtifact(), pin('1.2.3'), { status: 255, stdout: '', stderr: 'qemu-aarch64: /lib64/ld-linux-x86-64.so.2: Invalid ELF image for this architecture\n' })
    expect(r.verdict).toBe('fail')
    expect(r.message).toMatch(/could not be executed AT ALL/)
    expect(r.message).not.toMatch(/the program ran and refused|could not be started on this path/)
  })

  test('a missing soname is 127 and is NOT reported as a missing path', () => {
    const r = judge(versionArtifact(), pin('1.2.3'), MISSING_SONAME)
    expect(r.verdict).toBe('fail')
    expect(r.message).toMatch(/dynamic loader could not resolve it/)
    // The regression this replaced: it shares 127 with the case below, and the
    // old map sent it to that one -- a reader was told to go and look at the
    // register or the install script for a path that is present.
    expect(r.message).not.toMatch(/path does not exist/)
  })

  test('an absent path is also 127, and the two 127s are told apart by what came back', () => {
    // The positive control for the case above. Same status, opposite diagnosis;
    // if `diagnose` keyed on the status alone this pair could not both pass.
    const r = judge(versionArtifact(), pin('1.2.3'), ABSENT_PATH)
    expect(r.verdict).toBe('fail')
    expect(r.message).toMatch(/path does not exist in the factory root/)
    expect(r.message).not.toMatch(/dynamic loader/)
  })

  test('126 is a mode bit, and says so rather than naming an architecture', () => {
    const r = judge(versionArtifact(), pin('1.2.3'), NOT_EXECUTABLE)
    expect(r.verdict).toBe('fail')
    expect(r.message).toMatch(/no\s+executable bit/)
    expect(r.message).toMatch(/90-pack/)
    expect(r.message).not.toMatch(/wrong-architecture/)
  })

  test('any other non-zero status is the program refusing, and is not confused with the rest', () => {
    const r = judge(versionArtifact(), pin('1.2.3'), { status: 1, stdout: '', stderr: 'nope' })
    expect(r.verdict).toBe('fail')
    expect(r.message).toMatch(/the program ran and refused/)
    expect(r.message).not.toMatch(/wrong-architecture|dynamic loader|executable bit/)
  })

  test('255 with no recognised text says so rather than inventing a cause', () => {
    const r = judge(versionArtifact(), pin('1.2.3'), { status: 255, stdout: '', stderr: 'docker: something else' })
    expect(r.message).toMatch(/could not be started on this path at all/)
    expect(r.message).toMatch(/read the stderr/)
  })

  test('the text outranks the status, in both directions', () => {
    // ld.so's sentence is what identifies a missing soname, not 127: the same
    // sentence arriving with any other status must reach the same conclusion,
    // because a runner that believed the number over the message would go back
    // to being right only about the cases somebody happened to fabricate.
    expect(judge(versionArtifact(), pin('1.2.3'), { ...MISSING_SONAME, status: 1 }).message)
      .toMatch(/dynamic loader could not resolve it/)
    expect(judge(versionArtifact(), pin('1.2.3'), { ...WRONG_ARCH, status: 126 }).message)
      .toMatch(/ENOEXEC/)
  })

  test('a non-zero status is a failure even when the output DOES carry the right version', () => {
    // The exit-status half of the Scope sentence, on its own. A binary that
    // prints the right version and dies is not a binary that runs.
    const r = judge(versionArtifact(), pin('1.2.3'), { status: 3, stdout: 'thing 1.2.3', stderr: '' })
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('exited 3, expected 0')
  })
})

describe('judge -- the exec-only and unclaimed contracts', () => {
  const execArtifact: Artifact = {
    name: 'static-thing',
    path: '/usr/bin/static-thing',
    pin: () => pin('v0.2.1', '0.2.1'),
    contract: { kind: 'exec', argv: [] },
  }

  test('exec-only passes on exit 0 and says no version was asserted', () => {
    const r = judge(execArtifact, pin('v0.2.1', '0.2.1'), ok('usage: static-thing ...'))
    expect(r.verdict).toBe('pass')
    expect(r.message).toContain('no version asserted')
  })

  test('exec-only still fails on a non-zero exit', () => {
    expect(judge(execArtifact, pin('v0.2.1', '0.2.1'), { status: 1, stdout: '', stderr: 'x' }).verdict).toBe('fail')
  })

  test('exec-only does NOT go red on output that carries the wrong version', () => {
    // Stated so the difference between the two contracts is a decision on
    // record rather than an accident of which branch ran first.
    expect(judge(execArtifact, pin('v0.2.1', '0.2.1'), ok('static-thing 9.9.9')).verdict).toBe('pass')
  })

  const unclaimedArtifact: Artifact = {
    name: 'daemon',
    path: '/usr/bin/daemon',
    pin: () => pin('0.1.0'),
    contract: { kind: 'unclaimed', why: 'it parses no argv and starts a server instead of printing a version' },
  }

  test('unclaimed is its own verdict -- not a pass, not a fail, and it carries the reason', () => {
    const r = judge(unclaimedArtifact, pin('0.1.0'), ok(''))
    expect(r.verdict).toBe('unclaimed')
    expect(r.kind).toBe('unclaimed')
    expect(r.message).toContain('NOT EXECUTED')
    expect(r.message).toContain('would have to report 0.1.0')
    expect(r.detail).toContain('starts a server')
  })

  test('an unclaimed artifact is never invoked, whatever the exec would have said', async () => {
    let calls = 0
    const exec: Exec = async () => {
      calls += 1
      return ok('daemon 0.1.0')
    }
    const r = await checkArtifact(unclaimedArtifact, exec)
    expect(calls).toBe(0)
    expect(r.verdict).toBe('unclaimed')
  })

  test('a claimed artifact IS invoked, with its installed path and its argv', async () => {
    // The positive control for the line above: `calls` can move.
    const seen: string[][] = []
    const exec: Exec = async argv => {
      seen.push([...argv])
      return ok('thing 1.2.3')
    }
    const r = await checkArtifact(versionArtifact('thing', '/usr/libexec/podman/thing'), exec)
    expect(seen).toEqual([['/usr/libexec/podman/thing', '--version']])
    expect(r.verdict).toBe('pass')
  })
})

// ─── the executor-limited verdict: whose limitation was it? ────────────────

/**
 * The signature, read off the SHIPPED entry rather than retyped.
 *
 * Retyping it here would make every case below pass against a register that had
 * stopped declaring it -- the fabricated artifact would carry the sentence and
 * the shipped one would not, and the run that matters is the shipped one.
 * smoke-register.test.ts locks the value itself; this reads it.
 */
const CRUN_LIMIT = ARTIFACTS.find(a => a.name === 'crun')!.executorLimit!
const MEMFD = CRUN_LIMIT.stderrIncludes

describe('judge -- executor-limited, and the three conjuncts that gate it', () => {
  // What the emulated executor actually produced, measured 2026-08-30 while
  // building the cx3576 root on a host with no arm64 binfmt: exit 1, nothing on
  // stdout, one sentence on stderr. crun re-executes libcrun through a memory
  // file descriptor -- its CVE-2024-21626 mitigation -- before it parses argv,
  // and qemu-user cannot service that fexecve, so `--version` is never reached.
  const limited: Artifact = {
    ...versionArtifact('crun', '/usr/bin/crun', () => pin('1.29.1')),
    executorLimit: CRUN_LIMIT,
  }
  const observed: ExecResult = { status: 1, stdout: '', stderr: `${MEMFD}\n` }

  test('the declared signature on the buildkit route is executor-limited, and the row names the route and the reason', () => {
    const r = judge(limited, pin('1.29.1'), observed, 'buildkit')
    expect(r.verdict).toBe('executor-limited')
    // The route, because a reader of one row has to be able to tell which
    // executor the sentence is about.
    expect(r.message).toContain('buildkit')
    expect(r.message).toContain(CRUN_LIMIT.why)
    expect(r.message).toContain(MEMFD)
    // And it says out loud that it is not a pass.
    expect(r.message).toContain('NOT a pass')
  })

  // Conjunct (a): the route. The native route runs the binary on this host's
  // own kernel, where nothing is emulated -- softening it there would delete
  // the check on the only host that can really run it.
  test('the SAME signature on the native route is a FAIL, exactly as before', () => {
    const r = judge(limited, pin('1.29.1'), observed, 'native')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('exited 1, expected 0')
    expect(r.message).toContain('the program ran and refused')
  })

  test('the declared signature under docker run of a foreign platform (qemu-user through binfmt) is executor-limited too', () => {
    const r = judge(limited, pin('1.29.1'), observed, 'emulated')
    expect(r.verdict).toBe('executor-limited')
    expect(r.message).toContain('emulated')
  })

  test('and the default route is the strict one, so a caller that says nothing gets the FAIL', () => {
    expect(judge(limited, pin('1.29.1'), observed).verdict).toBe('fail')
  })

  // Conjunct (b): the entry declares it. There is no global pattern, so the
  // category cannot spread to a binary nobody measured.
  test('an entry that declares NO signature can never be executor-limited, whatever it printed', () => {
    const undeclared = versionArtifact('crun', '/usr/bin/crun', () => pin('1.29.1'))
    expect(undeclared.executorLimit).toBeUndefined()
    const r = judge(undeclared, pin('1.29.1'), observed, 'buildkit')
    expect(r.verdict).toBe('fail')
  })

  // Conjunct (c): the observed failure matches the declared one exactly, in
  // both halves.
  test('a different stderr under the same route is a FAIL -- the signature must MATCH', () => {
    const other: ExecResult = { status: 1, stdout: '', stderr: 'crun: cannot open config file\n' }
    expect(judge(limited, pin('1.29.1'), other, 'buildkit').verdict).toBe('fail')
  })

  test('the declared sentence with a DIFFERENT status is a FAIL too', () => {
    expect(judge(limited, pin('1.29.1'), { ...observed, status: 2 }, 'buildkit').verdict).toBe('fail')
  })

  test('the sentence on STDOUT is not the signature: it was measured on stderr', () => {
    // A binary that prints the emulator's sentence on stdout while failing some
    // other way is a different event, and a match over `stdout + stderr` -- the
    // shape `diagnose` uses, deliberately, for a different question -- would
    // file it under this verdict.
    const wrongStream: ExecResult = { status: 1, stdout: `${MEMFD}\n`, stderr: '' }
    expect(judge(limited, pin('1.29.1'), wrongStream, 'buildkit').verdict).toBe('fail')
  })

  // The positive controls. A declared limitation excuses exactly one failure
  // and changes nothing else: an entry that ANSWERS under emulation is judged
  // on its version like any other.
  test('exit 0 under the emulated route is still judged on the version, not excused', () => {
    expect(judge(limited, pin('1.29.1'), ok('crun version 1.29.1'), 'buildkit').verdict).toBe('pass')
    expect(judge(limited, pin('1.29.1'), ok('crun version 1.29.10'), 'buildkit').verdict).toBe('fail')
  })
})

// ─── catatonit: the normalisation, driven from the failing side ─────────────

describe('catatonit -- two normalisations, and a loose includes() would pass on anything', () => {
  // The exact string measured in the uefi-x64 factory root, and the exact shipped
  // pin. Both halves are real; neither is a plausible-looking stand-in.
  const SAID = 'tini version 0.2.1_catatonit'
  const catatonit = ARTIFACTS.find(a => a.name === 'catatonit')!

  test('the shipped pin and the real output agree, through both normalisations', () => {
    const p = catatonit.pin()
    // Pin side: the git tag prefix comes off.
    expect(p.recorded).toBe('v0.2.1')
    expect(p.expected).toBe('0.2.1')
    // Output side: `_catatonit` terminates the token, it is not trimmed by a
    // rule written for this one artifact.
    expect(versionTokens(SAID)).toEqual(['0.2.1'])
    expect(judge(catatonit, p, ok(SAID)).verdict).toBe('pass')
  })

  // The failing side, which is what makes the line above evidence.
  test('a wrong pin turns it RED -- so this is not a check that cannot fail', () => {
    const r = judge(catatonit, { ...catatonit.pin(), recorded: 'v0.2.2', expected: '0.2.2' }, ok(SAID))
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('expected 0.2.2')
    expect(r.message).toContain('0.2.1')
  })

  // Why it is equality against an extracted token and not a substring test.
  // Every one of these `includes` is TRUE on the real output, so a runner built
  // that way would accept four different wrong pins and one right one, and
  // would look identical doing it.
  test('a loose includes() on the raw line would accept pins that are wrong', () => {
    for (const wrong of ['0.2', '2.1', '0.2.1_cat', 'version 0.2.1']) {
      expect(SAID.includes(wrong)).toBe(true)          // the loose test passes...
      const r = judge(catatonit, { ...catatonit.pin(), recorded: wrong, expected: wrong }, ok(SAID))
      expect(r.verdict).toBe('fail')                    // ...and this one does not
    }
  })

  test('and the skew in the other direction is caught too', () => {
    // A 0.2.1 binary must not satisfy a 0.2.10 pin. Maximal munch is what makes
    // this work; a substring test would get it backwards.
    const r = judge(catatonit, { ...catatonit.pin(), recorded: 'v0.2.10', expected: '0.2.10' }, ok(SAID))
    expect(r.verdict).toBe('fail')
  })

  test('exit 0 is still asserted, which is the exec-only conjunct Scope asks for', () => {
    const r = judge(catatonit, catatonit.pin(), { status: 1, stdout: SAID, stderr: '' })
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('exited 1, expected 0')
  })
})

// The version loop, as a loop

describe('the version loop closes: bump the pin, do not rebuild, run goes red', () => {
  test('one fixture file, one unchanged binary, one edit -- and the verdict flips', async () => {
    const file = join(scratch(), 'loop-upstream.lock')
    const original = `# mica-lock v1\ngit\tthing\thttps://example.invalid/thing.git\tv1.2.3\t${'a'.repeat(40)}\n`
    writeFileSync(file, original)

    // The binary is built ONCE and never rebuilt: this output is a constant for
    // the whole test, exactly as a binary in an already-built image is.
    const exec: Exec = async () => ok('thing 1.2.3')
    const artifact: Artifact = {
      name: 'thing',
      path: '/usr/bin/thing',
      pin: () => readPin(file, 'thing'),
      contract: { kind: 'version', argv: ['--version'] },
    }

    // Green, against the pin as recorded.
    const before = await checkArtifact(artifact, exec)
    expect(before.verdict).toBe('pass')

    // Now bump the pin and nothing else. The mutation refuses to be a no-op.
    writeFileSync(file, mutate(readFileSync(file, 'utf8'), '\tv1.2.3\t', '\tv1.2.4\t'))

    const after = await checkArtifact(artifact, exec)
    expect(after.verdict).toBe('fail')
    expect(after.message).toContain('expected 1.2.4')
    expect(after.message).toContain('reports 1.2.3')

    // And back again, so the red is about the edit rather than about the file
    // having been touched at all.
    writeFileSync(file, original)
    expect((await checkArtifact(artifact, exec)).verdict).toBe('pass')
  })

  test('the whole run goes red, not just the one artifact', async () => {
    const file = join(scratch(), 'loop-run-upstream.lock')
    writeFileSync(file, `# mica-lock v1\ngit\tthing\thttps://example.invalid/thing.git\tv1.2.3\t${'a'.repeat(40)}\n`)
    const artifacts: Artifact[] = [
      { name: 'a', path: '/usr/bin/a', pin: () => readPin(file, 'thing'), contract: { kind: 'version', argv: ['--version'] } },
      { name: 'b', path: '/usr/bin/b', pin: () => readPin(file, 'thing'), contract: { kind: 'version', argv: ['--version'] } },
    ]
    const exec: Exec = async () => ok('x 1.2.3')

    // `allowUnclaimed: []` because this synthetic register has no unclaimed
    // entries and the shipped authorisation list names two. That the guard
    // fires here at all is the point of it: a register other than the shipped
    // one has to say what it authorises, rather than inheriting an answer.
    const green = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts, exec, files: [file], allowUnclaimed: [] })
    expect(green.conclusion.conclusion).toBe('PASS')
    expect(green.conclusion.exitCode).toBe(0)

    writeFileSync(file, mutate(readFileSync(file, 'utf8'), 'v1.2.3', 'v9.9.9'))
    const red = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts, exec, files: [file], allowUnclaimed: [] })
    expect(red.conclusion.conclusion).toBe('FAIL')
    expect(red.conclusion.exitCode).toBe(1)
    expect(red.conclusion.counts.fail).toBe(2)
  })
})

// conclude, and the vacuity guard

describe('conclude', () => {
  const r = (verdict: SmokeResult['verdict']): SmokeResult =>
    ({ name: 'x', path: '/usr/bin/x', kind: 'version', verdict, message: '' })

  test('all pass, and the count is the register size -- PASS, exit 0', () => {
    const c = conclude([r('pass'), r('pass')], 2)
    expect(c.conclusion).toBe('PASS')
    expect(c.exitCode).toBe(0)
    // The same five numbers the other two conclusions print, in the same order.
    // Until M7d this line read `(2/2 artifacts executed, version identity
    // asserted)` -- a second format for one summary, which left `0 unclaimed`
    // unstated on the only line most readers look at. `0 executor-limited` is
    // there for the same reason: a reader has to be able to tell a run that
    // softened nothing from one that softened something, on the green line.
    expect(c.line).toBe('RESULT: PASS (2 pass, 0 executor-limited, 0 fail, 0 unclaimed, of 2)')
  })

  test('one fail outranks everything else', () => {
    const c = conclude([r('pass'), r('fail'), r('unclaimed')], 3)
    expect(c.conclusion).toBe('FAIL')
    expect(c.exitCode).toBe(1)
  })

  test('no fails but an unclaimed is INCOMPLETE, and INCOMPLETE exits non-zero', () => {
    const c = conclude([r('pass'), r('unclaimed')], 2)
    expect(c.conclusion).toBe('INCOMPLETE')
    expect(c.exitCode).toBe(1)
    expect(c.line).toMatch(/not a pass and is not a skip/)
  })

  test('an unclaimed artifact is NOT inside the pass count, on any of the three lines', () => {
    // With no unclaimed artifact in the shipped register, the cases that
    // produce one assert the CONCLUSION and a phrase rather than the counts,
    // and the conclusion does not move under the mutation that folds
    // `unclaimed` into `pass` -- `unclaimed > 0` still fires. Without this
    // case, a `conclude` that filed an unasked artifact under `pass` passes the
    // whole suite: a guard whose removal changes no test.
    //
    // Asserted on the INCOMPLETE line and on the FAIL line, because they are two
    // separate format strings and a mutation could reach either.
    expect(conclude([r('pass'), r('unclaimed')], 2).line)
      .toContain('RESULT: INCOMPLETE (1 pass, 0 executor-limited, 0 fail, 1 unclaimed, of 2)')
    expect(conclude([r('pass'), r('fail'), r('unclaimed')], 3).line)
      .toContain('RESULT: FAIL (1 pass, 0 executor-limited, 1 fail, 1 unclaimed, of 3)')
    // And the positive control: with nothing unclaimed the same three numbers
    // are what they always were, so the case above is about the category and
    // not about the arithmetic.
    expect(conclude([r('pass'), r('fail')], 2).line)
      .toContain('RESULT: FAIL (1 pass, 0 executor-limited, 1 fail, 0 unclaimed, of 2)')
  })

  test('an executor-limited verdict is counted on its own, and the run still PASSES', () => {
    const c = conclude([r('pass'), r('executor-limited')], 2)
    expect(c.conclusion).toBe('PASS')
    expect(c.exitCode).toBe(0)
    // Not folded into `pass`: a reader has to be able to see how many
    // conclusions were softened, and a count that hides inside the pass count
    // is a guard whose removal changes nothing.
    expect(c.counts.executorLimited).toBe(1)
    expect(c.counts.pass).toBe(1)
    expect(c.line).toBe('RESULT: PASS (1 pass, 1 executor-limited, 0 fail, 0 unclaimed, of 2) EXECUTOR-LIMITED: x.')
  })

  test('the count is on EVERY result line, and zero is printed as zero', () => {
    // The line that matters most is the green one, so it is asserted first.
    expect(conclude([r('pass'), r('pass')], 2).line).toContain('0 executor-limited')
    expect(conclude([r('pass'), r('fail')], 2).line).toContain('0 executor-limited')
    expect(conclude([r('pass'), r('unclaimed')], 2).line).toContain('0 executor-limited')
    // ...and a run with nothing to name carries no EXECUTOR-LIMITED clause at
    // all, so the clause means something when it is there.
    expect(conclude([r('pass'), r('pass')], 2).line).not.toContain('EXECUTOR-LIMITED:')
  })

  test('the RESULT line NAMES what was limited, not only how many', () => {
    const results: SmokeResult[] = [
      { name: 'crun', path: '/usr/bin/crun', kind: 'version', verdict: 'executor-limited', message: '' },
      { name: 'rauc', path: '/usr/bin/rauc', kind: 'version', verdict: 'pass', message: '' },
    ]
    expect(conclude(results, 2).line).toContain('EXECUTOR-LIMITED: crun.')
  })

  test('a fail outranks an executor-limited verdict, and the red line carries both', () => {
    const results: SmokeResult[] = [
      { name: 'crun', path: '/usr/bin/crun', kind: 'version', verdict: 'executor-limited', message: '' },
      { name: 'podman', path: '/usr/bin/podman', kind: 'version', verdict: 'fail', message: '' },
    ]
    const c = conclude(results, 2)
    expect(c.conclusion).toBe('FAIL')
    expect(c.exitCode).toBe(1)
    expect(c.line).toContain('FAILED: podman.')
    expect(c.line).toContain('EXECUTOR-LIMITED: crun.')
  })

  // The vacuity guards. `RESULT: PASS (6/6)` is invariant under a run that
  // threw half its work away, which is exactly how the shell lint this package
  // replaced reported PASS over zero checks.
  test('fewer conclusions than the register is a FAIL whatever the conclusions were', () => {
    const c = conclude([r('pass'), r('pass')], 12)
    expect(c.conclusion).toBe('FAIL')
    expect(c.exitCode).toBe(1)
    expect(c.line).toMatch(/2 conclusions from a register of 12/)
  })

  test('more conclusions than the register is a FAIL too', () => {
    expect(conclude([r('pass'), r('pass'), r('pass')], 2).conclusion).toBe('FAIL')
  })

  test('an EMPTY register concludes nothing and must not exit 0', () => {
    const c = conclude([], 0)
    expect(c.conclusion).toBe('FAIL')
    expect(c.exitCode).toBe(1)
    expect(c.line).toMatch(/EMPTY register/)
  })
})

// the image record

describe('parseFactoryRootRecord', () => {
  const GOOD = [
    '# The uefi-x64 factory root, exported as an OCI image.',
    '# Load it with: docker load -i /x/factory-root.oci',
    'ref\tlocalhost/mica-factory-root:uefi-x64',
    'platform\tlinux/amd64',
    'target\tfactory-root',
    'archive\tfactory-root.oci',
    'bytes\t250209280',
    'sha256\t6e036711ce306cd2',
    'source-date-epoch\t1577836800',
    '',
  ].join('\n')

  test('reads the shape build/src/stages.ts writes', () => {
    const rec = parseFactoryRootRecord(GOOD, '/x/factory-root.txt')
    expect(rec.ref).toBe('localhost/mica-factory-root:uefi-x64')
    expect(rec.platform).toBe('linux/amd64')
    expect(rec.bytes).toBe(250209280)
    expect(rec.sha256).toBe('6e036711ce306cd2')
  })

  test('the comment lines are skipped rather than read as fields', () => {
    // `# Load it with: docker load -i ...` has no tab, so it cannot become a
    // key -- but a reader that split on whitespace would make one.
    expect(parseFactoryRootRecord(GOOD, '/x').archive).toBe('factory-root.oci')
  })

  test('a missing field is refused, naming it', () => {
    const withoutRef = mutate(GOOD, /^ref\t.*\n/m, '')
    expect(() => parseFactoryRootRecord(withoutRef, '/x/factory-root.txt')).toThrow(/carries no ref/)
  })

  test('a bytes that is not a positive integer is refused', () => {
    expect(() => parseFactoryRootRecord(mutate(GOOD, 'bytes\t250209280', 'bytes\tlots'), '/x')).toThrow(/not a positive integer/)
    expect(() => parseFactoryRootRecord(mutate(GOOD, 'bytes\t250209280', 'bytes\t0'), '/x')).toThrow(/not a positive integer/)
  })

  // There is deliberately no case here that reads the real
  // `_out/uefi-x64/factory-root.txt`. It would pass on a host that had built an
  // image and take a silent no-op branch on one that had not -- and this suite
  // must run green with `_out/` absent, so the no-op branch is the one CI takes
  // every time. checks.ts draws the same line in the same words: "a suite that
  // read the real `_out/` would pass on a host that had built an image and fail
  // on one that had not, and a skip reports the same green as a pass."
  //
  // The real record IS parsed, by the real CLI, in `run.sh --smoke` -- which is
  // an integration run against a built image and reports what it read on its
  // first line.
})

describe('readFactoryRoot -- a missing image REFUSES rather than skipping', () => {
  test('names the file and the command that would build it', () => {
    const empty = join(scratch(), 'no-such-out')
    mkdirSync(empty, { recursive: true })
    expect(() => readFactoryRoot('uefi-x64', empty)).toThrow(/factory-root\.txt does not exist/)
    expect(() => readFactoryRoot('uefi-x64', empty)).toThrow(/make os-rootfs PRODUCT=<product>/)
    expect(() => readFactoryRoot('uefi-x64', empty)).toThrow(/a skip reports the same green as a pass/)
  })

  test('and the positive control: a directory with both files is read', () => {
    const dir = join(scratch(), 'fake-out')
    mkdirSync(dir, { recursive: true })
    const { record, archive } = factoryRootPaths('uefi-x64', dir)
    writeFileSync(archive, 'not really an oci archive')
    writeFileSync(record, 'ref\tlocalhost/x:1\nplatform\tlinux/amd64\narchive\tfactory-root.oci\nbytes\t7\nsha256\tabc\n')
    const rec = readFactoryRoot('uefi-x64', dir)
    expect(rec.ref).toBe('localhost/x:1')
    expect(rec.archivePath).toBe(archive)
  })

  test('a record present with no archive beside it is refused too', () => {
    const dir = join(scratch(), 'record-only')
    mkdirSync(dir, { recursive: true })
    writeFileSync(factoryRootPaths('uefi-x64', dir).record, 'ref\tx\n')
    expect(() => readFactoryRoot('uefi-x64', dir)).toThrow(/factory-root\.oci does not exist/)
  })
})

// the declined-feature guard

describe('declinedFeatures -- reading what the build left out, off its own manifest', () => {
  // The exact line build/src/stages.ts writes when nothing was declined,
  // captured from the real _out/uefi-x64/rootfs-stages.txt this tree produced.
  const NONE = '# rootfs stage chain, as built. One line per stage, in build order.\n'
    + '# declined: (none -- every feature stage in the directory was built)\n'
    + '# name\tcontent-hash\ttag\n10-base\tabc\tmica-rootfs-stage:uefi-x64-10-base\n'

  test('the parenthesised form means nothing was declined', () => {
    expect(declinedFeatures(NONE)).toEqual([])
  })

  test('a real declined list is read, in the order it was written', () => {
    const some = mutate(NONE, '# declined: (none -- every feature stage in the directory was built)', '# declined: containers mqtt')
    expect(declinedFeatures(some)).toEqual(['containers', 'mqtt'])
  })

  // "A `# declined:` line naming nothing is not the same statement as no line
  // at all" -- stageManifest's own words. The two must not look alike here
  // either, so a manifest with no line is refused rather than read as "none".
  test('a manifest with NO declined line is refused, not read as nothing declined', () => {
    const missing = mutate(NONE, /^# declined:.*\n/m, '')
    expect(() => declinedFeatures(missing)).toThrow(/carries no `# declined:` line/)
  })
})

// the preflight, and the arm64 wall

describe('preflight -- the positive control that runs before any conclusion', () => {
  test('a root that can execute /bin/true is accepted', async () => {
    const seen: string[][] = []
    const exec: Exec = async argv => {
      seen.push([...argv])
      return ok('')
    }
    await preflight(exec, 'linux/amd64')
    expect(seen).toEqual([['/bin/true']])
  })

  // THE arm64 WALL, reachable without an arm64 image. This is the exact status
  // and message measured on this host: `docker run --platform linux/arm64
  // arm64v8/busybox /bin/true` exits 255 with `exec /bin/true: exec format
  // error`, with binfmt_misc not mounted.
  test('an exec format error is refused with the platform and the remedy', async () => {
    const exec: Exec = async () => ({ status: 255, stdout: '', stderr: 'exec /bin/true: exec format error' })
    await expect(preflight(exec, 'linux/arm64')).rejects.toThrow(/linux\/arm64 and this host cannot run it/)
    await expect(preflight(exec, 'linux/arm64')).rejects.toThrow(/tonistiigi\/binfmt --install/)
  })

  test('the refusal explains why it is not twelve separate failures', async () => {
    const exec: Exec = async () => ({ status: 255, stdout: '', stderr: 'exec format error' })
    await expect(preflight(exec, 'linux/arm64')).rejects.toThrow(/twelve wrong diagnoses of one condition/)
  })

  test('a non-zero exit that is NOT a format error does not claim an emulation problem', async () => {
    const exec: Exec = async () => ({ status: 1, stdout: '', stderr: 'permission denied' })
    await expect(preflight(exec, 'linux/amd64')).rejects.toThrow(/cannot execute anything on this host/)
    await expect(preflight(exec, 'linux/amd64')).rejects.not.toThrow(/tonistiigi/)
  })

  test('a start the watchdog killed is reported as a timeout, not as `/bin/true exited 137`', async () => {
    // Through the REAL watchdog, the real clock and a real subprocess: only the
    // argv is redirected, because /bin/true is the one command that cannot be
    // made slow. This is the event that failed a green chain build -- a
    // `/bin/true` SIGKILLed at 30s while two sibling builds ran, reported as the
    // program's own exit status.
    const slowStart: Exec = () => capture(['sleep', '5'], 150)
    let said = 'it did not refuse at all'
    try {
      await preflight(slowStart, 'linux/amd64')
    } catch (e) {
      said = (e as Error).message
    }
    expect(said).toMatch(/did not START within 150 ms/)
    expect(said).toMatch(/spent starting the container/)
    // The message this replaces made the reader decode a signal number, and
    // sent them looking at the root: the status is 137 and it says nothing here.
    expect(said).not.toMatch(/exited 137/)
    expect(said).not.toMatch(/cannot execute anything on this host/)
  })

  test('a 137 the watchdog did NOT cause is still read as the root refusing', async () => {
    // The same false alarm from the other side. `timedOutAfterMs` decides, never
    // the status, so a root whose /bin/true really answers 137 is not excused as
    // a slow host -- which is what a check on the number alone would do.
    const exec: Exec = async () => ({ status: 137, stdout: '', stderr: 'something else killed it' })
    await expect(preflight(exec, 'linux/amd64')).rejects.toThrow(/cannot execute anything on this host/)
    await expect(preflight(exec, 'linux/amd64')).rejects.not.toThrow(/did not START within/)
  })

  test('the start it measured is what it hands back, and that is what sizes the artifacts', async () => {
    const started: Exec = () => capture(['sleep', '0.3'], EXEC_TIMEOUT_MS)
    const startupMs = await preflight(started, 'linux/amd64')
    expect(startupMs).toBeGreaterThanOrEqual(250)
    // A start this quick does not shrink the fuse; see execTimeoutMs.
    expect(execTimeoutMs(startupMs)).toBe(EXEC_TIMEOUT_MS)
  })
})

// the argv the seam actually builds

describe('dockerArgv', () => {
  test('runs the absolute path in the loaded ref, with no network and no leftover container', () => {
    expect(dockerArgv('localhost/mica-factory-root:uefi-x64', ['/usr/bin/crun', '--version'])).toEqual([
      'docker', 'run', '--rm', '--network', 'none',
      'localhost/mica-factory-root:uefi-x64', '/usr/bin/crun', '--version',
    ])
  })
})

// ─── the whole run, over the SHIPPED register, with a fabricated image ──────

describe('smokeRun over the real register', () => {
  /** Answer every artifact with the version its own pin records. */
  const honest: Exec = async argv => {
    const path = argv[0]!
    const artifact = ARTIFACTS.find(a => a.path === path)
    if (artifact === undefined) return { status: 127, stdout: '', stderr: 'no such file or directory' }
    return ok(`${artifact.name} ${artifact.pin().expected}`)
  }

  // Every entry in the register answers `--version`, so the count is the
  // register's full size and the conclusion is driven from what every entry
  // did, not from a subset.
  test('the twelve shipped artifacts all answer, and that is PASS', async () => {
    const run = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', exec: honest })
    expect(run.results.length).toBe(ARTIFACTS.length)
    expect(run.conclusion.counts.pass).toBe(12)
    expect(run.conclusion.counts.fail).toBe(0)
    expect(run.conclusion.counts.unclaimed).toBe(0)
    expect(run.conclusion.conclusion).toBe('PASS')
    expect(run.conclusion.exitCode).toBe(0)
  })

  test('one binary at the wrong path takes the run to FAIL', async () => {
    const moved = ARTIFACTS.map(a => (a.name === 'crun' ? { ...a, path: '/usr/bin/crun-moved' } : a))
    // The mutation is a mutation: exactly one path changed.
    expect(moved.filter((a, i) => a.path !== ARTIFACTS[i]!.path).length).toBe(1)

    const run = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts: moved, exec: honest })
    expect(run.conclusion.conclusion).toBe('FAIL')
    const crun = run.results.find(r => r.name === 'crun')!
    expect(crun.verdict).toBe('fail')
    expect(crun.message).toMatch(/path does not exist in the factory root/)
  })

  // The guard has to be called, not merely to exist. Found by mutation: with
  // `unclaimedFaults` still correct but no longer consulted by `smokeRun`, the
  // whole suite stayed green -- every case was testing the function and none
  // was testing that the runner asks it. A guard nothing calls is a guard
  // nobody has run, which is the same defect one level up from a guard nothing
  // can drive red.
  test('an unauthorised unclaimed artifact refuses the RUN, and executes nothing', async () => {
    let calls = 0
    const counting: Exec = async argv => {
      calls += 1
      return honest(argv)
    }
    const withRogue = ARTIFACTS.map(a =>
      a.name === 'conmon'
        ? { ...a, contract: { kind: 'unclaimed' as const, why: 'MEASURED: fabricated for this case' } }
        : a)
    // The mutation is a mutation.
    expect(ARTIFACTS.find(a => a.name === 'conmon')!.contract.kind).toBe('version')

    await expect(smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts: withRogue, exec: counting })).rejects.toThrow(
      /marks artifacts unclaimed that nothing authorised, so nothing was executed/,
    )
    expect(calls).toBe(0)

    // Positive control on the same counter: the shipped register runs.
    await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts: ARTIFACTS, exec: counting })
    expect(calls).toBeGreaterThan(0)
  })

  // M7b wrote this against a register whose steady state was two unclaimed
  // artifacts. M7d emptied that set, so the shipped run has no names to print
  // -- and asserting "the names appear" over a run with no unclaimed artifacts
  // is a test that cannot fail. The subject moves to a register that HAS one:
  // the property under test is that `conclude` names members rather than only
  // counting them, and that property has to be exercised where there are
  // members.
  test('the RESULT line NAMES the unclaimed artifacts, not just their count', async () => {
    const withUnclaimed = ARTIFACTS.map(a =>
      a.name === 'conmon'
        ? { ...a, contract: { kind: 'unclaimed' as const, why: 'MEASURED: fabricated for this case' } }
        : a)
    // The mutation is a mutation.
    expect(ARTIFACTS.find(a => a.name === 'conmon')!.contract.kind).toBe('version')

    const run = await smokeRun({
      product: 'uefi-x64-dev', board: 'uefi-x64', artifacts: withUnclaimed, exec: honest, allowUnclaimed: ['conmon'],
    })
    // Register order, not sorted: the table above prints the same order, and a
    // summary that reordered its own rows would be one more thing to reconcile.
    expect(run.conclusion.line).toContain('UNCLAIMED: conmon')
    // A count alone would satisfy a reader and nobody else.
    expect(run.conclusion.line).toContain('1 unclaimed')
    expect(run.conclusion.conclusion).toBe('INCOMPLETE')

    // And the shipped register has none to name, which is the state M7d put it
    // in and is asserted here rather than left implicit.
    const shipped = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', exec: honest })
    expect(shipped.conclusion.line).toContain('0 unclaimed')
    expect(shipped.conclusion.line).not.toContain('UNCLAIMED:')
  })

  test('a FAIL line names what failed AND what stayed unclaimed', () => {
    const results = [
      { name: 'crun', path: '/usr/bin/crun', kind: 'version' as const, verdict: 'fail' as const, message: '' },
      { name: 'micad', path: '/usr/bin/micad', kind: 'unclaimed' as const, verdict: 'unclaimed' as const, message: '' },
      { name: 'rauc', path: '/usr/bin/rauc', kind: 'version' as const, verdict: 'pass' as const, message: '' },
    ]
    const c = conclude(results, 3)
    expect(c.conclusion).toBe('FAIL')
    expect(c.line).toContain('FAILED: crun')
    expect(c.line).toContain('UNCLAIMED: micad')
  })

  // The whole run, in the shape the cx3576 build produces: eleven artifacts
  // answer under emulation and crun cannot reach its own --version handler.
  // The exec is the same in both halves and only the ROUTE moves, which is the
  // whole claim -- the verdict is about the executor, so it must flip with the
  // executor and with nothing else.
  test('crun hitting its declared limit under the emulated route is ONE executor-limited verdict, and the run PASSES', async () => {
    const emulated: Exec = async argv =>
      argv[0] === '/usr/bin/crun'
        ? { status: 1, stdout: '', stderr: `${MEMFD}\n` }
        : honest(argv)

    const run = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', exec: emulated, route: 'buildkit' })
    expect(run.conclusion.conclusion).toBe('PASS')
    expect(run.conclusion.exitCode).toBe(0)
    expect(run.conclusion.counts.executorLimited).toBe(1)
    expect(run.conclusion.counts.pass).toBe(11)
    expect(run.conclusion.counts.fail).toBe(0)
    expect(run.conclusion.line).toContain(
      'RESULT: PASS (11 pass, 1 executor-limited, 0 fail, 0 unclaimed, of 12)',
    )
    expect(run.conclusion.line).toContain('EXECUTOR-LIMITED: crun.')
    const crun = run.results.find(x => x.name === 'crun')!
    expect(crun.verdict).toBe('executor-limited')
    // Exactly one: the other eleven are untouched by the category.
    expect(run.results.filter(x => x.verdict === 'executor-limited').map(x => x.name)).toEqual(['crun'])

    // The same failure on the native route, where nothing is emulated, is the
    // red it has always been -- and it takes the whole run with it.
    const native = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', exec: emulated })
    expect(native.conclusion.conclusion).toBe('FAIL')
    expect(native.conclusion.exitCode).toBe(1)
    expect(native.conclusion.counts.executorLimited).toBe(0)
    expect(native.conclusion.line).toContain('FAILED: crun.')
  })

  // The route is READ OFF the executor, not passed alongside it. This drives
  // the real `buildkitExec` -- the same function `smokeRun` falls back to on a
  // host that cannot execute the image -- with a fabricated `docker buildx`
  // invocation underneath, and passes NO route option: if the runner stopped
  // deriving the route from the executor it chose, or if `buildkitExec` stopped
  // saying what it is, crun's row goes back to FAIL here.
  test('the emulated route is derived from the executor itself, with no route option in sight', async () => {
    // `tmp/` is gitignored, so a fresh worktree does not have it, and mkdtemp does not
    // create the parent it is handed: without this the case dies on ENOENT before it
    // asserts anything, which reads as a failure of the executor it is about.
    mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
    const scratchDir = mkdtempSync(join(REPO_ROOT, 'tmp', 'smoke-buildkit-'))
    try {
      const exec = buildkitExec(
        { ref: 'r', layout: '/l', builder: 'mica-arm64', platform: 'linux/arm64', scratch: scratchDir },
        async argv => {
          // What the build would have written out: the three files `judge` reads.
          const out = argv[argv.indexOf('--output') + 1]!.replace('type=local,dest=', '')
          const df = readFileSync(join(argv[argv.length - 1]!, 'Dockerfile'), 'utf8')
          const path = /RUN --network=none mkdir -p \/mica-smoke && \( '([^']+)'/.exec(df)![1]!
          const artifact = ARTIFACTS.find(a => a.path === path)
          mkdirSync(out, { recursive: true })
          const limited = path === '/usr/bin/crun'
          writeFileSync(join(out, 'status'), limited ? '1\n' : '0\n')
          writeFileSync(join(out, 'stdout'), limited ? '' : `${artifact!.name} ${artifact!.pin().expected}\n`)
          writeFileSync(join(out, 'stderr'), limited ? `${MEMFD}\n` : '')
          return { status: 0, stdout: '', stderr: '' }
        },
      )
      expect(execRoute(exec)).toBe('buildkit')

      const run = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', exec })
      expect(run.results.find(x => x.name === 'crun')!.verdict).toBe('executor-limited')
      expect(run.conclusion.line).toContain(
        'RESULT: PASS (11 pass, 1 executor-limited, 0 fail, 0 unclaimed, of 12)',
      )
      expect(run.conclusion.exitCode).toBe(0)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  // The category does not leak sideways: the route is not a licence for the
  // OTHER eleven entries to fail quietly under emulation.
  test('a different artifact failing under the emulated route is still a FAIL', async () => {
    const emulated: Exec = async argv =>
      argv[0] === '/usr/bin/podman'
        ? { status: 1, stdout: '', stderr: `${MEMFD}\n` }
        : honest(argv)

    const run = await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', exec: emulated, route: 'buildkit' })
    expect(run.conclusion.conclusion).toBe('FAIL')
    expect(run.conclusion.counts.executorLimited).toBe(0)
    expect(run.results.find(x => x.name === 'podman')!.verdict).toBe('fail')
  })

  test('a register that disagrees with the pin files executes NOTHING', async () => {
    let calls = 0
    const counting: Exec = async argv => {
      calls += 1
      return honest(argv)
    }
    const withoutCrun = ARTIFACTS.filter(a => a.name !== 'crun')
    expect(withoutCrun.length).toBe(ARTIFACTS.length - 1)

    await expect(smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts: withoutCrun, exec: counting })).rejects.toThrow(
      /register and the version pins disagree, so nothing was executed/,
    )
    expect(calls).toBe(0)

    // Positive control on the same counter: with the register intact it moves.
    await smokeRun({ product: 'uefi-x64-dev', board: 'uefi-x64', artifacts: ARTIFACTS, exec: counting })
    expect(calls).toBeGreaterThan(0)
  })
})

// the buildkit executor: the same register, executed inside a builder that
// bundles its own emulator

describe('buildkitExec -- the register executed inside buildkit', () => {
  const ref = 'localhost/mica-factory-root:cx3576'
  const opts = { ref, layout: '/out/cx3576/factory-root.layout', builder: 'mica-arm64', platform: 'linux/arm64' }

  test('the Dockerfile runs the argv off the network and carries status, stdout and stderr out', () => {
    const text = buildkitDockerfile(ref, ['/usr/bin/crun', '--version'])
    expect(text).toContain(`FROM ${ref}`)
    expect(text).toContain('--network=none')
    expect(text).toContain("'/usr/bin/crun' '--version'")
    expect(text).toContain('FROM scratch')
  })

  test('the build names the builder, the platform and the layout as the build context of the ref', () => {
    const argv = buildkitArgv(opts, '/scratch/df', '/scratch/out')
    expect(argv.slice(0, 3)).toEqual(['docker', 'buildx', 'build'])
    expect(argv[argv.indexOf('--builder') + 1]).toBe('mica-arm64')
    expect(argv[argv.indexOf('--platform') + 1]).toBe('linux/arm64')
    expect(argv[argv.indexOf('--build-context') + 1]).toBe(`${ref}=oci-layout:///out/cx3576/factory-root.layout`)
    expect(argv).toContain('--no-cache')
    expect(argv[argv.indexOf('--output') + 1]).toBe('type=local,dest=/scratch/out')
    expect(argv[argv.length - 1]).toBe('/scratch/df')
  })

  test('the two executors say which they are, and an untagged function is the strict one', () => {
    // The route is not inferable from anything the runner sees at judging time
    // -- the outcome of an emulated run looks exactly like a native one -- so
    // each executor carries it, and anything else is read as `native`.
    expect(execRoute(buildkitExec(opts, async () => ({ status: 0, stdout: '', stderr: '' })))).toBe('buildkit')
    expect(execRoute(dockerExec(ref))).toBe('native')
    expect(execRoute(dockerExec(ref, undefined, undefined, 'emulated'))).toBe('emulated')
    // docker run is native only for the host's own platform.
    const host = process.arch === 'uefi-x64' ? 'amd64' : process.arch
    expect(dockerRoute(`linux/${host}`)).toBe('native')
    expect(dockerRoute(host === 'amd64' ? 'linux/arm64' : 'linux/amd64')).toBe('emulated')
    expect(execRoute(async () => ({ status: 0, stdout: '', stderr: '' }))).toBe('native')
  })

  test('the executor reads the three files back; a build that fails is an executor that cannot run', async () => {
    // `tmp/` may not exist yet -- see the case above.
    mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
    const scratchDir = mkdtempSync(join(REPO_ROOT, 'tmp', 'smoke-buildkit-'))
    try {
      const exec = buildkitExec({ ...opts, scratch: scratchDir }, async (argv) => {
        const out = argv[argv.indexOf('--output') + 1]!.replace('type=local,dest=', '')
        mkdirSync(out, { recursive: true })
        writeFileSync(join(out, 'status'), '0\n')
        writeFileSync(join(out, 'stdout'), 'crun version 1.2\n')
        writeFileSync(join(out, 'stderr'), '')
        return { status: 0, stdout: '', stderr: '' }
      })
      expect(await exec(['/usr/bin/crun', '--version'])).toEqual({ status: 0, stdout: 'crun version 1.2\n', stderr: '' })

      const failing = buildkitExec({ ...opts, scratch: scratchDir }, async () => ({
        status: 1,
        stdout: '',
        stderr: 'ERROR: failed to solve: process "/bin/sh -c ..." did not complete: exec format error',
      }))
      const r = await failing(['/bin/true'])
      expect(r.status).toBe(255)
      expect(r.stderr).toContain('exec format error')
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})


// Loading the root: a watchdog that must not fail a load which has already done
// its work, and a tag no other worktree on this host can re-point underneath
// this run.
//
// Both were observed during this campaign, on this host, and neither is
// hypothetical: a sibling's gate log carries
// `docker load ... exited 137: Loaded image: localhost/mica-factory-root:uefi-x64` --
// a SIGKILL reported beside docker's own success line -- and two worktrees'
// `mica-rootfs-stage:uefi-x64-*` tags have already interleaved into a plausible,
// cross-contaminated comparison.
//
// Everything below drives `loadFactoryRoot` through its one seam, so the daemon,
// the archive and the kill are all chosen by the test. The fixtures are not
// invented: INDEX_JSON and MANIFEST_JSON are verbatim from a 250,083,328-byte
// OCI archive exported by `docker buildx build --output type=oci` on this host
// on 2026-08-31, and OUR_ID is what `docker image inspect --format {{.Id}}`
// answered for it -- the MANIFEST digest, which is what docker 29.7.2's
// containerd image store answers with.

const ARCHIVE_PATH = '/out/uefi-x64/factory-root.oci'
const REF = 'localhost/mica-factory-root:uefi-x64'

const RECORD = {
  ref: REF,
  platform: 'linux/amd64',
  archive: 'factory-root.oci',
  sha256: '80d473b8d3c0290d1c8aacbce9725c39703ddbf073819b287ea5a5eb83a8d10e',
  bytes: 250_083_328,
  archivePath: ARCHIVE_PATH,
} as const

const MANIFEST_DIGEST = 'sha256:85156a1e0da976ac4f42c2f81c33152837f3b464d65c3c54a1e672eed1b54187'
const CONFIG_DIGEST = 'sha256:abc62c0e06f5d8105212a31b76f852a739c6f721b1dc6aeb27ed5c68e5b47845'
const OUR_ID = MANIFEST_DIGEST
/** A real second image on this host -- what a sibling's load would point `:uefi-x64` at. */
const SOMEONE_ELSE = 'sha256:47b582b490e687b644e3296ee6f1b527993c9f4c553de43c81b65e2ce407c97b'

const INDEX_JSON = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":`
  + `[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"${MANIFEST_DIGEST}","size":482,`
  + `"annotations":{"io.containerd.image.name":"${REF}","org.opencontainers.image.ref.name":"uefi-x64"},`
  + `"platform":{"architecture":"amd64","os":"linux"}}]}`

const MANIFEST_JSON = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json",`
  + `"config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"${CONFIG_DIGEST}","size":446},`
  + `"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip",`
  + `"digest":"sha256:f782443cfb4c76a2da2da883e08f1479e3bd19e315e7dfcb0f29ff2123a4e982","size":250076484}]}`

const MEMBERS: Readonly<Record<string, string>> = {
  'index.json': INDEX_JSON,
  [`blobs/sha256/${MANIFEST_DIGEST.slice('sha256:'.length)}`]: MANIFEST_JSON,
}

const LOADED_OK: ExecResult = { status: 0, stdout: `Loaded image: ${REF}\n`, stderr: '' }

interface FakeCall {
  readonly argv: readonly string[]
  readonly timeoutMs: number
}

/**
 * A daemon, a tar and a kill, fabricated at the one seam the loader spends
 * everything through.
 *
 * `images` is keyed by every reference that resolves, which is how a re-pointed
 * tag is expressed here: the tag answers one id and the archive's own digest
 * answers another. `calls` is kept because some of these cases are about what
 * was NOT asked -- a loader that consults the tag has not stopped trusting it,
 * however right its answer happens to be on a quiet host.
 */
function fakeDaemon(opts: {
  readonly load: ExecResult
  readonly images?: Readonly<Record<string, string>>
  readonly members?: Readonly<Record<string, string>>
}): {
  run: (argv: readonly string[], timeoutMs: number) => Promise<ExecResult>
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const run = async (argv: readonly string[], timeoutMs: number): Promise<ExecResult> => {
    calls.push({ argv, timeoutMs })
    const last = argv[argv.length - 1]!
    if (argv[0] === 'docker' && argv[1] === 'load') return opts.load
    if (argv[0] === 'tar') {
      const text = opts.members?.[last]
      return text === undefined
        ? { status: 2, stdout: '', stderr: `tar: ${last}: Not found in archive\n` }
        : { status: 0, stdout: text, stderr: '' }
    }
    if (argv[0] === 'docker' && argv[1] === 'image' && argv[2] === 'inspect') {
      const id = opts.images?.[last]
      return id === undefined
        ? { status: 1, stdout: '', stderr: `Error response from daemon: No such image: ${last}\n` }
        : { status: 0, stdout: `${id}\n`, stderr: '' }
    }
    throw new Error(`the fake daemon was asked something it does not model: ${argv.join(' ')}`)
  }
  return { run, calls }
}

const askedAbout = (calls: readonly FakeCall[], reference: string): boolean =>
  calls.some(c => c.argv[1] === 'image' && c.argv.includes(reference))

describe('capture -- a budget that fires names itself', () => {
  test('a command that outlives its budget comes back saying which budget killed it', async () => {
    const r = await capture(['sleep', '5'], 120)
    // 137 is 128+9, and on its own it is indistinguishable from a program that
    // chose to exit 137. The field beside it is the whole fix: the reader is
    // told the runner ended this, and after how long.
    expect(r.status).not.toBe(0)
    expect(r.timedOutAfterMs).toBe(120)
    expect(diagnose(r)).toMatch(/watchdog killed it after 120 ms/)
    expect(diagnose(r)).not.toBe('the program ran and refused')
  })

  test('a command that finishes inside its budget is not called a timeout', async () => {
    // The control for the case above. The timer and the exit can land in the
    // same tick, and a run that succeeded must not acquire a timeout because of
    // it -- that would be the same false alarm from the other side.
    const r = await capture(['true'], 30_000)
    expect(r.status).toBe(0)
    expect(r.timedOutAfterMs).toBeUndefined()
    expect(diagnose(r)).not.toMatch(/watchdog/)
  })
})

describe('the exec budget is sized against a measured start, not against an idle host', () => {
  // The constant this replaced, and the event that condemned it: a chain rootfs
  // build that had just been green went red with
  //   the factory root cannot execute anything on this host: /bin/true exited 137
  // while two sibling builds ran on this host. 137 is 128+9, and `/bin/true`
  // cannot be slow for any reason of its own -- so all 30s of it was spent
  // STARTING a container, and the number was sized against a host that was
  // starting them in 0.65s.
  const KILLED_BIN_TRUE_MS = 30_000

  test('the fuse a run that measured nothing gets is bigger than the one that killed /bin/true', () => {
    expect(EXEC_TIMEOUT_MS).toBeGreaterThan(KILLED_BIN_TRUE_MS)
    // Two halves, separately defensible, or the sum is the old constant with a
    // bigger number written on it. The half that has to absorb host load is the
    // START, and the program half is the one 30s was always right for: every
    // `--version` in the register answers in milliseconds.
    expect(EXEC_TIMEOUT_MS).toBe(EXEC_STARTUP_BUDGET_MS + EXEC_PROGRAM_BUDGET_MS)
    expect(EXEC_STARTUP_BUDGET_MS).toBeGreaterThan(KILLED_BIN_TRUE_MS)
  })

  test('a slow measured start buys more room, and a quick one does not shrink the fuse', () => {
    // Measured on this host (docker 29.7.2): 0.65s median with the daemon quiet,
    // 8.6s for the first start after three builds started. The quiet number must
    // not shrink the fuse -- the next start is queued behind whatever the daemon
    // does next -- and the loaded one must widen it. A budget that answered the
    // same to both is the constant again with a measurement printed beside it.
    expect(execTimeoutMs(650)).toBe(EXEC_TIMEOUT_MS)
    expect(execTimeoutMs(8_600)).toBeGreaterThan(execTimeoutMs(650))
    expect(execTimeoutMs(8_600)).toBe(8_600 * EXEC_STARTUP_SLACK + EXEC_PROGRAM_BUDGET_MS)
    // And it keeps scaling: a host twice as slow gets twice the start half,
    // which is what the load budget's own test asserts of its archive half.
    const startHalf = (ms: number): number => execTimeoutMs(ms) - EXEC_PROGRAM_BUDGET_MS
    expect(startHalf(17_200)).toBe(2 * startHalf(8_600))
  })

  test('every invocation of the real seam is given that budget and not one of its own', async () => {
    const calls: { argv: readonly string[]; timeoutMs: number }[] = []
    const run = async (argv: readonly string[], timeoutMs: number): Promise<ExecResult> => {
      calls.push({ argv, timeoutMs })
      return { status: 0, stdout: '', stderr: '' }
    }
    const argv = ['/usr/bin/crun', '--version']
    await dockerExec(REF, undefined, run)(argv)
    await dockerExec(REF, execTimeoutMs(8_600), run)(argv)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.argv).toEqual(dockerArgv(REF, argv))
    // The default is the composed fuse. A `dockerExec` that kept a number of its
    // own would make everything above a statement about an unused constant.
    expect(calls[0]!.timeoutMs).toBe(EXEC_TIMEOUT_MS)
    expect(calls[1]!.timeoutMs).toBe(execTimeoutMs(8_600))
  })

  test('a command that outlives a smaller budget survives the shipped one', async () => {
    // The direction that matters: without it, "report every exec as a timeout"
    // satisfies every other test here. Real subprocess, real watchdog, real
    // clock. It is scaled -- `sleep 0.5` against 100 ms is what a 31s
    // `--version` is against the 30s that killed one -- because the honest
    // full-size version sleeps for 31s on every gate run. The size of the
    // shipped budget is asserted above; this is the part that says the budget
    // is a budget and not a verdict.
    const killed = await capture(['sleep', '0.5'], 100)
    expect(killed.status).not.toBe(0)
    expect(killed.timedOutAfterMs).toBe(100)
    const survived = await capture(['sleep', '0.5'], EXEC_TIMEOUT_MS)
    expect(survived.status).toBe(0)
    expect(survived.timedOutAfterMs).toBeUndefined()
    expect(diagnose(survived)).not.toMatch(/watchdog/)
  })
})

describe('the load budget is a rate, which is what keeps it from being a bigger constant', () => {
  test('the part that is about the archive scales with the archive', () => {
    const shipped = loadTimeoutMs(RECORD.bytes)
    expect(shipped).toBe(LOAD_TIMEOUT_FLOOR_MS + Math.ceil(RECORD.bytes / LOAD_TIMEOUT_BYTES_PER_MS))
    // Measured on this host: this archive loads in 20.3s cold and 4.3s with the
    // layers already present, and the 30s constant this replaced killed it
    // under three concurrent builds. Whatever the floor and the rate are later
    // edited to, doubling the archive has to double the part that is about the
    // archive -- a budget that answers the same for 250 MB and for 1 GB is that
    // constant again under another name.
    expect(shipped).toBeGreaterThan(EXEC_TIMEOUT_MS)
    const twice = loadTimeoutMs(2 * RECORD.bytes) - LOAD_TIMEOUT_FLOOR_MS
    expect(Math.abs(twice - 2 * (shipped - LOAD_TIMEOUT_FLOOR_MS))).toBeLessThanOrEqual(1)
  })

  test('the load is given that budget and the questions beside it the ordinary fuse', async () => {
    const { run, calls } = fakeDaemon({ load: LOADED_OK, images: { [MANIFEST_DIGEST]: OUR_ID }, members: MEMBERS })
    await loadFactoryRoot(RECORD, run)
    const load = calls.filter(c => c.argv[1] === 'load')
    expect(load).toHaveLength(1)
    expect(load[0]!.timeoutMs).toBe(loadTimeoutMs(RECORD.bytes))
    const beside = calls.filter(c => c.argv[1] !== 'load')
    expect(beside.length).toBeGreaterThan(0)
    expect(beside.every(c => c.timeoutMs === EXEC_TIMEOUT_MS)).toBe(true)
  })
})

describe('a `docker load` the watchdog killed is not a load that failed', () => {
  // The observed event, verbatim: a kill whose captured output is docker's own
  // success line. Before this, the loader read the 137 and threw, and seven
  // minutes of a sibling's build went with it.
  const KILLED_BUT_DONE: ExecResult = {
    status: 137,
    stdout: `Loaded image: ${REF}\n`,
    stderr: '',
    timedOutAfterMs: 30_000,
  }

  test('the daemon holds the image the archive describes, so the run continues with it', async () => {
    const { run } = fakeDaemon({ load: KILLED_BUT_DONE, images: { [MANIFEST_DIGEST]: OUR_ID }, members: MEMBERS })
    const loaded = await loadFactoryRoot(RECORD, run)
    expect(loaded.id).toBe(OUR_ID)
    expect(loaded.source).toBe('content')
  })

  test('what is asked of the daemon after a kill is the ARCHIVE`s digest, never the tag', async () => {
    // A stale `:uefi-x64` another worktree loaded an hour ago answers "is something
    // loaded?" exactly as well as this build's root does, so after a kill the
    // tag is not evidence -- and the refusal below is the right answer even
    // though the daemon does hold an image under that name.
    const { run, calls } = fakeDaemon({ load: KILLED_BUT_DONE, images: { [REF]: SOMEONE_ELSE }, members: MEMBERS })
    await expect(loadFactoryRoot(RECORD, run)).rejects.toThrow(/watchdog killed/)
    expect(askedAbout(calls, REF)).toBe(false)
    expect(askedAbout(calls, MANIFEST_DIGEST)).toBe(true)
  })

  test('when the load really did not happen, the refusal names the watchdog and its budget', async () => {
    const { run } = fakeDaemon({ load: { ...KILLED_BUT_DONE, stdout: '' }, members: MEMBERS })
    let said = 'it did not refuse at all'
    try {
      await loadFactoryRoot(RECORD, run)
    } catch (e) {
      said = (e as Error).message
    }
    expect(said).toMatch(/the watchdog killed `docker load/)
    expect(said).toMatch(/after 30000 ms/)
    expect(said).toMatch(/250083328-byte archive/)
    // The message this replaces made the reader decode a signal number.
    expect(said).not.toMatch(/exited 137/)
  })

  test('a load that failed on its own still reports its own status and what it said', async () => {
    // The control: nothing here softens a real failure into a continuation.
    const { run } = fakeDaemon({
      load: { status: 1, stdout: '', stderr: 'open /out/uefi-x64/factory-root.oci: no such file or directory\n' },
    })
    await expect(loadFactoryRoot(RECORD, run)).rejects.toThrow(/exited 1: open \/out\/uefi-x64/)
  })

  test('a readable OCI archive rejected by the classic store can use BuildKit', async () => {
    const { run, calls } = fakeDaemon({
      load: { status: 1, stdout: '', stderr: 'invalid archive: does not contain a manifest.json' },
      members: MEMBERS,
    })
    await expect(loadFactoryRoot(RECORD, run)).rejects.toBeInstanceOf(OciArchiveLoadUnsupported)
    expect(askedAbout(calls, REF)).toBe(false)
  })

  test('the same load message for an unreadable archive remains a hard failure', async () => {
    const { run } = fakeDaemon({
      load: { status: 1, stdout: '', stderr: 'invalid archive: does not contain a manifest.json' },
    })
    await expect(loadFactoryRoot(RECORD, run)).rejects.toThrow(/tar could not read index.json/)
  })
})

describe('the run addresses the image it loaded, not the tag it loaded it under', () => {
  test('a tag re-pointed by a sibling between the load and the run cannot change what runs', async () => {
    // The race, expressed: this load exited 0, and by the time anything is
    // resolved the daemon-global tag already names another worktree's root.
    const { run, calls } = fakeDaemon({
      load: LOADED_OK,
      images: { [REF]: SOMEONE_ELSE, [MANIFEST_DIGEST]: OUR_ID },
      members: MEMBERS,
    })
    const loaded = await loadFactoryRoot(RECORD, run)
    expect(loaded.id).toBe(OUR_ID)
    expect(loaded.id).not.toBe(SOMEONE_ELSE)
    expect(loaded.source).toBe('content')
    expect(askedAbout(calls, REF)).toBe(false)
  })

  test('the classic image store calls the image by its CONFIG digest, and that is asked too', async () => {
    // Measured here: docker 29.7.2's containerd store answers {{.Id}} with the
    // manifest digest, and `docker image inspect <config digest>` answers
    // `No such image`. The classic store is the other way round. A loader that
    // knew only one of them would fall back to the tag on every host with the
    // other, which is the defect this exists to close.
    const classicId = 'sha256:37a4fbb3e1642b6ec6fc321f0ba5ea7c347ea0f581902895e60f566d5de2ae8d'
    const { run, calls } = fakeDaemon({ load: LOADED_OK, images: { [CONFIG_DIGEST]: classicId }, members: MEMBERS })
    const loaded = await loadFactoryRoot(RECORD, run)
    expect(loaded).toEqual({ ref: REF, id: classicId, source: 'content' })
    expect(askedAbout(calls, REF)).toBe(false)
  })

  test('a daemon that answers to neither digest falls back to the tag AND says which it did', async () => {
    // Never worse than what it replaced: an image store that names images a
    // third way must not turn every smoke run on that host into a refusal about
    // the runner. What it must not do is stay quiet about it, because
    // "resolved by content" and "resolved through a global tag" are different
    // statements about how much the verdicts after it can be trusted.
    const lines: string[] = []
    const { run } = fakeDaemon({ load: LOADED_OK, images: { [REF]: SOMEONE_ELSE }, members: MEMBERS })
    const loaded = await loadFactoryRoot(RECORD, run, l => lines.push(l))
    expect(loaded).toEqual({ ref: REF, id: SOMEONE_ELSE, source: 'tag' })
    expect(lines.join('\n')).toMatch(/through the TAG/)
  })

  test('an archive that will not say what it carries is a loud fallback, not a refusal', async () => {
    const lines: string[] = []
    const { run } = fakeDaemon({ load: LOADED_OK, images: { [REF]: OUR_ID } })
    const loaded = await loadFactoryRoot(RECORD, run, l => lines.push(l))
    expect(loaded.source).toBe('tag')
    expect(lines.join('\n')).toMatch(/does not say which image it carries/)
  })

  test('a load that exited 0 and left nothing behind at all is a refusal', async () => {
    const { run } = fakeDaemon({ load: LOADED_OK, members: MEMBERS })
    await expect(loadFactoryRoot(RECORD, run)).rejects.toThrow(/had no image at localhost\/mica-factory-root:uefi-x64/)
  })
})

describe('what the archive says it carries, read out of the archive and not out of the daemon', () => {
  test('the index names the image for this platform and the manifest names its config', async () => {
    const { run } = fakeDaemon({ load: LOADED_OK, members: MEMBERS })
    expect(await archiveImageDigests(RECORD, run)).toEqual([MANIFEST_DIGEST, CONFIG_DIGEST])
  })

  test('an index with two images for one platform refuses rather than picking one', () => {
    // build/src/stages.ts exports with --provenance=false --sbom=false, so
    // the shipped archive carries exactly one manifest. If that ever changes,
    // this must not choose between them, and the count is in the message so a
    // reader knows what it was looking at.
    const two = INDEX_JSON.replace(
      `"platform":{"architecture":"amd64","os":"linux"}}]}`,
      `"platform":{"architecture":"amd64","os":"linux"}},`
      + `{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"${SOMEONE_ELSE}","size":482,`
      + `"platform":{"architecture":"amd64","os":"linux"}}]}`,
    )
    expect(two).not.toBe(INDEX_JSON)
    expect(() => parseArchiveIndex(two, 'linux/amd64', '/x/index.json'))
      .toThrow(/2 manifest\(s\), 2 of them images and 2 of those for linux\/amd64/)
  })

  test('an image for another platform is not this record`s image', () => {
    expect(() => parseArchiveIndex(INDEX_JSON, 'linux/arm64', '/x/index.json'))
      .toThrow(/0 of those for linux\/arm64/)
  })

  test('the variant is not part of the comparison', () => {
    // `linux/arm64/v8` in an index and `linux/arm64` in the record are the same
    // platform; refusing that pair would send every arm64 board back to the tag.
    const arm = INDEX_JSON.replace('"architecture":"amd64"', '"architecture":"arm64","variant":"v8"')
    expect(arm).not.toBe(INDEX_JSON)
    expect(parseArchiveIndex(arm, 'linux/arm64', '/x/index.json')).toBe(MANIFEST_DIGEST)
  })

  test('a digest maps onto the member an OCI layout tar carries it as', () => {
    expect(blobMember(MANIFEST_DIGEST)).toBe(`blobs/sha256/${MANIFEST_DIGEST.slice('sha256:'.length)}`)
    expect(() => blobMember('85156a1e0da9')).toThrow(/<algorithm>:<hex>/)
  })

  test('a manifest with no config digest says so rather than resolving to nothing', () => {
    expect(() => parseArchiveManifest('{"schemaVersion":2}', '/x/manifest'))
      .toThrow(/names no config digest/)
    expect(parseArchiveManifest(MANIFEST_JSON, '/x/manifest')).toBe(CONFIG_DIGEST)
  })

  test('an archive tar cannot read is reported as the tar failure it was', async () => {
    const { run } = fakeDaemon({ load: LOADED_OK })
    await expect(archiveImageDigests(RECORD, run)).rejects.toThrow(/tar could not read index\.json/)
  })
})
