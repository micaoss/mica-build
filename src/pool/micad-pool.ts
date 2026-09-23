// What this tree reads out of the imported mica-apid archive.
//
//   bun src/cli.ts micad-pool --openapi    the OpenAPI document into _out/debs/mica-apid/openapi.json
//   bun src/cli.ts micad-pool --source     the mica-core source at the pinned commit into _out/src/mica-core
//
//   reads   _out/debs/amd64/pool/mica-apid_*.deb   (fetched at the pin by src/cli.ts pool fetch)
//   writes  _out/debs/mica-apid/openapi.json
//           _out/src/mica-core/                        (src/cli.ts source)
//
// The management daemon and apid are built and released by micaoss/mica-core; this repository imports micad,
// mica-apid, mica-mqttd and mica-mqtt-broker through the package rows of locks/mica-core.lock and never sees
// that repository's tree. Two consumers still need something out of it:
//
// - tests/suites/apid-api/src/spec-pins.ts pins the API harness's phase literals against the OpenAPI document,
//   and the mica-apid archive ships that document as /usr/share/mica-apid/openapi.json -- what the installed
//   apid answers, at the pinned commit, rather than a checkout that may be ahead of or behind the archive
//   (--openapi);
// - verify's connd family reads the wifi reconcilers' contract (unit names, config paths, the sweep prefix) out
//   of micad/src/reconciler/ rather than restating it, so it needs that SOURCE at the pinned commit: --source
//   checks it out with src/cli.ts source, at the commit every micad pin names, into _out/src/mica-core. `make
//   os-verify-test` and `make os-verify` run it first; MICA_VERIFY_RECONCILER_DIR overrides the path.
// The port of tools/micad-pool.sh (deleted 2026-09-23), message for message.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkout } from '../locks/source.ts'
import { payloadMember } from './deb.ts'
import { REPO_ROOT } from './producers.ts'

export class MicadPoolError extends Error {}

const die = (message: string): never => { throw new MicadPoolError(`error: ${message}`) }
const relative = (p: string) => (p.startsWith(`${REPO_ROOT}/`) ? p.slice(REPO_ROOT.length + 1) : p)

/** The OpenAPI document out of the amd64 mica-apid archive; the summary line. */
export async function openapi(pool = process.env['MICA_POOL_DIR'] ?? join(REPO_ROOT, '_out/debs')): Promise<string> {
  const dir = join(pool, 'amd64/pool')
  const found = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('mica-apid_') && f.endsWith('_amd64.deb')).sort() : []
  if (found.length !== 1) die(`expected exactly one mica-apid archive in ${dir}, found ${found.length}. locks/mica-core.lock pins it; fetch it with \`bash bin/bun.sh src/cli.ts pool fetch --arch amd64\` or \`make os-pool\``)
  const { body, mode } = await payloadMember(join(dir, found[0]!), 'usr/share/mica-apid/openapi.json')
  mkdirSync(join(pool, 'mica-apid'), { recursive: true })
  writeFileSync(join(pool, 'mica-apid/openapi.json'), body)
  chmodSync(join(pool, 'mica-apid/openapi.json'), mode & 0o777)
  return `micad-pool: ${relative(pool)}/mica-apid/openapi.json from ${found[0]}`
}

/** The mica-core source at its release commit, with the reconcilers verify reads. */
export function source(): string {
  const dest = checkout('mica-core')
  if (!existsSync(join(dest, 'crates/micad/src/reconciler'))) die('_out/src/mica-core/crates/micad/src/reconciler does not exist at the mica-core commit of its release; verify\'s connd family reads the reconcilers\' contract out of it')
  return dest
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === '--openapi' && argv.length === 1) { console.log(await openapi()); return 0 }
    if (argv[0] === '--source' && argv.length === 1) { source(); return 0 }
    console.error('usage: bun src/cli.ts micad-pool --openapi | --source')
    return 1
  }
  catch (e) {
    if (e instanceof MicadPoolError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['SourceError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.constructor.name === 'SourceError' ? `source: error: ${e.message}` : e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
