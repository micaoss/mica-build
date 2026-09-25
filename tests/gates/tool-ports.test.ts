// The small drivers of tools/ that became src/ modules on 2026-09-25, each over a fixture: the payload
// comparison of two pools (src/pool/payload-diff.ts), the cache pruning (src/pool/cache-prune.ts), a board's
// own kernel requirements (src/boards/kernel-config.ts) and the clone of a board (src/boards/new-board.ts).
// None of the four shell scripts had a test; each case here is a behaviour the script had, refusals included.
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prune } from '../../src/pool/cache-prune.ts'
import { diff } from '../../src/pool/payload-diff.ts'
import { configOf, required } from '../../src/boards/kernel-config.ts'
import { newBoard } from '../../src/boards/new-board.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'tool-ports-test.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

type Entry = { name: string, type?: '0' | '2' | '5', mode?: number, uid?: number, body?: string, link?: string }

function tar(entries: Entry[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const e of entries) {
    const h = new Uint8Array(512), body = new TextEncoder().encode(e.body ?? '')
    const put = (at: number, s: string) => h.set(new TextEncoder().encode(s), at)
    const octal = (at: number, len: number, n: number) => put(at, n.toString(8).padStart(len - 1, '0'))
    put(0, e.name); octal(100, 8, e.mode ?? 0o644); octal(108, 8, e.uid ?? 0); octal(116, 8, 0)
    octal(124, 12, e.type === '0' || e.type === undefined ? body.length : 0); octal(136, 12, 0)
    put(156, e.type ?? '0'); put(157, e.link ?? ''); put(257, 'ustar\x0000')
    h.fill(32, 148, 156)
    octal(148, 7, h.reduce((a, b) => a + b, 0))
    blocks.push(h)
    if ((e.type ?? '0') === '0') { const b = new Uint8Array(Math.ceil(body.length / 512) * 512); b.set(body); blocks.push(b) }
  }
  blocks.push(new Uint8Array(1024))
  const out = new Uint8Array(blocks.reduce((a, b) => a + b.length, 0))
  let at = 0
  for (const b of blocks) { out.set(b, at); at += b.length }
  return out
}

function deb(path: string, entries: Entry[]): void {
  const members: [string, Uint8Array][] = [['debian-binary', new TextEncoder().encode('2.0\n')], ['control.tar', tar([{ name: './control', body: 'Package: x\n' }])], ['data.tar', tar(entries)]]
  const parts: Uint8Array[] = [new TextEncoder().encode('!<arch>\n')]
  for (const [name, body] of members) {
    parts.push(new TextEncoder().encode(`${name}/`.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(body.length).padEnd(10) + '`\n'))
    parts.push(body)
    if (body.length % 2 === 1) parts.push(new TextEncoder().encode('\n'))
  }
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.concat(parts))
}

describe('pool-payload-diff', () => {
  const payload: Entry[] = [{ name: './usr/', type: '5', mode: 0o755 }, { name: './usr/bin/tool', mode: 0o755, body: 'binary\n' }, { name: './usr/bin/alias', type: '2', link: 'tool' }]
  test('two pools whose archives differ only in version are the same payloads', async () => {
    deb(join(T, 'same/a/amd64/pool/tool_1.0+gitaaaa_amd64.deb'), payload)
    deb(join(T, 'same/b/amd64/pool/tool_1.0+gitbbbb_amd64.deb'), payload)
    const r = await diff(join(T, 'same/a'), join(T, 'same/b'))
    expect(r).toEqual({ lines: ['same amd64 tool (3 members)', 'RESULT: PASS'], bad: 0 })
  })
  test('a changed body, mode, owner or link target is a DIFF naming the member; a package on one side only is one too', async () => {
    deb(join(T, 'diff/a/amd64/pool/tool_1_amd64.deb'), payload)
    deb(join(T, 'diff/b/amd64/pool/tool_1_amd64.deb'), [payload[0]!, { ...payload[1]!, body: 'other\n' }, { ...payload[2]!, link: 'elsewhere' }])
    deb(join(T, 'diff/a/arm64/pool/owner_1_arm64.deb'), [{ name: './f', body: 'x' }])
    deb(join(T, 'diff/b/arm64/pool/owner_1_arm64.deb'), [{ name: './f', body: 'x', uid: 1000, mode: 0o600 }])
    deb(join(T, 'diff/b/arm64/pool/extra_1_arm64.deb'), [{ name: './f', body: 'x' }])
    const r = await diff(join(T, 'diff/a'), join(T, 'diff/b'))
    expect(r.bad).toBe(3)
    expect(r.lines).toContain('DIFF arm64 extra: only in B')
    expect(r.lines.some(l => l.startsWith('DIFF amd64 tool: ./usr/bin/tool: ("0", 493, 0, 0, "'))).toBe(true)
    expect(r.lines).toContain('DIFF amd64 tool: ./usr/bin/alias: ("2", 420, 0, 0, "tool") -> ("2", 420, 0, 0, "elsewhere")')
    expect(r.lines).toContain('DIFF arm64 owner: ./f: ("0", 420, 0, 0, "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881") -> ("0", 384, 1000, 0, "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881")')
    expect(r.lines.at(-1)).toBe('RESULT: FAIL (3 package(s) differ)')
  })
})

describe('cache-prune', () => {
  test('keeps exactly the named entries, reports both counts, and passes over a cache that does not exist', () => {
    const d = join(REPO_ROOT, 'tmp', `tool-ports-cache.${process.pid}`)
    mkdirSync(join(d, 'partial'), { recursive: true })
    for (const f of ['a.deb', 'b.deb', 'stale.deb']) writeFileSync(join(d, f), f)
    try {
      expect(prune(d, new Set(['a.deb', 'b.deb', 'absent.deb']))).toBe(`cache-prune: tmp/tool-ports-cache.${process.pid}: 2 removed, 2 kept`)
      expect(['a.deb', 'b.deb', 'stale.deb', 'partial'].map(f => existsSync(join(d, f)))).toEqual([true, true, false, false])
      expect(prune(join(d, 'absent'), new Set())).toBeUndefined()
    }
    finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('kernel-config-test', () => {
  const root = join(T, 'kernel')
  const board = (name: string, config: string, req?: string, bsp?: string) => {
    mkdirSync(join(root, 'boards', name, 'kernel/config'), { recursive: true })
    writeFileSync(join(root, 'boards', name, 'kernel/config', bsp === undefined ? `${name}.config` : 'k.config'), config)
    if (req !== undefined) writeFileSync(join(root, 'boards', name, 'kernel/config', `${name}.required`), req)
    if (bsp !== undefined) writeFileSync(join(root, 'boards', name, 'bsp.env'), bsp)
  }
  test('a UEFI board reads its own config and Dockerfile, a FIT board the KERNEL_CONFIG its bsp.env names', () => {
    board('u', 'CONFIG_A=y\n'); board('f', 'CONFIG_A=y\n', undefined, 'X=1\nKERNEL_CONFIG=k.config\n')
    expect(configOf('u', root)).toEqual({ config: 'boards/u/kernel/config/u.config', gate: 'boards/u/kernel/Dockerfile' })
    expect(configOf('f', root)).toEqual({ config: 'boards/f/kernel/config/k.config', gate: 'boards/f/kernel/configure.sh' })
    board('n', '', undefined, 'X=1\n')
    expect(() => configOf('n', root)).toThrow('boards/n/bsp.env declares no KERNEL_CONFIG')
  })
  test('builtin wants =y, runtime =y or =m; what is not held is named with the value it has', () => {
    board('r', 'CONFIG_A=y\nCONFIG_B=m\nCONFIG_C=m\n# CONFIG_D is not set\n', '# guest\nbuiltin A\nruntime B\n\nbuiltin C\nruntime D\n')
    expect(() => required('r', 'boards/r/kernel/config/r.config', root)).toThrow('FAIL: r: boards/r/kernel/config/r.config does not hold what boards/r/kernel/config/r.required requires: builtin:C=m runtime:D=')
    board('ok', 'CONFIG_A=y\nCONFIG_B=m\n', 'builtin A\nruntime B\n')
    expect(required('ok', 'boards/ok/kernel/config/ok.config', root)).toBe('PASS: ok: all 2 symbols of boards/ok/kernel/config/ok.required are held')
    expect(required('u', 'boards/u/kernel/config/u.config', root)).toBeUndefined()
  })
  test('a kind that is neither, and a list that asserts nothing, are refused', () => {
    board('k', 'CONFIG_A=y\n', 'module A\n')
    expect(() => required('k', 'boards/k/kernel/config/k.config', root)).toThrow('boards/k/kernel/config/k.required: \'module\' is not builtin or runtime')
    board('e', 'CONFIG_A=y\n', '# nothing\n')
    expect(() => required('e', 'boards/e/kernel/config/e.config', root)).toThrow('boards/e/kernel/config/e.required lists no symbol')
  })
})

describe('new-board', () => {
  const root = join(T, 'new')
  mkdirSync(join(root, 'boards'), { recursive: true })
  cpSync(join(REPO_ROOT, 'boards/uefi-x64'), join(root, 'boards/uefi-x64'), { recursive: true, verbatimSymlinks: true })
  mkdirSync(join(root, 'boards/uefi-x64/_out'), { recursive: true })
  symlinkSync('../../meta', join(root, 'boards/uefi-x64/meta'))
  test('the clone carries the name rewritten, a fresh identity code and no outputs, evidence or signing link', () => {
    const before = readFileSync(join(root, 'boards/uefi-x64/board.env'), 'utf8')
    const old = /^DISK_GUID=[0-9A-F]{8}-([0-9A-F]{4})-/m.exec(before)![1]!
    const message = newBoard('x64-clone', 'uefi-x64', root, 'ABCD', '0123ABCD')
    expect(message.split('\n')[0]).toBe(`new-board: x64-clone/ created from uefi-x64/ with identity code ABCD (was ${old}); BOARD_RELEASE_TARGET=0.`)
    const env = readFileSync(join(root, 'boards/x64-clone/board.env'), 'utf8')
    expect(env).not.toMatch(/\buefi-x64\b/)
    expect(env).toMatch(/^DISK_GUID=[0-9A-F]{8}-ABCD-/m)
    expect(env).toMatch(/^BOARD_RELEASE_TARGET=0$/m)
    expect(env.match(new RegExp(`-${old}-`, 'gi'))).toBeNull()
    for (const p of ['_out', 'meta', 'evidence.json']) expect(existsSync(join(root, 'boards/x64-clone', p))).toBe(false)
    expect(existsSync(join(root, 'boards/x64-clone/kernel/config/x64-clone.config'))).toBe(true)
    expect(existsSync(join(root, 'boards/x64-clone/kernel/config/uefi-x64.config'))).toBe(false)
    expect(lstatSync(join(root, 'boards/uefi-x64/meta')).isSymbolicLink() && readlinkSync(join(root, 'boards/uefi-x64/meta'))).toBe('../../meta')
  })
  test('a bad name, an unknown source and an existing target are refused', () => {
    expect(() => newBoard('Bad_Name', 'uefi-x64', root)).toThrow('\'Bad_Name\' is not a board name')
    expect(() => newBoard('fresh', 'nope', root)).toThrow('nope is not a board here; the boards are: uefi-x64 x64-clone ')
    expect(() => newBoard('x64-clone', 'uefi-x64', root)).toThrow('boards/x64-clone/ exists')
  })
})
