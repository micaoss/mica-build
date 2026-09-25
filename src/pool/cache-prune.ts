// Reduce the download caches to what the current pins name before CI saves them.
//
//   bun src/cli.ts cache-prune
//
// _out/cache/pool keeps the archives `pool rows` names, _out/cache/debian the upstream archives of
// locks/mica-system-base.lock and their control fields, _out/cache/oci the manifests of the pool and board rows
// of locks/, _out/cache/boards the layers of those board artifacts, and _out/cache/base-status the root statuses
// of the mica-system-base rootfs rows; anything else -- a superseded pin, a partial download -- is removed, so a
// saved cache holds only third-party inputs of this commit. Every kept file is still hashed again by the step
// that reads it. The port of tools/cache-prune.sh (deleted 2026-09-25), message for message.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { REPO_ROOT, rows as lockRows } from '../locks/locks.ts'
import { controlPath } from '../rootfs/base-packages.ts'
import { rows as poolRows } from './pool.ts'

const CACHE = join(REPO_ROOT, '_out/cache')

/** Remove every entry of `dir` whose name is not in `keep`; the report line, or nothing when there is no dir. */
export function prune(dir: string, keep: Set<string>): string | undefined {
  if (!existsSync(dir)) return undefined
  let removed = 0
  for (const f of readdirSync(dir)) {
    if (keep.has(f)) continue
    rmSync(join(dir, f), { recursive: true, force: true })
    removed++
  }
  return `cache-prune: ${dir.slice(REPO_ROOT.length + 1)}: ${removed} removed, ${readdirSync(dir).length} kept`
}

/** The board artifact manifests of the OCI cache: a reused board component's manifest no lock names. */
function boardManifests(dir: string): { name: string, layers: string[] }[] {
  if (!existsSync(dir)) return []
  const out: { name: string, layers: string[] }[] = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue
    let m: { artifactType?: string, layers?: { digest: string }[] }
    try { m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as typeof m }
    catch { continue }
    if ((m.artifactType ?? '').startsWith('application/vnd.mica.board.')) out.push({ name: f, layers: (m.layers ?? []).map(l => l.digest.replace(/^sha256:/, '')) })
  }
  return out
}

/** The Base archives of the pinned rows and their control fields, by the names base-packages gives them. */
export function debianKeep(shas: string[]): Set<string> {
  return new Set(shas.flatMap(sha => [`${sha}.deb`, basename(controlPath(sha))]))
}

export async function cachePrune(cache = CACHE): Promise<string[]> {
  const lines: string[] = []
  const say = (l: string | undefined) => { if (l !== undefined) lines.push(l) }
  say(prune(join(cache, 'pool'), new Set((await poolRows()).map(r => `${r[3]}.deb`))))
  say(prune(join(cache, 'debian'), debianKeep(lockRows('upstream', 'mica-system-base').map(r => r[4]!))))
  // The pool manifests the locks name, and the manifests of reused board components (board-pool reads them by
  // the digest the latest release publishes, which no lock here names): a component manifest is kept when it is
  // the one a cached board layer came from, so the two caches are pruned together.
  const boards = boardManifests(join(cache, 'oci'))
  say(prune(join(cache, 'oci'), new Set([...lockRows('pool').map(r => `${r[2]!.replace(/^.*@/, '')}.json`), ...boards.map(b => b.name)])))
  say(prune(join(cache, 'boards'), new Set(boardManifests(join(cache, 'oci')).flatMap(b => b.layers))))
  say(prune(join(cache, 'base-status'), new Set(lockRows('image', 'mica-system-base').filter(r => r[3] !== 'index').map(r => r[4]!.replace(/^.*@/, '')))))
  return lines
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 0) { console.error('usage: bun src/cli.ts cache-prune'); return 64 }
  for (const l of await cachePrune()) console.log(l)
  return 0
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
