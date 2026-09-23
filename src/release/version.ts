// The version stamp of this tree: <VERSION>+git<commit12>[.dirty]-1.
//
//   bun src/cli.ts version
//
// VERSION is the repository's one-line release version; the stamp names the commit the components were made
// from, and `.dirty` a tree no commit reproduces (mica-build-env RULES.md 6). The port of tools/version.sh
// (deleted 2026-09-23), message for message; the lineage writer and the composer read it in-process.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'

export class VersionError extends Error {}

function die(message: string): never {
  throw new VersionError(`version: error: ${message}`)
}

function git(root: string, args: string[]): { ok: boolean, out: string } {
  const r = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  return { ok: r.exitCode === 0, out: r.stdout.toString() }
}

/** The stamp of the checkout at `root`. */
export function version(root = REPO_ROOT): string {
  const file = join(root, 'VERSION')
  if (!existsSync(file)) die(`${file} does not exist`)
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l !== '')
  if (lines.length !== 1) die(`${file} must hold exactly one non-empty line`)
  const declared = lines[0]!.replace(/\s/g, '')
  if (!/^[0-9][A-Za-z0-9.~]*$/.test(declared)) die(`${file} declares '${declared}', which is not a Debian upstream version`)
  if (!git(root, ['rev-parse', '--git-dir']).ok) die(`${root} is not a git checkout, so there is no commit to stamp`)
  const commit = git(root, ['rev-parse', '--short=12', 'HEAD'])
  if (!commit.ok) die(`${root} has no commit to stamp`)
  const dirty = git(root, ['status', '--porcelain']).out === '' ? '' : '.dirty'
  return `${declared}+git${commit.out.trim()}${dirty}-1`
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 0) die('usage: bun src/cli.ts version')
    console.log(version())
    return 0
  }
  catch (e) {
    if (e instanceof VersionError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
