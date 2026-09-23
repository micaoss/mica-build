// What this tree takes out of the imported mica-deploy archives and source.
//
//   bun src/cli.ts deploy-pool --lifecycle <amd64|arm64> <dir>   mica-runkit into <dir>
//   bun src/cli.ts deploy-pool --check                          the contract fixtures against the pinned source
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
//   board's architecture (src/pool/deb.ts), so the kernel is built from the binaries the pin names and nothing is
//   compiled here.
// - tests/fixtures/component-contracts/ is the contract between the assembly (the producer of envelopes and
//   records) and the crate's reader; both repositories commit the same four files. --check reads mica-deploy's
//   copy at the locked commit and refuses a difference, so the two cannot drift apart without a bump on one side
//   and a diff on the other -- and then proves the fixture's board VOCABULARY is this tree's: on 2026-09-16 four
//   boards were renamed here, the fixtures kept the old names as a sample value, both copies agreed, the check
//   passed, and every uefi image published for the next three days refused its own board name at PID 1. `make
//   os-pool` runs it beside the fetch, where the network is already required. The port of tools/deploy-pool.sh
//   (deleted 2026-09-23), message for message.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkout } from '../locks/source.ts'
import { payloadMember } from './deb.ts'
import { REPO_ROOT } from './producers.ts'

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
  if (arch !== 'amd64' && arch !== 'arm64') die('usage: deploy-pool --lifecycle <amd64|arm64> <dir>')
  if (dir === '') die('usage: deploy-pool --lifecycle <amd64|arm64> <dir>')
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

/** The fixture's accepted board vocabulary against boards.tsv; the summary line or a refusal. */
export function vocabulary(casesPath: string, boardsPath: string): string {
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as { boards?: { name: string, arch: string, result?: string }[] }
  const boards = Array.isArray(cases.boards) ? cases.boards : []
  if (boards.length === 0) die('tests/fixtures/component-contracts/cases.json declares no \'boards\' vocabulary. mica-core states the vocabulary and this tree checks it; a fixture with no vocabulary is the shape that let a rename through unnoticed')
  const pinned = new Map(readFileSync(boardsPath, 'utf8').split('\n').filter(l => l.trim() !== '' && !l.startsWith('#')).map(l => [l.split('\t')[0]!, l.split('\t')[1]!.replace(/\n$/, '')]))
  if (pinned.size === 0) die('boards/boards.tsv lists no board; a vocabulary checked against an empty set would pass on nothing')
  const accepted = new Map(boards.filter(b => b.result === 'accepted').map(b => [b.name, b.arch]))
  const refused = boards.filter(b => b.result === 'refused').map(b => b.name).sort()
  const same = accepted.size === pinned.size && [...accepted].every(([n, a]) => pinned.get(n) === a)
  if (!same) {
    const missing = [...pinned.keys()].filter(n => !accepted.has(n)).sort()
    const extra = [...accepted.keys()].filter(n => !pinned.has(n)).sort()
    const skew = [...accepted.keys()].filter(n => pinned.has(n) && pinned.get(n) !== accepted.get(n)).sort().map(n => `${n} is ${accepted.get(n)} in the fixture and ${pinned.get(n)} in boards/boards.tsv`)
    die('the accepted board vocabulary of tests/fixtures/component-contracts/cases.json is not the set of boards this tree builds (boards/boards.tsv).'
      + (missing.length > 0 ? ` Built and not accepted: ${missing.join(', ')}.` : '')
      + (extra.length > 0 ? ` Accepted and not built: ${extra.join(', ')}.` : '')
      + (skew.length > 0 ? ` Architecture: ${skew.join('; ')}.` : '')
      + ' Rename in mica-core, release, move the pin here and copy the same files. A fixture naming a board this tree no longer has is a client that refuses a board this tree still builds, and the guest finds out at PID 1')
  }
  const collision = refused.filter(n => pinned.has(n))
  if (collision.length > 0) die(`cases.json lists ${collision.join(', ')} as REFUSED while boards/boards.tsv lists it as a board this tree builds. One of the two is wrong, and a guest would be the one to find out`)
  return `deploy-pool: the fixture's board vocabulary is this tree's: ${[...accepted.keys()].sort().join(', ')} accepted at their declared architectures, ${refused.join(', ')} refused`
}

/** The contract fixtures against mica-core's copy at the commit of its release; the two summary lines. */
export function check(): string[] {
  checkout('mica-core')
  const theirs = join(REPO_ROOT, '_out/src/mica-core/crates/mica-deploy/tests/component-contracts')
  const ours = join(REPO_ROOT, 'tests/fixtures/component-contracts')
  if (!existsSync(theirs)) die(`${theirs.slice(REPO_ROOT.length + 1)} does not exist at the mica-core commit of its release; the contract fixtures are expected there`)
  const a = files(ours), b = files(theirs)
  const differ = a.join('\n') !== b.join('\n') || a.some(f => Buffer.compare(readFileSync(join(ours, f)), readFileSync(join(theirs, f))) !== 0)
  if (differ) {
    for (const f of new Set([...a, ...b])) {
      const x = existsSync(join(ours, f)) ? readFileSync(join(ours, f)) : undefined, y = existsSync(join(theirs, f)) ? readFileSync(join(theirs, f)) : undefined
      if (x === undefined || y === undefined || Buffer.compare(x, y) !== 0) console.error(`${f}: ${x === undefined ? 'only in mica-core' : y === undefined ? 'only in this tree' : 'differs'}`)
    }
    die('tests/fixtures/component-contracts differs from mica-core\'s copy at the commit of its release (see the diff above). The files are one contract read by both sides; change them in mica-core, release, move the pins here, and copy the same files')
  }
  return ['deploy-pool: tests/fixtures/component-contracts matches mica-core crates/mica-deploy at the commit of its release', vocabulary(join(ours, 'cases.json'), join(REPO_ROOT, 'boards/boards.tsv'))]
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === '--lifecycle') { console.log(await lifecycle(argv[1] ?? '', argv[2] ?? '')); return 0 }
    if (argv[0] === '--check' && argv.length === 1) { for (const l of check()) console.log(l); return 0 }
    console.error('usage: bun src/cli.ts deploy-pool --lifecycle <amd64|arm64> <dir> | --check')
    return 1
  }
  catch (e) {
    if (e instanceof DeployPoolError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['SourceError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.constructor.name === 'SourceError' ? `source: error: ${e.message}` : e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
