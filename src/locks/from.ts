// Resolve an image named in locks/ to its digest reference, and refuse everything that must not reach a FROM
// or a docker run.
//
//   bun src/cli.ts from --ref mica-build-env:base
//       -> ghcr.io/micaoss/mica-build-env:base.<release>@sha256:...
//   bun src/cli.ts from --ref mica-system-base:rootfs@amd64
//       -> ghcr.io/micaoss/mica-system-base@sha256:...
//   bun src/cli.ts from MICA_IMAGE_UBUNTU_2404=upstream:ubuntu:24.04 [...]
//       -> --build-arg
//          MICA_IMAGE_UBUNTU_2404=docker.io/library/ubuntu:24.04@sha256:...
//   bun src/cli.ts from --check
//       -> every image row of locks/ resolves, print nothing
//
// A selector is <source>:<name>[@<platform>], an image row of locks/ (mica:docs/design/release-lock.md 1.2.1):
// a repository image names its release lock's row (the index unless a platform is given), and an upstream
// image names a row of locks/mica-build-env.lock, the only place a third-party image comes from. locks.ts
// checks locks/ and answers; this builds and pulls nothing. The port of tools/from.sh (deleted 2026-09-22),
// message for message; where the shell spawned `locks image` once per selector, this reads locks/ once.
import { Exit, image, inputs, Refused, type Records } from './locks.ts'

export class FromError extends Error {}

const SELECTOR = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._/:-]*(@(index|amd64|arm64|386))?$/
const PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/

/** The one reference a selector names, or a refusal naming the selector. */
export function resolve(selector: string, records: Records): string {
  if (!SELECTOR.test(selector)) throw new FromError(`'${selector}' is not an image selector <source>:<name>[@<platform>]`)
  try { return image(selector, records) }
  catch (e) {
    if (e instanceof Exit) throw new FromError(`no image row for ${selector} in locks/ (${e.message})`)
    throw e
  }
}

/** Every image row of locks/, resolved through the same path a caller takes. */
export function check(records: Records): void {
  for (const [, [, lock]] of Object.entries(records))
    for (const row of lock) if (row[0] === 'image') resolve(`${row[1]}:${row[2]}@${row[3]}`, records)
}

/** `--build-arg` lines for ARG=selector pairs, as docker buildx build takes them. */
export function buildArgs(pairs: string[], records: Records): string[] {
  const out: string[] = []
  for (const pair of pairs) {
    const m = PAIR.exec(pair)
    if (m === null) throw new FromError(`'${pair}' is not <ARG_NAME>=<selector>`)
    out.push('--build-arg', `${m[1]}=${resolve(m[2]!, records)}`)
  }
  return out
}

export function main(argv: string[]): number {
  try {
    if (argv[0] === '--check') {
      if (argv.length !== 1) throw new FromError('--check takes no other argument')
      check(inputs())
    }
    else if (argv[0] === '--ref') {
      if (argv.length !== 2) throw new FromError('--ref takes exactly one selector')
      console.log(resolve(argv[1]!, inputs()))
    }
    else if (argv.length === 0) { throw new FromError('usage: from --ref <selector> | <ARG>=<selector> [...] | --check') }
    else { console.log(buildArgs(argv, inputs()).join('\n')) }
    return 0
  }
  catch (e) {
    if (e instanceof FromError) { console.error(`from: error: ${e.message}`); return 1 }
    if (e instanceof Exit || e instanceof Refused) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
