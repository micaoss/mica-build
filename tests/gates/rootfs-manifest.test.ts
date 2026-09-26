// src/rootfs/resolve.ts, driven over the boards, radios and features this repository actually supports
// (make os-rootfs-manifest-test; the boards' manifests come out of the fetched bundles, make board-fetch-all).
//
// Three things are asserted and the third is the one that is easy to skip:
//
//   1. THE RESOLVED SETS, for every board, and for a build that declines every feature. Written out literally: a
//      test that recomputed the answer from the manifests would agree with any manifest at all.
//   2. EVERY REFUSAL, each proven RED BY MUTATION. A copy of the manifest tree is made under tmp/, perturbed there,
//      and the refusal is required to fire on the copy and NOT on the pristine one -- a negative test whose removal
//      changes nothing is not a test. Each is matched on a FRAGMENT of its message and not on the refusal alone,
//      because a perturbed tree is usually true of more than one refusal at once; and every fragment is then
//      required to be absent from all the other refusals' messages, so a fragment that stopped discriminating fails
//      here rather than silently accepting whichever refusal happened to fire.
//   3. THE REVERSE DIRECTION: every package the lock and the producers declare has to be reachable by SOME legal
//      resolution. A package no manifest can ever name is a package the composer will never install, and nothing
//      else in this repository would notice -- every check downstream of composition runs over the set that WAS
//      installed.
//
// No docker, no build, no pool: this reads manifests and the pins. The resolver runs in-process. The port of
// tests/gates/rootfs-manifest-test.sh (deleted 2026-09-25), check for check.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { boards } from '../../src/boards/boards.ts'
import { rows } from '../../src/pool/pool.ts'
import { HARDWARE_FEATURES, plainValue, product } from '../../src/product/product.ts'
import { declaredPackages, main as resolveMain, PACKAGES_DIR, resolve, ResolveError } from '../../src/rootfs/resolve.ts'

const REPO_ROOT = resolvePath(import.meta.dir, '../..')
const BOARDS_OUT = join(REPO_ROOT, '_out/boards')
const bd = (board: string) => join(BOARDS_OUT, board, 'manifests')
// tmp/ and not /tmp: the repository-local scratch, per .gitignore.
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp', 'rootfs-manifest.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

let declared: Set<string>
beforeAll(async () => { declared = await declaredPackages() })

type Outcome = { ok: true, set: string[] } | { ok: false, message: string }
/** The resolver over a NAMED manifest directory, so the same call drives the tracked manifests and a perturbed copy
 * against the same producers. The directory is what differs between the trees, so it is normalised out of a refusal
 * before the messages are compared to each other. */
async function run(dir: string, board: string, boardDir: string, features: string, components?: string): Promise<Outcome> {
  try { return { ok: true, set: await resolve({ board, boardDir, features, components, packagesDir: dir, declared }) } }
  catch (e) {
    if (!(e instanceof ResolveError)) throw e
    return { ok: false, message: e.message.replaceAll(dir, '<MANIFESTS>') }
  }
}
async function resolved(dir: string, board: string, boardDir: string, features: string): Promise<string> {
  const r = await run(dir, board, boardDir, features)
  if (!r.ok) throw new Error(`the resolver refused a legal resolution: ${r.message}`)
  return r.set.join(' ')
}

// The features a product selects, read through src/product/product.ts, the one reader of product.env.
const featuresOf = (name: string) => product(name).features

// mica-busybox is in EVERY set below, including CX_MINIMAL, and that is what rootfs/packages/common.pkgs holding it
// means: the emergency binary is not declinable, because the build that declined it is the image an operator is
// holding when they need it (RFCT-281).
const CX_DEV = 'bash coreutils diffutils dmsetup findutils grep gzip kmod login mica-apid mica-bluetooth mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-ssh mica-system mica-tzdata mica-wifi mica-wifi-ap micad nftables procps sed'
// Kernel and module payloads are independent of every user-space root.
const X64_DEV = 'bash coreutils diffutils dmsetup findutils grep gzip kmod login mica-apid mica-board-uefi-x64 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-ssh mica-system mica-tzdata micad nftables procps sed'
// uefi-arm64 is uefi-x64's set with its own board package: the two boards differ in architecture and firmware, not
// in what userland the image carries. Spelled out rather than derived from X64_DEV by substitution -- a set computed
// from another set agrees with it by construction and would not notice the day they stop agreeing.
const VA_DEV = 'bash coreutils diffutils dmsetup findutils grep gzip kmod login mica-apid mica-board-uefi-arm64 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-ssh mica-system mica-tzdata micad nftables procps sed'
const CX_MINIMAL = 'bash coreutils diffutils dmsetup findutils grep gzip kmod login mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-sftp-server mica-ssh mica-system mica-tzdata nftables procps sed'

// ---------------------------------------------------------------------------------------------------------------
// 1. The resolved sets.
// ---------------------------------------------------------------------------------------------------------------

test.each([
  ['cx3576-dev', 'cx3576', CX_DEV],
  ['uefi-x64-dev', 'uefi-x64', X64_DEV],
  ['uefi-arm64-dev', 'uefi-arm64', VA_DEV],
])('%s resolves to its literal set', async (name, board, want) => {
  expect(await resolved(PACKAGES_DIR, board, bd(board), featuresOf(name))).toBe(want)
})

// A radio-less board carries no OTHER board's package and no radio package. Asserted on its own and not left to the
// literals above, because one board's packages leaking into another's image is a failure an updated expectation
// would absorb without anyone reading it. Over BOTH radio-less boards, so that it cannot pass on the one board the
// resolver was written around.
test.each(['uefi-x64', 'uefi-arm64'])('%s dev carries no other board package and no radio package', async (board) => {
  const set = (await resolved(PACKAGES_DIR, board, bd(board), featuresOf(`${board}-dev`))).split(' ')
  expect(set.filter(p => ['mica-wifi', 'mica-wifi-ap', 'mica-bluetooth'].includes(p) || (p.startsWith('mica-board-') && p !== `mica-board-${board}`))).toEqual([])
})

// Selecting ONE radio leaves the other out: wifi and bluetooth are independent features, which is the whole point
// of the split -- the retired umbrella token carried both together.
test('cx3576 dev, features without bluetooth keep Wi-Fi, and without wifi keep Bluetooth', async () => {
  expect(await resolved(PACKAGES_DIR, 'cx3576', bd('cx3576'), 'micad mqtt containers wifi'))
    .toBe('bash coreutils diffutils dmsetup findutils grep gzip kmod login mica-apid mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-ssh mica-system mica-tzdata mica-wifi mica-wifi-ap micad nftables procps sed')
  expect(await resolved(PACKAGES_DIR, 'cx3576', bd('cx3576'), 'micad mqtt containers bluetooth'))
    .toBe('bash coreutils diffutils dmsetup findutils grep gzip kmod login mica-apid mica-bluetooth mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-ssh mica-system mica-tzdata micad nftables procps sed')
})

// The umbrella token is GONE, not quietly tolerated.
test('--features radios is refused: the umbrella token no longer exists', async () => {
  expect((await run(PACKAGES_DIR, 'cx3576', bd('cx3576'), 'radios')).ok).toBe(false)
})

// Declining every feature drops exactly the feature packages and leaves a legal image set: common and one board.
// No product declares it any more (the minimal products were removed, user 2026-09-16), so this is where the floor
// is proved.
test('the floor on cx3576 is common and the board, and leaves out exactly the feature packages', async () => {
  expect(await resolved(PACKAGES_DIR, 'cx3576', bd('cx3576'), '')).toBe(CX_MINIMAL)
  expect(CX_DEV.split(' ').filter(p => !CX_MINIMAL.split(' ').includes(p)).join(' '))
    .toBe('mica-apid mica-bluetooth mica-mqtt-broker mica-mqttd mica-podman mica-wifi mica-wifi-ap micad')
})

test.each(boards().map(b => b.name).filter(b => b !== 'cx3576'))('the floor composes on %s with no feature', async (board) => {
  const r = await run(PACKAGES_DIR, board, bd(board), '')
  expect(r.ok ? '' : r.message).toBe('')
})

// ---------------------------------------------------------------------------------------------------------------
// 2. The refusals, each proven red by mutation.
// ---------------------------------------------------------------------------------------------------------------

const copy = (from: string, name: string) => { const dir = join(SCRATCH, name); cpSync(from, dir, { recursive: true }); return dir }
const mutate = (name: string) => copy(PACKAGES_DIR, name)
const mutateBoard = (name: string, board: string) => copy(bd(board), `${name}-${board}`)

// A copy of the manifest tree that nothing perturbs; every mutation below is measured against it.
test('the pristine copy under tmp/ resolves identically to the tracked tree', async () => {
  expect(await resolved(mutate('pristine'), 'cx3576', bd('cx3576'), featuresOf('cx3576-dev'))).toBe(CX_DEV)
})

const refusals: { label: string, token: string, message: string }[] = []
/** The refusal has to fire, and with a message carrying its fragment, or it is some OTHER refusal firing. */
async function expectRefusal(label: string, token: string, outcome: Promise<Outcome>) {
  const r = await outcome
  expect(r.ok, `${label}: the resolver SUCCEEDED where it had to refuse. It printed: ${r.ok ? r.set.join(' ') : ''}`).toBe(false)
  if (r.ok) return
  expect(r.message, `${label}: refused, but with a message that does not carry '${token}', so this is some OTHER refusal firing`).toContain(token)
  refusals.push({ label, token, message: r.message })
}

test('(a) an unknown feature is refused, a legal list is not, and a new feature manifest makes a name legal', async () => {
  const cx = featuresOf('cx3576-dev')
  await expectRefusal('unknown feature in --features', 'zigbee', run(PACKAGES_DIR, 'cx3576', bd('cx3576'), `${cx} zigbee`))
  expect((await run(PACKAGES_DIR, 'cx3576', bd('cx3576'), 'micad containers wifi bluetooth')).ok, 'a feature list without mqtt was refused on the tracked tree').toBe(true)
  // The stronger direction: a NEW feature manifest makes a previously illegal name legal, which a hardcoded list
  // of features could not do.
  const dir = mutate('feature-added')
  writeFileSync(join(dir, 'feature-zigbee.pkgs'), '# scratch mutation\nmica-mqttd\n')
  expect((await run(dir, 'cx3576', bd('cx3576'), `${cx} zigbee`)).ok, 'feature-zigbee.pkgs was added to a copy and zigbee was still refused, so the feature list does not come from the manifests').toBe(true)
})

test('(b) a manifest line naming a package nothing declares is refused', async () => {
  const dir = mutate('undeclared-package')
  writeFileSync(join(dir, 'common.pkgs'), 'mica-not-a-real-package\n', { flag: 'a' })
  await expectRefusal('manifest names a package no producer declares', 'mica-not-a-real-package', run(dir, 'cx3576', bd('cx3576'), featuresOf('cx3576-dev')))
})

// The image profile is not a resolver input: it selects no package. The only case that goes through the CLI, since
// the refusal is of the argument.
test('(c) --profile is refused', async () => {
  const error = console.error
  console.error = () => {}
  try { expect(await resolveMain(['--board', 'cx3576', '--board-dir', bd('cx3576'), '--profile', 'dev', '--features', featuresOf('cx3576-dev')])).not.toBe(0) }
  finally { console.error = error }
})

// (d) The fragment matters more here than anywhere else: an empty resolution also carries no board package, so both
// refusals are true of this tree and only the first to run says the useful thing.
test('(d) an empty resolution, and one with no board package, are refused by name', async () => {
  const cx = featuresOf('cx3576-dev')
  const dir = mutate('empty-resolution'), bdir = mutateBoard('empty-resolution', 'cx3576')
  for (const d of [dir, bdir]) for (const f of readdirSync(d).filter(f => f.endsWith('.pkgs'))) writeFileSync(join(d, f), '')
  await expectRefusal('empty resolution', 'is EMPTY', run(dir, 'cx3576', bdir, cx))
  const nobp = mutateBoard('no-board-package', 'cx3576')
  writeFileSync(join(nobp, 'board.pkgs'), '')
  await expectRefusal('resolution carries no board package', 'NO board package', run(PACKAGES_DIR, 'cx3576', nobp, cx))
})

// (e) The two halves of the split, each refused by name.
test('(e) a board manifest in the engine directory, and a bundle with no board.pkgs, are refused', async () => {
  const cx = featuresOf('cx3576-dev')
  const dir = mutate('board-manifest-in-engine')
  writeFileSync(join(dir, 'board-cx3576.pkgs'), 'mica-board-cx3576\n')
  await expectRefusal('a board manifest in the engine directory', 'board manifest in the engine', run(dir, 'cx3576', bd('cx3576'), cx))
  const bdir = mutateBoard('no-board-manifest', 'cx3576')
  rmSync(join(bdir, 'board.pkgs'))
  await expectRefusal('a board bundle with no board.pkgs', 'no board.pkgs', run(PACKAGES_DIR, 'cx3576', bdir, cx))
})

// Every refusal must have its OWN message, and every fragment matched above must be absent from every OTHER
// refusal's message: otherwise a fragment could match all six and each expectRefusal would assert nothing beyond a
// refusal.
test('each refusal has its own message, and each fragment appears in its own and in none of the others', () => {
  expect(refusals.length, 'not one refusal was recorded, so this compares nothing against nothing').toBe(6)
  expect(new Set(refusals.map(r => r.message)).size).toBe(refusals.length)
  const shared = refusals.flatMap(a => refusals.filter(b => b !== a && b.message.includes(a.token)).map(b => `'${a.token}' (${a.label}) also appears in the message for ${b.label}`))
  expect(shared).toEqual([])
})

// ---------------------------------------------------------------------------------------------------------------
// 3. The reverse direction: every declared package reachable.
// ---------------------------------------------------------------------------------------------------------------

// Packages that NO legal resolution can name, with the reason each is exempt. A written list rather than a
// tolerance: a package that quietly stops being reachable is a package the composer stops installing.
const UNREACHABLE_OK: Record<string, string> = {
  'mica-lifecycle': 'mica-runkit is taken out of the archive by src/pool/deploy-pool.ts --lifecycle into the image\'s own root, never installed by APT',
  'mica-systemd-boot': 'the unsigned systemd-boot loader src/boot/build-tools.ts signs into the firmware component, never installed into a root',
}

test('every package the lock declares is reachable by some legal resolution, or exempt by name', async () => {
  // The lock's rows are the declared packages: what locks/ imports is what the composer installs.
  const lockDeclared = [...new Set((await rows()).map(r => r[0]))]
  // The legal space, from the manifest tree and the board files rather than a list written here: a board, radio or
  // feature added to the repository is enumerated the day it lands.
  const all = [...new Set(readdirSync(PACKAGES_DIR).map(f => /^(?:feature|radio)-(.+)\.pkgs$/.exec(f)?.[1]).filter(f => f !== undefined))].sort()
  const reached = new Set<string>(), refused: string[] = []
  let resolutions = 0
  for (const { name: board } of boards()) {
    const has = plainValue(join(BOARDS_OUT, board, 'board.env'), 'BOARD_FEATURES').split(/\s+/)
    const takes = all.filter(f => !HARDWARE_FEATURES.includes(f) || has.includes(f))
    // The full power set, not just "select all": that alone would pass over a resolver that ignored --features.
    for (let mask = 0; mask < 1 << takes.length; mask++) {
      const features = takes.filter((_f, i) => (mask >> i) & 1).join(' ')
      const r = await run(PACKAGES_DIR, board, bd(board), features)
      if (!r.ok) { refused.push(`--board ${board} --features '${features}': ${r.message}`); continue }
      resolutions++
      for (const p of r.set) reached.add(p)
    }
    // Optional board components must also be reachable through their explicit selection.
    for (const f of readdirSync(bd(board)).filter(f => /^component-.+\.pkgs$/.test(f))) {
      const component = f.slice('component-'.length, -'.pkgs'.length)
      const r = await run(PACKAGES_DIR, board, bd(board), featuresOf(`${board}-dev`), component)
      if (!r.ok) { refused.push(`component ${board}/${component}: ${r.message}`); continue }
      resolutions++
      for (const p of r.set) reached.add(p)
    }
  }
  console.log(`COUNTS: ${lockDeclared.length} packages declared by the lock, ${reached.size} proven reachable, over ${resolutions} legal resolutions`)
  expect(refused, 'every one of these is a legal build').toEqual([])
  expect(lockDeclared.length).toBeGreaterThan(0)
  expect(resolutions).toBeGreaterThan(0)
  expect(lockDeclared.filter(p => !reached.has(p) && UNREACHABLE_OK[p] === undefined).map(p => `${p} is declared and NO legal resolution names it. The composer will never install it; name it in a manifest, or list it in UNREACHABLE_OK with the reason`)).toEqual([])
  // A stale exemption is an exemption that hides the next regression.
  expect(Object.keys(UNREACHABLE_OK).filter(p => reached.has(p)).map(p => `${p} is exempt but a legal resolution names it; remove the exemption`)).toEqual([])
})

test('the fetched bundles this test reads exist', () => {
  for (const { name } of boards()) expect(existsSync(bd(name)), `${bd(name)} is missing; make board-fetch-all`).toBe(true)
})
