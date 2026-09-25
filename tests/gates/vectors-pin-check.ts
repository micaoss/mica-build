// The vectors this tree tests against, AGAINST THE COMMIT IT CLAIMS THEM FROM.
//
//   bun tests/gates/vectors-pin-check.ts       (make os-vectors-pin-check; network)
//
// WHY A COPY NEEDED A GATE. tests/fixtures/release-lock/vectors/ was copied out of
// mica:docs/design/release-lock/vectors and then left alone. Measured on 2026-09-20 it was SIXTEEN FILES BEHIND,
// and every absence read as a pass: the release-lock test walks expected.tsv, and a vector that is not in the copy
// is not in the copy's expected.tsv either. A copy with no pin cannot go stale loudly.
//
// THIS GATE NEEDS THE NETWORK AND SAYS SO RATHER THAN SKIPPING: an unreachable API is a failure here, not a quiet
// success. It is a command and not a *.test.ts so that the offline `bun test` of tests/gates never reaches it. The
// tarball comes from the REST API in-process, with GH_TOKEN when it is set (mica is public, so a read needs none):
// bin/bun.sh's container route has no gh, and the shell's `gh api` made the gate red on CI the day it was ported.
// The port of tests/gates/vectors-pin-check.sh (deleted 2026-09-25); the comparison lists what differs, as the
// shell's `diff -r` did, rather than a digest that says only THAT it differs.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { checkVectorsPin } from '../../src/locks/locks.ts'
import { tarEntries } from '../../src/pool/deb.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const PIN = join(REPO_ROOT, 'tests/fixtures/release-lock/vectors.pin')
const VECTORS = join(REPO_ROOT, 'tests/fixtures/release-lock/vectors')
const UPSTREAM = 'docs/design/release-lock/vectors/'

function files(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.set(relative(root, p), readFileSync(p)) } }
  walk(root)
  return out
}

/** The differences between two trees, one line each; empty when they are the same bytes. */
export function differences(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string[] {
  const out: string[] = []
  for (const f of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!b.has(f)) out.push(`Only in upstream: ${f}`)
    else if (!a.has(f)) out.push(`Only in the copy: ${f}`)
    else if (!Buffer.from(a.get(f)!).equals(Buffer.from(b.get(f)!))) out.push(`Files differ: ${f}`)
  }
  return out
}

/** The vectors tree of a GitHub tarball (one top directory, then the repository), by path under the vectors. */
export function upstreamVectors(tarball: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const e of tarEntries(Bun.gunzipSync(new Uint8Array(tarball)))) {
    const path = e.name.replace(/^[^/]+\//, '')
    if ((e.type === '0' || e.type === '') && path.startsWith(UPSTREAM)) out.set(path.slice(UPSTREAM.length), e.body)
  }
  return out
}

async function main(): Promise<number> {
  const pin = checkVectorsPin(PIN)
  const repository = pin.REPOSITORY ?? '', commit = pin.COMMIT ?? ''
  // The whole tree in one request, at the pinned commit rather than at a branch.
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`
  let tarball: Uint8Array
  try {
    const r = await fetch(`https://api.github.com/repos/micaoss/${repository}/tarball/${commit}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!r.ok) { console.error(`error: the GitHub API could not read ${repository} at ${commit}: HTTP ${r.status}; this gate does not pass without looking`); return 1 }
    tarball = new Uint8Array(await r.arrayBuffer())
  }
  catch (e) { console.error(`error: the GitHub API could not be reached to read ${repository} at ${commit} (${(e as Error).message}); this gate does not pass without looking`); return 1 }
  const upstream = upstreamVectors(tarball)
  if (upstream.size === 0) { console.error(`error: ${repository} at ${commit} carries no ${UPSTREAM}`); return 1 }
  const diff = differences(upstream, files(VECTORS))
  if (diff.length > 0) {
    for (const l of diff) console.log(l)
    console.error(`RESULT: FAIL (${relative(REPO_ROOT, VECTORS)} differs from ${repository} ${commit}; copy that tree or move the pin)`)
    return 1
  }
  console.log(`RESULT: PASS (${upstream.size} files identical to ${repository} ${commit})`)
  return 0
}

if (import.meta.main) process.exit(await main())
