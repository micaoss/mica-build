// src/rootfs/measure.ts over a fixture factory root: a synthetic root packed as the one-layer OCI archive
// 90-pack exports, with real ELF files copied out of the root this test runs in (an executable that needs libc,
// libc itself, and libm, which nothing in the fixture needs). Every section of the report is read back, and the
// three refusals -- more than one layer, a layer this cannot open, a root too small to be one -- fire by name.
import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { measureBuild } from '../../src/rootfs/measure.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'measure-rootfs-test.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const TRIPLET = process.arch === 'arm64' ? 'aarch64-linux-gnu' : 'x86_64-linux-gnu'
const LIB = [`/usr/lib/${TRIPLET}`, `/lib/${TRIPLET}`].find(d => existsSync(join(d, 'libc.so.6')))!

function put(root: string, rel: string, body: string | Buffer): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}

function tar(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['tar', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`tar ${args.join(' ')}: ${r.stderr.toString()}`)
}

const digest = (b: Uint8Array) => `sha256:${new Bun.CryptoHasher('sha256').update(b).digest('hex')}`

/** An OCI archive of `root` as one layer (or `layers` copies of it), compressed as `media` says. */
function oci(root: string, out: string, media = 'application/vnd.oci.image.layer.v1.tar+gzip', layers = 1): void {
  const layout = `${out}.layout`
  mkdirSync(join(layout, 'blobs/sha256'), { recursive: true })
  tar(['--numeric-owner', '--sort=name', '-cf', `${layout}/layer.tar`, '.'], root)
  const plain = new Uint8Array(readFileSync(`${layout}/layer.tar`))
  const body = media.endsWith('+gzip') ? Bun.gzipSync(plain) : plain
  rmSync(`${layout}/layer.tar`)
  const layerDigest = digest(body)
  writeFileSync(join(layout, 'blobs/sha256', layerDigest.slice(7)), body)
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, layers: Array.from({ length: layers }, () => ({ mediaType: media, digest: layerDigest, size: body.length })) }))
  writeFileSync(join(layout, 'blobs/sha256', digest(manifest).slice(7)), manifest)
  writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ digest: digest(manifest) }] }))
  tar(['-cf', out, 'index.json', 'blobs'], layout)
  rmSync(layout, { recursive: true })
}

function fixture(name: string, files = 1100): { out: string, boards: string } {
  const root = join(T, name, 'root'), out = join(T, name, 'build'), boards = join(T, name, 'boards')
  for (let i = 0; i < files; i++) put(root, `usr/share/doc/pkg/${String(i).padStart(4, '0')}`, 'x'.repeat(10))
  put(root, 'usr/lib/os-release', 'ID=mica\nIMAGE_ID=mica-fix\nIMAGE_VERSION="20260925-0000"\n')
  put(root, 'usr/share/mica/manifest.tsv', '# package\tversion\nbase-files\t13\nmica-core\t1\nmicad\t2\n')
  put(root, 'usr/bin/big', 'y'.repeat(1000))
  linkSync(join(root, 'usr/bin/big'), join(root, 'usr/bin/big-link'))
  symlinkSync('big', join(root, 'usr/bin/big-alias'))
  mkdirSync(join(root, 'usr/lib/udev/rules.d'), { recursive: true })
  put(root, 'usr/lib/udev/rules.d/60-a.rules', 'IMPORT{builtin}="hwdb --subsystem=usb"\nIMPORT{builtin}="hwdb \'x\'"\n')
  put(root, 'usr/lib/udev/rules.d/61-b.rules', 'KERNEL=="x"\n')
  put(root, 'usr/lib/udev/hwdb.d/20-a.hwdb', 'usb:v*\n ID=1\n')
  put(root, 'usr/lib/modules/6.1/modules.dep', 'abc\n')
  put(root, 'boot/vmlinuz', 'k'.repeat(50))
  mkdirSync(join(root, 'usr/lib', TRIPLET), { recursive: true })
  copyFileSync('/usr/bin/true', join(root, 'usr/bin/true'))
  copyFileSync(join(LIB, 'libc.so.6'), join(root, 'usr/lib', TRIPLET, 'libc.so.6'))
  copyFileSync(join(LIB, 'libm.so.6'), join(root, 'usr/lib', TRIPLET, 'libm.so.6'))
  mkdirSync(out, { recursive: true })
  oci(root, join(out, 'factory-root.oci'))
  writeFileSync(join(out, 'rootfs-report.txt'), 'TOTAL_MB 42\n')
  put(boards, 'fix/board.env', 'MICA_ARCH="amd64"\n')
  return { out, boards }
}

test('the report reads the shipped root: identity, payload with hard links once, the named sets and the ELF surface', () => {
  const { out, boards } = fixture('full')
  const lines = measureBuild(out, 'fix', boards, false)
  const value = (key: string) => lines.find(l => l.startsWith(`${key}\t`))?.split('\t').slice(1).join('\t')
  expect(value('board')).toBe('fix')
  expect(value('root-image-version')).toBe('20260925-0000')
  expect(value('root-image-id')).toBe('mica-fix')
  expect(value('arch')).toBe('amd64')
  expect(value('report-TOTAL_MB')).toBe('42')
  expect(value('packages-shipped')).toBe('3')
  expect(value('packages-local')).toBe('2')
  expect(Number(value('regular-file-bytes-naive')) - Number(value('regular-file-bytes-dedup'))).toBe(1000)
  expect(value('hardlink-saving-bytes')).toBe('1000')
  expect(Number(value('regular-files')) - Number(value('distinct-inodes'))).toBe(1)
  expect(value('symlinks')).toBe('1')
  expect(value('hwdb-source-files')).toBe('1')
  expect(value('udev-rules-files')).toBe('2')
  expect(value('udev-rules-querying-hwdb')).toBe('1')
  expect(value('udev-hwdb-query-clauses')).toBe('2')
  expect(value('kernel-module-index-bytes')).toBe('4')
  expect(value('/boot')).toBe('50')
  expect(lines).toContain('present\t/usr/lib/udev/hwdb.d\t13')
  expect(lines).toContain('absent\t/usr/lib/udev/hwdb.bin\t0')
  expect(value('user-space-elf-files')).toBe('3')
  expect(value('shipped-SONAMEs')).toBe('2')
  // true needs libc; nothing in the fixture needs libm, so libm is the one candidate.
  expect(value('SONAMEs-with-no-DT_NEEDED-referrer')).toBe('1')
  expect(lines).toContain('  candidate\tlibm.so.6')
  expect(lines.at(-1)).toMatch(/^measured: .*measure-root \(\d+ paths\)$/)
  expect(existsSync(join(out, 'measure-root'))).toBe(false)
  const byTop = lines.slice(lines.indexOf('== payload by top-level directory (bytes, hard links counted once) ==') + 1)
  expect(byTop[0]!.split('\t')[0]).toBe('usr')
})

test('a root of more than one layer, a layer it cannot open and a root too small to be one are refused', () => {
  const small = fixture('small', 10)
  expect(() => measureBuild(small.out, 'fix', small.boards, false)).toThrow(/the extracted root holds \d+ path\(s\)/)
  const { out, boards } = fixture('two')
  oci(join(T, 'two/root'), join(out, 'factory-root.oci'), 'application/vnd.oci.image.layer.v1.tar+gzip', 2)
  expect(() => measureBuild(out, 'fix', boards, false)).toThrow('carries 2 layers; factory-root is a single-COPY scratch stage')
  oci(join(T, 'two/root'), join(out, 'factory-root.oci'), 'application/vnd.oci.image.layer.v1.tar+bzip2')
  expect(() => measureBuild(out, 'fix', boards, false)).toThrow('layer is \'application/vnd.oci.image.layer.v1.tar+bzip2\', which this command cannot open')
})
