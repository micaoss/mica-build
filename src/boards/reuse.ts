// Whether a board component can be reused from this repository's latest published release that carries it:
// prints that component's manifest digest when the manifest's mica.inputs annotation equals <inputs>, and
// nothing otherwise. Everything is read anonymously, as a consumer would.
//
//   bun src/cli.ts reuse <board> <component> <inputs sha256> [<release tag to skip>]
//
// The latest release is the newest scoped release <scope>.<YYYYMMDD-HHMM> with a mica-build.lock asset whose
// lock carries a `board <board> <component> <arch> <reference>` row (a board-scoped release, or a
// product-scoped release of one of the board's products: both publish the board's components under their own
// tag, src/pool/registry.ts latestLockWith); the one being published is skipped. The port of tools/reuse.sh
// (deleted 2026-09-23), message for message.
import { latestLockWith, manifestDigest, Oci, registryLoad, repoName } from '../pool/registry.ts'

export class ReuseError extends Error {}

/** The reused manifest's digest, or '' when no release carries a component with these inputs. */
export async function reuse(board: string, component: string, inputs: string, skip = ''): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(inputs)) throw new ReuseError(`reuse: error: '${inputs}' is not a sha256`)
  const reg = registryLoad(), repo = repoName()
  const latest = await latestLockWith(reg, repo, 'board', board, component, skip)
  if (latest === undefined) return ''
  const reference = latest.lock.split('\n').map(l => l.split('\t')).find(r => r[0] === 'board' && r[1] === board && r[2] === component)?.[4] ?? ''
  if (reference === '') return ''
  const digest = reference.slice(reference.lastIndexOf('@') + 1)
  const anonymous = new Oci(reg, '')
  const m = await anonymous.manifestGet(anonymous.repo(repo), digest)
  if (m.status !== 200 || manifestDigest(m.body) !== digest) throw new ReuseError(`reuse: error: ${reference} of ${latest.label} does not read anonymously (HTTP ${m.status})`)
  const annotations = (JSON.parse(new TextDecoder().decode(m.body)) as { annotations?: Record<string, string> }).annotations ?? {}
  return (annotations['mica.inputs'] ?? '') === inputs ? digest : ''
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length < 3 || argv.length > 4) throw new ReuseError('reuse: error: usage: reuse <board> <component> <inputs sha256> [<release tag to skip>]')
    const digest = await reuse(argv[0]!, argv[1]!, argv[2]!, argv[3] ?? '')
    if (digest !== '') console.log(digest)
    return 0
  }
  catch (e) {
    if (e instanceof ReuseError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['RegistryError', 'BoardsError'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
