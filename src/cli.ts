// The one entry of the engine: `bun src/cli.ts <command> [arguments]`, reached
// through bin/bun.sh (which finds bun on the host or in the pinned image) and
// the Makefile. Each command is one module below, run as its own process with
// the arguments passed through untouched, so a module keeps reading its argv
// the way it always has and a caller cannot tell it from a direct `bun`.
//
// `test` runs `bun test` over the given paths (src/ and tests/gates/ when none
// are given; a suite's own unit tests run with the suite) and turns a run that
// asserted nothing red: `bun test` exits 0 on a file that declares no tests,
// and the count is what makes a run evidence.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

const COMMANDS: Record<string, { module: string, what: string }> = {
  'components': { module: 'src/image/component-cli.ts', what: 'build one signed component (root, kernel, firmware, deployment, image, archive, identity, ...)' },
  'release': { module: 'src/image/release-cli.ts', what: 'assemble or gate a product release' },
  'build-rootfs': { module: 'src/image/stages-cli.ts', what: 'run the composition stages of a product root' },
  'compare-roots': { module: 'src/image/compare-roots-cli.ts', what: 'compare two composed roots' },
  'seed-data': { module: 'src/image/qemu-seed-data.ts', what: 'seed a DATA image for a QEMU run' },
  'lint': { module: 'src/verify/lint-cli.ts', what: 'lint board definitions against the schema' },
  'verify': { module: 'src/verify/verify-cli.ts', what: 'verify an assembled image against the contract' },
  'smoke': { module: 'src/verify/smoke-cli.ts', what: 'execute the self-built artifacts in a product\'s factory root' },
  'smoke-negative': { module: 'src/verify/smoke-negative-cli.ts', what: 'break the root three ways and require each red' },
  'spec-pins': { module: 'tests/suites/apid-api/src/spec-pins.ts', what: 'check the apid suite\'s phase pins against the pinned OpenAPI document' },
  'locks': { module: 'src/locks/locks.ts', what: 'read and check locks/: check, lock, upstream, pins, release, image, rows, pin, checkout, verify' },
  'deb': { module: 'src/pool/deb.ts', what: 'read a Debian archive without dpkg: control [Field...], member <path> [<out>]' },
  'evidence-schema': { module: 'src/boards/evidence-schema.ts', what: 'check a board\'s evidence.json against the shape the release manifest reads' },
  'lineage': { module: 'src/rootfs/lineage.ts', what: 'write the source lineage record of a pool (rootfs/build.sh)' },
  'release-index': { module: 'src/release/index.ts', what: 'the Mica version index: its lock and mica-index.json (tools/release.sh index)' },
}

function usage(): never {
  console.error('usage: bun src/cli.ts <command> [arguments]\n')
  console.error('  test [paths or filters]   bun test over src/ and tests/, red when no test ran')
  for (const [name, c] of Object.entries(COMMANDS)) console.error(`  ${name.padEnd(26)}${c.what}`)
  process.exit(2)
}

function run(args: string[]): number {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (r.error) throw r.error
  return r.status ?? 1
}

function test(args: string[]): number {
  const targets = args.length > 0 ? args : ['src', 'tests/gates'].filter(d => existsSync(join(ROOT, d)))
  const r = spawnSync(process.execPath, ['test', ...targets], { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' })
  process.stdout.write(r.stdout); process.stderr.write(r.stderr)
  if (r.error) throw r.error
  if (r.status !== 0) return r.status ?? 1
  const ran = /^Ran (\d+) tests? across/m.exec(r.stdout + r.stderr)
  if (!ran || Number(ran[1]) === 0) {
    console.error('error: bun test exited 0 but ran no test; a run that asserted nothing is not evidence')
    return 1
  }
  return 0
}

const [command, ...rest] = Bun.argv.slice(2)
if (command === undefined || command === '--help' || command === '-h') usage()
if (command === 'test') process.exit(test(rest))
const c = COMMANDS[command]
if (c === undefined) { console.error(`error: unknown command ${command}`); usage() }
process.exit(run([c.module, ...rest]))
