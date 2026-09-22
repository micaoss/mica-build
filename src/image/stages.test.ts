// The rootfs assembly files, driven from the failing side.
//
// Every fault auditChain reports is produced here from a synthetic directory,
// because a guard nobody has seen take is the shape of guard this campaign
// keeps finding. The real stages/compose/ is then asserted against the shape
// those faults describe -- so the tests fail if the shipped assembly breaks AND
// if the checker stops being able to notice.

import { describe, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  auditChain,
  buildArgv,
  DEFAULT_OCI_TARGET,
  DEFAULT_TERMINAL_TARGET,
  discoverStages,
  factoryRootRef,
  featureOf,
  ociExport,
  ociRecord,
  OCI_ARCHIVE_NAME,
  planChain,
  PREV_ARG,
  readStageFile,
  selectStages,
  stageManifest,
  StageChainError,
  STAGES_DIR,
  unusedArgs,
  unsuppliedArgs,
  type StageFile,
} from './stages.ts'
import { parseArgs, parseDriver, chainMode, dockerBin } from './stages-cli.ts'
import { BOARDS_DIR, REPO_ROOT } from './paths.ts'

// A scratch directory of stage files. Under the repository's own _out/ rather
// than /tmp: a bind mount of /tmp on this host propagates as an EMPTY directory
// (bin/bun.sh src/cli.ts records the measurement), so a fixture there is invisible to
// the container route and the same test would pass on one route and fail on the
// other for a reason that has nothing to do with what it asserts.
const FIXTURE_ROOT = join(STAGES_DIR, '..', '..', '_out', 'stage-fixtures')
// Cleared once per run rather than per fixture: each scratch() is a mkdtemp, so
// without this the directory grows by ~25 every `bun test` and nothing ever
// removes them. Cleared at load rather than in an afterAll so a run that dies
// mid-suite still leaves exactly one run's worth to look at.
rmSync(FIXTURE_ROOT, { recursive: true, force: true })

function scratch(files: Record<string, string>): string {
  mkdirSync(FIXTURE_ROOT, { recursive: true })
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'chain-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const FIRST = `FROM debian\nRUN true\n`
const LINK = `ARG ${PREV_ARG}\nFROM \${${PREV_ARG}}\nRUN true\n`
// The terminal stage has TWO export surfaces: `artifact`, the files the
// assembler reads, and `factory-root`, the packed root as an image. NO_OCI
// carries only the first, so the fault for a missing second surface has
// something to fire on -- a fixture that always satisfies a check is how a
// check stops being one.
const NO_OCI = `ARG ${PREV_ARG}\nFROM \${${PREV_ARG}} AS closed\nRUN true\nFROM scratch AS artifact\nCOPY --from=closed /x /\n`
const TERMINAL = `${NO_OCI}FROM scratch AS ${DEFAULT_OCI_TARGET}\nCOPY --from=closed / /\n`

function messages(stages: readonly StageFile[]): string {
  return auditChain(stages, DEFAULT_TERMINAL_TARGET, DEFAULT_OCI_TARGET)
    .map(f => f.message)
    .join('\n')
}

describe('readStageFile', () => {
  test('takes the order and the name from the file name', () => {
    const s = readStageFile('/x/10-base.Dockerfile', FIRST)
    expect(s.order).toBe(10)
    expect(s.name).toBe('10-base')
  })

  test('refuses a file whose name carries no number', () => {
    expect(() => readStageFile('/x/base.Dockerfile', FIRST)).toThrow(StageChainError)
  })

  test('collects every ARG but the chain link, in first-seen order', () => {
    const s = readStageFile(
      '/x/30-f.Dockerfile',
      `ARG ${PREV_ARG}\nFROM \${${PREV_ARG}}\nARG BOARD_RADIOS=""\nARG WITH_MICAD=1\nARG BOARD_RADIOS=""\n`,
    )
    expect(s.declaredArgs).toEqual(['BOARD_RADIOS', 'WITH_MICAD'])
    expect(s.declaresPrev).toBe(true)
    expect(s.fromsPrev).toBe(true)
  })

  // The distinction the driver's unsupplied-arg refusal is built on, and the
  // reason it is a distinction at all is measured rather than assumed: with no
  // --build-arg, buildkit leaves `ARG X` OUT of the RUN environment (set -u
  // catches it) and puts `ARG X=""` IN as an empty string (nothing catches it).
  test('separates an empty default from a real one and from none', () => {
    const s = readStageFile(
      '/x/90-p.Dockerfile',
      `FROM debian\nARG BARE\nARG EMPTY=""\nARG BLANK=\nARG SQUOTE=''\nARG REAL=sha256\nARG ZERO=0\n`,
    )
    expect(s.declaredArgs).toEqual(['BARE', 'EMPTY', 'BLANK', 'SQUOTE', 'REAL', 'ZERO'])
    expect(s.emptyDefaultArgs).toEqual(['EMPTY', 'BLANK', 'SQUOTE'])
  })

  // `ARG X` then `ARG X=""` in one file: the second declaration is the one that
  // decides what an unsupplied build reads, so the name is empty-defaulted even
  // though the first sighting was not.
  test('a name declared both bare and empty-defaulted counts as empty-defaulted', () => {
    const s = readStageFile('/x/90-p.Dockerfile', `FROM debian\nARG X\nARG X=""\n`)
    expect(s.declaredArgs).toEqual(['X'])
    expect(s.emptyDefaultArgs).toEqual(['X'])
  })

  test('ignores an ARG that is only mentioned in a comment', () => {
    const s = readStageFile('/x/10-b.Dockerfile', `# ARG NOT_REAL\nFROM debian\n`)
    expect(s.declaredArgs).toEqual([])
  })

  test('reads named targets and not unnamed ones', () => {
    const s = readStageFile('/x/90-p.Dockerfile', TERMINAL)
    expect(s.targets).toEqual(['closed', 'artifact', DEFAULT_OCI_TARGET])
  })

  test('reads a target whose FROM carries flags BEFORE the image', () => {
    // The first version of FROM_AS allowed --platform only AFTER the image, so
    // `FROM --platform=$BUILDPLATFORM ${X} AS pack` matched nothing and the
    // pack target went unseen -- which is the real spelling of both multi-FROM
    // stage files in this tree. Found by attributing the 34 scripts to their
    // stages with the same expression and getting `closed` for every pack-*.sh.
    const s = readStageFile(
      '/x/90-p.Dockerfile',
      `ARG ${PREV_ARG}\nFROM \${${PREV_ARG}} AS closed\nFROM --platform=$BUILDPLATFORM \${BOOKWORM} AS pack\nFROM scratch AS artifact\n`,
    )
    expect(s.targets).toEqual(['closed', 'pack', 'artifact'])
  })

  test('the content hash changes with the content', () => {
    const a = readStageFile('/x/10-b.Dockerfile', FIRST)
    const b = readStageFile('/x/10-b.Dockerfile', `${FIRST}RUN false\n`)
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.sha256).toHaveLength(64)
  })
})

describe('auditChain refuses, by name', () => {
  test('a directory with no stages at all', () => {
    const faults = auditChain([], DEFAULT_TERMINAL_TARGET, DEFAULT_OCI_TARGET)
    expect(faults).toHaveLength(1)
    expect(faults[0]!.message).toContain('holds no *.Dockerfile')
  })

  test('a chain of one', () => {
    const dir = scratch({ '10-base.Dockerfile': FIRST })
    expect(messages(discoverStages(dir))).toContain('is the only stage')
  })

  test('two stages sharing a number', () => {
    const dir = scratch({
      '10-base.Dockerfile': FIRST,
      '10-other.Dockerfile': LINK,
      '90-pack.Dockerfile': TERMINAL,
    })
    expect(messages(discoverStages(dir))).toContain('share the number 10')
  })

  test('a first stage that declares MICA_STAGE_PREV', () => {
    const dir = scratch({ '10-base.Dockerfile': LINK, '90-pack.Dockerfile': TERMINAL })
    expect(messages(discoverStages(dir))).toContain('is the first stage and declares')
  })

  test('a later stage that does not declare it', () => {
    const dir = scratch({
      '10-base.Dockerfile': FIRST,
      '20-install.Dockerfile': FIRST,
      '90-pack.Dockerfile': TERMINAL,
    })
    expect(messages(discoverStages(dir))).toContain(`does not declare ARG ${PREV_ARG}`)
  })

  test('a stage that declares the link and never FROMs it', () => {
    const dir = scratch({
      '10-base.Dockerfile': FIRST,
      '20-install.Dockerfile': `ARG ${PREV_ARG}\nFROM debian\nRUN true\n`,
      '90-pack.Dockerfile': TERMINAL,
    })
    expect(messages(discoverStages(dir))).toContain('no stage in it opens')
  })

  test('a last stage with no export target', () => {
    const dir = scratch({ '10-base.Dockerfile': FIRST, '90-pack.Dockerfile': LINK })
    expect(messages(discoverStages(dir))).toContain(`defines no \`AS ${DEFAULT_TERMINAL_TARGET}\``)
  })

  // The pre-M7 terminal stage, which exported the assembler's files and nothing
  // else. It is a valid chain by every other rule here, which is exactly why
  // this fault is worth having: the build succeeds, the assembler gets its
  // image, and the only thing missing is that nothing was ever executed.
  test('a last stage that exports files but no OCI image of the root', () => {
    const dir = scratch({ '10-base.Dockerfile': FIRST, '90-pack.Dockerfile': NO_OCI })
    const said = messages(discoverStages(dir))
    expect(said).toContain(`defines no \`AS ${DEFAULT_OCI_TARGET}\``)
    expect(said).not.toContain(`defines no \`AS ${DEFAULT_TERMINAL_TARGET}\``)
  })

  test('and accepts the shape the real chain has', () => {
    const dir = scratch({
      '10-base.Dockerfile': FIRST,
      '20-install.Dockerfile': LINK,
      '90-pack.Dockerfile': TERMINAL,
    })
    expect(auditChain(discoverStages(dir), DEFAULT_TERMINAL_TARGET, DEFAULT_OCI_TARGET)).toEqual([])
  })
})

describe('discoverStages', () => {
  test('orders numerically, not alphabetically', () => {
    const dir = scratch({
      '90-pack.Dockerfile': TERMINAL,
      '100-late.Dockerfile': LINK,
      '20-install.Dockerfile': LINK,
      '10-base.Dockerfile': FIRST,
    })
    // 100 after 90 is the case a string sort gets wrong, and the one a chain
    // would get wrong silently: it would build, in the wrong order.
    expect(discoverStages(dir).map(s => s.name)).toEqual([
      '10-base',
      '20-install',
      '90-pack',
      '100-late',
    ])
  })

  test('ignores files that are not Dockerfiles', () => {
    const dir = scratch({
      '10-base.Dockerfile': FIRST,
      '90-pack.Dockerfile': TERMINAL,
      'README.md': '# not a stage\n',
    })
    expect(discoverStages(dir).map(s => s.name)).toEqual(['10-base', '90-pack'])
  })

  test('refuses a directory that is not there', () => {
    expect(() => discoverStages(join(tmpdir(), 'mica-no-such-stage-dir'))).toThrow(StageChainError)
  })

  // A stage file SHARED by two directories: one definition referred to twice,
  // so that two builds cannot be reading a difference between two copies of it.
  // No entry in the repository is a symlink today -- the finalizer is a real
  // file in stages/compose -- so this fixture is the only thing that
  // exercises the resolution, and it is why the resolution is still tested.
  //
  // The path is what `docker buildx build -f` is given, and buildx does not
  // open it locally -- it transfers the dockerfile as a mini-context of its own
  // and the frontend opens it on the other side, where a relative symlink
  // pointing out of that context resolves to nothing. Measured against buildx
  // 0.32.2 on both drivers:
  //   #2 transferring dockerfile: 114B done
  //   ERROR: failed to read dockerfile: open probe.Dockerfile: no such file
  // So `path` has to be the TARGET, while the content and therefore the hash
  // were already the target's -- readFileSync follows the link. Both halves are
  // asserted, because the failure was in exactly the half that looked fine.
  test('a symlinked stage file is reported at its target path, with the target content', () => {
    const shared = scratch({ '90-pack.Dockerfile': TERMINAL })
    const dir = scratch({ '10-base.Dockerfile': FIRST })
    symlinkSync(join(shared, '90-pack.Dockerfile'), join(dir, '90-pack.Dockerfile'))

    const stages = discoverStages(dir)
    expect(stages.map(x => x.name)).toEqual(['10-base', '90-pack'])
    const pack = stages[1]!
    // The target, not the link. The link is the path that fails at buildx.
    expect(pack.path).toBe(realpathSync(join(shared, '90-pack.Dockerfile')))
    expect(pack.path).not.toBe(join(dir, '90-pack.Dockerfile'))
    expect(pack.sha256).toBe(
      new Bun.CryptoHasher('sha256').update(TERMINAL).digest('hex'),
    )
    // And what the driver would actually spawn names the target too, which is
    // the assertion the failing build would have gone red on: buildArgv puts
    // this path after `-f`, and that is the argument buildx choked on.
    const packBuild = planChain(stages, { board: 'uefi-x64', supplied: {} })[1]!
    const argv = buildArgv(packBuild, { context: '/ctx', platform: 'linux/amd64', dest: '/dest' })
    expect(argv).toContain(realpathSync(join(shared, '90-pack.Dockerfile')))
    expect(argv).not.toContain(join(dir, '90-pack.Dockerfile'))
  })

  // The other half of the same claim, and it is the half that decides whether
  // `stagePath` may be a blanket realpath. It may not: an ordinary stage file's
  // path has to be the one the caller spelled, so that every fault message
  // names the directory the reader passed in.
  //
  // The fixture is reached THROUGH A SYMLINKED PARENT, which is what makes this
  // able to fail. Written against a plain directory it discriminates nothing --
  // the realpath of a path with no link in it is that path -- and a blanket
  // realpath passed it. That is not hypothetical: this test was written that
  // way, mutated, and stayed green, which is how it got its symlink.
  test('a regular stage file keeps the path it was discovered at, under a symlinked parent', () => {
    const real = scratch({ '10-base.Dockerfile': FIRST, '90-pack.Dockerfile': TERMINAL })
    const via = join(dirname(real), `${basename(real)}-via-link`)
    symlinkSync(real, via)
    expect(discoverStages(via).map(s => s.path)).toEqual([
      join(via, '10-base.Dockerfile'),
      join(via, '90-pack.Dockerfile'),
    ])
  })
})

describe('planChain', () => {
  const dir = () =>
    scratch({
      '10-base.Dockerfile': `ARG TRIXIE\nFROM \${TRIXIE}\nARG MICA_PROFILE=dev\nRUN true\n`,
      '20-install.Dockerfile': `ARG ${PREV_ARG}\nFROM \${${PREV_ARG}}\nARG OVERLAY_DIR\nRUN true\n`,
      '90-pack.Dockerfile': `ARG ${PREV_ARG}\nARG BOOKWORM\nFROM \${${PREV_ARG}} AS closed\nRUN true\nFROM scratch AS artifact\nCOPY --from=closed /x /\nFROM scratch AS ${DEFAULT_OCI_TARGET}\nCOPY --from=closed / /\n`,
    })
  const supplied = {
    TRIXIE: 'debian@sha256:aaa',
    BOOKWORM: 'debian@sha256:bbb',
    MICA_PROFILE: 'dev',
    OVERLAY_DIR: '_out/uefi-x64/overlay',
  }

  test('tags each stage per board and links each to its predecessor', () => {
    const builds = planChain(discoverStages(dir()), { board: 'uefi-x64', supplied })
    expect(builds.map(b => b.tag)).toEqual([
      'mica-rootfs-stage:uefi-x64-10-base',
      'mica-rootfs-stage:uefi-x64-20-install',
      'mica-rootfs-stage:uefi-x64-90-pack',
    ])
    expect(builds[0]!.prevTag).toBeUndefined()
    expect(builds[1]!.prevTag).toBe('mica-rootfs-stage:uefi-x64-10-base')
    expect(builds[2]!.prevTag).toBe('mica-rootfs-stage:uefi-x64-20-install')
    expect(builds.map(b => b.terminal)).toEqual([false, false, true])
  })

  test('two boards in flight do not share a tag', () => {
    const s = discoverStages(dir())
    const a = planChain(s, { board: 'uefi-x64', supplied })
    const b = planChain(s, { board: 'cx3576', supplied })
    expect(a.map(x => x.tag)).not.toEqual(b.map(x => x.tag))
  })

  test('a stage is handed only the arguments it declares', () => {
    const builds = planChain(discoverStages(dir()), { board: 'uefi-x64', supplied })
    expect(builds[0]!.buildArgs).toEqual({ TRIXIE: 'debian@sha256:aaa', MICA_PROFILE: 'dev' })
    expect(builds[1]!.buildArgs).toEqual({ OVERLAY_DIR: '_out/uefi-x64/overlay' })
    expect(builds[2]!.buildArgs).toEqual({ BOOKWORM: 'debian@sha256:bbb' })
  })

  test('an argument no stage declares is refused, not warned about', () => {
    expect(() =>
      planChain(discoverStages(dir()), {
        board: 'uefi-x64',
        supplied: { ...supplied, VERITY_SALT: '00' },
      }),
    ).toThrow(/VERITY_SALT/)
  })

  test('unusedArgs names every stray, sorted', () => {
    const s = discoverStages(dir())
    expect(unusedArgs(s, { ...supplied, ZZZ: '1', AAA: '2' })).toEqual(['AAA', 'ZZZ'])
  })

  // The gap this closes: a supplied argument no file declares was already
  // refused (unusedArgs), and a file that READS an undeclared name already dies
  // under `set -u`. An argument declared `=""` and never supplied was the
  // remaining direction, and it is the silent one -- the build succeeds and
  // asserts less than it says it does.
  test('an empty-defaulted argument nobody supplies is refused', () => {
    const d = scratch({
      '10-base.Dockerfile': `ARG TRIXIE\nFROM \${TRIXIE}\nRUN true\n`,
      '90-pack.Dockerfile': `ARG ${PREV_ARG}\nARG BOARD_RADIOS=""\nFROM \${${PREV_ARG}} AS closed\nRUN true\nFROM scratch AS artifact\nCOPY --from=closed /x /\nFROM scratch AS ${DEFAULT_OCI_TARGET}\nCOPY --from=closed / /\n`,
    })
    const stages = discoverStages(d)
    expect(() => planChain(stages, { board: 'uefi-x64', supplied: { TRIXIE: 'debian@sha256:aaa' } }))
      .toThrow(/BOARD_RADIOS with an EMPTY default/)

    // And an EXPLICIT empty value is accepted, because that is uefi-x64 saying it
    // has no radios rather than nobody having been asked. A guard that could
    // not tell those apart would refuse every correct uefi-x64 build.
    const ok = planChain(stages, {
      board: 'uefi-x64',
      supplied: { TRIXIE: 'debian@sha256:aaa', BOARD_RADIOS: '' },
    })
    expect(ok[1]!.buildArgs).toEqual({ BOARD_RADIOS: '' })
  })

  test('unsuppliedArgs names every empty-defaulted absentee, sorted and once', () => {
    const d = scratch({
      '10-base.Dockerfile': `ARG TRIXIE\nFROM \${TRIXIE}\nARG ZZZ=""\nARG KEPT=dev\n`,
      '90-pack.Dockerfile': `ARG ${PREV_ARG}\nARG ZZZ=""\nARG AAA=""\nFROM \${${PREV_ARG}} AS closed\nRUN true\nFROM scratch AS artifact\nCOPY --from=closed /x /\nFROM scratch AS ${DEFAULT_OCI_TARGET}\nCOPY --from=closed / /\n`,
    })
    const stages = discoverStages(d)
    expect(unsuppliedArgs(stages, { TRIXIE: 'x' })).toEqual(['AAA', 'ZZZ'])
    expect(unsuppliedArgs(stages, { TRIXIE: 'x', AAA: '', ZZZ: 'wifi' })).toEqual([])
    // KEPT=dev is a default that IS the value. Demanding it would make every
    // Dockerfile constant an argument the caller has to restate.
    expect(unsuppliedArgs(stages, { TRIXIE: 'x', AAA: '', ZZZ: '' })).not.toContain('KEPT')
  })

  test('a broken chain is refused before any tag is computed', () => {
    const bad = scratch({ '10-base.Dockerfile': FIRST, '20-x.Dockerfile': FIRST })
    expect(() => planChain(discoverStages(bad), { board: 'uefi-x64', supplied: {} })).toThrow(
      StageChainError,
    )
  })
})

// THE SHIPPED PAIR, and the only check in this file whose subject is the real
// tree rather than a fixture. The refusal above proves the driver reacts; this
// proves the two files that actually ship are on the right side of it, and it
// goes red if rootfs/build.sh drops one of the `--arg` lines that keep
// them there -- which is the whole failure this guard exists for, and which no
// fixture can notice.
//
// Both sides are counted and neither may be zero: a compose directory that
// declared no empty default, or a build.sh this could read no --arg out of,
// would make the pairing pass by comparing nothing against nothing.
describe('the shipped compose directory and its supplier', () => {
  const ROOTFS_BUILD_SH = join(REPO_ROOT, 'rootfs', 'build.sh')

  /** The names build.sh hands the driver, read out of the file itself. */
  function suppliedByRootfsBuild(): string[] {
    const text = readFileSync(ROOTFS_BUILD_SH, 'utf8')
    return [...text.matchAll(/^\s*--arg\s+([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1] as string)
  }

  test('every empty-defaulted ARG in stages/compose is supplied by build.sh', () => {
    const stages = discoverStages(STAGES_DIR)
    expect(stages.length).toBeGreaterThan(0)
    const declared = [...new Set(stages.flatMap(s => s.emptyDefaultArgs))].sort()
    expect(declared.length).toBeGreaterThan(0)

    const names = suppliedByRootfsBuild()
    expect(names.length).toBeGreaterThan(0)

    const supplied = Object.fromEntries(names.map(n => [n, '']))
    expect(unsuppliedArgs(stages, supplied)).toEqual([])
    // Named, so that an ARG gaining or losing an empty default is a decision
    // somebody makes here rather than a set that silently changes size.
    expect(declared).toEqual(['MICA_RADIOS'])
  })
})

describe('buildArgv', () => {
  const dir = () =>
    scratch({
      '10-base.Dockerfile': `ARG TRIXIE\nFROM \${TRIXIE}\nRUN true\n`,
      '90-pack.Dockerfile': TERMINAL,
    })

  test('an intermediate stage loads a tag and exports nothing', () => {
    const [first] = planChain(discoverStages(dir()), {
      board: 'uefi-x64',
      supplied: { TRIXIE: 'debian@sha256:aaa' },
    })
    const argv = buildArgv(first!, {
      context: '/repo',
      platform: 'linux/amd64',
      dest: '/out',
    })
    expect(argv).toEqual([
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '-f',
      first!.path,
      '--build-arg',
      'TRIXIE=debian@sha256:aaa',
      '-t',
      'mica-rootfs-stage:uefi-x64-10-base',
      '--load',
      '/repo',
    ])
    expect(argv).not.toContain('--output')
  })

  test('the terminal stage exports and is not tagged', () => {
    const builds = planChain(discoverStages(dir()), {
      board: 'uefi-x64',
      supplied: { TRIXIE: 'debian@sha256:aaa' },
    })
    const argv = buildArgv(builds[1]!, {
      context: '/repo',
      platform: 'linux/amd64',
      dest: '/out/uefi-x64',
    })
    expect(argv).toContain('--target')
    expect(argv).toContain('artifact')
    expect(argv).toContain('type=local,dest=/out/uefi-x64')
    expect(argv).not.toContain('--load')
    expect(argv).toContain('--build-arg')
    expect(argv[argv.indexOf('--build-arg') + 1]).toBe(
      `${PREV_ARG}=mica-rootfs-stage:uefi-x64-10-base`,
    )
  })

  test('--no-cache comes first, before the builder, and is absent by default', () => {
    const [first] = planChain(discoverStages(dir()), {
      board: 'uefi-x64',
      supplied: { TRIXIE: 'x' },
    })
    const cold = buildArgv(first!, { context: '/r', platform: 'p', noCache: true })
    expect(cold.slice(0, 3)).toEqual(['buildx', 'build', '--no-cache'])
    expect(buildArgv(first!, { context: '/r', platform: 'p' })).not.toContain('--no-cache')
  })

  test('a builder name is passed through when given, and absent when not', () => {
    const [first] = planChain(discoverStages(dir()), {
      board: 'uefi-x64',
      supplied: { TRIXIE: 'x' },
    })
    const withB = buildArgv(first!, { context: '/r', platform: 'p', builder: 'mica-amd64' })
    expect(withB.slice(0, 4)).toEqual(['buildx', 'build', '--builder', 'mica-amd64'])
    expect(buildArgv(first!, { context: '/r', platform: 'p' })).not.toContain('--builder')
  })

  test('the terminal stage with no destination is refused, not silently dropped', () => {
    const builds = planChain(discoverStages(dir()), { board: 'uefi-x64', supplied: { TRIXIE: 'x' } })
    expect(() => buildArgv(builds[1]!, { context: '/r', platform: 'p' })).toThrow(
      /export somewhere|no output directory/,
    )
  })
})

// The packed root exported as an OCI image.
//
// Everything here is about the three ways the export can succeed and still be
// worthless -- the wrong stage, an unusable epoch, and a cache flag that would
// silently export a SECOND root -- because none of the three shows up as a
// failure at the time.
describe('ociExport -- the factory root as an OCI image', () => {
  const dir = () =>
    scratch({
      '10-base.Dockerfile': `ARG TRIXIE\nFROM \${TRIXIE}\nRUN true\n`,
      '90-pack.Dockerfile': TERMINAL,
    })
  const plan = () => planChain(discoverStages(dir()), { board: 'uefi-x64', supplied: { TRIXIE: 'x' } })
  const opts = {
    context: '/repo',
    platform: 'linux/amd64',
    board: 'uefi-x64',
    dest: '/out/uefi-x64',
    sourceDateEpoch: '1577836800',
  }

  test('the whole command line, and where the archive lands', () => {
    const builds = plan()
    const oci = ociExport(builds[1]!, opts)
    expect(oci.archive).toBe(`/out/uefi-x64/${OCI_ARCHIVE_NAME}`)
    expect(oci.ref).toBe('localhost/mica-factory-root:uefi-x64')
    expect(oci.argv).toEqual([
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '-f',
      builds[1]!.path,
      '--build-arg',
      `${PREV_ARG}=mica-rootfs-stage:uefi-x64-10-base`,
      '--target',
      DEFAULT_OCI_TARGET,
      '--provenance=false',
      '--sbom=false',
      '--output',
      `type=oci,dest=/out/uefi-x64/${OCI_ARCHIVE_NAME},name=localhost/mica-factory-root:uefi-x64,rewrite-timestamp=true`,
      '/repo',
    ])
  })

  // The epoch is not a flag, so nothing downstream can refuse it: buildkit
  // reads SOURCE_DATE_EPOCH from the environment and an unparseable value is
  // simply an absent one, which is the wall clock in the config and in every
  // layer entry. Measured: two cold builds one second apart differed in the
  // layer diffID and in nothing else.
  test('the epoch travels in the environment, not the argv', () => {
    const oci = ociExport(plan()[1]!, opts)
    expect(oci.env).toEqual({ SOURCE_DATE_EPOCH: '1577836800' })
    expect(oci.argv.join(' ')).not.toContain('SOURCE_DATE_EPOCH')
  })

  test('the three flags that make it reproduce are all present', () => {
    // Each was measured to be load-bearing on this host, and each is invisible
    // in the output when it is missing -- an archive with a wall-clock layer
    // and one without look identical to `docker load`.
    const line = ociExport(plan()[1]!, opts).argv.join(' ')
    expect(line).toContain('rewrite-timestamp=true')
    expect(line).toContain('--provenance=false')
    expect(line).toContain('--sbom=false')
  })

  test('an epoch that is not a count of seconds is refused, including the touch(1) spelling', () => {
    // `@1577836800` is how boards/<board>/board.env writes the same instant
    // for touch. Passed through unstripped it would reach buildkit as garbage
    // and be ignored, so it is refused here where there is still someone to
    // tell.
    for (const bad of ['@1577836800', '', 'now', '2020-01-01', '15778 36800']) {
      expect(() => ociExport(plan()[1]!, { ...opts, sourceDateEpoch: bad })).toThrow(
        /not a count of seconds/,
      )
    }
    expect(() => ociExport(plan()[1]!, opts)).not.toThrow()
  })

  test('a stage that is not the terminal one is refused', () => {
    // An OCI image of 10-base would be a root with no podman, no mica-deploy and no
    // micad in it -- and every smoke check for a binary that is not there has to
    // be written to notice that, or it passes.
    expect(() => ociExport(plan()[0]!, opts)).toThrow(/not the terminal stage/)
  })

  test('--no-cache never reaches it, whatever the chain was built with', () => {
    // The chain uses --no-cache for the determinism gate. This invocation must
    // read the cache that run just filled: cold, it would rebuild all nine
    // stages and export a root that is NOT the one the assembler was handed.
    expect(ociExport(plan()[1]!, opts).argv).not.toContain('--no-cache')
  })

  test('the builder is passed through when there is one, and absent when there is not', () => {
    expect(ociExport(plan()[1]!, { ...opts, builder: 'mica-amd64' }).argv.slice(0, 4)).toEqual([
      'buildx',
      'build',
      '--builder',
      'mica-amd64',
    ])
    expect(ociExport(plan()[1]!, opts).argv).not.toContain('--builder')
  })

  test('the reference is board-scoped, so two boards cannot overwrite each other', () => {
    expect(factoryRootRef('uefi-x64')).not.toBe(factoryRootRef('cx3576'))
    expect(ociExport(plan()[1]!, { ...opts, board: 'cx3576' }).ref).toBe(
      'localhost/mica-factory-root:cx3576',
    )
  })

  test('a custom --oci-target reaches --target and nothing else', () => {
    const argv = ociExport(plan()[1]!, { ...opts, ociTarget: 'somewhere-else' }).argv
    expect(argv[argv.indexOf('--target') + 1]).toBe('somewhere-else')
  })
})

describe('ociRecord', () => {
  const fields = {
    board: 'uefi-x64',
    ref: 'localhost/mica-factory-root:uefi-x64',
    platform: 'linux/amd64',
    target: DEFAULT_OCI_TARGET,
    archive: '/out/uefi-x64/factory-root.oci',
    bytes: 123456789,
    sha256: 'a'.repeat(64),
    sourceDateEpoch: '1577836800',
  }

  test('records what was exported, as tab-separated fields a reader can grep', () => {
    const text = ociRecord(fields)
    const kv = new Map(
      text
        .split('\n')
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.split('\t') as [string, string]),
    )
    expect(kv.get('ref')).toBe('localhost/mica-factory-root:uefi-x64')
    expect(kv.get('platform')).toBe('linux/amd64')
    expect(kv.get('sha256')).toBe('a'.repeat(64))
    expect(kv.get('bytes')).toBe('123456789')
    expect(kv.get('source-date-epoch')).toBe('1577836800')
    // The basename, not the path the exporting host happened to use: the
    // record travels with the archive it names.
    expect(kv.get('archive')).toBe('factory-root.oci')
  })

  test('says in the file that the hash is not a baseline', () => {
    // rootfs/README.md's reasoning, carried to where someone would actually
    // meet the number. A cold rootfs build does not reproduce itself, so a
    // reader who takes this hash as an expectation has a check that fails on
    // every honest rebuild -- and would then be deleted rather than understood.
    expect(ociRecord(fields)).toContain('NOT a baseline')
  })
})

describe('selectStages -- stage selection, in place of WITH_* build args', () => {
  // The four-feature shape the shipped chain has, in miniature. Every case
  // below is driven from this one directory so that "it dropped the right file"
  // and "it left the rest alone" are the same assertion.
  const dir = () =>
    scratch({
      '10-base.Dockerfile': FIRST,
      '30-feature-radios.Dockerfile': LINK,
      '31-feature-containers.Dockerfile': LINK,
      '33-feature-micad.Dockerfile': LINK,
      '40-board.Dockerfile': LINK,
      '90-pack.Dockerfile': TERMINAL,
    })

  test('featureOf names the feature, and only for a feature stage', () => {
    const stages = discoverStages(dir())
    expect(stages.map(s => featureOf(s))).toEqual([
      undefined,
      'radios',
      'containers',
      'micad',
      undefined,
      undefined,
    ])
  })

  test('drops exactly the named feature and keeps the chain in order', () => {
    const stages = discoverStages(dir())
    expect(selectStages(stages, ['containers']).map(s => s.name)).toEqual([
      '10-base',
      '30-feature-radios',
      '33-feature-micad',
      '40-board',
      '90-pack',
    ])
  })

  test('drops several at once, and the result is still a chain auditChain accepts', () => {
    const stages = discoverStages(dir())
    const kept = selectStages(stages, ['containers', 'micad', 'radios'])
    expect(kept.map(s => s.name)).toEqual(['10-base', '40-board', '90-pack'])
    expect(auditChain(kept, DEFAULT_TERMINAL_TARGET, DEFAULT_OCI_TARGET)).toEqual([])
  })

  test('the empty selection is the whole chain, and is the same array content', () => {
    const stages = discoverStages(dir())
    expect(selectStages(stages, []).map(s => s.name)).toEqual(stages.map(s => s.name))
  })

  // THE CONTROL FOR EVERY CASE ABOVE. Without it, a selectStages that dropped
  // nothing at all would satisfy the "still a chain" tests and the plan would
  // quietly build the FULL image for every --without anyone typed.
  test('a feature that was NOT named is still built', () => {
    const stages = discoverStages(dir())
    const kept = selectStages(stages, ['containers'])
    expect(kept.map(s => s.name)).toContain('30-feature-radios')
    expect(kept.map(s => s.name)).toContain('33-feature-micad')
  })

  // Distinct numbers, so the duplicate-NUMBER fault cannot see it, and the
  // consequence is worse: the switch half-fires and still exits 0.
  test('auditChain refuses two stages naming the same feature', () => {
    const stages = discoverStages(
      scratch({
        '10-base.Dockerfile': FIRST,
        '31-feature-containers.Dockerfile': LINK,
        '32-feature-containers.Dockerfile': LINK,
        '90-pack.Dockerfile': TERMINAL,
      }),
    )
    expect(messages(stages)).toMatch(
      /both name the feature 'containers'.*would drop one of them, leave the other in the image/s,
    )
    // The control: two DIFFERENT features at different numbers is fine.
    const ok = discoverStages(
      scratch({
        '10-base.Dockerfile': FIRST,
        '31-feature-containers.Dockerfile': LINK,
        '32-feature-micad.Dockerfile': LINK,
        '90-pack.Dockerfile': TERMINAL,
      }),
    )
    expect(auditChain(ok, DEFAULT_TERMINAL_TARGET, DEFAULT_OCI_TARGET)).toEqual([])
  })

  test('refuses a feature name nothing matches, and lists the ones that exist', () => {
    const stages = discoverStages(dir())
    // The typo case. Silently building the full image is the failure this
    // refusal exists for: `--without contaners` would otherwise exit 0 with an
    // engine in the image and a caller who believes there is none.
    expect(() => selectStages(stages, ['contaners'])).toThrow(
      /no stage here is named <number>-feature-contaners/,
    )
    expect(() => selectStages(stages, ['contaners'])).toThrow(
      /The features are: containers, micad, radios/,
    )
  })

  test('refuses to decline a stage that is not a feature, by its file name', () => {
    const stages = discoverStages(dir())
    expect(() => selectStages(stages, ['board'])).toThrow(
      /'board', which is 40-board\.Dockerfile -- not a feature stage/,
    )
    expect(() => selectStages(stages, ['10-base'])).toThrow(/not a feature stage/)
    expect(() => selectStages(stages, ['90-pack'])).toThrow(/not a feature stage/)
  })

  test('reports every bad name in one refusal, not just the first', () => {
    const stages = discoverStages(dir())
    try {
      selectStages(stages, ['contaners', 'board'])
      throw new Error('selectStages accepted two bad names')
    }
    catch (e) {
      expect(e).toBeInstanceOf(StageChainError)
      expect((e as StageChainError).faults).toHaveLength(2)
    }
  })

  // The consequence a caller actually feels: the arguments the dropped stage
  // declared become arguments no stage declares, and planChain refuses them.
  // That is not a nuisance -- it is what stops a build from passing PODMAN_DIR
  // into a chain with no container stage and believing it took effect.
  test('an argument only the dropped stage declared is then refused by planChain', () => {
    const stages = discoverStages(
      scratch({
        '10-base.Dockerfile': FIRST,
        '31-feature-containers.Dockerfile': `ARG ${PREV_ARG}\nFROM \${${PREV_ARG}}\nARG PODMAN_DIR\n`,
        '90-pack.Dockerfile': TERMINAL,
      }),
    )
    expect(unusedArgs(stages, { PODMAN_DIR: 'x' })).toEqual([])
    const kept = selectStages(stages, ['containers'])
    expect(unusedArgs(kept, { PODMAN_DIR: 'x' })).toEqual(['PODMAN_DIR'])
    expect(() => planChain(kept, { board: 'uefi-x64', supplied: { PODMAN_DIR: 'x' } })).toThrow(
      /PODMAN_DIR, which no stage declares/,
    )
  })
})

describe('stageManifest', () => {
  test('records every stage, in order, with its content hash', () => {
    const stages = discoverStages(
      scratch({ '10-base.Dockerfile': `ARG T\nFROM \${T}\n`, '90-pack.Dockerfile': TERMINAL }),
    )
    const builds = planChain(stages, { board: 'uefi-x64', supplied: { T: 'x' } })
    const text = stageManifest(builds, stages)
    const rows = text.trimEnd().split('\n').filter(l => !l.startsWith('#'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe(`10-base\t${stages[0]!.sha256}\tmica-rootfs-stage:uefi-x64-10-base`)
    expect(rows[1]).toBe(`90-pack\t${stages[1]!.sha256}\t(exported)`)
  })

  // A build that declined a feature and a build that had none to decline must
  // not produce the same record. The image cannot tell them apart afterwards --
  // that is the whole reason the manifest exists -- so the line is written in
  // both cases and says which one it is.
  test('names the declined features, and says so explicitly when there are none', () => {
    const stages = discoverStages(
      scratch({ '10-base.Dockerfile': `ARG T\nFROM \${T}\n`, '90-pack.Dockerfile': TERMINAL }),
    )
    const builds = planChain(stages, { board: 'uefi-x64', supplied: { T: 'x' } })
    expect(stageManifest(builds, stages)).toContain('# declined: (none')
    expect(stageManifest(builds, stages, ['containers', 'micad'])).toContain(
      '# declined: containers micad',
    )
    // Sorted, so two builds that declined the same set produce the same file
    // whatever order the flags were typed in.
    expect(stageManifest(builds, stages, ['micad', 'containers'])).toContain(
      '# declined: containers micad',
    )
  })
})

describe('the driver refuses a builder that cannot chain', () => {
  test('parseDriver reads the field docker prints', () => {
    expect(
      parseDriver('Name:   default\nDriver: docker\nLast Activity: 2026-08-25\n'),
    ).toBe('docker')
    expect(parseDriver('Name:  mica-amd64\nDriver: docker-container\n')).toBe('docker-container')
  })

  test('parseDriver returns undefined rather than guessing', () => {
    expect(parseDriver('')).toBeUndefined()
    expect(parseDriver('ERROR: no builder\n')).toBeUndefined()
  })

  test('the docker CLI is this package\'s, not a bare name', () => {
    // Measured: on the pinned-bun route the host client is bind-mounted at its
    // own path and named in MICA_BUILD_DOCKER, and a bare `docker` there asks a
    // different question -- is /usr/bin on this image's PATH. src/toolbox.ts
    // reads the same variable for the same reason.
    const before = process.env.MICA_BUILD_DOCKER
    try {
      delete process.env.MICA_BUILD_DOCKER
      expect(dockerBin()).toBe('docker')
      process.env.MICA_BUILD_DOCKER = '/usr/bin/docker'
      expect(dockerBin()).toBe('/usr/bin/docker')
    }
    finally {
      if (before === undefined) delete process.env.MICA_BUILD_DOCKER
      else process.env.MICA_BUILD_DOCKER = before
    }
  })

  test('the docker driver chains by tag; a driver with its own store chains by layout', () => {
    // Measured on 2026-08-25: a docker-container builder handed a tag that IS
    // in the local image store answered "pull access denied, repository does
    // not exist" -- about Docker Hub, for an image that is right there. And on
    // 2026-08-30: the same builder, handed the previous stage as an OCI layout
    // build context, chained two arm64 stages on a host with no binfmt.
    expect(chainMode('docker')).toBe('tags')
    expect(chainMode('docker-container')).toBe('layouts')
    expect(chainMode('remote')).toBe('layouts')
    expect(chainMode(undefined)).toBeUndefined()
  })
})

describe('parseArgs', () => {
  test('the minimum a real build passes', () => {
    const o = parseArgs([
      '--board',
      'uefi-x64',
      '--dest',
      '/out/uefi-x64',
      '--platform',
      'linux/amd64',
      '--source-date-epoch',
      '1577836800',
      '--arg',
      'MICA_ARCH=amd64',
      '--arg',
      'BOARD_RADIOS=',
    ])
    expect(o.board).toBe('uefi-x64')
    expect(o.dest).toBe('/out/uefi-x64')
    expect(o.sourceDateEpoch).toBe('1577836800')
    expect(o.ociTarget).toBe(DEFAULT_OCI_TARGET)
    expect(o.args).toEqual({ MICA_ARCH: 'amd64', BOARD_RADIOS: '' })
  })

  test('a real build with no --source-date-epoch is refused; a plan without one is not', () => {
    // Not defaulted to `now`, and not defaulted to the mtime of anything.
    // buildkit takes this from the ENVIRONMENT, so an absent value produces an
    // archive rather than an error -- one whose config and whose every layer
    // entry carry the wall clock, and which therefore agrees with no other
    // build of the same tree. The failure that would be seen first is a
    // determinism gate with nothing to compare, days later.
    expect(() => parseArgs(['--board', 'uefi-x64', '--dest', '/out/uefi-x64'])).toThrow(
      /--source-date-epoch is required/,
    )
    expect(parseArgs(['--board', 'uefi-x64', '--plan']).sourceDateEpoch).toBeUndefined()
  })

  test('--oci-target overrides the target, and refuses to swallow the next flag', () => {
    expect(
      parseArgs(['--board', 'uefi-x64', '--plan', '--oci-target', 'other']).ociTarget,
    ).toBe('other')
    expect(() => parseArgs(['--board', 'uefi-x64', '--oci-target', '--plan'])).toThrow(
      /--oci-target needs a value/,
    )
    expect(() => parseArgs(['--board', 'uefi-x64', '--source-date-epoch', '--plan'])).toThrow(
      /--source-date-epoch needs a value/,
    )
  })

  test('an empty --arg value is a value, not a missing one', () => {
    // BOARD_RADIOS= is how uefi-x64 says it declares no radio. Treating it as
    // absent would make the stage that reads it fail under `set -u` on a board
    // whose answer is "none", which is a statement rather than an omission.
    expect(parseArgs(['--board', 'uefi-x64', '--plan', '--arg', 'BOARD_RADIOS=']).args).toEqual({
      BOARD_RADIOS: '',
    })
  })

  test('--board with no value is refused rather than eating the next flag', () => {
    expect(() => parseArgs(['--board', '--plan'])).toThrow(/needs a value/)
  })

  test('--arg without an = is refused', () => {
    expect(() => parseArgs(['--board', 'uefi-x64', '--plan', '--arg', 'NOEQUALS'])).toThrow(
      /is not KEY=VALUE/,
    )
  })

  test('no --board at all is refused', () => {
    expect(() => parseArgs(['--plan'])).toThrow(/--board is required/)
  })

  test('a real build with no --dest is refused; a plan without one is not', () => {
    // --dest first: a caller who named neither should be told about the one
    // that decides whether anything is written at all.
    expect(() => parseArgs(['--board', 'uefi-x64'])).toThrow(/--dest is required/)
    expect(parseArgs(['--board', 'uefi-x64', '--plan']).planOnly).toBe(true)
  })

  test('--no-cache is off unless asked for', () => {
    expect(parseArgs(['--board', 'uefi-x64', '--plan']).noCache).toBe(false)
    expect(parseArgs(['--board', 'uefi-x64', '--plan', '--no-cache']).noCache).toBe(true)
  })

  test('an unknown option is refused', () => {
    expect(() => parseArgs(['--board', 'uefi-x64', '--plan', '--nope'])).toThrow(/unknown option/)
  })

  test('--without collects feature names, and is repeatable', () => {
    expect(parseArgs(['--board', 'uefi-x64', '--plan']).without).toEqual([])
    expect(
      parseArgs(['--board', 'uefi-x64', '--plan', '--without', 'containers', '--without', 'micad'])
        .without,
    ).toEqual(['containers', 'micad'])
  })

  test('--without refuses to swallow the next flag as its value', () => {
    // `--without --plan` taking '--plan' as a feature name would decline
    // nothing (no stage is called that) and then not plan either.
    expect(() => parseArgs(['--board', 'uefi-x64', '--without', '--plan'])).toThrow(
      /--without needs a value/,
    )
  })
})

describe('the assembly this tree actually ships', () => {
  const stages = discoverStages()

  test('is a sequence auditChain accepts', () => {
    expect(auditChain(stages, DEFAULT_TERMINAL_TARGET, DEFAULT_OCI_TARGET)).toEqual([])
  })

  // The whole shape, asserted as one list rather than as two endpoint checks.
  // The chain that used to be here had nine files and the interesting claim was
  // where it started and stopped; the composition has two, and the interesting
  // claim is that it is still exactly two -- a third file appearing in
  // stages/compose is a stage boundary somebody reintroduced, which is the
  // thing PLAN-036 section 4 removed.
  test('is exactly 10-compose then 90-pack', () => {
    expect(stages.map(s => s.name)).toEqual(['10-compose', '90-pack'])
  })

  test('90-pack captures installation inputs before selecting, validating and exporting', () => {
    const pack = stages.find(s => s.name === '90-pack')!
    expect(pack.targets).toEqual([
      'bun-source',
      'pack-tools',
      'inventoried',
      'captured',
      'closed',
      'pack',
      DEFAULT_OCI_TARGET,
      'factory-checked',
      DEFAULT_TERMINAL_TARGET,
    ])
  })

  const packBody = readFileSync(stages.find(s => s.name === '90-pack')!.path, 'utf8')

  // Bound each assertion to its target. A correct COPY in a later stage or a
  // comment must not hide an export of the disposable installation tree.
  function targetInstructions(body: string, target: string): string[] {
    const lines = body
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n')
      .replace(/\\\n/g, ' ')
      .split('\n')
      .map(line => line.trim().replace(/\s+/g, ' '))
      .filter(Boolean)
    const start = lines.findIndex(line => line.startsWith('FROM ') && line.endsWith(` AS ${target}`))
    if (start < 0) return []
    const next = lines.findIndex((line, i) => i > start && line.startsWith('FROM '))
    return lines.slice(start, next < 0 ? undefined : next)
  }

  const factoryCopy = 'COPY --from=pack /runtime/ /'
  const factoryVerify = 'bun /mica-runtime/select.ts verify --root /factory-check --report /out/rootfs-report.runtime.json'

  function expectSelectedExports(body: string): void {
    expect(targetInstructions(body, DEFAULT_OCI_TARGET)).toEqual([
      `FROM scratch AS ${DEFAULT_OCI_TARGET}`,
      factoryCopy,
    ])
    expect(targetInstructions(body, 'factory-checked')).toEqual([
      'FROM pack AS factory-checked',
      'RUN --network=none '
      + '--mount=type=bind,from=factory-root,source=/,target=/factory-check '
      + '--mount=type=bind,source=src/rootfs/runtime,target=/mica-runtime '
      + factoryVerify,
    ])
    expect(targetInstructions(body, DEFAULT_TERMINAL_TARGET)).toEqual([
      `FROM scratch AS ${DEFAULT_TERMINAL_TARGET}`,
      'COPY --from=factory-checked /out/pkg-logs/ /pkg-logs/',
      'COPY --from=factory-checked /out/rootfs-verity.img /',
      'COPY --from=factory-checked /out/rootfs-verity.env /',
      'COPY --from=factory-checked /out/rootfs-report.txt /',
      'COPY --from=factory-checked /out/rootfs-report.runtime.json /',
      'COPY --from=factory-checked /out/rootfs-report.runtime.json.drops.tsv /',
      'COPY --from=factory-checked /out/build-inputs/ /build-inputs/',
      'COPY --from=factory-checked /out/boot/ /boot/',
      'COPY --from=factory-checked /out/debug/ /debug/',
    ])
  }

  test('factory-root exports only the selected packed tree and artifacts require its verification', () => {
    expectSelectedExports(packBody)
  })

  test.each([
    ['the transformed installation root', factoryCopy, 'COPY --from=pack /rootfs/ /'],
    ['the closed root', factoryCopy, 'COPY --from=closed / /'],
    ['the installed root', factoryCopy, 'COPY --from=inventoried / /'],
    ['an inherited pack root', 'FROM scratch AS factory-root', 'FROM pack AS factory-root'],
    ['an extra installation overlay', factoryCopy, `${factoryCopy}\nCOPY --from=closed /etc/ /etc/`],
    ['a commented correct COPY', factoryCopy, `# ${factoryCopy}\nCOPY --from=closed / /`],
    ['a correct COPY in the next stage', factoryCopy, `FROM scratch AS unused\n${factoryCopy}`],
    ['validation of a disposable root', 'FROM pack AS factory-checked', 'FROM closed AS factory-checked'],
    ['validation of the source instead of its transfer', 'from=factory-root,source=/', 'from=pack,source=/runtime'],
    ['a missing verifier', factoryVerify, 'true'],
    ['an ignored verification failure', factoryVerify, `${factoryVerify} || true`],
    ['an unrelated selection report', factoryVerify, factoryVerify.replace('rootfs-report.runtime.json', 'other.json')],
    ['an unchecked artifact', 'COPY --from=factory-checked /out/rootfs-verity.img /', 'COPY --from=pack /out/rootfs-verity.img /'],
  ])('the export contract rejects %s', (_name, from, to) => {
    const changed = packBody.replace(from!, to!)
    expect(changed).not.toBe(packBody)
    expect(() => expectSelectedExports(changed)).toThrow()
  })

  // The finalizer is a REAL FILE beside 10-compose, not a symlink out of the
  // directory. It was a symlink to rootfs/stages/90-pack.Dockerfile while
  // the chain existed, so that both paths ran one finalizer; the chain is gone
  // and the file moved here with its content unchanged. A symlink reappearing
  // would mean the definition had been split again.
  test('the finalizer is a regular file in the directory that builds it', () => {
    const dir = STAGES_DIR
    const entry = join(dir, '90-pack.Dockerfile')
    expect(lstatSync(entry).isSymbolicLink()).toBe(false)
    expect(stages.find(s => s.name === '90-pack')!.path).toBe(entry)
  })

  test('later files are linked and external tool images are declared explicitly', () => {
    stages.forEach((s, i) => {
      expect(s.declaresPrev).toBe(i > 0)
    })
    const withBase = stages.filter(s =>
      s.declaredArgs.some(a => a.startsWith('MICA_IMAGE_')),
    )
    // The Base root is the composition's base; bookworm supplies packing tools.
    expect(withBase.map(s => s.name)).toEqual(['10-compose', '90-pack'])
  })

  test('no file declares WITH_CONTAINERS or WITH_MICAD any more', () => {
    // The WITH_* build args were replaced by the RESOLUTION: a declined feature
    // is a package the manifest does not name. One that reappeared here would
    // be a second switch beside it, and the two could disagree.
    const stray = stages.flatMap(s =>
      s.declaredArgs.filter(a => a.startsWith('WITH_')).map(a => `${s.name}:${a}`),
    )
    expect(stray).toEqual([])
  })

  // Neither file is parameterised by the board; the board is a PACKAGE.
  //
  // The board names come from the directory, boards/, for the same reason
  // the file list is the directory: a board added to the tree but not to a list
  // here would be a board this check cannot see, and it would pass for that
  // reason alone.
  //
  // COMMENTS ARE EXCLUDED ON PURPOSE. Prose that names a board is how the
  // reasoning stays legible. What must not name one is an INSTRUCTION, because
  // that is where a board name decides what the image carries.
  const boardNames = readdirSync(BOARDS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)

  // `COPY boards/cx3576/bsp/rootfs/firmware/...` must be seen; `# ... on cx3576 ...`
  // must not. Docker line continuations mean an instruction can span lines, so
  // this keeps every non-comment line rather than trying to reassemble them.
  const instructionLines = (text: string): string[] =>
    text.split('\n').filter(l => !l.trimStart().startsWith('#') && l.trim().length > 0)

  const namesABoard = (text: string): string[] =>
    instructionLines(text).flatMap(l =>
      boardNames.filter(b => l.includes(b)).map(b => `${b}: ${l.trim()}`),
    )

  test('no INSTRUCTION names a board', () => {
    expect(boardNames.length).toBeGreaterThanOrEqual(2)
    const offences = stages.flatMap(s =>
      namesABoard(readFileSync(s.path, 'utf8')).map(o => `${basename(s.path)} -- ${o}`),
    )
    expect(offences).toEqual([])
  })

  test('...and the check can see one, so the green above is not vacuous', () => {
    // Driven from the failing side with the exact instruction M5d removed. A
    // check whose subject never occurs passes on an empty tree, which is the
    // shape of green this campaign keeps finding.
    const before = [
      '# COPY boards/cx3576/bsp/rootfs/firmware/fmacfw_8800d80_u02.bin /tmp/fw/',
      'COPY boards/cx3576/hwinit/ /tmp/hwinit/',
    ].join('\n')
    expect(namesABoard(before)).toEqual(['cx3576: COPY boards/cx3576/hwinit/ /tmp/hwinit/'])
  })

  // What 10-compose is handed, and it is deliberately little: the resolution
  // arrives as ONE file that resolve.sh wrote, so the Dockerfile makes no
  // package selection of its own. A COMPOSE_DIR that stopped being declared
  // would mean the selection had moved back into the Dockerfile.
  test('10-compose takes the resolved set and the pool arch as arguments', () => {
    const compose = stages.find(s => s.name === '10-compose')!
    for (const a of ['COMPOSE_DIR', 'MICA_ARCH', 'MICA_BOARD', 'SOURCE_DATE_EPOCH'])
      expect(compose.declaredArgs).toContain(a)
  })
})

describe('layout mode -- sequencing on a builder that cannot read the image store', () => {
  const dir = () =>
    scratch({
      '10-base.Dockerfile': `ARG TRIXIE\nFROM \${TRIXIE}\nRUN true\n`,
      '20-install.Dockerfile': LINK,
      '90-pack.Dockerfile': TERMINAL,
    })
  const opts = { context: '/repo', platform: 'linux/arm64', dest: '/out/cx3576', layoutDir: '/out/cx3576/stages' }
  const plan = () => planChain(discoverStages(dir()), { board: 'cx3576', supplied: { TRIXIE: 'debian@sha256:aaa' } })

  test('an intermediate stage exports an OCI layout named for its tag, and loads nothing', () => {
    const argv = buildArgv(plan()[0]!, opts)
    expect(argv[argv.indexOf('--output') + 1]).toBe(
      'type=oci,dest=/out/cx3576/stages/mica-rootfs-stage-cx3576-10-base,tar=false,name=mica-rootfs-stage:cx3576-10-base',
    )
    expect(argv).not.toContain('--load')
    expect(argv).not.toContain('-t')
    expect(argv).not.toContain('--build-context')
  })

  test('a later stage takes its predecessor as an oci-layout build context, under the tag FROM names', () => {
    const argv = buildArgv(plan()[1]!, opts)
    expect(argv).toContain('--build-arg')
    expect(argv[argv.indexOf('--build-arg') + 1]).toBe(`${PREV_ARG}=mica-rootfs-stage:cx3576-10-base`)
    expect(argv[argv.indexOf('--build-context') + 1]).toBe(
      'mica-rootfs-stage:cx3576-10-base=oci-layout:///out/cx3576/stages/mica-rootfs-stage-cx3576-10-base',
    )
    expect(argv[argv.indexOf('--output') + 1]).toBe(
      'type=oci,dest=/out/cx3576/stages/mica-rootfs-stage-cx3576-20-install,tar=false,name=mica-rootfs-stage:cx3576-20-install',
    )
  })

  test('the terminal stage still exports files, from the layout of its predecessor', () => {
    const argv = buildArgv(plan()[2]!, opts)
    expect(argv[argv.indexOf('--build-context') + 1]).toBe(
      'mica-rootfs-stage:cx3576-20-install=oci-layout:///out/cx3576/stages/mica-rootfs-stage-cx3576-20-install',
    )
    expect(argv).toContain('type=local,dest=/out/cx3576')
    expect(argv.filter(a => a.startsWith('type=oci'))).toEqual([])
  })

  test('the factory-root export takes the same build context', () => {
    const oci = ociExport(plan()[2]!, { ...opts, board: 'cx3576', sourceDateEpoch: '1700000000' })
    expect(oci.argv[oci.argv.indexOf('--build-context') + 1]).toBe(
      'mica-rootfs-stage:cx3576-20-install=oci-layout:///out/cx3576/stages/mica-rootfs-stage-cx3576-20-install',
    )
    expect(oci.argv.join(' ')).toContain('type=oci,dest=/out/cx3576/factory-root.oci,name=')
  })

  test('tag mode is what it was when no layout directory is given', () => {
    const argv = buildArgv(plan()[1]!, { context: '/repo', platform: 'linux/arm64', dest: '/out/cx3576' })
    expect(argv).not.toContain('--build-context')
    expect(argv.slice(-4)).toEqual(['-t', 'mica-rootfs-stage:cx3576-20-install', '--load', '/repo'])
  })
})
