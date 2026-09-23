// The build outputs a workflow job hands to the next, as tar files with unique names, so a download of one
// artifact and of several look the same.
//
//   bun src/cli.ts ci-outputs pack <name> <path under _out>...   _out/<name>.tar holding those paths
//   bun src/cli.ts ci-outputs unpack <dir> <expected name>...    every <name>.tar in <dir> into _out/; each
//                                                               expected one must be there
//
// build-boards.yml and release.yml upload each tar as the artifact <name> and download with merge-multiple,
// which puts every tar flat in one directory whether one artifact matched or many. A missing expected tar is
// an error, never taken for a reused component or an absent architecture. The port of tools/ci-outputs.sh
// (deleted 2026-09-23), message for message.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'

export class CiOutputsError extends Error {}

function die(message: string): never {
  throw new CiOutputsError(`ci-outputs: error: ${message}`)
}

function tar(args: string[]): void {
  const r = Bun.spawnSync(['tar', ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) die(`tar ${args.join(' ')} failed: ${r.stderr.toString().trim()}`)
}

export function pack(name: string, paths: string[]): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) die(`'${name}' is not an artifact name`)
  for (const p of paths) if (!existsSync(join(REPO_ROOT, '_out', p))) die(`_out/${p} does not exist`)
  tar(['-cf', `_out/${name}.tar`, '-C', '_out', ...paths])
  return `ci-outputs: _out/${name}.tar (${paths.join(' ')})`
}

export function unpack(dir: string, expected: string[]): string[] {
  for (const name of expected) if (!existsSync(join(dir, `${name}.tar`))) die(`${dir}/${name}.tar is missing; the job that builds ${name} did not hand it over`)
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const tars = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.tar')).sort() : []
  const out: string[] = []
  for (const t of tars) {
    tar(['-xf', join(dir, t), '-C', '_out'])
    out.push(`ci-outputs: ${t} into _out/`)
  }
  if (tars.length === 0) die(`${dir} holds no output tar`)
  return out
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'pack' && argv.length >= 3) console.log(pack(argv[1]!, argv.slice(2)))
    else if (argv[0] === 'pack') die('usage: ci-outputs pack <name> <path under _out>...')
    else if (argv[0] === 'unpack' && argv.length >= 2) for (const l of unpack(argv[1]!, argv.slice(2))) console.log(l)
    else if (argv[0] === 'unpack') die('usage: ci-outputs unpack <dir> <expected name>...')
    else die('usage: ci-outputs pack <name> <path>... | unpack <dir> <expected name>...')
    return 0
  }
  catch (e) {
    if (e instanceof CiOutputsError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
