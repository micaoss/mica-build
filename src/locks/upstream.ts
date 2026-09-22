// One field of a row of locks/upstream.lock, the third-party trees and archives the boards build from
// (mica:docs/design/release-lock.md section 4.1).
//
//   bun src/cli.ts upstream git <name> url|ref|commit
//   bun src/cli.ts upstream source <name> <amd64|arm64|all> version|sha256|url
//
// A missing row or field is an error naming it, so a build never runs on an empty pin. The port of
// tools/upstream.sh (deleted 2026-09-22), message for message; the lock is read through locks.ts's reader,
// so a malformed lock is refused here as everywhere.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkUpstream, Exit, LOCKS, Refused } from './locks.ts'

export class UpstreamError extends Error {}

const GIT_FIELDS: Record<string, number> = { url: 2, ref: 3, commit: 4 }
const SOURCE_FIELDS: Record<string, number> = { version: 3, sha256: 4, url: 5 }

export function field(argv: string[], locks = LOCKS): string {
  const lock = join(locks, 'upstream.lock')
  if (!existsSync(lock)) throw new UpstreamError(`${lock} does not exist`)
  const usage = 'usage: upstream git <name> url|ref|commit | source <name> <amd64|arm64|all> version|sha256|url'
  if (argv[0] === 'git' && argv.length === 3) {
    const [, name, what] = argv as [string, string, string]
    const col = GIT_FIELDS[what]
    if (col === undefined) throw new UpstreamError(`a git row has url, ref and commit, not ${what}`)
    const row = checkUpstream(lock).find(r => r[0] === 'git' && r[1] === name)
    const value = row?.[col]
    if (!value) throw new UpstreamError(`${lock} pins no git tree ${name}`)
    return value
  }
  if (argv[0] === 'source' && argv.length === 4) {
    const [, name, arch, what] = argv as [string, string, string, string]
    const col = SOURCE_FIELDS[what]
    if (col === undefined) throw new UpstreamError(`a source row has version, sha256 and url, not ${what}`)
    const row = checkUpstream(lock).find(r => r[0] === 'source' && r[1] === name && r[2] === arch)
    const value = row?.[col]
    if (!value) throw new UpstreamError(`${lock} pins no source ${name} for ${arch}`)
    return value
  }
  throw new UpstreamError(usage)
}

export function main(argv: string[]): number {
  try { console.log(field(argv)); return 0 }
  catch (e) {
    if (e instanceof UpstreamError) { console.error(`upstream: error: ${e.message}`); return 1 }
    if (e instanceof Exit || e instanceof Refused) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
