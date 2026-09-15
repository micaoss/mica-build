// The tool seam, and the register that keeps a port honest.
//
// Everything here runs on a host with no docker and no image, because
// `make os-verify-test` does -- and in CI inside the pinned bun container,
// which has neither. The route DECISION is a pure function for that reason: a
// test that could only reach it by having sgdisk installed would run on one
// machine and skip on another, and a skip reports the same green as a pass.

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  APK_ATTEMPTS,
  apkExhaustedNote,
  chooseRoute,
  missingHostTools,
  mountDirs,
  mountFault,
  REQUIRED_TOOLS,
  retryInstall,
  routeReason,
  runChecked,
  TOOL_IMAGE_KEY,
  TOOL_PACKAGES,
  toolImageRef,
  ToolError,
  ToolOutputError,
  type ToolResult,
} from './tools.ts'
import { REPO_ROOT } from './paths.ts'

describe('the route is chosen once, and a value that is neither is refused', () => {
  test('a host with EVERY tool still takes the pinned container', () => {
    // The case that makes this a policy rather than a measurement. It used to
    // return 'host' here, so the verdict a verifier printed depended on the
    // debugfs and unsquashfs of whatever machine ran it; the tools are judges
    // by mica:docs/design/build.md section 0, and the pin is the contract.
    expect(chooseRoute(undefined, [])).toBe('container')
  })

  test('and so does a host that is missing one', () => {
    expect(chooseRoute(undefined, ['sgdisk'])).toBe('container')
  })

  test('MICA_VERIFY_TOOLS=host is the opt-out, and it is honoured when the tools are there', () => {
    // Both routes stay reachable on one machine -- a seam with one reachable
    // route is a seam nobody is checking -- but the host one has to be asked
    // for by name now.
    expect(chooseRoute('host', [])).toBe('host')
  })

  test('MICA_VERIFY_TOOLS=container is honoured even with every tool present', () => {
    expect(chooseRoute('container', [])).toBe('container')
  })

  test('MICA_VERIFY_TOOLS=host with tools missing is refused, naming them', () => {
    expect(() => chooseRoute('host', ['sgdisk', 'mdir'])).toThrow(/no sgdisk, mdir/)
    expect(() => chooseRoute('host', ['sgdisk'])).toThrow(ToolOutputError)
  })

  test('a value that is neither is refused rather than read as unset', () => {
    // The failure this prevents: a typo silently taking the other route, and
    // the run then being about a bun -- or a tool set -- nobody asked for.
    expect(() => chooseRoute('contaner', [])).toThrow(/takes 'host' or 'container'/)
    expect(() => chooseRoute('1', ['sgdisk'])).toThrow(/is '1'/)
  })
})

describe('the announce line says WHY, because it is the only thing that says which tools ran', () => {
  test('missing tools are named', () => {
    expect(routeReason(undefined, ['sgdisk', 'mdir'])).toBe('no sgdisk, mdir on this host')
  })

  test('a forced container on a tool-ful host names the variable that forced it', () => {
    expect(routeReason('container', [])).toBe('MICA_VERIFY_TOOLS=container')
  })

  test('the DEFAULT container on a tool-ful host says it is the contract, not a shortage', () => {
    // A host with every tool takes the container now, and telling that reader
    // "no  on this host" -- or nothing at all -- would name a reason that is
    // not the reason.
    expect(routeReason(undefined, [])).toContain('the pinned tools are the contract')
  })

  test('never an empty subject', () => {
    // Driven by a real regression: once parity-cli decided the route up front
    // and passed it in, createToolRuntime stopped computing the missing list
    // and announced "(no <empty tool list> on this host)".
    for (const reason of [routeReason(undefined, []), routeReason('container', []), routeReason('host', [])]) {
      expect(reason).not.toMatch(/^no\s*$|no\s+on this host/)
      expect(reason.length).toBeGreaterThan(3)
    }
  })
})

describe('the tool set and the image it comes from', () => {
  test('every tool the shell verifier requires and this port drives is named', () => {
    const named: readonly string[] = REQUIRED_TOOLS
    for (const tool of ['sgdisk', 'mdir', 'mcopy', 'mlabel', 'debugfs', 'tune2fs', 'unsquashfs', 'veritysetup']) {
      expect(named).toContain(tool)
    }
  })

  // GONE WITH THE ORACLE, as this test itself said it would be: it read the
  // `apk add` line out of the verification contract and required TOOL_PACKAGES to
  // equal it, so that a parity divergence could never be a package difference.
  // There is no second tool list left to agree with -- TOOL_PACKAGES is now the
  // only statement of what the verifier installs, and a test that compared it
  // against itself would asserted nothing. Removed rather than weakened.

  test('the image comes from the one resolver, by key, as a digest', async () => {
    const ref = await toolImageRef()
    expect(ref).toMatch(/^docker\.io\/library\/alpine:3\.24\.1@sha256:[0-9a-f]{64}$/)
    expect(TOOL_IMAGE_KEY).toBe('upstream:alpine:3.24.1')
  })

  test('missingHostTools only ever names tools this package drives', async () => {
    const named: readonly string[] = REQUIRED_TOOLS
    for (const t of await missingHostTools()) expect(named).toContain(t)
  })
})

describe('mounts are identity mounts, and there is one per directory', () => {
  test('a directory is mounted itself; a file gives up its directory', () => {
    expect(mountDirs([REPO_ROOT])).toEqual([REPO_ROOT])
    expect(mountDirs([join(REPO_ROOT, 'Makefile')])).toEqual([REPO_ROOT])
  })

  // THE FIXTURES ARE ASSERTED TO EXIST, and that is the whole difference
  // between this test and the one below it. mountDirs() falls back to dirname()
  // for a path that is not there, so two GHOST files in one directory give the
  // same answer two real ones do -- this case would keep passing while silently
  // becoming a duplicate of 'a path that is not there yields its PARENT'.
  test('two files in one directory are one mount', () => {
    const dir = join(REPO_ROOT, 'boot')
    const pair = [join(dir, 'verity-tool.sh'), join(dir, 'dev-keys.sh')]
    for (const f of pair) expect(existsSync(f)).toBe(true)
    expect(mountDirs(pair)).toEqual([dir])
  })

  test('a path that is not there yields its PARENT, so the tool reports the file', () => {
    // A runtime that refused here would send the reader to look at a mount
    // when what is missing is the file they named.
    const ghost = join(REPO_ROOT, '_out', 'nothing-here.img')
    expect(mountDirs([ghost])).toEqual([dirname(ghost)])
  })
})

describe('the mount preflight probes CONTENT, because a path proves nothing', () => {
  const base = { unseen: [] as string[], echoed: 'S', sentinel: 'S', workDir: '/w' }

  test('a mount that carries what the host has is no fault', () => {
    expect(mountFault(base)).toBeUndefined()
  })

  test('a path the container cannot see names it and names the mount', () => {
    // The shape this host produces: a bind mount under /tmp succeeds and
    // delivers an empty directory, so the sentinel FILE is not in it.
    const fault = mountFault({ ...base, unseen: ['/tmp/w/.probe'] })
    expect(fault).toContain('/tmp/w/.probe')
    expect(fault).toContain('the mount that is empty')
  })

  test('a mount that carries something ELSE is a fault too', () => {
    // Cannot be produced on this host -- so it is driven here rather than left
    // as a branch nobody has ever seen take. The first version of this guard
    // asked `[ -e "$dir" ]` of the work directory, which an empty mount
    // SATISFIES: run with --work under /tmp it reported no problem at all.
    const fault = mountFault({ ...base, echoed: 'something else' })
    expect(fault).toContain("reads back as 'something else'")
    expect(fault).toContain('a content probe and not an existence one')
  })

  test('a sentinel that reads back empty is reported as (nothing)', () => {
    expect(mountFault({ ...base, echoed: '' })).toContain('reads back as (nothing)')
    expect(mountFault({ ...base, echoed: undefined })).toContain('reads back as (nothing)')
  })
})

describe('runChecked is where a non-zero exit becomes a throw', () => {
  const exec = (code: number) => async (argv: readonly string[]): Promise<ToolResult> =>
    ({ argv, code, stdout: 'out', stderr: 'boom' })

  test('exit 0 comes back', async () => {
    expect((await runChecked(exec(0), ['sgdisk', '-p'], undefined)).stdout).toBe('out')
  })

  test('a non-zero exit throws, naming the argv, the status and the stderr', async () => {
    const p = runChecked(exec(2), ['sgdisk', '-p', '/x.img'], { context: 'reading the GPT' })
    await expect(p).rejects.toThrow(ToolError)
    await expect(p).rejects.toThrow(/reading the GPT: `sgdisk -p \/x\.img` exited 2/)
    await expect(p).rejects.toThrow(/stderr: boom/)
  })

  test('an ALLOWED status comes back instead -- veritysetup answers with one', async () => {
    expect((await runChecked(exec(1), ['veritysetup'], { allow: [1] })).code).toBe(1)
  })

  test('and a status that was not allowed still throws', async () => {
    await expect(runChecked(exec(2), ['veritysetup'], { allow: [1] })).rejects.toThrow(ToolError)
  })
})

describe('the package install is retried, because apk lies about losing its index', () => {
  // The rule this package lives by is that an unreliable environment is a
  // FINDING and a retry that hides one decides the verdict. That rule is about
  // a check's ANSWER; this is the setup, it fails ~7% of the time, and it
  // MISREPORTS its own cause. So the retry is legitimate here -- and every case
  // below exists to prove it hides nothing.

  /** An install that fails `failures` times and then succeeds, counting calls. */
  function flaky(failures: number): { attempt: () => Promise<ToolResult>, calls: () => number } {
    let n = 0
    return {
      calls: () => n,
      attempt: async (): Promise<ToolResult> => {
        n += 1
        return n <= failures
          ? {
              argv: ['apk', 'add', '-q', 'e2fsprogs'],
              code: 1,
              stdout: '',
              stderr: 'ERROR: unable to select packages:\n  e2fsprogs (no such package):',
            }
          : { argv: ['apk', 'add', '-q', 'e2fsprogs'], code: 0, stdout: '', stderr: '' }
      },
    }
  }

  /** No real sleeping: the exhausted case would otherwise cost three seconds. */
  const nopause = async (): Promise<void> => {}

  test('a first-attempt success runs ONCE -- no needless retry, no sleep', async () => {
    const f = flaky(0)
    expect((await retryInstall(f.attempt, APK_ATTEMPTS, nopause)).code).toBe(0)
    expect(f.calls()).toBe(1)
  })

  test('the measured failure -- two lost index fetches, then the install lands', async () => {
    // M6a measured 3 failures in 40 consecutive runs. Two in a row is well past
    // that and still recovers.
    const f = flaky(2)
    expect((await retryInstall(f.attempt, APK_ATTEMPTS, nopause)).code).toBe(0)
    expect(f.calls()).toBe(3)
  })

  test('a package that GENUINELY does not exist fails every attempt and is reported', async () => {
    // The half that keeps the retry honest. A real absence is not flaky, so it
    // survives all three attempts and comes back as a failure -- the retry
    // changes how long it takes to say so, never what it says.
    const f = flaky(Number.MAX_SAFE_INTEGER)
    const last = await retryInstall(f.attempt, APK_ATTEMPTS, nopause)
    expect(last.code).toBe(1)
    expect(f.calls()).toBe(APK_ATTEMPTS)
    // ...and the LAST result is handed back, so the reader sees apk's own words.
    expect(last.stderr).toContain('no such package')
  })

  test('the pause grows between attempts, and there is one fewer pause than attempt', async () => {
    // Not decoration: a fetch that failed because the network was briefly gone
    // is likelier to succeed after a second than after none, and pausing AFTER
    // the last attempt would only slow the refusal down.
    const waited: number[] = []
    await retryInstall(flaky(Number.MAX_SAFE_INTEGER).attempt, APK_ATTEMPTS,
      async (ms) => { waited.push(ms) })
    expect(waited).toEqual([1000, 2000])
  })

  test('zero attempts is REFUSED, not reported as a silent success', async () => {
    // A loop that runs no attempts has no result, and returning one anyway --
    // or `undefined` for a caller to read as ok -- would turn a failed install
    // into a container with no tools in it and a check blaming the image.
    await expect(retryInstall(flaky(0).attempt, 0, nopause)).rejects.toThrow(/has no result to report/)
  })

  test('the refusal SAYS what apk\'s sentence actually means', async () => {
    // The message fix, which is separate from the retry and would have been
    // worth making on its own. apk's own sentence is specific, confident and
    // points somewhere useless -- it blames a package the pinned image
    // demonstrably carries -- so quoting it unqualified sends a reader to look
    // for a packaging problem that is not there.
    const note = apkExhaustedNote('alpine:3.21@sha256:dead', APK_ATTEMPTS)
    expect(note).toContain('failed index FETCH')
    expect(note).toContain('NOT evidence the named package is absent')
    expect(note).toContain('alpine:3.21@sha256:dead')
    expect(note).toContain(`attempts: ${APK_ATTEMPTS}`)
  })

  test('and the note reaches the reader, attached to the tool output', async () => {
    // Asserted through ToolError rather than on the note alone: the note is
    // useless if the throw path drops it, and that is exactly the kind of gap
    // a test on the helper by itself would not see.
    const err = new ToolError(
      {
        argv: ['apk', 'add', '-q', 'e2fsprogs'],
        code: 1,
        stdout: '',
        stderr: 'ERROR: unable to select packages:\n  e2fsprogs (no such package):',
      },
      'installing the image tools into alpine:3.21',
      apkExhaustedNote('alpine:3.21'),
    )
    expect(err.message).toContain('no such package')          // apk's words, kept
    expect(err.message).toContain('failed index FETCH')        // ...and qualified
    expect(err.message).toContain('3 attempts are')
    expect(err).toBeInstanceOf(ToolError)
    expect(err.code).toBe(1)
  })

  test('a ToolError with NO note is unchanged -- every other tool still reads as before', () => {
    // The note is opt-in. sgdisk, debugfs, unsquashfs and veritysetup say what
    // they mean, and appending anything to their refusals would be noise.
    const err = new ToolError(
      { argv: ['sgdisk', '-p', '/x.img'], code: 2, stdout: '', stderr: 'boom' },
      'reading the GPT',
    )
    expect(err.message).toBe(
      'reading the GPT: `sgdisk -p /x.img` exited 2\n  stderr: boom\n  stdout: (empty)',
    )
  })
})
