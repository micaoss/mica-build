// The source of an imported repository at the commit its release names.
//
//   bun src/cli.ts source <repository>[.<scope>]
//
//   reads   locks/ (the commit of the input's release row, and for an offline pin the CHECKOUT it names)
//   writes  _out/src/<repository>[.<scope>]/  a clean checkout of exactly that commit; a scoped input keeps its
//           scope in the directory name, because two scopes of one repository can name two commits
//
// The full 40-hex commit is the pin: git refuses a commit whose object does not hash to it, and the checkout is
// refused unless HEAD is that commit and the tree is clean. The repository is public; no credential is used.
// The port of tools/source.sh (deleted 2026-09-22), message for message.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Exit, inputs, Refused } from './locks.ts'

export class SourceError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, '../..')
const INPUT = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)?$/

function git(args: string[], quiet = false): { ok: boolean, out: string } {
  const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: quiet ? 'pipe' : 'inherit', timeout: 600000 })
  return { ok: r.exitCode === 0, out: r.stdout.toString() }
}

/** The release commit of an input and, for an offline pin, the checkout that stands in for the repository. */
export function pin(input: string): { repository: string, commit: string, url: string } {
  const records = inputs()
  const named = Object.keys(records).filter(n => n === input || n.split('.')[0] === input)
  if (named.length === 0) throw new SourceError(`locks/ pins no one release commit of ${input} (locks/ holds no input ${input})`)
  const commits = [...new Set(named.map(n => records[n]![1][0]![3]!))].sort()
  if (commits.length !== 1) throw new SourceError(`locks/ pins no one release commit of ${input} (the inputs ${named.sort().join(', ')} name ${commits.length} commits; name one input <repository>.<scope>)`)
  const repository = input.split('.')[0]!
  const commit = commits[0]!
  // An offline pin names its checkout, which is read, never written; locks.ts refuses one under CI.
  let url = ''
  if (named.some(n => records[n]![1][0]![2] === 'offline')) {
    const checkouts = [...new Set(Object.entries(records).filter(([n]) => n.split('.')[0] === repository).map(([, [v]]) => v.CHECKOUT ?? ''))].sort()
    if (checkouts.length !== 1 || checkouts[0] === '') throw new SourceError(`locks/ names no one offline checkout of ${repository} (found ${checkouts.length})`)
    url = checkouts[0]!
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new SourceError(`no 40-hex commit for ${repository}`)
  return { repository, commit, url: url || `https://github.com/micaoss/${repository}.git` }
}

export function checkout(input: string): string {
  if (!INPUT.test(input)) throw new SourceError('usage: source <repository>[.<scope>]')
  const { repository, commit, url } = pin(input)
  const dest = join(REPO_ROOT, '_out/src', input)
  if (!existsSync(join(dest, '.git'))) {
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    if (!git(['-C', dest, 'init', '--quiet']).ok) throw new SourceError(`git init failed in ${dest}`)
  }
  if (!git(['-C', dest, 'cat-file', '-e', `${commit}^{commit}`], true).ok
    && !git(['-C', dest, 'fetch', '--quiet', '--depth', '1', url, commit]).ok)
    throw new SourceError(`could not fetch ${commit} from ${url} (see git's message above)`)

  if (!git(['-C', dest, 'checkout', '--quiet', '--force', '--detach', commit]).ok) throw new SourceError(`could not check out ${commit} in ${dest}`)
  if (git(['-C', dest, 'rev-parse', 'HEAD']).out.trim() !== commit) throw new SourceError(`${dest} is not at ${commit} after checkout`)
  if (!git(['-C', dest, 'clean', '--quiet', '-fdx']).ok) throw new SourceError(`git clean failed in ${dest}`)
  if (git(['-C', dest, 'status', '--porcelain']).out !== '') throw new SourceError(`${dest} is not clean after checkout`)
  console.log(`source: ${repository} at ${commit} in ${dest.slice(REPO_ROOT.length + 1)}`)
  return dest
}

export function main(argv: string[]): number {
  try {
    if (argv.length !== 1) throw new SourceError('usage: source <repository>[.<scope>]')
    checkout(argv[0]!)
    return 0
  }
  catch (e) {
    if (e instanceof SourceError) { console.error(`source: error: ${e.message}`); return 1 }
    if (e instanceof Exit || e instanceof Refused) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
