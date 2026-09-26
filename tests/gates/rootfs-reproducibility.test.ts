// The rootfs reproducibility boundary, over fixture trees (make os-rootfs-runtime-test).
//
// pack-tree-surgery.sh drops ldconfig's aux-cache (an optimizer cache whose bytes vary run to run) and leaves
// ld.so.cache and ldconfig alone; pack-squashfs.sh refuses a final tree that still holds aux-cache, holds an empty
// ld.so.cache, or lacks ldconfig. Both run on the host with their /rootfs, /runtime and /out rewritten into a
// scratch tree and mksquashfs recorded instead of run. Then the initramfs packer's three determinism controls (the
// epoch, the sorted order, cpio --reproducible) are asserted present, and each one removed is caught. The port of
// tests/gates/rootfs-reproducibility-test.sh (deleted 2026-09-25) and its inline Python, case for case.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, 'tmp', 'rootfs-reproducibility.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const write = (path: string, text: string, mode?: number) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  if (mode !== undefined) chmodSync(path, mode)
}
const LDCONFIG = '#!/bin/sh\nexit 0\n'

/** A stage script with its fixed container paths moved under the scratch tree, as the shell gate's sed did. */
function rewritten(stageScript: string, dir: string, paths: Record<string, string>): string {
  let text = readFileSync(join(REPO_ROOT, 'stages/compose/scripts', stageScript), 'utf8')
  for (const [from, to] of Object.entries(paths)) text = text.replace(new RegExp(`${from}(/|\\s|$)`, 'gm'), `${to}$1`)
  const script = join(dir, stageScript)
  write(script, text, 0o755)
  return script
}

test.each([['aux-present', true], ['aux-already-absent', false]] as const)('pack-tree-surgery: %s', (label, withAux) => {
  const tree = join(WORK, label, 'rootfs'), out = join(WORK, label, 'out')
  mkdirSync(out, { recursive: true })
  for (const d of ['var/cache/ldconfig', 'var/lib/systemd', 'var/log', 'rootfs-report.pkglogs']) mkdirSync(join(tree, d), { recursive: true })
  write(join(tree, 'rootfs-report.txt'), 'packages\n')
  write(join(tree, 'etc/hosts'), '127.0.0.1 localhost\n')
  write(join(tree, 'etc/ld.so.cache'), 'loader-cache-fixture\n')
  write(join(tree, 'usr/sbin/ldconfig'), LDCONFIG, 0o755)
  if (withAux) write(join(tree, 'var/cache/ldconfig/aux-cache'), 'optimizer-cache-fixture\n')
  const script = rewritten('pack-tree-surgery.sh', join(WORK, label), { '/rootfs': tree, '/out': out })
  const r = Bun.spawnSync([script], { stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode, `pack-tree-surgery rejected the ${label} fixture:\n${r.stderr.toString()}`).toBe(0)
  expect(existsSync(join(tree, 'var/cache/ldconfig/aux-cache')), `${label} retained aux-cache`).toBe(false)
  expect(readFileSync(join(tree, 'etc/ld.so.cache'), 'utf8')).toBe('loader-cache-fixture\n')
  expect(Bun.spawnSync(['test', '-x', join(tree, 'usr/sbin/ldconfig')]).exitCode, `${label} lost executable ldconfig`).toBe(0)
})

const bin = join(WORK, 'bin')
write(join(bin, 'mksquashfs'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$MICA_PACK_ARGS"\ntouch "$2"\n', 0o755)

test.each([
  ['final-clean', ''],
  ['final-aux', 'aux-cache'],
  ['final-empty-cache', 'ld.so.cache'],
  ['final-no-ldconfig', 'ldconfig'],
] as const)('pack-squashfs: %s', (label, refusal) => {
  const runtime = join(WORK, label, 'runtime'), out = join(WORK, label, 'out')
  mkdirSync(out, { recursive: true })
  mkdirSync(join(runtime, 'var/cache/ldconfig'), { recursive: true })
  write(join(runtime, 'etc/ld.so.cache'), label === 'final-empty-cache' ? '' : 'loader-cache-fixture\n')
  if (label !== 'final-no-ldconfig') write(join(runtime, 'usr/sbin/ldconfig'), LDCONFIG, 0o755)
  if (label === 'final-aux') write(join(runtime, 'var/cache/ldconfig/aux-cache'), 'optimizer-cache-fixture\n')
  const script = rewritten('pack-squashfs.sh', join(WORK, label), { '/runtime': runtime, '/out': out })
  const r = Bun.spawnSync([script], {
    env: { ...process.env, SQUASHFS_TIME: '1577836800', SQUASHFS_COMPRESSION: 'zstd', MICA_PACK_ARGS: join(WORK, `${label}.args`), PATH: `${bin}:${process.env.PATH}` },
    stdout: 'pipe', stderr: 'pipe',
  })
  const log = r.stdout.toString() + r.stderr.toString()
  if (refusal === '') { expect(r.exitCode, `pack-squashfs rejected ${label}:\n${log}`).toBe(0) }
  else {
    expect(r.exitCode, `pack-squashfs accepted ${label}`).not.toBe(0)
    expect(log, `pack-squashfs refusal for ${label} omitted '${refusal}'`).toContain(refusal)
  }
})

// The board's compression reaches mksquashfs (mica:docs/plan/20260926-0930-mini-images-on-128-mb.md): zstd 19 for
// every board that says nothing, xz with 1 MiB blocks and the host architecture's branch filter for one that says
// xz, and anything else is refused before mksquashfs runs.
test.each([
  ['zstd', ['-comp', 'zstd', '-Xcompression-level', '19']],
  ['xz', ['-comp', 'xz', '-b', '1M', '-Xdict-size', '100%', '-Xbcj']],
  ['lz4', undefined],
] as const)('pack-squashfs with SQUASHFS_COMPRESSION=%s', (compression, expected) => {
  const label = `compression-${compression}`
  const runtime = join(WORK, label, 'runtime'), out = join(WORK, label, 'out')
  mkdirSync(out, { recursive: true })
  mkdirSync(join(runtime, 'var/cache/ldconfig'), { recursive: true })
  write(join(runtime, 'etc/ld.so.cache'), 'loader-cache-fixture\n')
  write(join(runtime, 'usr/sbin/ldconfig'), LDCONFIG, 0o755)
  const script = rewritten('pack-squashfs.sh', join(WORK, label), { '/runtime': runtime, '/out': out })
  const argsFile = join(WORK, `${label}.args`)
  const r = Bun.spawnSync([script], {
    env: { ...process.env, SQUASHFS_TIME: '1577836800', SQUASHFS_COMPRESSION: compression, MICA_PACK_ARGS: argsFile, PATH: `${bin}:${process.env.PATH}` },
    stdout: 'pipe', stderr: 'pipe',
  })
  if (expected === undefined) {
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('it is zstd or xz')
    expect(existsSync(argsFile), 'mksquashfs ran for a compression the script refuses').toBe(false)
    return
  }
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  const args = readFileSync(argsFile, 'utf8').split('\n')
  expect(args.slice(2, 2 + expected.length)).toEqual([...expected])
})

const INITRAMFS_CONTROLS = [
  'find . -exec touch -h -d @1577836800 {} +',
  'find . -print0 | LC_ALL=C sort -z | cpio --null --reproducible --owner=0:0 -o -H newc --quiet',
  'find "$DEST" -type f -printf \'%P\\n\' | LC_ALL=C sort > /output/initramfs.files',
]
const holdsControls = (text: string) => INITRAMFS_CONTROLS.every(c => text.includes(c))
const initramfs = readFileSync(join(REPO_ROOT, 'stages/boot/initramfs.sh'), 'utf8')

test('the initramfs packer holds its deterministic archive controls', () => {
  expect(INITRAMFS_CONTROLS.filter(c => !initramfs.includes(c))).toEqual([])
})

test.each([
  ['reproducible', (t: string) => t.replaceAll(' --reproducible', '')],
  ['ordering', (t: string) => t.replaceAll('LC_ALL=C sort -z', 'cat')],
  ['epoch', (t: string) => t.replaceAll('@1577836800', '@1700000000')],
] as const)('the initramfs contract refuses a packer missing its %s control', (_mutation, mutate) => {
  expect(holdsControls(mutate(initramfs))).toBe(false)
})
