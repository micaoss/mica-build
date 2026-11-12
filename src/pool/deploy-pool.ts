// What this tree takes out of the imported mica-deploy archives and source.
//
//   bun src/cli.ts deploy-pool --lifecycle <amd64|arm64|armhf> <dir>   mica-runkit into <dir>
//   bun src/cli.ts deploy-pool --check                          the contract fixtures against the pinned source
//   bun src/cli.ts deploy-pool --refresh                        the contract fixtures copied from the pinned source
//
//   reads   _out/debs/<arch>/pool/mica-lifecycle_*.deb   (fetched at the pin by src/cli.ts pool fetch)
//           _out/src/mica-core/                          (src/cli.ts source, at the commit of its release)
//   writes  <dir>/mica-runkit                             (--lifecycle)
//
// The native boot and deployment tools are built and released by micaoss/mica-core; this repository imports
// mica-deploy (the device-side client, installed into every root) and mica-lifecycle (the static mica-runkit
// the signed kernel carries) through locks/mica-core.lock and never sees that repository's tree except at its
// release commit. Two consumers still need something out of it:
//
// - src/image/kernel-package.ts packs mica-runkit into the initramfs, as /init and the exit ramdisk's shutdown,
//   where it is part of the authenticated kernel identity. --lifecycle reads it out of the pinned archive of the
//   board's architecture (mica-build-tools' archive reader), so the kernel is built from the binaries the pin names and nothing is
//   compiled here.
// - tests/fixtures/component-contracts/ is the contract between the assembly (the producer of envelopes and
//   records) and the crate's reader; both repositories commit the same four files. --check reads mica-deploy's
//   copy at the locked commit and refuses a difference, so the two cannot drift apart without a bump on one side
//   and a diff on the other -- and then proves the fixture's board POLICIES are the ones this tree writes into
//   boot.json for every board both name (src/image/board-facts.ts, BoardPolicy): the device reads its backend,
//   partitions, firmware target and record geometry from that policy and from nothing compiled in, so a board the
//   fixture does not name needs no mica-core change. `make os-pool` runs it beside the fetch, where the network is
//   already required. --refresh is the other half of a mica-core pin move: it copies mica-core's files at the
//   pinned commit over this tree's, after the same policy check, so the commit that moves the pin carries them
//   (local-build runs it for an offline pin, on its local branch).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { boardFactsFrom, type BoardFacts } from '../image/board-facts.ts'
import { canonicalJson } from '../image/components.ts'
import { checkout } from '../locks/source.ts'
import { payloadMember } from '@mica/build-tools'
import { REPO_ROOT } from './producers.ts'
import { ARCH_CHOICES, isArch } from '../rootfs/runtime/arch.ts'
import { coreCarriesDataEncryption, fixtureProblems } from '../product/data-encryption.ts'
import { product, products } from '../product/product.ts'

export class DeployPoolError extends Error {}

const die = (message: string): never => { throw new DeployPoolError(`error: ${message}`) }

function archiveFor(pool: string, arch: string): string {
  const dir = join(pool, arch, 'pool')
  const found = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('mica-lifecycle_') && f.endsWith(`_${arch}.deb`)).sort() : []
  if (found.length !== 1) die(`expected exactly one mica-lifecycle archive in ${dir}, found ${found.length}. locks/mica-core.lock pins it; fetch it with \`make os-pool\``)
  return join(dir, found[0]!)
}

/** mica-runkit of the architecture into `dir`; the summary line. */
export async function lifecycle(arch: string, dir: string, pool = process.env['MICA_POOL_DIR'] ?? join(REPO_ROOT, '_out/debs')): Promise<string> {
  if (!isArch(arch)) die(`usage: deploy-pool --lifecycle <${ARCH_CHOICES}> <dir>`)
  if (dir === '') die('usage: deploy-pool --lifecycle <amd64|arm64|armhf> <dir>')
  const archive = archiveFor(pool, arch)
  mkdirSync(dir, { recursive: true })
  const { body, mode } = await payloadMember(archive, 'usr/lib/mica/lifecycle/mica-runkit')
  writeFileSync(join(dir, 'mica-runkit'), body)
  chmodSync(join(dir, 'mica-runkit'), mode & 0o777)
  return `deploy-pool: mica-runkit for ${arch} in ${dir} from ${archive.slice(archive.lastIndexOf('/') + 1)}`
}

/** Every file under a directory, relative, sorted. */
function files(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e), rel = prefix === '' ? e : `${prefix}/${e}`
    if (statSync(p).isDirectory()) out.push(...files(p, rel))
    else out.push(rel)
  }
  return out
}

type Policed = Pick<BoardFacts, 'arch' | 'policy'>

/** A board of this tree by name: the facts of boards/<board>/, or undefined where the tree has no such board. */
function treeBoard(board: string): Policed | undefined {
  const env = join(REPO_ROOT, 'boards', board, 'board.env')
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(board) && existsSync(env) ? boardFactsFrom(env) : undefined
}

/** The fixture's board policies against the ones this tree writes into boot.json; the summary line or a refusal. */
export function policies(casesPath: string, factsOf: (board: string) => Policed | undefined = treeBoard): string {
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as { boardPolicies?: Record<string, { arch: string, board: unknown }> }
  const fixture = cases.boardPolicies !== null && typeof cases.boardPolicies === 'object' ? Object.entries(cases.boardPolicies).sort(([x], [y]) => x.localeCompare(y)) : []
  if (fixture.length === 0) die('tests/fixtures/component-contracts/cases.json declares no \'boardPolicies\'. mica-core states the policies its reader accepts and this tree checks the ones it writes; a fixture with none proves nothing')
  const ours = fixture.flatMap(([name, want]) => {
    const facts = factsOf(name)
    return facts === undefined ? [] : [{ name, want, facts }]
  })
  if (ours.length === 0) die(`cases.json's board policies (${fixture.map(([n]) => n).join(', ')}) name no board this tree builds; the check would pass on nothing`)
  const differ = ours.filter(({ want, facts }) => want.arch !== facts.arch || canonicalJson(want.board) !== canonicalJson(facts.policy))
  if (differ.length > 0) {
    die(`the boot policy this tree writes differs from mica-core's fixture for ${differ.map(({ name, want, facts }) => `${name} (fixture ${want.arch} ${canonicalJson(want.board)}, this tree ${facts.arch} ${canonicalJson(facts.policy)})`).join('; ')}.`
      + ' The device reads its board from that policy: change the board here or the fixture in mica-core, release, move the pin and copy the same files')
  }
  return `deploy-pool: the boot policy of ${ours.map(o => o.name).join(', ')} is the one mica-core's fixture states; a board it does not name is this tree's alone`
}

const OURS = join(REPO_ROOT, 'tests/fixtures/component-contracts')

/** mica-core's copy of the fixtures at the pinned commit (src/cli.ts source checks it out). */
function pinnedCopy(): string {
  checkout('mica-core')
  const theirs = join(REPO_ROOT, '_out/src/mica-core/crates/mica-deploy/tests/component-contracts')
  if (!existsSync(theirs)) die(`${theirs.slice(REPO_ROOT.length + 1)} does not exist at the mica-core commit of its release; the contract fixtures are expected there`)
  return theirs
}

/** Each file that is not the same on both sides: [name, 'only in mica-core' | 'only in this tree' | 'differs']. */
function differences(ours: string, theirs: string): Array<[string, string]> {
  const a = files(ours), b = files(theirs)
  return [...new Set([...a, ...b])].sort().flatMap((f): Array<[string, string]> => {
    const x = existsSync(join(ours, f)) ? readFileSync(join(ours, f)) : undefined, y = existsSync(join(theirs, f)) ? readFileSync(join(theirs, f)) : undefined
    if (x !== undefined && y !== undefined && Buffer.compare(x, y) === 0) return []
    return [[f, x === undefined ? 'only in mica-core' : y === undefined ? 'only in this tree' : 'differs']]
  })
}

/** mica-core's copy over the tree's: its board policies are checked first, and nothing is written when they
 * differ from the ones this tree writes. The summary lines. */
export function sync(ours: string, theirs: string, factsOf?: (board: string) => Policed | undefined): string[] {
  const policy = policies(join(theirs, 'cases.json'), factsOf)
  const differ = differences(ours, theirs)
  if (differ.length === 0) return ['deploy-pool: tests/fixtures/component-contracts already is mica-core\'s copy', policy]
  for (const [f, how] of differ) {
    if (how === 'only in this tree') { rmSync(join(ours, f)); continue }
    mkdirSync(dirname(join(ours, f)), { recursive: true })
    copyFileSync(join(theirs, f), join(ours, f))
  }
  const word = { 'only in mica-core': 'added', 'only in this tree': 'removed', 'differs': 'changed' } as Record<string, string>
  return [`deploy-pool: ${differ.map(([f, how]) => `${f} ${word[how]}`).join(', ')}: tests/fixtures/component-contracts is mica-core's copy again`, policy]
}

/** --refresh: the pinned copy over the tree's. */
export function refresh(): string[] {
  return sync(OURS, pinnedCopy())
}

/** What every `on` product of this tree writes as dataEncryption against mica-core's cases (W1.4); the summary line. */
export function encryptionCases(casesPath: string): string {
  const written = products().flatMap((name) => {
    const member = product(name).dataEncryption
    return member === undefined ? [] : [{ product: name, member }]
  })
  if (!coreCarriesDataEncryption(casesPath)) return `deploy-pool: the pinned core's contract has no dataEncryption cases; ${written.map(w => w.product).join(', ') || 'no product'} with DATA_ENCRYPTION=on is refused at build`
  const problems = fixtureProblems(written, casesPath)
  if (problems.length > 0) die(`the dataEncryption this tree writes disagrees with mica-core's cases: ${problems.join('; ')}`)
  return `deploy-pool: dataEncryption agrees with mica-core's accepted and refused cases (${written.map(w => w.product).join(', ') || 'no on product'})`
}

/** The contract fixtures against mica-core's copy at the commit of its release; the summary lines. */
export function check(): string[] {
  const theirs = pinnedCopy(), ours = OURS
  const differ = differences(ours, theirs)
  if (differ.length > 0) {
    for (const [f, how] of differ) console.error(`${f}: ${how}`)
    die('tests/fixtures/component-contracts differs from mica-core\'s copy at the commit of its release (see the diff above). The files are one contract read by both sides; change them in mica-core, release, move the pins here, and copy the same files (deploy-pool --refresh)')
  }
  return ['deploy-pool: tests/fixtures/component-contracts matches mica-core crates/mica-deploy at the commit of its release', policies(join(ours, 'cases.json')),
    encryptionCases(join(ours, 'cases.json'))]
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === '--lifecycle') { console.log(await lifecycle(argv[1] ?? '', argv[2] ?? '')); return 0 }
    if (argv[0] === '--check' && argv.length === 1) { for (const l of check()) console.log(l); return 0 }
    if (argv[0] === '--refresh' && argv.length === 1) { for (const l of refresh()) console.log(l); return 0 }
    console.error('usage: bun src/cli.ts deploy-pool --lifecycle <amd64|arm64|armhf> <dir> | --check | --refresh')
    return 1
  }
  catch (e) {
    if (e instanceof DeployPoolError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['SourceError', 'ToolError', 'Refused'].includes(e.constructor.name)) { console.error(e.constructor.name === 'SourceError' ? `source: error: ${e.message}` : e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
