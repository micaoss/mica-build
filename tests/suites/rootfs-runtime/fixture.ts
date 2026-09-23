// The offline fixture the runtime suite runs the selector and the composer over: a small installed tree with
// real ELF files, symlinks, hardlinks, foreign owners and file capabilities, a dpkg ownership capture and a
// declaration. It needs root (device nodes, chown, security.capability) and the fetched amd64 pool (the
// shipped policy files the fixtures are seeded with); `make os-rootfs-runtime-test` provides both, and a run
// without them refuses at the first fixture rather than skipping.
//
// The port of tests/gates/rootfs-runtime/selection_test.py's fixture (deleted 2026-09-22).
import { expect } from 'bun:test'
import { dlopen, FFIType } from 'bun:ffi'
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { payloadMember } from '../../../src/pool/deb.ts'
import { getxattr, lchown, lutimesNs, setxattr } from '../../../src/rootfs/runtime/fsx.ts'
import { compact, parse, type Value } from '../../../src/rootfs/runtime/pyjson.ts'
import type { RuntimeLink } from '../../../src/rootfs/runtime/select.ts'

export const REPO = resolve(import.meta.dir, '../../..')
export const SELECT = join(REPO, 'src/rootfs/runtime/select.ts')
export const COMPOSE = join(REPO, 'src/rootfs/runtime/compose.ts')
export const CONSUMERS = join(REPO, 'src/rootfs/runtime/consumers.json')
const POOL = process.env.MICA_POOL_DIR || join(REPO, '_out/debs')

export type Obj = { [key: string]: Value }
export type Rule = { paths: string[], kind: string, reason: string, generated?: string, packages?: string[], expect?: Obj }
export type Consumer = { roots: Rule[], runtime_links: RuntimeLink[] }
export type Rules = { library_dirs: string[], path: string[], consumers: Record<string, Consumer> }
export type Run = { exitCode: number, stdout: string, stderr: string }

/** The shipped policy (src/rootfs/runtime/consumers.json), parsed. */
export function policy(): Rules {
  return JSON.parse(readFileSync(CONSUMERS, 'utf8')) as Rules
}

/** Navigate a parsed report: get(report, 'provenance', 'files', path, 'final', 'sha256'). */
export function get(value: Value, ...keys: (string | number)[]): Value {
  let v = value
  for (const k of keys) {
    if (Array.isArray(v) && typeof k === 'number') v = v[k]!
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) v = (v as Obj)[k]!
    else throw new Error(`no ${keys.join('.')} in the value`)
  }
  return v
}

export function loadJson(path: string): Value {
  return parse(readFileSync(path, 'utf8'))
}

/** The rows of a report's `files`, by path. */
export function rowsOf(report: Value): Map<string, Obj> {
  return new Map((get(report, 'files') as Obj[]).map(r => [r.path as string, r]))
}

export function pathsOf(report: Value): Set<string> {
  return new Set((get(report, 'files') as Obj[]).map(r => r.path as string))
}

/** A shipped policy file, out of the archives the lock imports (mica-system, and mica-podman for the Quadlet mount unit). */
export async function shipped(path: string): Promise<Uint8Array> {
  for (const pattern of [/^mica-system_.*_all\.deb$/, /^mica-podman_.*_amd64\.deb$/]) {
    const dir = join(POOL, 'amd64/pool')
    const archives = existsSync(dir) ? readdirSync(dir).filter(f => pattern.test(f)).sort() : []
    for (const archive of archives) {
      try { return (await payloadMember(join(dir, archive), path.replace(/^\/+/, ''))).body }
      catch { /* not in this archive */ }
    }
  }
  throw new Error(`${path} is in none of the imported archives under ${POOL}/amd64/pool; fetch them with \`make os-pool\``)
}

const libc = dlopen('libc.so.6', {
  mknod: { args: [FFIType.cstring, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  mkfifo: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
})
const S_IFCHR = 0o020000

export function makedev(major: number, minor: number): bigint {
  const M = BigInt(major), m = BigInt(minor)
  return ((M & 0xfffff000n) << 32n) | ((M & 0xfffn) << 8n) | ((m & 0xffffff00n) << 12n) | (m & 0xffn)
}

export function mknodChr(path: string, mode: number, major: number, minor: number): void {
  if (libc.symbols.mknod(Buffer.from(path + '\0'), S_IFCHR | mode, makedev(major, minor)) !== 0) throw new Error(`mknod ${path} failed (root required)`)
  chmodSync(path, mode)
}

export function mkfifo(path: string): void {
  if (libc.symbols.mkfifo(Buffer.from(path + '\0'), 0o644) !== 0) throw new Error(`mkfifo ${path} failed`)
}

/** shutil.copy2: bytes, mode, mtime and the user extended attribute the fixture sets. */
export function copy2(from: string, to: string): void {
  writeFileSync(to, readFileSync(from))
  const st = statSync(from, { bigint: true })
  chmodSync(to, Number(st.mode & 0o7777n))
  lutimesNs(to, st.mtimeNs)
  try { setxattr(to, 'user.fixture', getxattr(from, 'user.fixture')) }
  catch { /* none */ }
}

export function utimeNs(path: string, ns: bigint): void {
  lutimesNs(path, ns)
}

export function readlink(path: string): string {
  return readlinkSync(path)
}

export function lexists(path: string): boolean {
  try { lstatSync(path); return true }
  catch { return false }
}

export function walk(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      out.push('/' + p.slice(root.length + 1))
      if (e.isDirectory() && !e.isSymbolicLink()) visit(p)
    }
  }
  visit(root)
  return out
}

/** struct.pack('<IIIII', 0x02000001, 0x2000, 0, 0, 0).hex(): a VFS capability header with CAP_NET_BIND_SERVICE permitted. */
export const CAP = (() => {
  const b = Buffer.alloc(20)
  b.writeUInt32LE(0x02000001, 0); b.writeUInt32LE(0x2000, 4)
  return b.toString('hex')
})()

export function hex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'))
}

export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function text(path: string): string {
  return readFileSync(path, 'utf8')
}

export function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

/** A sectionless ELF64 with PT_LOAD/PT_DYNAMIC, just as stripped inputs may be. */
export function elf(o: { machine?: number, needed?: string[], interp?: string, runpath?: string, rpath?: string, soname?: string } = {}): Uint8Array {
  const machine = o.machine ?? 62
  const strings: number[] = [0]
  const tags: [number, number][] = []
  const add = (tag: number, values: string[]): void => {
    for (const value of values) {
      tags.push([tag, strings.length])
      strings.push(...bytes(value), 0)
    }
  }
  add(1, o.needed ?? [])
  add(29, o.runpath !== undefined ? [o.runpath] : [])
  add(15, o.rpath !== undefined ? [o.rpath] : [])
  add(14, o.soname !== undefined ? [o.soname] : [])
  const entries: [number, number][] = [[5, 0x400400], [10, strings.length], ...tags, [0, 0]]
  const dynamic = Buffer.alloc(16 * entries.length)
  entries.forEach(([t, v], i) => { dynamic.writeBigUInt64LE(BigInt(t), i * 16); dynamic.writeBigUInt64LE(BigInt(v), i * 16 + 8) })
  const data = Buffer.alloc(2048)
  Buffer.from('\x7fELF\x02\x01\x01', 'latin1').copy(data, 0)
  data.writeUInt16LE(3, 16); data.writeUInt16LE(machine, 18); data.writeUInt32LE(1, 20)
  data.writeBigUInt64LE(0n, 24); data.writeBigUInt64LE(64n, 32); data.writeBigUInt64LE(0n, 40)
  data.writeUInt32LE(0, 48); data.writeUInt16LE(64, 52); data.writeUInt16LE(56, 54); data.writeUInt16LE(o.interp ? 3 : 2, 56)
  const headers: number[][] = [
    [1, 5, 0, 0x400000, 0x400000, data.length, data.length, 4096],
    [2, 4, 512, 0x400200, 0x400200, dynamic.length, dynamic.length, 8],
  ]
  if (o.interp) {
    const raw = Buffer.from(o.interp + '\0')
    raw.copy(data, 256)
    headers.push([3, 4, 256, 0x400100, 0x400100, raw.length, raw.length, 1])
  }
  headers.forEach((h, i) => {
    const at = 64 + i * 56
    data.writeUInt32LE(h[0]!, at); data.writeUInt32LE(h[1]!, at + 4)
    for (let j = 2; j < 8; j++) data.writeBigUInt64LE(BigInt(h[j]!), at + 8 + (j - 2) * 8)
  })
  dynamic.copy(data, 512)
  Buffer.from(strings).copy(data, 1024)
  return new Uint8Array(data)
}

export function loaderCache(entries: [string, string][]): Uint8Array {
  const strings: number[] = []
  const records = Buffer.alloc(24 * entries.length)
  const start = 48 + 24 * entries.length
  entries.forEach(([name, path], i) => {
    const key = start + strings.length; strings.push(...bytes(name), 0)
    const value = start + strings.length; strings.push(...bytes(path), 0)
    records.writeInt32LE(0x303, i * 24); records.writeUInt32LE(key, i * 24 + 4); records.writeUInt32LE(value, i * 24 + 8)
    records.writeUInt32LE(0, i * 24 + 12); records.writeBigUInt64LE(0n, i * 24 + 16)
  })
  const header = Buffer.alloc(28)
  header.writeUInt32LE(entries.length, 0); header.writeUInt32LE(strings.length, 4); header[8] = 2
  return new Uint8Array(Buffer.concat([Buffer.from('glibc-ld.so.cache1.1'), header, records, Buffer.from(strings)]))
}

export function run(argv: string[], options: { cwd?: string, env?: Record<string, string>, timeout?: number } = {}): Run {
  const r = Bun.spawnSync(argv, { cwd: options.cwd, env: options.env ?? process.env, stdout: 'pipe', stderr: 'pipe', timeout: options.timeout ?? 60000 })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

export class Fixture {
  readonly base: string
  readonly root: string
  readonly out: string
  readonly db: string
  readonly manifest: string
  readonly packages: string
  readonly report: string
  readonly rulesPath: string
  rules: Rules

  constructor() {
    this.base = mkdtempSync(join(tmpdir(), 'mica-b4-fixture-'))
    this.root = join(this.base, 'installed'); mkdirSync(this.root)
    this.out = join(this.base, 'runtime')
    this.db = join(this.base, 'dpkg-info'); mkdirSync(this.db)
    this.manifest = join(this.base, 'manifest.tsv')
    writeFileSync(this.manifest, '#package\tversion\tarchitecture\nmica-system\t1\tall\nlibfixture\t1\tamd64\nunused\t1\tall\n')
    this.packages = join(this.base, 'selected.pkgs')
    writeFileSync(this.packages, 'mica-system\n')
    this.report = join(this.base, 'rootfs-report.runtime.json')
    this.rulesPath = join(this.base, 'rules.json')
    this.write('/usr/bin/app', elf({ needed: ['libfirst.so'], interp: '/lib/loader.so' }), 0o755)
    this.write('/usr/lib/libfirst.so', elf({ needed: ['libsecond.so'] }))
    this.write('/usr/lib/libsecond.so', elf())
    this.write('/usr/lib/loader.so', elf(), 0o755)
    this.link('/lib', 'usr/lib')
    this.write('/usr/bin/sh', elf(), 0o755)
    this.write('/usr/bin/helper', '#!/usr/bin/sh\nexit 0\n', 0o755)
    this.write('/usr/bin/entry', '#!/usr/bin/sh\nhelper\n', 0o755)
    this.write('/usr/lib/security/pam_fixture.so', elf())
    this.write('/usr/lib/libnss_fixture.so.2', elf())
    this.write('/etc/pam.d/login', 'auth required pam_fixture.so\n')
    this.write('/etc/nsswitch.conf', 'passwd: fixture\n')
    this.write('/etc/generated.conf', 'generated\n', 0o640)
    this.write('/etc/license', 'license\n')
    this.write('/usr/share/doc/mica-system/copyright', 'system license\n')
    this.write('/usr/share/doc/libfixture/copyright', 'library license\n')
    this.write('/var/lib/seed', 'seed\n', 0o640)
    lchown(this.at('/var/lib/seed'), 123, 456)
    this.write('/usr/bin/captool', elf(), 0o4755)
    setxattr(this.at('/usr/bin/captool'), 'security.capability', hex(CAP))
    setxattr(this.at('/var/lib/seed'), 'user.fixture', bytes('value'))
    linkSync(this.at('/var/lib/seed'), this.at('/var/lib/seed-alias'))
    this.link('/etc/absolute', '/var/lib/seed')
    this.link('/etc/relative', '../var/lib/seed-alias')
    this.write('/usr/bin/unselected', elf(), 0o755)
    this.write('/usr/lib/debug/app.debug', 'matching debug input')
    this.write('/usr/lib/udev/hwdb.bin', 'static hwdb')
    this.write('/usr/lib/modules/modules.dep', 'support index input')
    this.write('/etc/systemd/system-generators/systemd-ssh-generator', 'placeholder')
    rmSync(this.at('/etc/systemd/system-generators/systemd-ssh-generator'))
    this.link('/etc/systemd/system-generators/systemd-ssh-generator', '/dev/null')
    this.write('/usr/lib/systemd/systemd-tmpfiles', elf(), 0o755)
    this.write('/etc/tmpfiles.d/mica-var.conf', 'f /run/mica/wtmp 0664 root utmp -\n')
    this.link('/var/log/wtmp', '/run/mica/wtmp')
    this.write('/etc/systemd/system/systemd-tmpfiles-setup.service', '[Service]\n')
    mkdirSync(this.at('/mnt/data'), { recursive: true })
    this.rules = { library_dirs: ['/usr/lib'], path: ['/usr/bin'], consumers: { 'mica-system': {
      roots: [
        { paths: ['/usr/bin/app', '/usr/bin/entry', '/usr/bin/helper', '/usr/bin/captool'], kind: 'executable', reason: 'entrypoints and invoked helper' },
        { paths: ['/usr/lib/security/pam_fixture.so', '/usr/lib/libnss_fixture.so.2', '/etc/pam.d/login', '/etc/nsswitch.conf', '/etc/license', '/etc/absolute', '/etc/relative', '/etc/systemd/system-generators/systemd-ssh-generator'], kind: 'resource', reason: 'authentication and policy' },
        { paths: ['/var/lib/seed', '/var/lib/seed-alias', '/etc/generated.conf'], kind: 'resource', reason: 'generated state', generated: 'fixture-configure' },
        { paths: ['/mnt/data'], kind: 'directory', reason: 'DATA mountpoint' },
        { paths: ['/usr/bin/captool'], kind: 'executable', reason: 'required capability', expect: { xattrs: { 'security.capability': CAP } } },
        { paths: ['/var/log/wtmp'], kind: 'resource', reason: 'bounded login accounting' },
      ],
      runtime_links: [
        { path: '/etc/systemd/system-generators/systemd-ssh-generator', target: '/dev/null', generator: 'kernel devtmpfs', ordering: 'before systemd generators', test: 'B7 SSH listen and image-only keys', requires: [] },
        { path: '/var/log/wtmp', target: '/run/mica/wtmp', generator: 'systemd-tmpfiles', ordering: 'systemd-tmpfiles-setup before login', test: 'B7 repeated login bounds', requires: ['/usr/lib/systemd/systemd-tmpfiles', '/etc/tmpfiles.d/mica-var.conf', '/etc/systemd/system/systemd-tmpfiles-setup.service'] },
      ],
    } } }
    this.captureOwnership()
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true })
  }

  /** The installed tree's path of an absolute path. */
  at(path: string): string {
    return join(this.root, path.replace(/^\/+/, ''))
  }

  /** The output tree's path of an absolute path. */
  outAt(path: string): string {
    return join(this.out, path.replace(/^\/+/, ''))
  }

  write(path: string, data: Uint8Array | string, mode = 0o644): void {
    const at = this.at(path)
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, data)
    chmodSync(at, mode)
  }

  link(path: string, target: string): void {
    const at = this.at(path)
    mkdirSync(dirname(at), { recursive: true })
    symlinkSync(target, at)
  }

  unlink(path: string): void {
    rmSync(this.at(path))
  }

  /** Move an installed path aside for a check and put it back. */
  withheld(path: string, check: () => void): void {
    const at = this.at(path), saved = join(this.base, 'saved')
    renameSync(at, saved)
    try { check() }
    finally { renameSync(saved, at) }
  }

  /** Forget the previous selection's output and report. */
  reset(): void {
    rmSync(this.out, { recursive: true, force: true })
    rmSync(this.report, { force: true })
  }

  captureOwnership(): void {
    let paths = ['/.', ...walk(this.root)]
    paths = paths.filter(p => !['/etc/generated.conf', '/var/lib/seed', '/var/lib/seed-alias'].includes(p))
    writeFileSync(join(this.db, 'mica-system.list'), [...new Set(paths)].sort().join('\n') + '\n')
    writeFileSync(join(this.db, 'libfixture:amd64.list'), '/usr/lib/libsecond.so\n/usr/share/doc/libfixture/copyright\n')
    let t = text(join(this.db, 'mica-system.list')).replaceAll('/usr/lib/libsecond.so\n', '').replaceAll('/usr/share/doc/libfixture/copyright\n', '')
    writeFileSync(join(this.db, 'mica-system.list'), t)
    writeFileSync(join(this.db, 'unused.list'), '/usr/bin/unselected\n')
    t = t.replaceAll('/usr/bin/unselected\n', '')
    writeFileSync(join(this.db, 'mica-system.list'), t)
  }

  writeRules(): void {
    writeFileSync(this.rulesPath, JSON.stringify(this.rules))
  }

  command(command = 'select', overrides: Record<string, string> = {}): Run {
    this.writeRules()
    let options: Record<string, string> = { root: this.root, output: this.out, packages: this.packages, inventory: this.manifest,
      ownership: this.db, rules: this.rulesPath, arch: 'amd64', report: this.report, ...overrides }
    if (command === 'verify') options = { root: this.out, report: this.report, ...overrides }
    const argv = [process.execPath, SELECT, command]
    for (const [k, v] of Object.entries(options)) argv.push('--' + k, v)
    return run(argv, { timeout: 10000 })
  }

  selected(): Value {
    const result = this.command()
    expect(result.exitCode, result.stderr).toBe(0)
    return loadJson(this.report)
  }

  refuse(fragment: string, overrides: Record<string, string> = {}): void {
    const result = this.command('select', overrides)
    expect(result.exitCode, result.stdout).not.toBe(0)
    expect(result.stderr).toContain(fragment)
    expect(existsSync(this.report), 'failed selection must not publish a success report').toBe(false)
  }

  verified(): void {
    const r = this.command('verify')
    expect(r.exitCode, r.stderr).toBe(0)
  }

  /** The shipped accounting links, with the tmpfiles generator and its resources in place. */
  accountingLinks(): RuntimeLink[] {
    const shippedPolicy = policy()
    const paths = new Set(['/var/log/wtmp', '/var/log/btmp', '/var/log/lastlog'])
    const links = shippedPolicy.consumers['mica-system']!.runtime_links.filter(l => paths.has(l.path))
    expect(new Set(links.map(l => l.path))).toEqual(paths)
    rmSync(this.at('/usr/lib/systemd/systemd-tmpfiles'))
    rmSync(this.at('/etc/systemd/system/systemd-tmpfiles-setup.service'))
    this.write('/usr/bin/systemd-tmpfiles', elf({ needed: ['libfirst.so'], interp: '/lib/loader.so' }), 0o755)
    this.write('/usr/lib/systemd/system/systemd-tmpfiles-setup.service', '[Service]\nExecStart=systemd-tmpfiles --create --remove --boot\n')
    this.write('/etc/tmpfiles.d/mica-var.conf', this.shippedSync('/etc/tmpfiles.d/mica-var.conf'))
    const declared = this.rules.consumers['mica-system']!.runtime_links
    declared.splice(0, declared.length, ...declared.filter(l => !paths.has(l.path)), ...links)
    for (const link of links) if (link.path !== '/var/log/wtmp') this.link(link.path, link.target)
    this.captureOwnership()
    return links
  }

  /** shipped(), for the synchronous fixture builders: the archive is read once per process. */
  shippedSync(path: string): Uint8Array {
    const cached = SHIPPED.get(path)
    if (cached === undefined) throw new Error(`shipped(${path}) was not preloaded; call preload() first`)
    return cached
  }
}

const SHIPPED = new Map<string, Uint8Array>()

/** Read the shipped policy files the fixtures seed, once, before the synchronous builders need them. */
export async function preload(paths: string[]): Promise<void> {
  for (const p of paths) if (!SHIPPED.has(p)) SHIPPED.set(p, await shipped(p))
}

export function cpTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true })
}

// ---- the composition fixture: the inputs the pack stage hands the composer, over the selection fixture above ----

export const PACKAGE_VERSION = '1.0.0-1'
export const TREE_VERSION = '0.1.0+git' + 'a'.repeat(12) + '-1'

/** Every parent directory of an absolute path, as pathlib's Path.parents names them ('/usr/bin' -> '/usr', '/'). */
export function parents(path: string): string[] {
  const out: string[] = []
  let p = dirname(path)
  for (;;) { out.push(p); if (p === '/') break; p = dirname(p) }
  return out
}

export function canonicalLine(record: Value): string {
  return compact(record) + '\n'
}

export class Composition {
  readonly f: Fixture
  readonly inputs: string
  readonly debug: string

  constructor() {
    const f = this.f = new Fixture()
    this.inputs = join(f.base, 'inputs')
    mkdirSync(this.inputs)
    cpTree(f.db, join(this.inputs, 'info'))
    writeFileSync(join(this.inputs, 'manifest.tsv'), readFileSync(f.manifest))
    writeFileSync(join(this.inputs, 'selected.pkgs'), readFileSync(f.packages))
    writeFileSync(join(this.inputs, 'upstream.tsv'), 'libfixture\t1\tamd64\t' + 'a'.repeat(64) + '\thttps://example.invalid/library.deb\tmica-system\nunused\t1\tall\t' + 'b'.repeat(64) + '\thttps://example.invalid/unused.deb\tbase\n')
    writeFileSync(join(this.inputs, 'Packages'), 'Package: mica-system\nVersion: 1\nArchitecture: all\nFilename: pool/mica-system.deb\nSHA256: ' + 'c'.repeat(64) + '\n\n')
    writeFileSync(join(this.inputs, 'sources.tsv'), 'mica-system\tmica-system\t1\nlibfixture\tfixture-source\t1\nunused\tunused\t1\n')
    mkdirSync(join(this.inputs, 'alternatives'))
    mkdirSync(join(this.inputs, 'enablement'))
    writeFileSync(join(this.inputs, 'preset-removed.tsv'), '')
    f.write('/usr/share/mica/manifest.tsv', readFileSync(f.manifest))
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/usr/share/mica', '/usr/share/mica/manifest.tsv'], kind: 'resource', reason: 'shipping inventory', generated: 'runtime composition' })
    // An unselected executable is an operator omission, even when owned.
    f.unlink('/usr/bin/unselected')
    f.writeRules()
    for (const path of [f.manifest, join(this.inputs, 'manifest.tsv'), join(this.inputs, 'sources.tsv'), f.at('/usr/share/mica/manifest.tsv')]) {
      writeFileSync(path, text(path).replaceAll('mica-system\t1\t', 'mica-system\t' + PACKAGE_VERSION + '\t')
        .replaceAll('mica-system\tmica-system\t1\n', 'mica-system\tmica-system\t' + PACKAGE_VERSION + '\n'))
    }
    const index = join(this.inputs, 'Packages')
    writeFileSync(index, text(index).replaceAll('Version: 1\n', 'Version: ' + PACKAGE_VERSION + '\n'))
    this.lineage()
    this.debug = join(f.base, 'debug')
    mkdirSync(this.debug)
    writeFileSync(join(this.debug, 'manifest.tsv'), '#path\tbuild-id\tdebug\tbytes-before\tbytes-after\tsha256-after\n')
  }

  cleanup(): void {
    this.f.cleanup()
  }

  in(name: string): string {
    return join(this.inputs, name)
  }

  lineage(arch = 'amd64'): void {
    for (const name of ['SHA256SUMS', 'manifest.txt']) if (!existsSync(this.in(name))) writeFileSync(this.in(name), 'fixture pool index\n')
    const files: Record<string, string> = {}
    for (const name of ['Packages', 'SHA256SUMS', 'manifest.txt']) files[name] = sha256(readFileSync(this.in(name)))
    files['pool/mica-system.deb'] = 'c'.repeat(64)
    const record: Value = { schema: 'mica/source-lineage/v1', architecture: arch, root_epoch: 1000000000,
      package_source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), epoch: 1000000000, version: TREE_VERSION },
      composition_source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), epoch: 1000000000 },
      lock: [{ package: 'mica-system', version: PACKAGE_VERSION, architecture: 'all', sha256: 'c'.repeat(64), source_repo: 'mica-system-base', source_commit: 'e'.repeat(40) }],
      unlocked: [], pool: { files, packages: [{ package: 'mica-system', version: PACKAGE_VERSION, architecture: 'all',
        archive: 'pool/mica-system.deb', sha256: 'c'.repeat(64), control_sha256: 'd'.repeat(64), source_repo: 'mica-system-base', source_commit: 'e'.repeat(40) }] } }
    writeFileSync(this.in('source-lineage.json'), canonicalLine(record))
  }

  command(action: string, options: Record<string, string> = {}): Run {
    const argv = [process.execPath, COMPOSE, action]
    for (const [name, value] of Object.entries(options)) argv.push('--' + name.replaceAll('_', '-'), value)
    return run(argv, { timeout: 15000 })
  }

  capture(): void {
    const alternatives = readdirSync(this.in('alternatives')).sort()
    writeFileSync(this.in('alternative-names.txt'), alternatives.map(n => n + '\n').join(''))
    const enablement = readdirSync(this.in('enablement')).filter(n => n.endsWith('.dsh-also')).sort()
    writeFileSync(this.in('enablement-names.txt'), enablement.map(n => n + '\n').join(''))
    const r = this.command('snapshot', { root: this.f.root, output: this.in('configured.json') })
    expect(r.exitCode, r.stderr).toBe(0)
  }

  compose(): Run {
    return this.command('compose', { root: this.f.root, output: this.f.out, inputs: this.inputs, rules: this.f.rulesPath, arch: 'amd64', epoch: '1000000000', debug: this.debug, report: this.f.report })
  }

  composed(): Value {
    const r = this.compose()
    expect(r.exitCode, r.stderr).toBe(0)
    return parse(text(this.f.report))
  }

  refused(fragment: string): void {
    const r = this.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain(fragment)
    expect(existsSync(this.f.report)).toBe(false)
  }

  podmanAlias(): string[] {
    const f = this.f
    const declared = policy().consumers['mica-podman']!
    const entries = declared.roots[0]!.paths
    for (const path of entries) f.write(path, elf({ needed: ['libpodman-fixture.so'], interp: '/usr/lib/podman-loader.so' }), 0o755)
    f.write('/usr/lib/libpodman-fixture.so', elf())
    f.write('/usr/lib/podman-loader.so', elf(), 0o755)
    f.write('/usr/share/doc/mica-podman/copyright', 'Podman fixture license\n')
    f.link('/usr/bin/docker', 'podman')
    let owned = [...entries, '/usr/bin/docker', '/usr/lib/libpodman-fixture.so', '/usr/lib/podman-loader.so', '/usr/share/doc/mica-podman/copyright']
    owned = [...new Set([...owned, ...owned.flatMap(parents)])].sort()
    writeFileSync(this.in('info/mica-podman.list'), owned.join('\n') + '\n')
    for (const path of [this.in('manifest.tsv'), f.at('/usr/share/mica/manifest.tsv')]) appendFileSync(path, `mica-podman\t${PACKAGE_VERSION}\tamd64\n`)
    appendFileSync(this.in('sources.tsv'), `mica-podman\tmica-podman\t${PACKAGE_VERSION}\n`)
    appendFileSync(this.in('selected.pkgs'), 'mica-podman\n')
    appendFileSync(this.in('Packages'), `Package: mica-podman\nVersion: ${PACKAGE_VERSION}\nArchitecture: amd64\nFilename: pool/mica-podman.deb\nSHA256: ` + 'e'.repeat(64) + '\n\n')
    this.lineage()
    const path = this.in('source-lineage.json')
    const record = parse(text(path)) as Obj
    ;(get(record, 'pool', 'files') as Obj)['pool/mica-podman.deb'] = 'e'.repeat(64)
    ;(get(record, 'pool', 'packages') as Value[]).push({ package: 'mica-podman', version: PACKAGE_VERSION, architecture: 'amd64', archive: 'pool/mica-podman.deb',
      sha256: 'e'.repeat(64), control_sha256: 'f'.repeat(64), source_repo: 'mica-podman', source_commit: 'f'.repeat(40) })
    ;(record.lock as Value[]).unshift({ package: 'mica-podman', version: PACKAGE_VERSION, architecture: 'amd64', sha256: 'e'.repeat(64), source_repo: 'mica-podman', source_commit: 'f'.repeat(40) })
    writeFileSync(path, canonicalLine(record))
    f.rules.consumers['mica-podman'] = { roots: [declared.roots[0]!, ...declared.roots.filter(row => row.paths.length === 1 && row.paths[0] === '/usr/bin/docker')], runtime_links: [] }
    f.writeRules()
    return entries
  }

  operatorCompanions(): { operators: Record<string, [string, string | null]>, resources: Record<string, string[]>, links: Record<string, string>, expected: Set<string> } {
    const f = this.f
    const operators: Record<string, [string, string | null]> = {}
    for (const name of ['halt', 'poweroff', 'reboot', 'runlevel', 'shutdown', 'telinit']) operators[`/usr/sbin/${name}`] = ['systemd-sysv', '../bin/systemctl']
    Object.assign(operators, { '/usr/bin/resolvectl': ['systemd-resolved', null], '/usr/sbin/resolvconf': ['systemd-resolved', '../bin/resolvectl'],
      '/usr/sbin/invoke-rc.d': ['init-system-helpers', null], '/usr/sbin/service': ['init-system-helpers', null],
      '/usr/bin/dpkg-realpath': ['dpkg', null], '/usr/bin/update-alternatives': ['dpkg', null], '/usr/sbin/start-stop-daemon': ['dpkg', null] })
    const resources: Record<string, string[]> = {
      'dbus': ['/etc/init.d/dbus', '/etc/default/dbus'],
      'procps': ['/etc/init.d/procps'],
      'quota': ['/etc/init.d/quota', '/etc/init.d/quotarpc', '/etc/default/quota', '/usr/share/quota/quotaon.sh', '/usr/share/quota/quotaoff.sh',
        '/usr/share/quota/quotarpc.sh', '/usr/share/quota/quota-initial-check.sh', '/var/lib/quota'],
      'sysvinit-utils': ['/usr/lib/lsb/init-functions', '/usr/lib/lsb/init-functions.d/00-verbose', '/usr/lib/init/init-d-script', '/usr/lib/init/vars.sh'],
      'systemd': ['/usr/lib/lsb/init-functions.d/40-systemd'],
    }
    const links: Record<string, string> = {}
    for (const level of ['2', '3', '4', '5']) links[`/etc/rc${level}.d/S01dbus`] = '../init.d/dbus'
    links['/etc/rcS.d/S01procps'] = '../init.d/procps'
    const expected = new Set([...Object.keys(operators), ...Object.values(resources).flat(), ...Object.keys(links)])
    const rows = policy().consumers['mica-system']!.roots.filter(row => row.paths.some(p => expected.has(p)))
    const system = f.rules.consumers['mica-system']!.roots
    system.push(...rows)
    const owners: Record<string, string> = {}
    for (const [path, [owner, target]] of Object.entries(operators)) {
      owners[path] = owner
      if (target) f.link(path, target)
      else f.write(path, owner === 'init-system-helpers' ? bytes('#!/usr/bin/sh\nexit 0\n') : elf({ needed: ['liboperator.so'], interp: '/usr/lib/operator-loader.so' }), 0o755)
    }
    for (const [owner, paths] of Object.entries(resources)) {
      for (const path of paths) {
        owners[path] = owner
        if (path === '/var/lib/quota') { mkdirSync(f.at(path), { recursive: true }) }
        else {
          const executable = path.startsWith('/etc/init.d/') || path.startsWith('/usr/share/quota/') || path.endsWith('/init-d-script')
          f.write(path, executable ? '#!/usr/bin/sh\nexit 0\n' : 'fixture resource\n', executable ? 0o755 : 0o644)
        }
      }
    }
    for (const path of ['/usr/bin/systemctl', '/usr/lib/operator-loader.so', '/usr/lib/liboperator.so']) {
      f.write(path, elf(), 0o755)
      owners[path] = 'systemd'
    }
    system.push({ paths: ['/usr/bin/systemctl'], packages: ['systemd'], kind: 'executable', reason: 'existing retained systemctl target' })
    for (const [path, target] of Object.entries(links)) f.link(path, target)
    for (const owner of [...new Set(Object.values(owners))].sort()) {
      const copyrightPath = `/usr/share/doc/${owner}/copyright`
      f.write(copyrightPath, 'fixture license\n')
      let paths = new Set([...Object.entries(owners).filter(([, pkg]) => pkg === owner).map(([p]) => p), copyrightPath])
      paths = new Set([...paths, ...[...paths].flatMap(parents)])
      writeFileSync(this.in(`info/${owner}.list`), [...paths].sort().join('\n') + '\n')
      appendFileSync(this.in('manifest.tsv'), `${owner}\t1\tamd64\n`)
      appendFileSync(this.in('upstream.tsv'), `${owner}\t1\tamd64\t` + 'e'.repeat(64) + `\thttps://example.invalid/${owner}.deb\tmica-system\n`)
      appendFileSync(this.in('sources.tsv'), `${owner}\t${owner}\t1\n`)
    }
    f.writeRules()
    return { operators, resources, links, expected }
  }

  bootstrapDevice(name = 'console', major = 5, minor = 1, mode = 0o666): string {
    const path = join(this.f.root, 'dev', name)
    mkdirSync(dirname(path), { recursive: true })
    mknodChr(path, mode, major, minor)
    return path
  }

  systemdMasks(withDevice = true): { masks: string[], unit: string } {
    const f = this.f
    const masks = ['cryptdisks-early', 'cryptdisks', 'hwclock', 'x11-common'].map(name => '/usr/lib/systemd/system/' + name + '.service')
    const unit = '/usr/lib/systemd/system/basic.target'
    f.write(unit, '[Unit]\nDescription=Required ordinary unit\n')
    const licensePath = '/usr/share/doc/systemd/copyright'
    f.write(licensePath, 'systemd fixture license\n')
    for (const path of masks) f.link(path, '/dev/null')
    writeFileSync(this.in('info/systemd.list'), ['/usr/lib/systemd', '/usr/lib/systemd/system', '/usr/share/doc/systemd', ...masks, unit, licensePath].join('\n') + '\n')
    for (const path of [this.in('manifest.tsv'), f.at('/usr/share/mica/manifest.tsv')]) appendFileSync(path, 'systemd\t257\tamd64\n')
    appendFileSync(this.in('upstream.tsv'), 'systemd\t257\tamd64\t' + 'e'.repeat(64) + '\thttps://example.invalid/systemd.deb\tmica-system\n')
    appendFileSync(this.in('sources.tsv'), 'systemd\tsystemd\t257\n')
    const system = f.rules.consumers['mica-system']!
    system.roots.push({ paths: [...masks, unit], packages: ['systemd'], kind: 'resource', reason: 'units, live udev rules, PAM and D-Bus resources' })
    system.runtime_links.push(...policy().consumers['mica-system']!.runtime_links.filter(row => masks.includes(row.path)))
    if (withDevice) this.bootstrapDevice('null', 1, 3)
    f.writeRules()
    return { masks, unit }
  }

  publicMetadata(marker?: Uint8Array): void {
    const producer = 'src/rootfs/build.ts public-meta staging; compose-install.sh meta_install'
    // Every declared public file: the manifest and the product record.
    for (const rule of policy().consumers['mica-system']!.roots.filter(r => r.generated === producer)) this.f.rules.consumers['mica-system']!.roots.push(rule)
    this.f.writeRules()
    this.f.write('/usr/share/mica/meta/updates/manifest.json', readFileSync(join(REPO, 'meta.example/updates/manifest.json')))
    this.f.write('/usr/lib/mica/product.conf', 'PRODUCT=fixture\nBOARD=fixture\nPROFILE=dev\nFEATURES=""\nCOMPONENTS=""\n')
    if (marker !== undefined) this.f.write('/usr/share/mica/meta/GENERATED', marker)
  }

  readlineConfiguration(): void {
    const rule = policy().consumers['mica-wifi']!.roots.find(r => r.paths.includes('/etc/inputrc'))!
    this.f.rules.consumers['mica-system']!.roots.push(rule)
    this.f.writeRules()
    this.f.write('/etc/inputrc', 'fixture readline defaults\n')
    this.capture()
  }
}
