// The vectors this tree tests against, AGAINST THE COMMIT IT CLAIMS THEM FROM.
//
//   bun tests/gates/vectors-pin-check.ts       (make os-vectors-pin-check; gh, network)
//
// WHY A COPY NEEDED A GATE. tests/fixtures/release-lock/vectors/ was copied out of
// mica:docs/design/release-lock/vectors and then left alone. Measured on 2026-09-20 it was SIXTEEN FILES BEHIND,
// and every absence read as a pass: the release-lock test walks expected.tsv, and a vector that is not in the copy
// is not in the copy's expected.tsv either. A copy with no pin cannot go stale loudly.
//
// THIS GATE NEEDS THE NETWORK AND SAYS SO RATHER THAN SKIPPING: an absent `gh` is a failure here, not a quiet
// success. It is a command and not a *.test.ts so that the offline `bun test` of tests/gates never reaches it.
// The port of tests/gates/vectors-pin-check.sh (deleted 2026-09-25); the comparison lists what differs, as the
// shell's `diff -r` did, rather than a digest that says only THAT it differs.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { checkVectorsPin } from '../../src/locks/locks.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const PIN = join(REPO_ROOT, 'tests/fixtures/release-lock/vectors.pin')
const VECTORS = join(REPO_ROOT, 'tests/fixtures/release-lock/vectors')

function files(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out.set(relative(root, p), readFileSync(p)) } }
  walk(root)
  return out
}

/** The differences between two trees, one line each; empty when they are the same bytes. */
export function differences(upstream: string, copy: string): string[] {
  const a = files(upstream), b = files(copy)
  const out: string[] = []
  for (const f of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!b.has(f)) out.push(`Only in upstream: ${f}`)
    else if (!a.has(f)) out.push(`Only in the copy: ${f}`)
    else if (!a.get(f)!.equals(b.get(f)!)) out.push(`Files differ: ${f}`)
  }
  return out
}

function main(): number {
  const pin = checkVectorsPin(PIN)
  const repository = pin.REPOSITORY ?? '', commit = pin.COMMIT ?? ''
  if (Bun.which('gh') === null) { console.error(`error: gh is required to read ${repository} at ${commit}; this gate does not pass without looking`); return 1 }
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/vectors-pin.'))
  try {
    // The whole tree in one request, at the pinned commit rather than at a branch.
    const r = Bun.spawnSync(['gh', 'api', `repos/micaoss/${repository}/tarball/${commit}`], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) { console.error(`error: gh api could not read ${repository} at ${commit}: ${r.stderr.toString().trim()}`); return 1 }
    writeFileSync(join(work, 'tree.tar.gz'), r.stdout)
    if (Bun.spawnSync(['tar', '-xzf', join(work, 'tree.tar.gz'), '-C', work]).exitCode !== 0) { console.error('error: the tarball did not extract'); return 1 }
    const top = readdirSync(work).find(d => existsSync(join(work, d, 'docs/design/release-lock/vectors')))
    if (top === undefined) { console.error(`error: ${repository} at ${commit} carries no docs/design/release-lock/vectors`); return 1 }
    const diff = differences(join(work, top, 'docs/design/release-lock/vectors'), VECTORS)
    if (diff.length > 0) {
      for (const l of diff) console.log(l)
      console.error(`RESULT: FAIL (${relative(REPO_ROOT, VECTORS)} differs from ${repository} ${commit}; copy that tree or move the pin)`)
      return 1
    }
    console.log(`RESULT: PASS (${files(VECTORS).size} files identical to ${repository} ${commit})`)
    return 0
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

if (import.meta.main) process.exit(main())
