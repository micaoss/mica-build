// The lock and pin readers (src/locks/locks.ts) against the vectors of mica:docs/design/release-lock.md section 9,
// copied unchanged into tests/fixtures/release-lock/vectors/: every lock, upstream, pins and vectors-pin vector is
// valid, or refused by exactly its rule, as expected.tsv lists; and every such vector file is listed, so none is
// skipped silently. The repos/ vectors belong to a repos reader this tree does not have. The port of
// tests/gates/release-lock-test.sh (deleted 2026-09-25), vector for vector (make locks-verify).
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { checkLock, checkPins, checkUpstream, checkVectorsPin, Refused } from '../../src/locks/locks.ts'

const VECTORS = resolve(import.meta.dir, '../fixtures/release-lock/vectors')

/** `valid`, `refused <rule>`, or '' for a refusal that is not a rule (the CLI printed nothing then). */
function verdict(path: string, mode: string): string {
  const file = join(VECTORS, path)
  try {
    if (path.startsWith('lock/')) checkLock(file)
    else if (path.startsWith('upstream/')) checkUpstream(file)
    else if (path.startsWith('pins/')) checkPins(file, mode)
    else if (path.startsWith('vectors-pin/')) checkVectorsPin(file)
    else return `no reader for ${path}`
    return 'valid'
  }
  catch (e) {
    if (e instanceof Refused) return `refused ${e.rule}`
    return ''
  }
}

const rows = readFileSync(join(VECTORS, 'expected.tsv'), 'utf8').split('\n')
  .filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t') as [string, string, string, string])
  .filter(([path]) => !path.startsWith('repos/'))

test.each(rows.map(r => [r[0], r] as const))('%s', (_path, [path, result, rule, mode]) => {
  expect(verdict(path, mode ?? '')).toBe(result === 'valid' ? 'valid' : `refused ${rule}`)
})

test('every lock, upstream and vectors-pin vector is listed in expected.tsv', () => {
  const listed = new Set(readFileSync(join(VECTORS, 'expected.tsv'), 'utf8').split('\n').map(l => l.split('\t')[0]))
  const files: string[] = []
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(relative(VECTORS, p)) } }
  walk(VECTORS)
  const unlisted = files.filter(f => /^(lock\/.*\.lock|upstream\/.*\.lock|vectors-pin\/.*\.pin)$/.test(f) && !listed.has(f))
  expect(unlisted).toEqual([])
  expect(rows.length).toBeGreaterThan(40)
})
