// Exercise actual ELF files, filesystem objects and the selector CLI offline.
// The port of tests/gates/rootfs-runtime/selection_test.py (deleted 2026-09-22), case for case.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getxattr, lchown, removexattr, setxattr } from '../../../src/rootfs/runtime/fsx.ts'
import { bytes, CAP, copy2, elf, Fixture, get, hex, loaderCache, mkfifo, pathsOf, policy, preload, readlink, REPO, rowsOf, run, text, utimeNs, walk } from './fixture.ts'

beforeAll(async () => {
  await preload(['/etc/tmpfiles.d/mica-var.conf', '/etc/systemd/system/mica-load-extensions.service',
    '/etc/systemd/system/usr-local-lib-systemd-system.mount', '/etc/systemd/system/etc-containers-systemd.mount'])
})

describe('runtime selection', () => {
  let f: Fixture
  beforeEach(() => { f = new Fixture() })
  afterEach(() => { f.cleanup() })

  test('positive offline metadata and provenance', () => {
    const report = f.selected()
    const rows = rowsOf(report)
    for (const path of ['/usr/lib/libsecond.so', '/usr/lib/loader.so', '/usr/bin/sh', '/usr/bin/helper', '/etc/generated.conf']) {
      expect(rows.has(path)).toBe(true)
      expect((rows.get(path)!.reasons as unknown[]).length).toBeGreaterThan(0)
      expect((rows.get(path)!.origins as unknown[]).length).toBeGreaterThan(0)
    }
    for (const path of ['/usr/bin/unselected', '/usr/lib/debug/app.debug', '/usr/lib/udev/hwdb.bin', '/usr/lib/modules/modules.dep']) {
      expect(rows.has(path)).toBe(false)
      expect(existsSync(f.at(path))).toBe(true)
    }
    const external = new Set((get(report, 'external_inputs') as { path: string }[]).map(r => r.path))
    expect(external.has('/usr/lib/debug/app.debug')).toBe(true)
    expect(external.has('/usr/lib/modules/modules.dep')).toBe(true)
    const seed = f.outAt('/var/lib/seed'), alias = f.outAt('/var/lib/seed-alias')
    expect(statSync(seed).ino).toBe(statSync(alias).ino)
    const st = statSync(seed)
    expect([st.uid, st.gid, st.mode & 0o7777]).toEqual([123, 456, 0o640])
    expect(Buffer.from(getxattr(seed, 'user.fixture')).toString()).toBe('value')
    expect(Buffer.from(getxattr(f.outAt('/usr/bin/captool'), 'security.capability')).toString('hex')).toBe(CAP)
    expect(readlink(f.outAt('/etc/absolute'))).toBe('/var/lib/seed')
    expect(readlink(f.outAt('/etc/systemd/system-generators/systemd-ssh-generator'))).toBe('/dev/null')
    f.verified()
  })

  test('declaration family', () => {
    // A declaration keyed `mica-board-*` covers every mica-board-<b>: the member's own name is not in the file,
    // and in the family's rules the key stands for the member.
    f.write('/etc/mica/board.conf', 'board fact\n')
    f.write('/usr/share/doc/mica-board-fixture/copyright', 'board license\n')
    writeFileSync(join(f.db, 'mica-board-fixture.list'), '/etc/mica\n/etc/mica/board.conf\n/usr/share/doc/mica-board-fixture\n/usr/share/doc/mica-board-fixture/copyright\n')
    appendFileSync(f.manifest, 'mica-board-fixture\t1\tall\n')
    writeFileSync(f.packages, 'mica-system\nmica-board-fixture\n')
    f.rules.consumers['mica-board-*'] = {
      roots: [{ paths: ['/etc/mica/*.conf'], kind: 'resource', reason: 'board facts', packages: ['mica-board-*'] }],
      runtime_links: [] }
    const report = f.selected()
    expect(existsSync(f.outAt('/etc/mica/board.conf'))).toBe(true)
    expect(readFileSync(f.report, 'utf8')).toContain('mica-board-fixture')
    void report
    f.reset()
    writeFileSync(f.packages, 'mica-system\nmica-boardless\n')
    appendFileSync(f.manifest, 'mica-boardless\t1\tall\n')
    f.refuse('no runtime declaration: mica-boardless')
  })

  test('arm64 offline', () => {
    for (const p of walk(f.root)) {
      const at = f.at(p)
      const st = lstatSync(at)
      if (st.isSymbolicLink() || !st.isFile()) continue
      const data = readFileSync(at)
      if (data.subarray(0, 4).equals(Buffer.from('\x7fELF', 'latin1'))) { data.writeUInt16LE(183, 18); writeFileSync(at, data) }
    }
    setxattr(f.at('/usr/bin/captool'), 'security.capability', hex(CAP))
    writeFileSync(f.manifest, text(f.manifest).replaceAll('amd64', 'arm64'))
    renameSync(join(f.db, 'libfixture:amd64.list'), join(f.db, 'libfixture:arm64.list'))
    const r = f.command('select', { arch: 'arm64' })
    expect(r.exitCode, r.stderr).toBe(0)
  })

  test('missing elf interpreter', () => { f.unlink('/usr/lib/loader.so'); f.refuse('ELF interpreter') })
  test('missing recursive library', () => { f.unlink('/usr/lib/libsecond.so'); f.refuse('shared library libsecond.so') })
  test('missing script interpreter', () => { f.unlink('/usr/bin/sh'); f.refuse('script interpreter') })
  test('missing invoked helper', () => { f.unlink('/usr/bin/helper'); f.refuse('/usr/bin/helper') })
  test('missing generated state', () => { f.unlink('/etc/generated.conf'); f.refuse('/etc/generated.conf') })

  test('missing pam nss config license mountpoint', () => {
    for (const path of ['usr/lib/security/pam_fixture.so', 'usr/lib/libnss_fixture.so.2', 'etc/pam.d/login', 'etc/license', 'mnt/data'])
      f.withheld('/' + path, () => f.refuse('/' + path))
  })

  test('symlink escape', () => { f.unlink('/etc/relative'); f.link('/etc/relative', '../../outside'); f.refuse('path escape') })
  test('broken link', () => { f.unlink('/etc/relative'); f.link('/etc/relative', '/missing-target'); f.refuse('broken link') })
  test('symlink cycle', () => { f.unlink('/etc/relative'); f.link('/etc/relative', 'relative'); f.refuse('symlink cycle') })
  test('interpreter cycle', () => { f.write('/usr/bin/sh', '#!/usr/bin/entry\n', 0o755); f.refuse('interpreter cycle') })
  test('lost capability before selection', () => { removexattr(f.at('/usr/bin/captool'), 'security.capability'); f.refuse('security.capability') })

  test('verify detects metadata and payload losses', () => {
    const mutations: [string, () => void][] = [
      ['capability', () => removexattr(f.outAt('/usr/bin/captool'), 'security.capability')],
      ['mode', () => chmodSync(f.outAt('/usr/bin/helper'), 0o644)],
      ['uid', () => lchown(f.outAt('/var/lib/seed'), 0, 456)],
      ['mtime', () => utimeNs(f.outAt('/etc/generated.conf'), 0n)],
      ['digest', () => writeFileSync(f.outAt('/etc/generated.conf'), 'bad')],
      ['target', () => { rmSync(f.outAt('/etc/relative')); symlinkSync('/etc/license', f.outAt('/etc/relative')) }],
      ['hardlink', () => { rmSync(f.outAt('/var/lib/seed-alias')); copy2(f.outAt('/var/lib/seed'), f.outAt('/var/lib/seed-alias')) }],
    ]
    for (const [label, mutation] of mutations) {
      const report = f.selected(); mutation()
      if (label === 'hardlink') lchown(f.outAt('/var/lib/seed-alias'), 123, 456)
      for (const row of rowsOf(report).values()) if (row.type === 'directory') utimeNs(f.outAt(row.path as string), row.mtime_ns as bigint)
      const result = f.command('verify')
      expect(result.exitCode, label).not.toBe(0)
      expect(result.stderr, label).toContain(label === 'hardlink' ? 'hardlink changed' : 'changed')
      f.reset()
    }
  })

  test('ambiguous ownership', () => { writeFileSync(join(f.db, 'unused.list'), '/usr/bin/app\n'); f.refuse('ambiguous ownership') })
  test('unowned selected path', () => {
    const p = join(f.db, 'mica-system.list'); writeFileSync(p, text(p).replaceAll('/usr/bin/app\n', ''))
    f.refuse('no origin')
  })
  test('ambiguous inventory', () => { appendFileSync(f.manifest, 'mica-system\t2\tall\n'); f.refuse('duplicate package') })
  test('wrong architecture', () => { f.write('/usr/lib/libsecond.so', elf({ machine: 183 })); f.refuse('ELF architecture') })
  test('lost executable bit', () => { chmodSync(f.at('/usr/bin/helper'), 0o644); f.refuse('not executable') })
  test('missing feature declaration', () => { writeFileSync(f.packages, 'mica-system\nnew-feature\n'); f.refuse('no runtime declaration') })
  test('runtime link requires generator', () => { f.unlink('/etc/tmpfiles.d/mica-var.conf'); f.refuse('/etc/tmpfiles.d/mica-var.conf') })

  test('accounting links retain generator and resources', () => {
    const links = f.accountingLinks()
    const rows = rowsOf(f.selected())
    for (const link of links) {
      expect(rows.get(link.path)!.runtime_link).toEqual(link)
      expect(rows.get(link.path)!.target).toBe(link.target)
      for (const required of link.requires) {
        expect(rows.get(required)!.type).toBe('file')
        expect((rows.get(required)!.origins as unknown[]).length).toBeGreaterThan(0)
      }
    }
    for (const dependency of ['/usr/lib/libfirst.so', '/usr/lib/libsecond.so', '/usr/lib/loader.so']) expect(rows.has(dependency)).toBe(true)
    expect(rows.get('/usr/bin/systemd-tmpfiles')!.mode).toBe(0o755n)
    f.verified()
  })

  test('accounting links refuse missing dependencies', () => {
    f.accountingLinks()
    for (const path of ['/usr/bin/systemd-tmpfiles', '/usr/lib/systemd/system/systemd-tmpfiles-setup.service', '/etc/tmpfiles.d/mica-var.conf', '/etc/license'])
      f.withheld(path, () => f.refuse(path))
  })

  test('declared runtime links reject file and directory substitutions', () => {
    for (const path of ['/etc/systemd/system-generators/systemd-ssh-generator', '/var/log/wtmp']) {
      const at = f.at(path)
      const target = readlink(at)
      for (const kind of ['file', 'directory']) {
        rmSync(at)
        if (kind === 'file') f.write(path, path.endsWith('generator') ? elf() : bytes('persistent accounting data'), 0o755)
        else mkdirSync(at)
        try { f.refuse('runtime link must be a symlink: ' + path) }
        finally {
          rmSync(at, { recursive: true })
          symlinkSync(target, at)
          f.reset()
        }
      }
    }
    const rows = rowsOf(f.selected())
    for (const link of f.rules.consumers['mica-system']!.runtime_links) {
      expect(rows.get(link.path)!.type).toBe('symlink')
      expect(rows.get(link.path)!.target).toBe(link.target)
      expect(rows.get(link.path)!.runtime_link).toEqual(link)
    }
  })

  test('runtime link declaration is itself required', () => {
    const declaration = f.rules.consumers['mica-system']!
    for (const rule of declaration.roots) rule.paths = rule.paths.filter(p => p !== '/var/log/wtmp')
    declaration.roots = declaration.roots.filter(rule => rule.paths.length > 0)
    const rows = rowsOf(f.selected())
    expect(rows.has('/var/log/wtmp')).toBe(true)
    expect(rows.has('/etc/tmpfiles.d/mica-var.conf')).toBe(true)
    f.reset()
    f.unlink('/etc/tmpfiles.d/mica-var.conf')
    f.refuse('/etc/tmpfiles.d/mica-var.conf')
  })

  test('runtime link declaration uses canonical parent', () => {
    f.link('/etc-alias', 'etc')
    f.captureOwnership()
    f.rules.consumers['mica-system']!.runtime_links[0]!.path = '/etc-alias/systemd/system-generators/systemd-ssh-generator'
    const rows = rowsOf(f.selected())
    const path = '/etc/systemd/system-generators/systemd-ssh-generator'
    expect(get(rows.get(path)!, 'runtime_link', 'target')).toBe('/dev/null')
    expect(rows.get('/etc-alias')!.target).toBe('etc')
    f.reset()
    f.unlink(path)
    f.write(path, elf(), 0o755)
    f.refuse('runtime link must be a symlink: ' + path)
  })

  test('runtime link canonical alias is ambiguous', () => {
    f.link('/etc-alias', 'etc')
    f.captureOwnership()
    const links = f.rules.consumers['mica-system']!.runtime_links
    links.push({ ...links[0]!, path: '/etc-alias/systemd/system-generators/systemd-ssh-generator' })
    f.refuse('duplicate runtime link')
  })

  test('multi package roots require each ownership list', () => {
    f.write('/usr/share/doc/unused/copyright', 'operator tool copyright')
    writeFileSync(join(f.db, 'unused.list'), '/usr/bin/unselected\n/usr/share/doc/unused\n/usr/share/doc/unused/copyright\n')
    f.rules.consumers['mica-system']!.roots.push({
      packages: ['mica-system', 'unused'], paths: ['/usr/bin/*'],
      kind: 'executable', reason: 'selected operator tools from two required installed packages',
    })
    const rows = rowsOf(f.selected())
    expect(rows.get('/usr/bin/unselected')!.origins).toEqual([{ package: 'unused', version: '1', architecture: 'all' }])
    f.reset()
    rmSync(join(f.db, 'unused.list'))
    f.refuse('missing ownership list: unused')
    expect(existsSync(f.out)).toBe(false)
  })

  test('selected consumer requires ownership capture', () => { rmSync(join(f.db, 'mica-system.list')); f.refuse('missing ownership list: mica-system') })

  test('unrequired package ownership may be omitted', () => {
    rmSync(join(f.db, 'unused.list'))
    expect(pathsOf(f.selected()).has('/usr/bin/unselected')).toBe(false)
  })

  test('native ownership capture must be unambiguous', () => {
    copyFileSync(join(f.db, 'libfixture:amd64.list'), join(f.db, 'libfixture.list'))
    f.refuse('duplicate ownership list: libfixture')
  })

  test('undeclared runtime link', () => { f.rules.consumers['mica-system']!.runtime_links.pop(); f.refuse('broken link') })

  test('output overlap or symlink', () => {
    f.refuse('overlap', { output: join(f.root, 'output') })
    symlinkSync(join(f.base, 'elsewhere'), f.out); f.refuse('symlink')
  })

  test('output not empty', () => {
    mkdirSync(f.out); writeFileSync(join(f.out, 'sentinel'), 'preserve')
    f.refuse('empty'); expect(text(join(f.out, 'sentinel'))).toBe('preserve')
  })

  test('env shebang and missing command', () => {
    f.write('/usr/bin/env', elf(), 0o755)
    f.write('/usr/bin/entry', '#!/usr/bin/env sh\nhelper\n', 0o755)
    f.captureOwnership(); f.selected()
    f.reset()
    f.write('/usr/bin/entry', '#!/usr/bin/env -S sh -e\n', 0o755)
    f.refuse('unsupported env shebang')
  })

  test('rpath inherited but runpath not inherited', () => {
    for (const tag of ['rpath', 'runpath'] as const) {
      f.write('/usr/bin/app', elf({ needed: ['libprivate.so'], [tag]: '$ORIGIN/../private' }), 0o755)
      f.write('/usr/private/libprivate.so', elf({ needed: ['libchild.so'] }))
      f.write('/usr/private/libchild.so', elf())
      f.captureOwnership()
      if (tag === 'rpath') { f.selected(); f.reset() }
      else { f.refuse('shared library libchild.so') }
    }
  })

  test('ambiguous library context', () => {
    f.write('/usr/bin/app', elf({ needed: ['libfirst.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libfirst.so', elf())
    f.write('/usr/bin/helper', elf({ needed: ['libfirst.so'] }), 0o755)
    f.captureOwnership(); f.refuse('ambiguous library')
  })

  test('elf entry direct siblings are discovered before children', () => {
    f.write('/usr/bin/app', elf({ needed: ['libcore.so', 'libshared.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libcore.so', elf({ needed: ['libshared.so'] }))
    f.write('/usr/private/libshared.so', elf())
    f.captureOwnership()
    const rows = rowsOf(f.selected())
    expect(rows.has('/usr/private/libcore.so')).toBe(true)
    expect(rows.has('/usr/private/libshared.so')).toBe(true)
    f.verified()
  })

  test('elf entry soname alias is loaded without synthetic file', () => {
    f.write('/usr/bin/app', elf({ needed: ['libcore.so', 'libprovider.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libcore.so', elf({ needed: ['libalias.so'] }))
    f.write('/usr/private/libprovider.so', elf({ soname: 'libalias.so' }))
    f.captureOwnership()
    const rows = rowsOf(f.selected())
    expect(rows.has('/usr/private/libprovider.so')).toBe(true)
    expect(rows.has('/usr/private/libalias.so')).toBe(false)
    expect(existsSync(f.at('/usr/private/libalias.so'))).toBe(false)
    f.verified()
  })

  test('elf entry loaded provider cannot hide missing transitive library', () => {
    f.write('/usr/bin/app', elf({ needed: ['libcore.so', 'libprovider.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libcore.so', elf({ needed: ['libalias.so'] }))
    f.write('/usr/private/libprovider.so', elf({ soname: 'libalias.so', needed: ['libabsent.so'] }))
    f.captureOwnership(); f.refuse('shared library libabsent.so')
  })

  test('elf entry missing direct sibling is not supplied by context', () => {
    f.write('/usr/bin/app', elf({ needed: ['libcore.so', 'libshared.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libcore.so', elf({ needed: ['libshared.so'] }))
    f.captureOwnership(); f.refuse('shared library libshared.so')
  })

  test('elf entry independent root cannot borrow retained namespace', () => {
    f.write('/usr/bin/app', elf({ needed: ['libcore.so', 'libshared.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libcore.so', elf({ needed: ['libshared.so'] }))
    f.write('/usr/private/libshared.so', elf())
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/usr/private/libcore.so'], kind: 'resource', reason: 'independent ELF entry' })
    f.captureOwnership(); f.refuse('shared library libshared.so for /usr/private/libcore.so')
  })

  test('elf entry keeps first discovery context', () => {
    f.write('/usr/bin/app', elf({ needed: ['liba.so', 'libb.so'] }), 0o755)
    f.write('/usr/lib/liba.so', elf({ needed: ['libcommon.so'], runpath: '/usr/private' }))
    f.write('/usr/lib/libb.so', elf({ needed: ['libcommon.so'], rpath: '/usr/private:/usr/child' }))
    f.write('/usr/private/libcommon.so', elf({ needed: ['libchild.so'] }))
    f.write('/usr/child/libchild.so', elf())
    f.captureOwnership(); f.refuse('shared library libchild.so')
  })

  test('elf entry soname conflict across independent entries is refused', () => {
    f.write('/usr/bin/app', elf({ needed: ['liba.so'] }), 0o755)
    f.write('/usr/lib/liba.so', elf({ soname: 'libalias.so' }))
    f.write('/usr/bin/helper', elf({ needed: ['libb.so'] }), 0o755)
    f.write('/usr/lib/libb.so', elf({ soname: 'libalias.so' }))
    f.captureOwnership(); f.refuse('ambiguous library libalias.so')
  })

  test('elf entry loaded soname does not mask ambiguous cache', () => {
    f.write('/usr/bin/app', elf({ needed: ['libprovider.so', 'libalias.so'] }), 0o755)
    f.write('/usr/lib/libprovider.so', elf({ soname: 'libalias.so' }))
    f.write('/etc/ld.so.cache', loaderCache([['libalias.so', '/usr/lib/libfirst.so'], ['libalias.so', '/usr/lib/libsecond.so']]))
    f.captureOwnership(); f.refuse('ambiguous cache library: libalias.so')
  })

  test('elf entry wrong architecture is not registered by soname', () => {
    f.write('/usr/bin/app', elf({ needed: ['libcore.so', 'libprovider.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libcore.so', elf({ needed: ['libalias.so'] }))
    f.write('/usr/private/libprovider.so', elf({ machine: 183, soname: 'libalias.so' }))
    f.captureOwnership(); f.refuse('ELF architecture')
  })

  test('elf entry breadth first discovers provider before grandchild', () => {
    f.write('/usr/bin/app', elf({ needed: ['liba.so', 'libb.so'], runpath: '/usr/private' }), 0o755)
    f.write('/usr/private/liba.so', elf({ needed: ['libchild.so'], runpath: '/usr/private' }))
    f.write('/usr/private/libb.so', elf({ needed: ['libshared.so'], runpath: '/usr/deep' }))
    f.write('/usr/private/libchild.so', elf({ needed: ['libshared.so'] }))
    f.write('/usr/deep/libshared.so', elf({ soname: 'libshared.so' }))
    f.captureOwnership()
    const paths = pathsOf(f.selected())
    expect(paths.has('/usr/private/libchild.so')).toBe(true)
    expect(paths.has('/usr/deep/libshared.so')).toBe(true)
    f.verified()
  })

  test('elf entry dependency cycle is bounded', () => {
    f.write('/usr/lib/libsecond.so', elf({ needed: ['libfirst.so'] }))
    f.captureOwnership()
    const paths = pathsOf(f.selected())
    expect(paths.has('/usr/lib/libfirst.so')).toBe(true)
    expect(paths.has('/usr/lib/libsecond.so')).toBe(true)
    f.verified()
  })

  test('elf soname invalid names are refused', () => {
    for (const name of ['', '.', '..', '/usr/lib/libfirst.so', 'lib/name', 'lib\tname', 'lib name', '$ORIGIN']) {
      f.write('/usr/lib/libfirst.so', elf({ soname: name }))
      f.refuse('invalid ELF SONAME')
    }
  })

  test('elf soname duplicate tag is refused', () => {
    const data = Buffer.from(elf({ needed: ['libsecond.so'], soname: 'libfirst.so' }))
    data.writeBigUInt64LE(14n, 512 + 2 * 16)
    f.write('/usr/lib/libfirst.so', data)
    f.refuse('ambiguous ELF dynamic tag')
  })

  test('elf soname string bounds and utf8 are checked', () => {
    for (const mutation of ['bounds', 'termination', 'utf8']) {
      const data = Buffer.from(elf({ soname: 'libfirst.so' }))
      if (mutation === 'bounds') data.writeBigUInt64LE(BigInt(data.length), 512 + 2 * 16 + 8)
      else if (mutation === 'termination') data[1024 + '\0libfirst.so'.length] = 0xff
      else data[1025] = 0xff
      f.write('/usr/lib/libfirst.so', data)
      f.refuse(mutation === 'utf8' ? 'utf-8' : 'invalid ELF string')
    }
  })

  test('removed owned hwdb vendor enablement is not selected', () => {
    const unit = '/usr/lib/systemd/system/systemd-hwdb-update.service'
    const link = '/usr/lib/systemd/system/sysinit.target.wants/systemd-hwdb-update.service'
    const keep = '/usr/lib/systemd/system/required-fixture.service'
    f.write(unit, '[Service]\n')
    f.write(keep, '[Service]\n')
    f.link(link, '../systemd-hwdb-update.service')
    f.captureOwnership()
    f.unlink(unit); f.unlink(link)
    f.rules.consumers['mica-system']!.roots.push({
      packages: ['mica-system'], paths: ['/usr/lib/systemd/system/*.service', '/usr/lib/systemd/system/*.wants/*'],
      kind: 'resource', reason: 'owned units after the existing exact hwdb removal' })
    const paths = pathsOf(f.selected())
    expect(paths.has(keep)).toBe(true)
    expect(paths.has(unit)).toBe(false)
    expect(paths.has(link)).toBe(false)
  })

  test('unrelated missing owned unit is refused', () => {
    const path = '/usr/lib/systemd/system/required-fixture.service'
    f.write(path, '[Service]\n')
    f.captureOwnership()
    f.unlink(path)
    f.rules.consumers['mica-system']!.roots.push({ packages: ['mica-system'], paths: ['/usr/lib/systemd/system/*.service'], kind: 'resource', reason: 'unrelated required unit' })
    f.refuse('missing path: ' + path)
  })

  test('unrelated missing owned enablement is refused', () => {
    const path = '/usr/lib/systemd/system/sysinit.target.wants/required-fixture.service'
    f.link(path, '/etc/systemd/system/systemd-tmpfiles-setup.service')
    f.captureOwnership()
    f.unlink(path)
    f.rules.consumers['mica-system']!.roots.push({ packages: ['mica-system'], paths: ['/usr/lib/systemd/system/*.wants/*'], kind: 'resource', reason: 'unrelated required enablement' })
    f.refuse('missing path: ' + path)
  })

  test('removed hwdb vendor enablement cannot be an explicit root', () => {
    const path = '/usr/lib/systemd/system/sysinit.target.wants/systemd-hwdb-update.service'
    f.write('/usr/lib/systemd/system/systemd-hwdb-update.service', '[Service]\n')
    f.link(path, '../systemd-hwdb-update.service')
    f.captureOwnership()
    f.rules.consumers['mica-system']!.roots.push({ paths: [path], kind: 'resource', reason: 'accidental explicit selection' })
    f.refuse('excluded runtime payload: ' + path)
  })

  test('excluded payload cannot be a root', () => {
    for (const p of ['/usr/lib/udev/hwdb.bin', '/usr/lib/debug/app.debug', '/usr/lib/modules/modules.dep']) {
      f.rules.consumers['mica-system']!.roots.push({ paths: [p], kind: 'resource', reason: 'bad accidental selection' })
      f.refuse('excluded runtime payload')
      f.rules.consumers['mica-system']!.roots.pop()
    }
  })

  test('no recursive directory copy', () => {
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/usr'], kind: 'directory', reason: 'parent only' })
    f.selected(); expect(existsSync(f.outAt('/usr/bin/unselected'))).toBe(false)
  })

  test('loader cache precedes default directories', () => {
    f.write('/usr/private/libfirst.so', elf())
    f.write('/etc/ld.so.cache', loaderCache([['libfirst.so', '/usr/private/libfirst.so']]))
    f.captureOwnership()
    const paths = pathsOf(f.selected())
    expect(paths.has('/usr/private/libfirst.so')).toBe(true)
    expect(paths.has('/usr/lib/libfirst.so')).toBe(false)
    expect(paths.has('/etc/ld.so.cache')).toBe(true)
  })

  test('missing library in merged usr search directory falls through', () => {
    mkdirSync(f.at('/usr/lib/x86_64-linux-gnu'))
    f.captureOwnership()
    f.rules.library_dirs = ['/lib/x86_64-linux-gnu', '/usr/lib']
    f.selected()
  })

  test('invalid or ambiguous loader cache', () => {
    const cases: [Uint8Array, string][] = [[bytes('broken cache'), 'loader cache'],
      [loaderCache([['libfirst.so', '/usr/lib/libfirst.so'], ['libfirst.so', '/usr/lib/libsecond.so']]), 'ambiguous cache']]
    for (const [data, expected] of cases) { f.write('/etc/ld.so.cache', data); f.captureOwnership(); f.refuse(expected) }
  })

  test('symlink parent dotdot uses target directory', () => {
    mkdirSync(f.at('/var/deep'))
    f.link('/etc/dirlink', '/var/deep')
    f.write('/var/correct', 'correct target')
    f.unlink('/etc/relative'); f.link('/etc/relative', 'dirlink/../correct')
    f.captureOwnership(); f.selected()
    expect(text(f.outAt('/var/correct'))).toBe('correct target')
    expect(lstatSync(f.outAt('/var/deep')).isDirectory(), 'intermediate link target must survive even before ..').toBe(true)
  })

  test('elf interpreter cycle', () => { f.write('/usr/lib/loader.so', elf({ interp: '/usr/bin/app' }), 0o755); f.refuse('interpreter cycle') })

  test('owned executable patterns are not recursive', () => {
    f.write('/usr/bin/nested/not-a-root', elf(), 0o755)
    f.captureOwnership()
    f.rules.consumers['mica-system']!.roots.push({ packages: ['mica-system'], paths: ['/usr/bin/*'], kind: 'executable', reason: 'operator tools' })
    f.selected()
    expect(existsSync(f.outAt('/usr/bin/nested/not-a-root'))).toBe(false)
  })

  test('owned executable lost mode', () => {
    f.rules.consumers['mica-system']!.roots = [{ packages: ['mica-system'], paths: ['/usr/bin/helper'], kind: 'executable', reason: 'helper' }]
    chmodSync(f.at('/usr/bin/helper'), 0o644)
    f.refuse('not executable')
  })

  test('owned payload missing is not a smaller selection', () => {
    f.rules.consumers['mica-system']!.roots = [{ packages: ['mica-system'], paths: ['/usr/bin/*'], kind: 'executable', reason: 'tools' }]
    f.unlink('/usr/bin/helper')
    f.refuse('/usr/bin/helper')
  })

  test('missing contributing package copyright', () => {
    f.selected(); f.reset()
    f.unlink('/usr/share/doc/libfixture/copyright')
    f.refuse('/usr/share/doc/libfixture/copyright')
  })

  test('missing env command', () => {
    f.write('/usr/bin/env', elf(), 0o755)
    f.write('/usr/bin/entry', '#!/usr/bin/env missingcommand\n', 0o755)
    f.captureOwnership(); f.refuse('missing env command')
  })

  test('relative loader path rejected', () => {
    f.write('/usr/bin/app', elf({ needed: ['libfirst.so'], runpath: 'relative' }), 0o755)
    f.refuse('invalid absolute path')
  })

  test('child runpath overrides inherited rpath', () => {
    f.write('/usr/bin/app', elf({ needed: ['libprivate.so'], rpath: '/usr/private' }), 0o755)
    f.write('/usr/private/libprivate.so', elf({ needed: ['libchild.so'], runpath: '/usr/child' }))
    f.write('/usr/private/libchild.so', elf())
    f.write('/usr/child/libchild.so', elf())
    f.captureOwnership(); f.selected()
    expect(existsSync(f.outAt('/usr/child/libchild.so'))).toBe(true)
    expect(existsSync(f.outAt('/usr/private/libchild.so'))).toBe(false)
  })

  test('undeclared loader preload rejected', () => {
    f.write('/etc/ld.so.preload', '/usr/lib/libfirst.so\n')
    f.captureOwnership(); f.refuse('loader preload')
  })

  test('unsupported node', () => { f.unlink('/usr/bin/helper'); mkfifo(f.at('/usr/bin/helper')); f.refuse('unsupported node') })

  function readlineResources(radios: string[] = []): void {
    const shippedPolicy = policy()
    const resource = shippedPolicy.consumers['mica-system']!.roots.find(r => r.paths.includes('/etc/login.defs'))!
    f.rules.consumers = { 'mica-system': { roots: [resource], runtime_links: [] } }
    const owners: Record<string, string> = { 'tzdata': '/usr/share/zoneinfo/Etc/UTC', 'ncurses-base': '/usr/share/terminfo/x/xterm',
      'login.defs': '/etc/login.defs', 'libaudit-common': '/etc/libaudit.conf' }
    if (radios.length > 0) {
      owners['readline-common'] = '/usr/share/readline/inputrc'
      f.write('/etc/inputrc', 'readline configuration\n')
    }
    for (const [pkg, path] of Object.entries(owners)) {
      f.write(path, pkg === 'readline-common' ? 'readline configuration\n' : 'required resource\n')
      f.write('/usr/share/doc/' + pkg + '/copyright', 'fixture license\n')
    }
    f.captureOwnership()
    const system = join(f.db, 'mica-system.list')
    const transferred = new Set(['/etc/inputrc', ...Object.values(owners), ...Object.keys(owners).map(p => '/usr/share/doc/' + p + '/copyright')])
    writeFileSync(system, text(system).split('\n').filter(p => p !== '' && !transferred.has(p)).map(p => p + '\n').join(''))
    for (const [pkg, path] of Object.entries(owners)) {
      appendFileSync(f.manifest, pkg + '\t1\tall\n')
      writeFileSync(join(f.db, pkg + '.list'), path + '\n/usr/share/doc/' + pkg + '/copyright\n')
    }
    for (const radio of radios) {
      appendFileSync(f.manifest, radio + '\t1\tall\n')
      writeFileSync(join(f.db, radio + '.list'), '/.\n')
      const rules = shippedPolicy.consumers[radio]!.roots.filter(r => r.paths.includes('/usr/share/readline/inputrc') || r.paths.includes('/etc/inputrc'))
      expect(rules.length).toBe(2)
      f.rules.consumers[radio] = { roots: rules, runtime_links: [] }
    }
    writeFileSync(f.packages, ['mica-system', ...radios].join('\n') + '\n')
  }

  test('readline is not required without radios', () => {
    readlineResources()
    f.selected()
    expect(lstatSync(f.outAt('/etc/login.defs')).isFile()).toBe(true)
    expect(existsSync(f.outAt('/etc/inputrc'))).toBe(false)
  })

  function selectedReadline(radios: string[]): void {
    readlineResources(radios)
    const rows = rowsOf(f.selected())
    expect(readFileSync(f.outAt('/etc/inputrc'))).toEqual(readFileSync(f.outAt('/usr/share/readline/inputrc')))
    expect(['mode', 'uid', 'gid'].map(k => rows.get('/etc/inputrc')![k])).toEqual([0o644n, 0n, 0n])
    expect((rows.get('/etc/inputrc')!.origins as unknown[]).length).toBeGreaterThan(0)
    f.verified()
  }

  test('readline wifi resource', () => selectedReadline(['mica-wifi']))
  test('readline bluetooth resource', () => selectedReadline(['mica-bluetooth']))
  test('readline shared radio resource', () => selectedReadline(['mica-wifi', 'mica-bluetooth']))

  test('readline missing owner refuses', () => {
    readlineResources(['mica-wifi'])
    writeFileSync(f.manifest, text(f.manifest).replaceAll('readline-common\t1\tall\n', ''))
    rmSync(join(f.db, 'readline-common.list'))
    f.refuse('root package not installed: readline-common')
  })

  test('readline missing template refuses', () => {
    readlineResources(['mica-wifi'])
    f.unlink('/usr/share/readline/inputrc')
    f.refuse('missing path: /usr/share/readline/inputrc')
  })

  test('readline missing generated resource refuses', () => {
    readlineResources(['mica-bluetooth'])
    f.unlink('/etc/inputrc')
    f.refuse('missing path: /etc/inputrc')
  })

  test('readline unrelated owner remains required', () => {
    readlineResources()
    writeFileSync(f.manifest, text(f.manifest).replaceAll('tzdata\t1\tall\n', ''))
    rmSync(join(f.db, 'tzdata.list'))
    f.refuse('root package not installed: tzdata')
  })

  test('readline unrelated resource remains required', () => {
    readlineResources()
    f.unlink('/usr/share/zoneinfo/Etc/UTC')
    f.refuse('missing path: /usr/share/zoneinfo/Etc/UTC')
  })

  test('disabled nftables unit survives runtime selection', () => {
    const path = '/usr/lib/systemd/system/nftables.service'
    f.write(path, '[Service]\nExecStart=/usr/bin/app\n')
    f.write('/usr/share/doc/nftables/copyright', 'nftables license\n')
    appendFileSync(f.manifest, 'nftables\t1\tall\n')
    writeFileSync(join(f.db, 'nftables.list'), path + '\n/usr/lib/systemd/system\n/usr/share/doc/nftables\n/usr/share/doc/nftables/copyright\n')
    f.rules.consumers['mica-system']!.roots.push(...policy().consumers['mica-system']!.roots.filter(r => r.paths.includes(path)))
    const rows = rowsOf(f.selected())
    expect(rows.has(path)).toBe(true)
    expect(readFileSync(f.outAt(path))).toEqual(readFileSync(f.at(path)))
    expect(existsSync(f.outAt('/etc/systemd/system/sysinit.target.wants/nftables.service'))).toBe(false)
  })

  test('empty mqtt enrollment directory survives runtime selection', () => {
    const path = '/usr/lib/mica/mqtt-applications.d'
    mkdirSync(f.at(path), { recursive: true })
    f.write('/usr/share/doc/mica-mqttd/copyright', 'mqtt license\n')
    appendFileSync(f.manifest, 'mica-mqttd\t1\tall\n')
    writeFileSync(join(f.db, 'mica-mqttd.list'), path + '\n/usr/lib/mica\n/usr/share/doc/mica-mqttd\n/usr/share/doc/mica-mqttd/copyright\n')
    appendFileSync(f.packages, 'mica-mqttd\n')
    f.rules.consumers['mica-mqttd'] = {
      roots: [...policy().consumers['mica-mqttd']!.roots.filter(r => r.paths.includes(path)),
        { paths: ['/usr/share/doc/mica-mqttd/copyright'], kind: 'resource', reason: 'fixture package license' }],
      runtime_links: [] }
    const rows = rowsOf(f.selected())
    expect(rows.has(path)).toBe(true)
    expect(lstatSync(f.outAt(path)).isDirectory()).toBe(true)
    expect(walk(f.outAt(path))).toEqual([])
  })

  test('bluez uses the current libexec entrypoint', () => {
    const path = '/usr/libexec/bluetooth/bluetoothd'
    f.write(path, elf(), 0o755)
    f.write('/usr/bin/bluetoothctl', elf(), 0o755)
    f.write('/usr/share/doc/bluez/copyright', 'bluez license\n')
    appendFileSync(f.manifest, 'bluez\t5.82-1.1\tamd64\nmica-bluetooth\t1\tall\n')
    writeFileSync(join(f.db, 'bluez.list'), path + '\n/usr/libexec\n/usr/libexec/bluetooth\n/usr/bin/bluetoothctl\n/usr/share/doc/bluez\n/usr/share/doc/bluez/copyright\n')
    writeFileSync(join(f.db, 'mica-bluetooth.list'), '/.\n')
    appendFileSync(f.packages, 'mica-bluetooth\n')
    f.rules.consumers['mica-bluetooth'] = { roots: policy().consumers['mica-bluetooth']!.roots.filter(r => r.kind === 'executable'), runtime_links: [] }
    const rows = rowsOf(f.selected())
    expect(rows.has(path)).toBe(true)
    expect(readFileSync(f.outAt(path))).toEqual(readFileSync(f.at(path)))
    expect(existsSync(f.outAt('/usr/lib/bluetooth'))).toBe(false)
  })

  test('s905 bluetooth keeps bridge dynamic library and board data', () => {
    const bridge = '/usr/sbin/skw_vhci_bridge'
    const library = '/usr/lib/bluetooth/plugins/libskwbt.so'
    const data = ['/etc/bluetooth/skwbt.conf', '/etc/bluetooth/sv6160.nvbin', '/etc/bluetooth/sv6160lite.nvbin', '/etc/bluetooth/sv6316.nvbin']
    f.write(bridge, elf(), 0o755)
    f.write(library, elf({ needed: ['libfirst.so'] }))
    for (const path of data) f.write(path, 'board bluetooth input\n')
    const license = '/usr/share/doc/mica-s905x5m-bluetooth/copyright'
    f.write(license, 'board license\n')
    appendFileSync(f.manifest, 'mica-s905x5m-bluetooth\t1\tall\n')
    const owned = [bridge, library, ...data, license, '/usr/sbin', '/usr/lib/bluetooth', '/usr/lib/bluetooth/plugins', '/etc/bluetooth', '/usr/share/doc/mica-s905x5m-bluetooth']
    writeFileSync(join(f.db, 'mica-s905x5m-bluetooth.list'), owned.join('\n') + '\n')
    appendFileSync(f.packages, 'mica-s905x5m-bluetooth\n')
    f.rules.consumers['mica-s905x5m-bluetooth'] = {
      roots: [...policy().consumers['mica-s905x5m-bluetooth']!.roots.filter(r => [bridge, library, ...data].some(p => r.paths.includes(p))),
        { paths: [license], kind: 'resource', reason: 'fixture board license' }],
      runtime_links: [] }
    const rows = rowsOf(f.selected())
    for (const path of [bridge, library, ...data]) {
      expect(rows.has(path)).toBe(true)
      expect(readFileSync(f.outAt(path))).toEqual(readFileSync(f.at(path)))
    }
    f.verified()
  })

  function retainedNamedResources(): Set<string> {
    const wanted = [['tzdata'], ['debianutils', 'bash', 'dash'], ['e2fsprogs']].map(p => JSON.stringify(p))
    const roots = policy().consumers['mica-system']!.roots.filter(r => r.kind === 'resource' && r.packages !== undefined && wanted.includes(JSON.stringify(r.packages)))
    f.rules.consumers['mica-system']!.roots.push(...roots)
    const owners: Record<string, string[]> = {
      tzdata: ['/usr/share/zoneinfo/iso3166.tab', '/usr/share/zoneinfo/Europe/London'],
      debianutils: ['/usr/share/debianutils/shells'], bash: ['/usr/share/debianutils/shells.d/bash'],
      dash: ['/usr/share/debianutils/shells.d/dash'], e2fsprogs: ['/etc/e2scrub.conf'] }
    for (const [owner, paths] of Object.entries(owners)) {
      f.write('/usr/share/doc/' + owner + '/copyright', 'fixture license\n')
      for (const path of paths) f.write(path, 'configured retained tool resource\n')
    }
    f.captureOwnership()
    const system = join(f.db, 'mica-system.list')
    const transferred = new Set(Object.values(owners).flat())
    writeFileSync(system, text(system).split('\n').filter(p => p !== '' && !transferred.has(p)).map(p => p + '\n').join(''))
    for (const [owner, paths] of Object.entries(owners)) {
      appendFileSync(f.manifest, owner + '\t1\tall\n')
      writeFileSync(join(f.db, owner + '.list'), paths.join('\n') + '\n')
    }
    return transferred
  }

  test('retained named resources without python', () => {
    const required = retainedNamedResources()
    const rows = pathsOf(f.selected())
    expect([...required].every(p => rows.has(p))).toBe(true)
    expect([...rows].some(p => p.includes('python'))).toBe(false)
    f.verified()
  })

  test('retained named resources missing input refuses', () => {
    const required = retainedNamedResources()
    for (const path of [...required].sort()) f.withheld(path, () => f.refuse(path))
  })

  test('current policy declares all selected consumers', () => {
    const shippedPolicy = policy()
    // The packages a root installs: every pin but the separate components (the lifecycle runkit, the unsigned loader).
    const apart = ['mica-lifecycle', 'mica-systemd-boot']
    const rows = run([process.execPath, join(REPO, 'src/cli.ts'), 'pool', 'rows'])
    expect(rows.exitCode, rows.stderr).toBe(0)
    const consumers = new Set(rows.stdout.split('\n').filter(l => l !== '' && !apart.some(a => l.startsWith(a))).map(l => l.split('\t')[0]!))
    // And the packages this tree's own producers declare (tools/deb/producers.sh): the board and radio packages
    // are rows of the pool only once make board-pool has built them, and the policy names them whether or not
    // this checkout has.
    const producers = run(['bash', join(REPO, 'tools/deb/producers.sh')])
    expect(producers.exitCode, producers.stderr).toBe(0)
    for (const line of producers.stdout.split('\n').filter(l => l !== '')) for (const p of line.split(/\s+/)[3]!.split(',')) consumers.add(p)
    // The policy and the pins know the same consumers, where a family entry `<prefix>-*` of the policy covers
    // the pinned members it names.
    const family = (k: string, name: string): boolean => k.endsWith('-*') && name.startsWith(k.slice(0, -1)) && name.length > k.length - 1
    const covered = (name: string, names: Set<string>): boolean => names.has(name) || [...names].some(k => family(k, name) || family(name, k))
    const policyNames = new Set(Object.keys(shippedPolicy.consumers))
    expect([...policyNames].filter(n => !covered(n, consumers))).toEqual([])
    expect([...consumers].filter(n => !covered(n, policyNames))).toEqual([])
    for (const [name, consumer] of Object.entries(shippedPolicy.consumers)) expect(consumer.roots.length, name).toBeGreaterThan(0)
    const explicit = new Set(shippedPolicy.consumers['mica-system']!.roots.flatMap(r => r.paths))
    for (const p of ['/usr/bin/bash', '/usr/sbin/dropbear', '/usr/lib/mica/mica-dropbear-prestart', '/usr/bin/systemctl',
      '/etc/systemd/system/mica-load-extensions.service', '/etc/tmpfiles.d/mica-var.conf']) expect(explicit.has(p), p).toBe(true)
    expect(new Set(shippedPolicy.consumers['mica-podman']!.roots.flatMap(r => r.paths)).has('/usr/libexec/podman/quadlet')).toBe(true)
  })

  test('current extension and accounting resources', () => {
    const anchors = ['/etc/systemd/system/mica-load-extensions.service', '/etc/systemd/system/usr-local-lib-systemd-system.mount',
      '/etc/systemd/system/etc-containers-systemd.mount', '/etc/tmpfiles.d/mica-var.conf']
    for (const path of anchors) f.write(path, f.shippedSync(path))
    f.write('/usr/libexec/podman/quadlet', elf(), 0o755)
    anchors.push('/usr/libexec/podman/quadlet')
    f.rules.consumers['mica-system']!.roots.push({ paths: anchors, kind: 'resource', reason: 'current residual policy resources' })
    f.captureOwnership(); f.selected()
    for (const path of anchors) expect(readFileSync(f.at(path))).toEqual(readFileSync(f.outAt(path)))
    f.reset()
    for (const path of anchors) f.withheld(path, () => f.refuse(path))
    const mask = f.at('/etc/systemd/system-generators/systemd-ssh-generator')
    rmSync(mask); symlinkSync('/usr/bin/sh', mask)
    f.refuse('runtime link target changed')
  })
})
