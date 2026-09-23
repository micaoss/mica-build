// Generate isolated development inputs; no existing directory is overwritten.
//
//   bun src/cli.ts dev-keys --out NEW_DIRECTORY
//
// The three identities (boot, verity, updates) are minted by stages/boot/dev-keys-inner.sh in the
// mica-build-env base image, as the calling user, into the directory this creates; the public manifest of
// meta.example is installed beside them. The port of boot/dev-keys.sh (deleted 2026-09-23), message for
// message; the key initializer calls generate() in-process.
import { chmodSync, copyFileSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolve as fromResolve } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { hostPath } from '../shared/host-path.ts'

export class DevKeysError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

const INNER = join(REPO_ROOT, 'stages/boot/dev-keys-inner.sh')

/** Whether a path exists as anything, a dangling symlink included. */
export function present(path: string): boolean {
  try { lstatSync(path); return true }
  catch { return false }
}

/** Mint the development inputs into `out`, which must not exist; its path. */
export function generate(out: string): string {
  if (Bun.spawnSync(['docker', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) throw new DevKeysError('error: docker is required')
  const output = resolve(out)
  if (present(output)) throw new DevKeysError('error: key output already exists')
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output, { mode: 0o700 })
  chmodSync(output, 0o700)
  const image = fromResolve('mica-build-env:base', inputs())
  const r = Bun.spawnSync(['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', 'traefik',
    '--user', `${process.getuid!()}:${process.getgid!()}`, '-v', `${hostPath(output)}:/keys`,
    '-v', `${hostPath(INNER)}:/inner.sh:ro`, '--entrypoint', '/bin/bash', image, '/inner.sh'], { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new DevKeysError('error: the key generator failed (see above)')
  copyFileSync(join(REPO_ROOT, 'meta.example/updates/manifest.json'), join(output, 'updates/manifest.json'))
  chmodSync(join(output, 'updates/manifest.json'), 0o644)
  return output
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 2 || argv[0] !== '--out') throw new DevKeysError('usage: dev-keys --out NEW_DIRECTORY', 2)
    const output = generate(argv[1]!)
    console.log(`Development boot, content and metadata signing inputs created at ${output}`)
    return 0
  }
  catch (e) {
    if (e instanceof DevKeysError) { console.error(e.message); return e.code }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
