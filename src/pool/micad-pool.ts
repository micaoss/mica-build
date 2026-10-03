// What this tree reads out of the imported micad core component.
//
//   bun src/cli.ts micad-pool --openapi    the OpenAPI document into _out/debs/mica-apid/openapi.json
//   bun src/cli.ts micad-pool --source     the mica-core source at the pinned commit into _out/src/mica-core
//
//   reads   _out/debs/amd64/pool/micad_*_amd64.core.{json,img}   (fetched at the pin by src/cli.ts pool fetch)
//   writes  _out/debs/mica-apid/openapi.json
//           _out/src/mica-core/                        (src/cli.ts source)
//
// The management daemon and apid are built and released by micaoss/mica-core; this repository imports them as
// the micad core component (its item rows in locks/mica-core.lock), and mica-mqttd and mica-mqtt-broker through its
// package rows, and never sees that repository's tree. Two consumers still need something out of it:
//
// - tests/suites/apid-api/src/spec-pins.ts pins the API harness's phase literals against the OpenAPI document,
//   and the micad component ships that document as /usr/share/mica-apid/openapi.json -- what the running
//   apid answers, at the pinned commit, rather than a checkout that may be ahead of or behind the component
//   (--openapi);
// - verify's connd family reads the wifi reconcilers' contract (unit names, config paths, the sweep prefix) out
//   of micad/src/reconciler/ rather than restating it, so it needs that SOURCE at the pinned commit: --source
//   checks it out with src/cli.ts source, at the commit every micad pin names, into _out/src/mica-core. `make
//   os-verify-test` and `make os-verify` run it first; MICA_VERIFY_RECONCILER_DIR overrides the path.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkout } from '../locks/source.ts'
import { poolComponents } from './core-items.ts'
import { COMPONENT_TOOLS } from '../image/component-build.ts'
import { Toolbox } from '../image/toolbox.ts'
import { REPO_ROOT } from './producers.ts'

export class MicadPoolError extends Error {}

const die = (message: string): never => { throw new MicadPoolError(`error: ${message}`) }
const relative = (p: string) => (p.startsWith(`${REPO_ROOT}/`) ? p.slice(REPO_ROOT.length + 1) : p)

/** The OpenAPI document out of the amd64 micad core component; the summary line. */
export async function openapi(pool = process.env['MICA_POOL_DIR'] ?? join(REPO_ROOT, '_out/debs')): Promise<string> {
  const dir = join(pool, 'amd64/pool')
  const found = poolComponents(dir, 'amd64').filter(c => c.name === 'micad')
  if (found.length !== 1) die(`expected exactly one micad core component in ${dir}, found ${found.length}. locks/mica-core.lock pins it; fetch it with \`bash bin/bun.sh src/cli.ts pool fetch --arch amd64\` or \`make os-pool\``)
  const image = join(dir, found[0]!.image.file)
  const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [dir] })
  let body: string
  try { body = (await tb.must(['unsquashfs', '-cat', image, 'usr/share/mica-apid/openapi.json'])).stdout }
  finally { await tb.close() }
  mkdirSync(join(pool, 'mica-apid'), { recursive: true })
  writeFileSync(join(pool, 'mica-apid/openapi.json'), body, { mode: 0o644 })
  return `micad-pool: ${relative(pool)}/mica-apid/openapi.json from ${found[0]!.image.file}`
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
    if (e instanceof Error && ['SourceError', 'ToolError', 'Refused'].includes(e.constructor.name)) { console.error(e.constructor.name === 'SourceError' ? `source: error: ${e.message}` : e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
