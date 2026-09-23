// Initialize or validate development signing inputs without rotating identities.
//
//   bun src/cli.ts init-keys [--out DIRECTORY]        (default: meta/)
//
// An absent or empty directory is generated (src/boot/dev-keys.ts); an existing one is validated by
// stages/boot/init-keys-inner.sh in the mica-build-env base image, read-only, and never replaced. Two
// initializers of one directory serialize on a lock under .tmp/, so the second finds the first's output and
// validates it. The port of boot/init-keys.sh (deleted 2026-09-23), message for message.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolve as fromResolve } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { hostPath } from '../shared/host-path.ts'
import { DevKeysError, generate } from './dev-keys.ts'

export class InitKeysError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

const INNER = join(REPO_ROOT, 'stages/boot/init-keys-inner.sh')

/** The lock file two initializers of `output` serialize on. */
export function lockPath(output: string): string {
  return join(REPO_ROOT, '.tmp', `key-init-${createHash('sha256').update(output).digest('hex')}.lock`)
}

/** Initialize or validate `out`, holding its lock already; the directory's path. */
export function initialize(out: string): string {
  for (const tool of ['docker', 'flock'])
    if (Bun.spawnSync([tool, '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) throw new InitKeysError(`error: ${tool} is required`)
  const output = resolve(out)
  for (let parent = output; parent !== '/'; parent = dirname(parent))
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new InitKeysError('error: signing path contains a symlink')
  const image = fromResolve('mica-build-env:base', inputs())
  if (existsSync(output) && lstatSync(output).isDirectory() && readdirSync(output).length === 0) rmdirSync(output)
  if (!existsSync(output)) {
    try { generate(output) }
    catch (e) {
      if (e instanceof DevKeysError) throw new InitKeysError(e.message, e.code)
      throw e
    }
    console.log(`Development boot, content and metadata signing inputs created at ${output}`)
  }
  if (!existsSync(output) || !lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) throw new InitKeysError('error: invalid signing directory')
  const r = Bun.spawnSync(['docker', 'run', '--rm', '--label', 'ai-agent=true', '--name', `ai-agent-mica-key-init-${process.pid}`, '--network', 'traefik',
    '--mount', `type=bind,source=${hostPath(output)},target=/keys,readonly`,
    '-v', `${hostPath(INNER)}:/inner.sh:ro`, '--entrypoint', '/bin/bash', image, '/inner.sh'], { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new InitKeysError('error: signing inputs are incomplete, invalid or mismatched; existing identities were not replaced')
  return output
}

export async function main(argv: string[]): Promise<number> {
  try {
    let out = join(REPO_ROOT, 'meta'), locked = false
    const rest = [...argv]
    if (rest[0] === '--locked') { locked = true; rest.shift() }
    if (rest.length !== 0) {
      if (rest.length !== 2 || rest[0] !== '--out') throw new InitKeysError('usage: init-keys [--out DIRECTORY]', 2)
      out = rest[1]!
    }
    const output = resolve(out)
    if (!locked) {
      // The lock is held by flock around a second run of this module, which does the work.
      mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
      const r = Bun.spawnSync(['flock', '-x', lockPath(output), process.execPath, import.meta.path, '--locked', '--out', output], { stdout: 'inherit', stderr: 'inherit' })
      return r.exitCode
    }
    initialize(output)
    console.log(`Development signing inputs verified at ${output}`)
    return 0
  }
  catch (e) {
    if (e instanceof InitKeysError) { console.error(e.message); return e.code }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
