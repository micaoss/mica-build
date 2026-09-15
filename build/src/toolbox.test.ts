// The toolbox seam, driven from the failing side.
//
// THERE IS ONE ROUTE NOW. This file used to open COREUTILS on the host and
// FILE_IMAGE_TOOLS in a container and assert that the choice was measured; the
// policy in mica:docs/design/build.md section 0 removed the choice, and the cases
// below assert the refusal instead. COREUTILS is what makes that a real
// assertion rather than a restatement: dd and truncate ARE on this host, so a
// refusal that fired only where the tools were missing would be a capability
// check wearing a policy's message, and this one has to fire anyway.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $ } from 'bun'
import { makeWorkDir, REPO_ROOT } from './paths.ts'
import { Toolbox, ToolError, type Toolset } from './toolbox.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from './testing.ts'
import { COREUTILS } from './toolsets.ts'
import { FILE_IMAGE_TOOLS } from './file-image.ts'

const docker = process.env.MICA_BUILD_DOCKER || 'docker'

let work = ''
// Two toolboxes, two images' worth of packages, one route. `coreutils` is the
// toolset whose tools this host HAS, and it is here so that every assertion
// below is about the rule rather than about what happens to be installed.
let coreutils: Toolbox
let container: Toolbox
const announced: string[] = []

beforeAll(async () => {
  work = makeWorkDir('toolbox')
  coreutils = await Toolbox.open(COREUTILS, { mounts: [REPO_ROOT], cwd: work, announce: l => announced.push(l) })
  container = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [REPO_ROOT], cwd: work, announce: l => announced.push(l) })
}, OPEN_TIMEOUT_MS)

afterAll(async () => {
  await coreutils?.close()
  await container?.close()
  if (work !== '') rmSync(work, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

describe('there is one route, and it is the container', () => {
  test('a toolset whose tools are ON this host still runs in the pinned image', async () => {
    // THE MUTATION-PROOF CASE. dd and truncate are on every machine, this one
    // included -- so if the route were still measured, this toolbox would be a
    // host toolbox. It is not, and that is the policy rather than a property of
    // this host.
    expect((await $`sh -c ${'command -v dd >/dev/null 2>&1 && command -v truncate >/dev/null 2>&1'}`.nothrow().quiet()).exitCode)
      .toBe(0)
    expect(coreutils.route).toBe('container')
    expect(coreutils.image).toMatch(/^alpine:3\.21@sha256:[0-9a-f]{64}$/)
  })

  test('the assembly toolset runs in the image its key pins', () => {
    expect(container.route).toBe('container')
    expect(container.image).toMatch(/^alpine:3\.21@sha256:[0-9a-f]{64}$/)
  })

  test('the announce line says WHY, so a run is never ambiguous about it', () => {
    // "no bun on this host" is verify/run.sh's version of the same sentence.
    for (const tb of [coreutils, container]) {
      expect(tb.announceLine).toContain('every tool here writes bytes that ship')
    }
  })

  test('a route is announced exactly once per toolbox', () => {
    expect(announced.length).toBe(2)
    expect(announced.every(l => l.startsWith('build: '))).toBe(true)
  })

})

describe('a tool that runs, runs the same way in every toolbox', () => {
  test('the same argv, the same stdout, in two toolsets', async () => {
    const a = await coreutils.run(['truncate', '-s', '1M', join(work, 'a.img')])
    const b = await container.run(['truncate', '-s', '1M', join(work, 'b.img')])
    expect(`${a.ok} ${a.exitCode}`).toBe(`${b.ok} ${b.exitCode}`)
    expect(Bun.file(join(work, 'a.img')).size).toBe(1048576)
    expect(Bun.file(join(work, 'b.img')).size).toBe(1048576)
    // Byte-identical, which is the property every later milestone is gated on.
    expect(await Bun.file(join(work, 'a.img')).bytes()).toEqual(await Bun.file(join(work, 'b.img')).bytes())
  }, TOOL_TIMEOUT_MS)

  test('the identity mount makes a host path name the same file inside', async () => {
    // Not /w and not /work. The container is handed a path built OUTSIDE it,
    // so a translated one would name something else -- or nothing, and a bind
    // mount of a path the daemon cannot see does not fail: it succeeds and
    // delivers an empty directory.
    const marker = join(work, 'identity.txt')
    writeFileSync(marker, 'written on the host\n')
    const r = await container.run(['cat', marker])
    expect(r.stdout).toBe('written on the host\n')
    expect(r.ok).toBe(true)
  })

  test('an argument with a space or a semicolon is an argument, not a command', async () => {
    // Nothing is passed through a shell on either route: Bun.$ interpolates an
    // array as separate arguments and `docker exec` takes an argv. A partition
    // LABEL is a value out of a board definition, and the parser that read it
    // refuses shell metacharacters for the same reason this layer must.
    const nasty = 'a b; touch /tmp/PWNED'
    for (const [name, tb] of [['coreutils', coreutils], ['assembly', container]] as const) {
      const r = await tb.run(['sh', '-c', 'printf "%s" "$1"', 'sh', nasty])
      expect(`${name}: ${r.stdout}`).toBe(`${name}: ${nasty}`)
    }
    expect(existsSync('/tmp/PWNED')).toBe(false)
  })

  test('the environment a toolset declares reaches the tool', async () => {
    for (const [name, tb] of [['coreutils', coreutils], ['assembly', container]] as const) {
      const r = await tb.run(['sh', '-c', 'printf "%s" "${SOME_PIN}"'], { env: { SOME_PIN: '1577836800' } })
      expect(`${name}: ${r.stdout}`).toBe(`${name}: 1577836800`)
    }
  })
})

describe('read-only identity mounts', () => {
  test.each([false, true])('read-only protection survives overlapping and duplicate declarations, reversed=%s', async (reversed) => {
    const fixture = join(work, `mounts-${reversed}`)
    const metadata = join(fixture, '.git')
    const nested = join(metadata, 'worktrees', 'linked')
    mkdirSync(nested, { recursive: true, mode: 0o777 })
    const alias = join(fixture, 'metadata-alias')
    symlinkSync(metadata, alias)
    const files = [join(metadata, 'config'), join(nested, 'HEAD')]
    for (const file of files) writeFileSync(file, 'fixture metadata\n', { mode: 0o666 })
    const writable = [fixture, metadata, `${metadata}/.`, nested, alias]
    const protectedPaths = [metadata, nested, `${metadata}/.`, metadata]
    if (reversed) { writable.reverse(); protectedPaths.reverse() }
    const tb = await Toolbox.open({ key: 'mount-fixture', imageKey: 'upstream:alpine:3.24.1', manager: 'apk', packages: [], tools: ['sh', 'cat', 'id'] }, {
      mounts: writable,
      readOnlyMounts: protectedPaths,
    })
    try {
      expect((await tb.must(['id', '-u'])).stdout.trim()).toBe('0')
      for (const file of [...files, join(alias, 'config')]) {
        expect((await tb.must(['cat', file])).stdout).toBe('fixture metadata\n')
        const write = await tb.run(['sh', '-c', 'printf changed > "$1"', 'sh', file])
        expect(write.exitCode, `${write.stdout}${write.stderr}`).not.toBe(0)
        expect(write.stderr).toMatch(/Read-only file system/i)
        expect(readFileSync(file, 'utf8')).toBe('fixture metadata\n')
      }
      const ordinary = join(fixture, '.git-other')
      await tb.must(['sh', '-c', 'printf writable > "$1"', 'sh', ordinary])
      expect(readFileSync(ordinary, 'utf8')).toBe('writable')
    } finally { await tb.close() }
  }, OPEN_TIMEOUT_MS)
})

describe('a failing tool is reported, never swallowed', () => {
  test('run() hands back the status and both streams and decides nothing', async () => {
    for (const [name, tb] of [['coreutils', coreutils], ['assembly', container]] as const) {
      const r = await tb.run(['sh', '-c', 'echo out; echo err >&2; exit 3'])
      expect(`${name}: ${r.exitCode} ${r.ok}`).toBe(`${name}: 3 false`)
      expect(`${name}: ${r.stdout.trim()}`).toBe(`${name}: out`)
      expect(`${name}: ${r.stderr.trim()}`).toBe(`${name}: err`)
    }
  })

  test('must() throws a ToolError carrying the argv, the route, the status and both streams', async () => {
    let caught: ToolError | undefined
    try {
      await container.must(['sh', '-c', 'echo the-stdout; echo the-stderr >&2; exit 7'])
    } catch (e) {
      caught = e as ToolError
    }
    expect(caught).toBeInstanceOf(ToolError)
    expect(caught!.exitCode).toBe(7)
    expect(caught!.route).toBe('container')
    expect(caught!.stderr).toContain('the-stderr')
    expect(caught!.stdout).toContain('the-stdout')
    // ...and all of it is in the MESSAGE, because that is what a build log shows.
    expect(caught!.message).toContain('exit 7')
    expect(caught!.message).toContain('the-stderr')
    expect(caught!.message).toContain('the-stdout')
    expect(caught!.message).toContain('route:  container')
  })

  test('a real tool failing is the same shape as a contrived one', async () => {
    // The contrived `exit 7` above proves the plumbing; this proves it against
    // sgdisk refusing a file that is not there.
    let msg = ''
    try {
      await container.must(['sgdisk', '--verify', join(work, 'not-here.img')])
    } catch (e) {
      msg = (e as ToolError).message
    }
    expect(msg).toContain('sgdisk')
    expect(msg).toContain('not-here.img')
    expect(msg).toMatch(/does not exist|Error is 2/)
  })

  test('a tool that is not in the toolset at all fails as a tool, not as a crash', async () => {
    for (const tb of [container, coreutils]) {
      const r = await tb.run(['definitely-not-a-tool-xyz'])
      expect(r.ok).toBe(false)
      // Two things worth pinning, both measured against docker 28 on
      // 2026-09-04 and neither obvious. `docker exec` reports a missing binary
      // as 127 -- and it writes "OCI runtime exec failed: ... executable file
      // not found in $PATH" to STDOUT, not stderr. A wrapper that read only
      // stderr would report a failure with no reason attached, which is why
      // ToolError carries both streams.
      expect(r.exitCode).toBe(127)
      expect(`${r.stdout}${r.stderr}`).toMatch(/executable file not found/)
    }
  })

  test('an empty argv is refused, before docker turns it into a usage error', async () => {
    await expect(coreutils.run([])).rejects.toThrow(/empty argv, which is not a tool call/)
    await expect(container.run([])).rejects.toThrow(/empty argv, which is not a tool call/)
  })
})

describe('a toolbox that cannot provide its tools does not open', () => {
  test('a package that does not provide the tool it claims is caught at open, by name', async () => {
    // THE REAL SHAPE OF THIS: alpine splits debugfs and dumpe2fs out of
    // e2fsprogs into e2fsprogs-extra, so `apk add e2fsprogs` succeeds and
    // provides neither. Without this assertion the gap surfaces as "debugfs:
    // not found" from pin_seeded_times, forty steps into an assembly.
    const wrong: Toolset = {
      key: 'missing-extra',
      imageKey: 'upstream:alpine:3.24.1',
      manager: 'apk',
      packages: ['e2fsprogs'],
      tools: ['mke2fs', 'debugfs', 'dumpe2fs'],
    }
    let msg = ''
    try {
      const tb = await Toolbox.open(wrong, { route: 'container' })
      await tb.close()
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('missing-extra')
    expect(msg).toContain('missing:')
    expect(msg).toMatch(/debugfs/)
    expect(msg).toContain('e2fsprogs')
  }, OPEN_TIMEOUT_MS)

  test('the positive control: the same image WITH the extra package opens', async () => {
    // Otherwise the assertion above would also pass if nothing could ever open.
    const right: Toolset = {
      key: 'with-extra',
      imageKey: 'upstream:alpine:3.24.1',
      manager: 'apk',
      packages: ['e2fsprogs', 'e2fsprogs-extra'],
      tools: ['mke2fs', 'debugfs', 'dumpe2fs'],
    }
    const tb = await Toolbox.open(right, { route: 'container' })
    try {
      expect((await tb.run(['debugfs', '-V'])).ok).toBe(true)
    } finally {
      await tb.close()
    }
  }, OPEN_TIMEOUT_MS)

  test('a package that does not exist is an install failure naming the packages', async () => {
    const bad: Toolset = {
      key: 'no-such-package',
      imageKey: 'upstream:alpine:3.24.1',
      manager: 'apk',
      packages: ['this-package-does-not-exist-xyz'],
      tools: ['sh'],
    }
    await expect(Toolbox.open(bad, { route: 'container' }))
      .rejects.toThrow(/could not be installed.*this-package-does-not-exist-xyz/s)
  }, OPEN_TIMEOUT_MS)

  test('an install failure says how many attempts were made, and does not read as one', async () => {
    // The install is retried because apk reports a failed index FETCH as "no
    // such package" -- measured at ~7% of runs on this host, which is a red
    // suite every other time. A package that really is absent fails identically
    // every attempt, so nothing is hidden; what must not happen is a refusal
    // that describes one attempt when there were three.
    const bad: Toolset = {
      key: 'still-no-such-package',
      imageKey: 'upstream:alpine:3.24.1',
      manager: 'apk',
      packages: ['this-package-does-not-exist-xyz'],
      tools: ['sh'],
    }
    let msg = ''
    try {
      const tb = await Toolbox.open(bad, { route: 'container' })
      await tb.close()
    } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('in 3 attempts')
    expect(msg).toContain('apk reports a failed index FETCH as "no such package"')
  }, OPEN_TIMEOUT_MS)

  test('an image key no image file defines is refused BY THE KEY, before any container', async () => {
    const bad: Toolset = {
      key: 'no-such-image',
      imageKey: 'IMAGE_NOT_IN_THE_FILE',
      manager: 'apk',
      packages: [],
      tools: ['sh'],
    }
    await expect(Toolbox.open(bad, { route: 'container' })).rejects.toThrow(/no image key IMAGE_NOT_IN_THE_FILE/)
  })

  test('asking for the host route is a refusal that names the policy', async () => {
    let msg = ''
    try { await Toolbox.open(FILE_IMAGE_TOOLS, { route: 'host' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('file-image')
    expect(msg).toContain('the caller asked for it')
    expect(msg).toContain('mica:docs/design/build.md section 0')
  })

  test('...and it is a policy, not a capability check that installing tools would satisfy', async () => {
    // COREUTILS again, for the reason at the top of this file: its tools are
    // HERE. A refusal that only fired on a missing tool would let this through.
    let msg = ''
    try { await Toolbox.open(COREUTILS, { route: 'host' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('coreutils')
    expect(msg).toContain('not a capability check that can be satisfied by installing the tools')
    expect(msg).toContain('upstream:alpine:3.24.1')
  })

  test('MICA_BUILD_TOOLBOX=host is refused too, and says which asked', async () => {
    // Two ways in, one rule. Honouring the environment variable while refusing
    // the argument -- or the other way round -- would make the policy depend on
    // how it was asked for.
    const before = process.env.MICA_BUILD_TOOLBOX
    process.env.MICA_BUILD_TOOLBOX = 'host'
    try {
      let msg = ''
      try { await Toolbox.open(COREUTILS) } catch (e) { msg = (e as Error).message }
      expect(msg).toContain('MICA_BUILD_TOOLBOX=host asked for it')
      expect(msg).toContain('mica:docs/design/build.md section 0')
    } finally {
      if (before === undefined) delete process.env.MICA_BUILD_TOOLBOX
      else process.env.MICA_BUILD_TOOLBOX = before
    }
  })
})

describe('the session is torn down, and says so if used afterwards', () => {
  test('close removes the container, and a second close is harmless', async () => {
    const tb = await Toolbox.open(COREUTILS, { route: 'container' })
    const name = tb.containerName
    expect((await $`${docker} inspect ${name}`.nothrow().quiet()).exitCode).toBe(0)
    await tb.close()
    await tb.close()
    expect((await $`${docker} inspect ${name}`.nothrow().quiet()).exitCode).not.toBe(0)
  }, OPEN_TIMEOUT_MS)

  // OPEN_TIMEOUT_MS, and it was not needed here until COREUTILS stopped taking
  // the host route: a ~4 ms open became a ~4.6 s one, which src/testing.ts
  // calls "the one that matters -- it is UNDER the default and it flaked
  // against it". This test went red at exactly 5000 ms the first time the
  // suite ran after the policy landed.
  test('a call after close names the toolbox rather than a random container id', async () => {
    const tb = await Toolbox.open(COREUTILS, { route: 'container' })
    await tb.close()
    await expect(tb.run(['true'])).rejects.toThrow(/toolbox was closed/)
    await expect(tb.run(['true'])).rejects.toThrow(/coreutils/)
  }, OPEN_TIMEOUT_MS)

  test('MICA_BUILD_TOOLBOX only accepts the two routes there are', async () => {
    const before = process.env.MICA_BUILD_TOOLBOX
    process.env.MICA_BUILD_TOOLBOX = 'sometimes'
    try {
      await expect(Toolbox.open(COREUTILS)).rejects.toThrow(/neither 'host' nor 'container'/)
    } finally {
      if (before === undefined) delete process.env.MICA_BUILD_TOOLBOX
      else process.env.MICA_BUILD_TOOLBOX = before
    }
  })
})
