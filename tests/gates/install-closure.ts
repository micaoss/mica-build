// The INSTALL-time gates, over the imported pools.
//
//   bun tests/gates/install-closure.ts        (make os-install-closure-gate; docker, both pools from make os-pool)
//
//   reads   _out/debs/<arch>/{pool/*.deb,Packages}  and src/rootfs/resolve.ts (the package set per board)
//   builds  roots from the Base root of the pinned mica-system-base release, per architecture, and asserts what only
//           an INSTALLED root can answer
//
// Everything an archive cannot answer lives here -- whether dpkg can configure the set on the Base root at all,
// whether a wants-symlink points at a unit some package actually ships, whether an ELF finds its libraries, whether
// the accounts the units name exist, and what the imported binaries report when they are asked.
//
// WHAT IS CHECKED
//
//   1  THE SET ON THE BASE ROOT, PER ARCHITECTURE. The package set comes from the resolver, for the board that
//      declares this pool's MICA_ARCH -- not from a list here, which would be a second manifest set agreeing with the
//      first until either is edited. It is installed with one offline dpkg transaction, as
//      stages/compose/compose-install.sh installs it, with the upstream rows of locks/mica-system-base.lock the set
//      needs. Then, inside that root: `dpkg --audit` clean; every payload path present; every wants-symlink resolving
//      to a unit file that is also payload; every `User=`/`Group=` a shipped unit names resolving in the root's passwd
//      and group databases; `ldd` over every dynamically linked ELF in the payload with no unresolved soname; and each
//      imported component asked for its version.
//   2  THE SAME MANIFEST WITH `mqtt` DECLINED, in a separate root, with the same ELF closure checks: the MQTT payload
//      absent, the package delta and ELF count reported. Other components must declare their own dependencies without
//      relying on an optional feature to bring them in.
//   3  BOTH ARCHITECTURES. A foreign architecture runs under the emulated buildkit executor; a component may be
//      excused only under emulation, only against a signature this file declares for it by name, and only when the
//      observed status AND stderr match that signature (the `executor-limited` verdict of verify's smoke runner).
//   4  THE RADIO PACKAGES, SEPARATELY. mica-wifi, mica-wifi-ap and mica-bluetooth each go into their OWN Base root,
//      because the claim under test is that they are independent: each configures alone, their non-directory payloads
//      are disjoint, no root holds another radio package, and `rfkill` is declared and installed in all three.
//
// THE HOST JUDGES, THE CONTAINER MEASURES. The in-root scripts are tests/suites/install-closure/guest/; every stage
// writes a report and is not allowed to fail its build, since a stage that died would take its report with it. Each
// report ends in a terminator line this requires, so one that stops mid-sentence is a failure rather than a short pass.
// The port of tests/gates/install-closure-gate.sh (deleted 2026-09-25), whose in-root heredocs are the guest files.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { buildArgs } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'
import { plainValue, product } from '../../src/product/product.ts'
import { resolve } from '../../src/rootfs/resolve.ts'
import { dockerBin } from '../../src/shared/docker.ts'
import { ARTIFACTS } from '../../src/verify/smoke-register.ts'

const REPO_ROOT = resolvePath(import.meta.dir, '../..')
const DIST = join(REPO_ROOT, '_out/debs')
const PODMAN_LOCK = join(DIST, 'mica-podman/upstream.lock')
const GUEST = join(REPO_ROOT, 'tests/suites/install-closure/guest')
const WORK = join(REPO_ROOT, 'tmp/install-closure-gate')
// The two pools, written here rather than discovered under _out/debs: a discovered list turns a pool that was never
// fetched into a gate that checks one architecture and reports green.
const ARCHES = ['amd64', 'arm64']
const REPORTS: [string, string][] = [
  ['full.txt', '-- end full --'], ['declined.txt', '-- end declined --'], ['radio-mica-wifi.txt', '-- end radio mica-wifi --'],
  ['radio-mica-wifi-ap.txt', '-- end radio mica-wifi-ap --'], ['radio-mica-bluetooth.txt', '-- end radio mica-bluetooth --'],
]
const RADIOS = ['mica-wifi', 'mica-wifi-ap', 'mica-bluetooth']

class GateError extends Error {}
const refuse = (message: string): never => { throw new GateError(`error: ${message}`) }
const docker = dockerBin()
const quiet = { stdout: 'pipe', stderr: 'pipe' } as const
const cli = (args: string[], stdout: 'pipe' | 'inherit' = 'inherit') => {
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'src/cli.ts'), ...args], { cwd: REPO_ROOT, stdout, stderr: 'inherit' })
  if (r.exitCode !== 0) refuse(`src/cli.ts ${args.join(' ')} failed (see above)`)
  return stdout === 'pipe' ? r.stdout!.toString() : ''
}

// --- the pins. What each self-built binary must report, read from the file that owns the number and from nowhere
// else: the smoke register's own pin for the binary at that path (src/verify/smoke-register.ts, which knows that
// micad and mica-apid compile the whole package version in and the others report its upstream part). A version
// written down twice is a version that stops matching the binary the first time one copy moves.
function pinnedVersion(pkg: string, path: string): string {
  const artifact = ARTIFACTS.find(a => a.package === pkg && a.path === path)
  if (artifact === undefined) refuse(`src/verify/smoke-register.ts registers no artifact of ${pkg} at ${path}, so there is no version for it to report`)
  return artifact!.pin().expected
}
// A leading `v` immediately followed by a digit is what a git TAG carries and a --version output does not; the rule,
// and why it is applied on the PIN side once rather than per binary, are src/verify/smoke-pins.ts's.
function pin(key: string): string {
  const v = readFileSync(PODMAN_LOCK, 'utf8').split('\n').map(l => l.split('\t')).find(f => f[0] === 'git' && f[1] === key)?.[3] ?? ''
  if (v === '') refuse(`${PODMAN_LOCK} declares no non-empty ${key}. That value is what the binary is required to report; an empty expectation is not a weaker check but a different one, matched by nothing and failing for a reason nobody can act on`)
  return /^v[0-9]/.test(v) ? v.slice(1) : v
}

/** name, path, expected, pin-origin, emulated-only status, emulated-only stderr. The installed paths are the ones
 * src/verify/smoke-register.ts measured; `-` in the last two means the component declares no executor limit and can
 * only pass or fail, under emulation exactly as natively. */
function components(): string[][] {
  return [
    ...['micad', 'mica-apid', 'mica-mqttd', 'mica-mqtt-broker', 'mica-deploy'].map(n => [n, `/usr/bin/${n}`, pinnedVersion(n, `/usr/bin/${n}`), `package ${n}`, '-', '-']),
    ['podman', '/usr/bin/podman', pin('podman'), 'podman', '-', '-'],
    ['quadlet', '/usr/libexec/podman/quadlet', pin('podman'), 'podman', '-', '-'],
    // crun 1.29.1 re-executes libcrun out of a memory file descriptor -- its CVE-2024-21626 mitigation -- before it
    // parses argv, and qemu-user cannot service that fexecve. ONE entry with ONE status and ONE stderr substring, so
    // the category cannot spread to a binary nobody measured.
    ['crun', '/usr/bin/crun', pin('crun'), 'crun', '1', 'Failed to re-execute libcrun via memory file descriptor'],
    ...['conmon', 'netavark', 'aardvark-dns', 'catatonit'].map(n => [n, `/usr/libexec/podman/${n}`, pin(n), n, '-', '-']),
  ]
}

async function main(): Promise<number> {
  const say = (l = '') => console.log(l)
  let passN = 0, failN = 0
  const pass = (m: string) => { passN++; say(`PASS: ${m}`) }
  const fail = (m: string) => { failN++; say(`FAIL: ${m}`) }

  if (!existsSync(PODMAN_LOCK)) refuse(`${PODMAN_LOCK} does not exist. It is the upstream.lock the pinned mica-podman archives carry, taken out of them by src/pool/podman-pool.ts --check (make os-pool)`)
  if (Bun.spawnSync([docker, 'version'], quiet).exitCode !== 0) refuse('docker is required and does not answer. The roots are built with buildx, which is also the route to a foreign-architecture root on a host with no binfmt registration')
  for (const arch of ARCHES) {
    for (const f of [join(DIST, arch, 'pool'), join(DIST, arch, 'Packages')])
      if (!existsSync(f)) refuse(`${f} does not exist, so there is nothing to install for ${arch}. Fetch and index both pools with \`make os-pool\`; a gate that skipped the missing architecture would report on half a pool`)
  }
  const hostArch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : refuse(`${process.arch} is not an architecture the Base root is published for`)
  // The Base root: the rootfs index of the pinned mica-system-base release, the one src/rootfs/build.ts composes on.
  const baseArgs = buildArgs(['MICA_BASE=mica-system-base:rootfs'], inputs())
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  const rows = components()
  // The direction that catches a component nobody asked about: every git row of the podman upstream.lock has to be
  // claimed by at least one component row, or an eighth binary would leave this gate green over seven of eight.
  const pins = readFileSync(PODMAN_LOCK, 'utf8').split('\n').map(l => l.split('\t')).filter(f => f[0] === 'git').map(f => f[1]!)
  if (pins.length === 0) refuse(`${PODMAN_LOCK} declares no git row at all, so the coverage check compared the component rows against an empty set and would have accepted any of them`)
  const unclaimed = pins.filter(k => !rows.some(r => r[3] === k))
  if (unclaimed.length > 0) refuse(`${pins.length} version pin(s) were read out of ${PODMAN_LOCK} and no component row claims: ${unclaimed.join(' ')}. A pin nothing claims is a binary this gate installs and never asks, so its version goes unchecked while the RESULT line stays green`)
  say(`install-closure-gate: ${pins.length} upstream version pin(s) claimed by ${rows.length} component row(s)`)

  const presets = JSON.parse(readFileSync(join(REPO_ROOT, 'rootfs/packages/presets.json'), 'utf8')) as Record<string, { system: string[], user: string[] }>
  const preset = (kind: 'system' | 'user') => [...new Set(Object.values(presets).flatMap(p => p[kind]))].sort().map(u => `disable ${u}\n`).join('')

  let roots = 0
  const totals = { packages: 0, paths: 0, wants: 0, rootwants: 0, undeclared: 0, accounts: 0, ldd: 0, components: 0, limited: 0, radio: 0, declinedLdd: 0, declinedLost: 0 }
  const created: string[] = []
  try {
    for (const arch of ARCHES) {
      say()
      say(`=================== ${arch} ===================`)
      const ctx = join(WORK, `ctx-${arch}`), out = join(WORK, `out-${arch}`)
      mkdirSync(join(ctx, 'in'), { recursive: true })
      for (const f of readdirSync(GUEST).filter(f => f.endsWith('.sh'))) copyFileSync(join(GUEST, f), join(ctx, 'in', f))
      writeFileSync(join(ctx, 'in/components.tsv'), rows.map(r => `${r.join('\t')}\n`).join(''))
      // A board whose MICA_ARCH is this pool's and whose development product exists, found in the fetched boards: the
      // board files are the one authority on which architecture a board is.
      const board = readdirSync(join(REPO_ROOT, '_out/boards')).sort().find(b => existsSync(join(REPO_ROOT, '_out/boards', b, 'board.env'))
        && plainValue(join(REPO_ROOT, '_out/boards', b, 'board.env'), 'MICA_ARCH') === arch && existsSync(join(REPO_ROOT, 'products', `${b}-dev`, 'product.env')))
      ?? refuse(`no fetched board of ${arch} has a products/<board>-dev recipe`)
      // The board's development product: the features it selects are the full set this closure proves.
      const features = product(`${board}-dev`).features, boardDir = join(REPO_ROOT, '_out/boards', board, 'manifests')
      // The resolver decides WHAT is installed, and this gate has no fallback set: a board set written here would be a
      // second manifest set, and a clean install of a subset is a green report over the packages it chose.
      const full = await resolve({ board, boardDir, features })
      writeFileSync(join(ctx, 'in/packages.txt'), full.map(p => `${p}\n`).join(''))
      say(`install-closure-gate: ${arch}: board ${board}, features '${features}', ${full.length} package(s): ${full.join(' ')}`)
      // The same product without `mqtt`, resolved rather than subtracted: the resolver's own refusals are the ones that
      // must fire if leaving the feature out is not a configuration the manifests can express.
      const declined = await resolve({ board, boardDir, features: features.split(/\s+/).filter(f => f !== '' && f !== 'mqtt').join(' ') })
      writeFileSync(join(ctx, 'in/packages-declined.txt'), declined.map(p => `${p}\n`).join(''))
      say(`install-closure-gate: ${arch}: mqtt declined, ${declined.length} package(s): ${declined.join(' ')}`)
      // The pool, hardlinked where the filesystem allows it: it carries a kernel and its modules, and buildx wants it
      // inside the context.
      if (Bun.spawnSync(['cp', '-al', join(DIST, arch), join(ctx, 'dist')], quiet).exitCode !== 0) cpSync(join(DIST, arch), join(ctx, 'dist'), { recursive: true })
      // The upstream rows of locks/mica-system-base.lock any of these roots can need, verified, and the presets every
      // root carries.
      cli(['base-packages', 'fetch', '--arch', arch])
      const upstream = cli(['base-packages', 'select', '--arch', arch, '--packages', [...full, ...RADIOS].join(' ')], 'pipe')
      writeFileSync(join(ctx, 'in/upstream.tsv'), upstream)
      mkdirSync(join(ctx, 'upstream'))
      for (const row of upstream.split('\n').filter(l => l !== '')) {
        const sha = row.split('\t')[3]!
        copyFileSync(join(REPO_ROOT, '_out/cache/debian', `${sha}.deb`), join(ctx, 'upstream', `${sha}.deb`))
      }
      writeFileSync(join(ctx, 'in/system.preset'), preset('system'))
      writeFileSync(join(ctx, 'in/user.preset'), preset('user'))

      const emulated = arch === hostArch ? 0 : 1
      // The builder: a caller who named BUILDX_BUILDER meant it; otherwise the default builder for the native
      // architecture, and for the foreign one the docker-container builder whose buildkit image bundles the emulators.
      const builder = process.env.BUILDX_BUILDER || (emulated === 0 ? 'default' : `mica-${arch}`)
      if (!process.env.BUILDX_BUILDER && emulated === 1 && Bun.spawnSync([docker, 'buildx', 'inspect', builder], quiet).exitCode !== 0) {
        if (Bun.spawnSync([docker, 'buildx', 'create', '--name', builder, '--driver', 'docker-container'], quiet).exitCode !== 0) refuse(`docker buildx create ${builder} failed`)
        created.push(builder)
      }
      const log = join(WORK, `build-${arch}.log`)
      say(`install-closure-gate: building ${REPORTS.length} ${arch} roots on builder '${builder}' (emulated=${emulated}); the build log is ${log}`)
      const built = Bun.spawnSync([docker, 'buildx', 'build', '--label', 'ai-agent=true', '--builder', builder, ...baseArgs, '--build-arg', `EMULATED=${emulated}`,
        '--platform', `linux/${arch}`, '--target', 'reports', '-f', join(GUEST, 'Dockerfile'), '-o', out, ctx], { stdout: 'pipe', stderr: 'pipe' })
      writeFileSync(log, built.stdout.toString() + built.stderr.toString())
      if (built.exitCode !== 0) {
        fail(`${arch}: the root builds did not complete; the tail of ${log} follows`)
        say(readFileSync(log, 'utf8').trimEnd().split('\n').slice(-40).join('\n'))
        continue
      }

      const report = (name: string) => existsSync(join(out, name)) ? readFileSync(join(out, name), 'utf8').replace(/\n$/, '').split('\n') : undefined
      for (const [name, terminator] of REPORTS) {
        const r = report(name)
        if (r === undefined) { fail(`${arch}: ${name} was not produced at all`); continue }
        // The terminator is what tells "it finished and found nothing wrong" apart from "it was killed", and it has to
        // be the LAST line: found anywhere, it would pass for a report that was cut off after it.
        if (r.at(-1) !== terminator) { fail(`${arch}: ${name} does not END in '${terminator}' (its last line is '${r.at(-1)}'), so it was truncated and its silence is not a pass`); continue }
        roots++
        const p = r.filter(l => l.startsWith('PASS: ')).length, f = r.filter(l => l.startsWith('FAIL: ')).length
        passN += p
        failN += f
        say(`--- ${arch}/${name}: ${p} pass, ${f} fail`)
        for (const l of r.filter(l => /^(PASS: |FAIL: |EXECUTOR-LIMITED: |UNDECLARED-ENABLEMENT: |install-closure: )/.test(l))) say(`  ${l}`)
      }
      // The denominators the full root measured, lifted off its own COUNT lines rather than recomputed here. Zero when
      // the key is absent, so a report that never reached its COUNT lines lands in the RESULT line as the zero it is.
      const countOf = (r: string[] | undefined, key: string) => Number(r?.find(l => l.startsWith(`COUNT ${key} `))?.slice(`COUNT ${key} `.length) || 0)
      const fullReport = report('full.txt'), declinedReport = report('declined.txt')
      if (fullReport !== undefined) {
        totals.packages += countOf(fullReport, 'packages')
        totals.paths += countOf(fullReport, 'paths')
        totals.wants += countOf(fullReport, 'wants')
        totals.rootwants += countOf(fullReport, 'rootwants')
        totals.undeclared += countOf(fullReport, 'undeclared')
        totals.accounts += countOf(fullReport, 'accounts')
        totals.ldd += countOf(fullReport, 'ldd')
        totals.components += countOf(fullReport, 'components')
        totals.limited += countOf(fullReport, 'limited')
      }
      // --- what declining mqtt actually took out of the root. Diffed HERE because no root can see another's package
      // database, and it is this difference that decides whether the declined root's ldd sweep could have failed at
      // all. Reported as the measured list rather than as a count: WHICH libraries left with mica-mqttd is the fact.
      if (fullReport !== undefined && declinedReport !== undefined) {
        totals.declinedLdd += countOf(declinedReport, 'ldd')
        const pkgdb = (r: string[]) => [...new Set(r.map(l => /^PKGDB: (\S*) /.exec(l)?.[1]).filter(p => p !== undefined))].sort()
        const fullDb = pkgdb(fullReport), declinedDb = pkgdb(declinedReport)
        const lost = fullDb.filter(p => !declinedDb.includes(p))
        if (fullDb.length === 0 || declinedDb.length === 0) { fail(`${arch}: one of the two roots reported an empty package database (${fullDb.length} full, ${declinedDb.length} declined), so the comparison of what mqtt took with it was over nothing`) }
        else {
          say(`install-closure-gate: ${arch}: the full root holds ${fullDb.length} package(s), the mqtt-declined root ${declinedDb.length}; declining mqtt removed ${lost.length}: ${lost.length > 0 ? lost.join(' ') : 'nothing at all'}`)
          totals.declinedLost += lost.length
          if (!lost.includes('mica-mqttd')) fail(`${arch}: mica-mqttd is not among the packages the declined root lacks (${lost.join(' ') || 'none'}), so that root is not the mqtt-declined configuration it was meant to be`)
          else if (lost.length > 1) pass(`${arch}: declining mqtt removed ${lost.length} package(s) beyond nothing, so the ldd sweep over that root had material that could have failed it`)
          else say(`install-closure-gate: ${arch}: mica-mqttd was the ONLY package that left. Nothing else's libraries went with it, so the sweep over the declined root could not have found an undeclared dependency -- it is a true green over an empty search space, and it is reported as that rather than quoted as a proof`)
        }
      }
      // --- the disjointness the three radio roots exist for, compared HERE: no root can see another's payload.
      const owner = new Map<string, string>(), overlap: string[] = []
      let radioPaths = 0
      for (const pkg of RADIOS) {
        for (const l of report(`radio-${pkg}.txt`) ?? []) {
          if (!l.startsWith('PAYLOAD: ')) continue
          const path = l.slice('PAYLOAD: '.length)
          radioPaths++
          if (owner.has(path)) overlap.push(`${path}(${owner.get(path)},${pkg})`)
          else owner.set(path, pkg)
        }
      }
      totals.radio += radioPaths
      if (radioPaths === 0) fail(`${arch}: the three radio roots reported ZERO payload paths between them, so the disjointness comparison was over an empty set`)
      else if (overlap.length === 0) pass(`${arch}: the three radio packages' payloads are disjoint over ${radioPaths} non-directory path(s)`)
      else fail(`${arch}: radio payload path(s) claimed by two packages: ${overlap.join(' ')}`)
    }
  }
  finally {
    for (const b of created) Bun.spawnSync([docker, 'buildx', 'rm', b], quiet)
  }

  if (roots === 0) refuse('no root reported at all, so nothing was installed and nothing was checked')
  const expected = ARCHES.length * REPORTS.length
  if (roots !== expected) fail(`${roots} of ${expected} roots reported; a gate that read fewer reports than it built has one missing, not a smaller job`)
  say()
  say(`RESULT: ${failN === 0 ? 'PASS' : 'FAIL'} (${passN}/${passN + failN} checks passed, ${roots} Base roots over ${ARCHES.length} architectures, ${totals.packages} packages installed, ${totals.paths} payload paths present, ${totals.wants} payload wants-symlinks resolved of ${totals.rootwants} present in those roots, ${totals.undeclared} units enabled outside any payload, ${totals.accounts} unit accounts resolved, ${totals.ldd} objects ldd-checked in the full roots, ${totals.declinedLdd} in the mqtt-declined roots over ${totals.declinedLost} packages those roots lost, ${totals.components} component versions asked, ${totals.limited} executor-limited, ${totals.radio} radio payload paths compared)`)
  return failN === 0 ? 0 : 1
}

if (import.meta.main) {
  try { process.exit(await main()) }
  catch (e) {
    if (e instanceof GateError || (e instanceof Error && e.constructor.name === 'ResolveError')) { console.error(e.message); process.exit(1) }
    throw e
  }
}
