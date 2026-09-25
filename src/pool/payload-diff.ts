// Are two pools the same payloads? The archives' versions carry the commit, so the comparison is of each
// package's data.tar members (path, type, mode, owner, sha256 or link target), not of the archive files.
//
//   bun src/cli.ts pool-payload-diff <pool A> <pool B>     (each: _out/debs-like, <arch>/pool/*.deb)
//
// One line per package (`same` or `DIFF`), then `RESULT: PASS` or `RESULT: FAIL (<n> package(s) differ)` and
// the matching status. The port of tools/pool-payload-diff.sh (deleted 2026-09-25) and its inline Python.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { payloadEntries } from './deb.ts'

type Member = [type: string, mode: number, uid: number, gid: number, digest: string]

async function members(archive: string): Promise<Map<string, Member>> {
  const out = new Map<string, Member>()
  for (const e of await payloadEntries(archive)) {
    const regular = e.type === '0' || e.type === '7'
    const digest = regular ? new Bun.CryptoHasher('sha256').update(e.body).digest('hex') : e.type === '2' ? e.linkname : ''
    out.set(e.name.replace(/\/+$/, ''), [e.type, e.mode, e.uid, e.gid, digest])
  }
  return out
}

function pools(root: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const arch of ['amd64', 'arm64']) {
    const d = join(root, arch, 'pool')
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).sort()) if (f.endsWith('.deb')) found.set(`${arch} ${f.split('_')[0]}`, join(d, f))
  }
  return found
}

const show = (m: Member | undefined) => m === undefined ? 'None' : `(${m.map(v => JSON.stringify(v)).join(', ')})`

/** The report lines and the number of packages that differ. */
export async function diff(a: string, b: string): Promise<{ lines: string[], bad: number }> {
  const pa = pools(a), pb = pools(b)
  const lines: string[] = []
  let bad = 0
  for (const key of [...new Set([...pa.keys(), ...pb.keys()])].sort()) {
    const fa = pa.get(key), fb = pb.get(key)
    if (fa === undefined || fb === undefined) { lines.push(`DIFF ${key}: only in ${fa === undefined ? 'B' : 'A'}`); bad++; continue }
    const ma = await members(fa), mb = await members(fb)
    const paths = [...new Set([...ma.keys(), ...mb.keys()])].sort()
    const differing = paths.filter(p => show(ma.get(p)) !== show(mb.get(p)))
    if (differing.length === 0) { lines.push(`same ${key} (${ma.size} members)`); continue }
    bad++
    for (const p of differing) lines.push(`DIFF ${key}: ${p}: ${show(ma.get(p))} -> ${show(mb.get(p))}`)
  }
  lines.push(`RESULT: ${bad === 0 ? 'PASS' : `FAIL (${bad} package(s) differ)`}`)
  return { lines, bad }
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 2) { console.error('usage: bun src/cli.ts pool-payload-diff <pool A> <pool B>'); return 2 }
  const { lines, bad } = await diff(argv[0]!, argv[1]!)
  for (const l of lines) console.log(l)
  return bad === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
