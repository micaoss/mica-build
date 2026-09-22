// Exercise the final packing entry against real small installed trees.
// The port of tests/gates/rootfs-runtime/composition_test.py (deleted 2026-09-22), case for case.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getxattr, lchown } from '../../../src/rootfs/runtime/fsx.ts'
import { parse } from '../../../src/rootfs/runtime/pyjson.ts'
import { bytes, canonicalLine, Composition, copy2, elf, type Fixture, get, lexists, loaderCache, mkfifo, mknodChr, PACKAGE_VERSION, pathsOf, policy, preload, readlink, REPO, rowsOf, run, SELECT, sha256, text, utimeNs, type Obj } from './fixture.ts'

beforeAll(async () => {
  await preload(['/etc/tmpfiles.d/mica-var.conf', '/etc/systemd/system/mica-load-extensions.service',
    '/etc/systemd/system/usr-local-lib-systemd-system.mount', '/etc/systemd/system/etc-containers-systemd.mount'])
})

/** shipped bytes, through the fixture's preloaded cache. */
function shippedSync(c: Composition, path: string): Uint8Array {
  return c.f.shippedSync(path)
}

describe('runtime composition', () => {
  let c: Composition
  let f: Fixture
  const extra: Composition[] = []
  beforeEach(() => { c = new Composition(); f = c.f })
  afterEach(() => { c.cleanup(); for (const e of extra.splice(0)) e.cleanup() })
  const fresh = (): Composition => { const e = new Composition(); extra.push(e); return e }

  test('package owned docker alias composes with target and helpers', () => {
    const entries = c.podmanAlias()
    c.capture()
    const report = c.composed()
    const rows = rowsOf(report)
    const row = rows.get('/usr/bin/docker')!
    expect([row.type, row.target, row.mode, row.uid, row.gid]).toEqual(['symlink', 'podman', 0o777n, 0n, 0n])
    expect(get(report, 'provenance', 'files', '/usr/bin/docker', 'archives', 0, 'package')).toBe('mica-podman')
    expect(readlink(f.outAt('/usr/bin/docker'))).toBe('podman')
    for (const path of entries) expect(readFileSync(f.outAt(path))).toEqual(readFileSync(f.at(path)))
    f.verified()
  })

  test('package owned docker alias preserves refusals', () => {
    const cases: [string, string][] = [['owner', 'empty owned runtime roots'], ['wrong-owner', 'empty owned runtime roots'],
      ['target', 'required target changed'], ['mode', 'required mode changed'],
      ['missing-target', 'missing path:'], ['interpreter', 'missing path:'],
      ['library', 'unresolved shared library'], ['unrelated', 'operator executable omitted:']]
    for (const [mutation, expected] of cases) {
      const x = fresh()
      x.podmanAlias()
      if (mutation === 'owner' || mutation === 'wrong-owner') {
        const owner = x.in('info/mica-podman.list')
        writeFileSync(owner, text(owner).replaceAll('/usr/bin/docker\n', ''))
        if (mutation === 'wrong-owner') appendFileSync(x.in('info/unused.list'), '/usr/bin/docker\n')
      }
      else if (mutation === 'target') { x.f.unlink('/usr/bin/docker'); x.f.link('/usr/bin/docker', 'crun') }
      else if (mutation === 'mode') {
        // Linux symlink modes are fixed; a conflicting required mode must refuse.
        const roots = x.f.rules.consumers['mica-podman']!.roots
        roots[roots.length - 1]!.expect!.mode = 0o755
      }
      else if (mutation === 'missing-target' || mutation === 'interpreter' || mutation === 'library') {
        const path = { 'missing-target': 'usr/bin/podman', 'interpreter': 'usr/lib/podman-loader.so', 'library': 'usr/lib/libpodman-fixture.so' }[mutation]
        x.f.unlink('/' + path)
      }
      else {
        x.f.link('/usr/bin/unexpected-podman-alias', 'podman')
        appendFileSync(x.in('info/mica-podman.list'), '/usr/bin/unexpected-podman-alias\n')
      }
      x.f.writeRules()
      x.capture()
      const result = x.compose()
      expect(result.exitCode, mutation).not.toBe(0)
      expect(result.stderr, mutation).toContain(expected)
      expect(existsSync(x.f.report), mutation).toBe(false)
    }
  })

  test('retained operator companions compose with native resources', () => {
    const { operators, links, expected } = c.operatorCompanions()
    c.capture()
    const report = c.composed()
    const rows = rowsOf(report)
    expect([...expected].every(p => rows.has(p))).toBe(true)
    for (const [path, [owner, target]] of Object.entries(operators)) {
      expect(rows.get(path)!.mode).toBe(target ? 0o777n : 0o755n)
      expect([rows.get(path)!.uid, rows.get(path)!.gid]).toEqual([0n, 0n])
      expect((rows.get(path)!.origins as Obj[]).filter(o => 'package' in o).map(o => o.package)).toContain(owner)
      if (target) expect(readlink(f.outAt(path))).toBe(target)
      else expect(readFileSync(f.outAt(path))).toEqual(readFileSync(f.at(path)))
    }
    for (const [path, target] of Object.entries(links)) {
      expect(readlink(f.outAt(path))).toBe(target)
      expect((rows.get(path)!.origins as Obj[]).some(o => 'generated' in o)).toBe(true)
    }
    for (const path of ['usr/bin/dpkg', 'usr/bin/dpkg-query', 'usr/bin/apt-get', 'usr/bin/perl', 'var/lib/dpkg']) expect(lexists(join(f.out, path))).toBe(false)
    f.verified()
  })

  test('retained operator companions preserve refusals', () => {
    const cases: Record<string, string> = { 'owner': 'empty owned runtime roots', 'wrong-owner': 'empty owned runtime roots',
      'script-interpreter': 'missing path:', 'device': 'unsupported node:', 'mode': 'required mode changed',
      'target': 'required target changed', 'target-missing': 'No such file or directory',
      'interpreter': 'missing path:', 'library': 'unresolved shared library',
      'resource': 'missing path:', 'rc-target': 'required target changed',
      'omitted': 'operator executable omitted:', 'package-manager': 'operator executable omitted:',
      'database': 'build residue selected:' }
    for (const [mutation, message] of Object.entries(cases)) {
      const x = fresh()
      x.operatorCompanions()
      if (mutation === 'owner' || mutation === 'wrong-owner') {
        const p = x.in('info/dpkg.list')
        writeFileSync(p, text(p).replaceAll('/usr/bin/dpkg-realpath\n', ''))
        if (mutation === 'wrong-owner') appendFileSync(x.in('info/unused.list'), '/usr/bin/dpkg-realpath\n')
      }
      else if (mutation === 'script-interpreter') { x.f.write('/usr/sbin/service', '#!/usr/bin/missing-shell\n', 0o755) }
      else if (mutation === 'device') {
        x.capture()
        const path = x.f.at('/dev/unexpected')
        mkdirSync(dirname(path), { recursive: true })
        mkfifo(path)
        x.f.rules.consumers['mica-system']!.roots.push({ paths: ['/dev/unexpected'], kind: 'resource', reason: 'negative special node', generated: 'negative fixture' })
      }
      else if (mutation === 'mode') { chmodSync(x.f.at('/usr/bin/dpkg-realpath'), 0o700) }
      else if (mutation === 'target' || mutation === 'rc-target') {
        const path = mutation === 'target' ? '/usr/sbin/halt' : '/etc/rc2.d/S01dbus'
        x.f.unlink(path)
        x.f.link(path, mutation === 'target' ? '../bin/resolvectl' : '../init.d/procps')
      }
      else if (['target-missing', 'interpreter', 'library', 'resource'].includes(mutation)) {
        const path = { 'target-missing': 'usr/bin/resolvectl', 'interpreter': 'usr/lib/operator-loader.so', 'library': 'usr/lib/liboperator.so', 'resource': 'etc/default/dbus' }[mutation]!
        x.f.unlink('/' + path)
      }
      else if (mutation === 'omitted' || mutation === 'package-manager') { x.f.link(mutation === 'omitted' ? '/usr/bin/unexpected-alias' : '/usr/bin/dpkg', 'systemctl') }
      else {
        x.f.write('/var/lib/dpkg/status', 'fixture forbidden database\n')
        x.f.rules.consumers['mica-system']!.roots.push({ paths: ['/var/lib/dpkg', '/var/lib/dpkg/status'], kind: 'resource', reason: 'negative forbidden database', generated: 'negative fixture' })
      }
      x.f.writeRules()
      if (mutation !== 'device') x.capture()
      const result = x.compose()
      expect(result.exitCode, mutation).not.toBe(0)
      expect(result.stderr, mutation).toContain(message)
      expect(existsSync(x.f.report), mutation).toBe(false)
    }
  })

  function assertSystemdMasksCompose(withDevice: boolean): void {
    const { masks, unit } = c.systemdMasks(withDevice)
    c.capture()
    const report = c.composed()
    const rows = rowsOf(report)
    expect(rows.has(unit)).toBe(true)
    expect(readFileSync(f.outAt(unit))).toEqual(readFileSync(f.at(unit)))
    for (const path of masks) {
      const row = rows.get(path)!
      expect([row.type, row.target, row.mode, row.uid, row.gid]).toEqual(['symlink', '/dev/null', 0o777n, 0n, 0n])
      expect(get(row, 'runtime_link', 'generator')).toBe('kernel devtmpfs')
      expect(get(report, 'provenance', 'files', path, 'archives', 0, 'package')).toBe('systemd')
      expect(readlink(f.outAt(path))).toBe('/dev/null')
    }
    expect(rows.has('/dev/null')).toBe(false)
    expect(lexists(f.outAt('/dev/null'))).toBe(false)
    f.verified()
  }

  test('systemd masks compose without copying device', () => assertSystemdMasksCompose(true))
  test('systemd masks compose without disposable device', () => assertSystemdMasksCompose(false))

  test('systemd masks preserve strict refusals', () => {
    const cases: [string, string][] = [['target', 'runtime link target changed'], ['owner', 'no origin:'], ['unit', 'missing path:'], ['undeclared', 'unsupported node:']]
    for (const [mutation, expected] of cases) {
      const x = fresh()
      const { masks, unit } = x.systemdMasks()
      if (mutation === 'target') { x.f.unlink(masks[0]!); x.f.link(masks[0]!, '/dev/zero') }
      else if (mutation === 'owner') { const owner = x.in('info/systemd.list'); writeFileSync(owner, text(owner).replaceAll(masks[0]! + '\n', '')) }
      else if (mutation === 'unit') { x.f.unlink(unit) }
      else {
        const extraUnit = '/usr/lib/systemd/system/undeclared.service'
        x.f.link(extraUnit, '/dev/null')
        appendFileSync(x.in('info/systemd.list'), extraUnit + '\n')
        const roots = x.f.rules.consumers['mica-system']!.roots
        roots[roots.length - 1]!.paths.push(extraUnit)
        x.f.writeRules()
      }
      x.capture()
      const result = x.compose()
      expect(result.exitCode, mutation).not.toBe(0)
      expect(result.stderr, mutation).toContain(expected)
      expect(existsSync(x.f.report), mutation).toBe(false)
    }
  })

  test('missing swapped or malformed lineage refuses', () => {
    c.capture()
    const path = c.in('source-lineage.json')
    const original = readFileSync(path)
    for (const mutation of ['missing', 'epoch', 'architecture', 'unknown', 'duplicate', 'pool']) {
      writeFileSync(path, original)
      if (mutation === 'missing') { rmSync(path) }
      else if (mutation === 'duplicate') { writeFileSync(path, original.toString('latin1').replace('{', '{"schema":"duplicate",'), 'latin1') }
      else {
        const value = parse(original.toString()) as Obj
        if (mutation === 'epoch') value.root_epoch = (value.root_epoch as bigint) + 1n
        if (mutation === 'architecture') value.architecture = 'arm64'
        if (mutation === 'unknown') value.waiver = true
        if (mutation === 'pool') (get(value, 'pool', 'files') as Obj).Packages = '0'.repeat(64)
        writeFileSync(path, canonicalLine(value))
      }
      const r = c.compose()
      expect(r.exitCode, mutation).not.toBe(0)
      expect(r.stderr, mutation).toContain('lineage')
      expect(existsSync(f.report), mutation).toBe(false)
    }
  })

  test('lineage is captured and retained in runtime provenance', () => {
    c.capture()
    const record = get(c.composed(), 'provenance')
    expect(get(record, 'source_lineage')).toEqual(parse(text(c.in('source-lineage.json'))))
    expect(get(record, 'capture_sha256', 'source-lineage.json')).toBe(sha256(readFileSync(c.in('source-lineage.json'))))
  })

  test('bootstrap devices are captured but never shipped', () => {
    const devices: Record<string, [number, number]> = { console: [5, 1], full: [1, 7], null: [1, 3], ptmx: [5, 2], random: [1, 8], tty: [5, 0], urandom: [1, 9], zero: [1, 5] }
    for (const [name, [major, minor]] of Object.entries(devices)) c.bootstrapDevice(name, major, minor)
    c.capture()
    const rows = parse(text(c.in('configured.json'))) as Obj
    for (const [name, [major, minor]] of Object.entries(devices)) {
      const row = rows['/dev/' + name] as Obj
      expect(row.type).toBe('bootstrap-character-device')
      expect([row.major, row.minor, row.mode, row.uid, row.gid]).toEqual([BigInt(major), BigInt(minor), 0o666n, 0n, 0n])
      expect('mtime_ns' in row).toBe(true)
      expect('xattrs' in row).toBe(true)
    }
    const report = c.composed()
    expect(Object.keys(devices).every(name => !existsSync(join(f.out, 'dev', name)))).toBe(true)
    expect((get(report, 'files') as Obj[]).every(row => ['file', 'directory', 'symlink'].includes(row.type as string))).toBe(true)
  })

  test('selected bootstrap device still refuses', () => {
    c.bootstrapDevice()
    c.capture()
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/dev/console'], kind: 'resource', reason: 'invalid shipped device', generated: 'fixture' })
    f.writeRules()
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('unsupported node:')
    expect(r.stderr).toContain('/dev/console')
    expect(existsSync(f.report)).toBe(false)
  })

  function transferred(): string {
    const copy = join(f.base, 'transferred')
    mkdirSync(copy)
    const archive = join(f.base, 'tree.tar')
    let r = run(['tar', '-C', f.root, '--numeric-owner', '--xattrs', '--xattrs-include=*', '-cf', archive, '.'], { timeout: 15000 })
    expect(r.exitCode, r.stderr).toBe(0)
    r = run(['tar', '-C', copy, '--same-owner', '--xattrs', '--xattrs-include=*', '-xf', archive], { timeout: 15000 })
    expect(r.exitCode, r.stderr).toBe(0)
    return copy
  }

  test('bootstrap device transfer checks inode metadata', () => {
    c.bootstrapDevice()
    c.capture()
    const copy = transferred()
    let r = c.command('compare', { root: copy, snapshot: c.in('configured.json') })
    expect(r.exitCode, r.stderr).toBe(0)
    expect(lstatSync(join(copy, 'dev/console')).isCharacterDevice()).toBe(true)
    utimeNs(join(copy, 'dev/console'), 1000000000n)
    r = c.command('compare', { root: copy, snapshot: c.in('configured.json') })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('installation transfer changed')
  })

  test('snapshot refuses unrelated special nodes', () => {
    for (const relative of ['dev/other-device', 'var/lib/device']) {
      const path = join(f.root, relative)
      mkdirSync(dirname(path), { recursive: true })
      mknodChr(path, 0o666, 5, 1)
      const r = c.command('snapshot', { root: f.root, output: c.in('refused.json') })
      expect(r.exitCode, relative).not.toBe(0)
      expect(r.stderr, relative).toContain('unsupported node:')
      expect(existsSync(c.in('refused.json'))).toBe(false)
      rmSync(path)
    }
    const path = join(f.root, 'dev/console')
    mkfifo(path)
    const r = c.command('snapshot', { root: f.root, output: c.in('refused.json') })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('unsupported node:')
  })

  test('snapshot refuses changed bootstrap device identity', () => {
    for (const [major, minor, mode, uid] of [[1, 3, 0o666, 0], [5, 1, 0o600, 0], [5, 1, 0o666, 123]] as [number, number, number, number][]) {
      const path = c.bootstrapDevice('console', major, minor, mode)
      lchown(path, uid, 0)
      const r = c.command('snapshot', { root: f.root, output: c.in('refused.json') })
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toContain('bootstrap device identity')
      expect(existsSync(c.in('refused.json'))).toBe(false)
      rmSync(path)
    }
  })

  test('pack entry selects real paths and metadata', () => {
    c.capture()
    f.write('/var/lib/dpkg/status', 'build database')
    f.write('/mica-compose/archive.deb', 'build archive')
    f.write('/.debian-extra/bootstrap', 'bootstrap')
    f.write('/usr/lib/udev/hwdb.bin', 'hwdb')
    const report = c.composed()
    expect(lstatSync(f.outAt('/usr/bin/app')).isFile()).toBe(true)
    for (const path of ['var/lib/dpkg', 'mica-compose', '.debian-extra', 'usr/lib/udev/hwdb.bin', 'usr/lib/debug', 'usr/lib/modules/modules.dep']) expect(existsSync(join(f.out, path)), path).toBe(false)
    expect(readlink(f.outAt('/etc/systemd/system-generators/systemd-ssh-generator'))).toBe('/dev/null')
    expect(readlink(f.outAt('/var/log/wtmp'))).toBe('/run/mica/wtmp')
    expect(statSync(f.outAt('/var/lib/seed')).ino).toBe(statSync(f.outAt('/var/lib/seed-alias')).ino)
    expect(statSync(f.outAt('/var/lib/seed')).uid).toBe(123)
    expect(Buffer.from(getxattr(f.outAt('/var/lib/seed'), 'user.fixture')).toString()).toBe('value')
    expect(getxattr(f.outAt('/usr/bin/captool'), 'security.capability')).toEqual(getxattr(f.at('/usr/bin/captool'), 'security.capability'))
    expect(text(f.outAt('/usr/share/mica/manifest.tsv'))).not.toContain('unused\t')
    expect(new Set((get(report, 'provenance', 'build_packages') as Obj[]).map(p => p.package))).toEqual(new Set(['mica-system', 'libfixture', 'unused']))
    expect(new Set((get(report, 'provenance', 'shipped_packages') as Obj[]).map(p => p.package))).toEqual(new Set(['mica-system', 'libfixture']))
    expect(get(report, 'measurements', 'unique_file_bytes') as bigint).toBeLessThan(get(report, 'measurements', 'apparent_file_bytes') as bigint)
    expect(get(report, 'measurements', 'runtime_allocation')).toBe('pending B7 guest evidence')
    const check = run([process.execPath, SELECT, 'verify', '--root', f.out, '--report', f.report])
    expect(check.exitCode, check.stderr).toBe(0)
  })

  test('accounting link capture preserves producer identity', () => {
    const links = f.accountingLinks()
    f.writeRules()
    writeFileSync(c.in('info/mica-system.list'), readFileSync(join(f.db, 'mica-system.list')))
    c.capture()
    const report = c.composed()
    const rows = rowsOf(report)
    const snapshot = parse(text(c.in('configured.json'))) as Obj
    for (const link of links) {
      expect(rows.get(link.path)!.runtime_link).toEqual(link)
      for (const path of link.requires) {
        expect(rows.get(path)!.sha256).toBe(get(snapshot, path, 'sha256'))
        expect(rows.get(path)!.origins).toContainEqual({ package: 'mica-system', version: PACKAGE_VERSION, architecture: 'all' })
      }
    }
    expect(get(report, 'provenance', 'capture_sha256', 'configured.json')).toBe(sha256(readFileSync(c.in('configured.json'))))
  })

  test('optimizer cache is excluded while loader state survives', () => {
    const cache = loaderCache([['libfirst.so', '/usr/lib/libfirst.so']])
    f.write('/etc/ld.so.cache', cache)
    f.write('/usr/sbin/ldconfig', elf(), 0o755)
    f.write('/var/cache/ldconfig/aux-cache', 'host-specific optimizer state\n')
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/etc/ld.so.cache', '/usr/sbin/ldconfig'], kind: 'resource', reason: 'runtime dynamic loader state and maintenance tool' })
    f.writeRules()
    f.captureOwnership()
    writeFileSync(c.in('info/mica-system.list'), readFileSync(join(f.db, 'mica-system.list')))
    c.capture()
    const report = c.composed()
    expect(existsSync(f.outAt('/var/cache/ldconfig/aux-cache'))).toBe(false)
    expect(readFileSync(f.outAt('/etc/ld.so.cache')).toString('hex')).toBe(Buffer.from(cache).toString('hex'))
    expect(statSync(f.outAt('/usr/sbin/ldconfig')).mode & 0o111).not.toBe(0)
    const rows = pathsOf(report)
    expect(rows.has('/etc/ld.so.cache')).toBe(true)
    expect(rows.has('/usr/sbin/ldconfig')).toBe(true)
    expect(rows.has('/var/cache/ldconfig/aux-cache')).toBe(false)
  })

  test('missing required path is not filtered', () => { c.capture(); f.unlink('/usr/bin/app'); c.refused('missing path') })
  test('missing archive identity refuses', () => { c.capture(); writeFileSync(c.in('upstream.tsv'), ''); c.refused('archive identity') })
  test('surviving operator omission refuses', () => { c.capture(); f.write('/usr/bin/unselected', elf(), 0o755); c.refused('operator executable omitted: /usr/bin/unselected') })

  test('post transform hash and debug counterpart', () => {
    c.capture()
    const before = sha256(readFileSync(f.at('/usr/bin/app')))
    f.write('/usr/bin/app', elf(), 0o755)
    const after = sha256(readFileSync(f.at('/usr/bin/app')))
    const debug = join(c.debug, '.build-id/ab/cd.debug')
    mkdirSync(dirname(debug), { recursive: true })
    writeFileSync(debug, 'fixture symbols')
    writeFileSync(join(c.debug, 'manifest.tsv'), `/usr/bin/app\tabcd\t.build-id/ab/cd.debug\t2048\t2048\t${after}\n`)
    const provenance = get(c.composed(), 'provenance', 'files', '/usr/bin/app')
    expect(get(provenance, 'configured', 'sha256')).toBe(before)
    expect(get(provenance, 'final', 'sha256')).toBe(after)
    expect(get(provenance, 'debug', 'sha256')).toBe(sha256(readFileSync(debug)))
  })

  test('debug mismatch refuses', () => {
    c.capture()
    writeFileSync(join(c.debug, 'manifest.tsv'), '/usr/bin/app\tabcd\t.build-id/ab/cd.debug\t2048\t2048\t' + '0'.repeat(64) + '\n')
    c.refused('debug counterpart')
  })

  test('explicit residue rule is refused', () => {
    f.write('/var/lib/dpkg/status', 'build database')
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/var/lib/dpkg', '/var/lib/dpkg/status'], kind: 'resource', reason: 'invalid build-state root', generated: 'fixture' })
    f.writeRules()
    c.capture()
    c.refused('build residue selected')
  })

  test('transfer compares hardlinks and capabilities', () => {
    c.capture()
    const copy = transferred()
    let r = c.command('compare', { root: copy, snapshot: c.in('configured.json') })
    expect(r.exitCode, r.stderr).toBe(0)
    const alias = join(copy, 'var/lib/seed-alias'), saved = join(copy, 'var/lib/seed')
    rmSync(alias)
    copy2(saved, alias)
    lchown(alias, 123, 456)
    r = c.command('compare', { root: copy, snapshot: c.in('configured.json') })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('transfer changed')
  })

  test('native alternative capture retains exact alias', () => {
    f.link('/usr/bin/fixture-alias', '/etc/alternatives/fixture-alias')
    f.link('/etc/alternatives/fixture-alias', '/usr/bin/helper')
    writeFileSync(c.in('alternatives/fixture-alias'), 'Name: fixture-alias\nLink: /usr/bin/fixture-alias\nStatus: auto\nBest: /usr/bin/helper\nValue: /usr/bin/helper\n\nAlternative: /usr/bin/helper\nPriority: 1\n')
    c.capture()
    c.composed()
    expect(readlink(f.outAt('/etc/alternatives/fixture-alias'))).toBe('/usr/bin/helper')
  })

  test('native enablement retains configured link', () => {
    const link = '/etc/systemd/system/multi-user.target.wants/fixture.service'
    const target = '/usr/lib/systemd/system/fixture.service'
    f.write(target, '[Service]\nExecStart=/usr/bin/helper\n')
    f.link(link, target)
    f.captureOwnership()
    const native = join(f.db, 'mica-system.list')
    writeFileSync(native, text(native).replaceAll(link + '\n', ''))
    writeFileSync(c.in('info/mica-system.list'), readFileSync(native))
    writeFileSync(c.in('enablement/fixture.service.dsh-also'), link + '\n')
    c.capture()
    c.composed()
    expect(readlink(f.outAt(link))).toBe(target)
  })

  test('lost configured enablement refuses', () => {
    const link = '/etc/systemd/system/multi-user.target.wants/fixture.service'
    f.link(link, '/usr/bin/helper')
    writeFileSync(c.in('enablement/fixture.service.dsh-also'), link + '\n')
    c.capture()
    f.unlink(link)
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('missing path')
  })

  test('preset removal uses exact record and retained policy', () => {
    const link = '/etc/systemd/system/multi-user.target.wants/fixture.service'
    const preset = '/usr/lib/systemd/system-preset/fixture.preset'
    f.write(preset, 'disable fixture.service\n')
    f.link(link, '/usr/bin/helper')
    f.captureOwnership()
    const native = join(f.db, 'mica-system.list')
    writeFileSync(native, text(native).replaceAll(link + '\n', ''))
    writeFileSync(c.in('info/mica-system.list'), readFileSync(native))
    writeFileSync(c.in('enablement/fixture.service.dsh-also'), link + '\n')
    c.capture()
    f.unlink(link)
    writeFileSync(c.in('preset-removed.tsv'), link + '\t' + preset + '\n')
    c.composed()
    expect(lexists(f.outAt(link))).toBe(false)
    expect(text(f.outAt(preset))).toBe('disable fixture.service\n')
  })

  test('alternative manual slave needs exact install exclusion', () => {
    f.link('/usr/bin/fixture-alias', '/etc/alternatives/fixture-alias')
    f.link('/etc/alternatives/fixture-alias', '/usr/bin/helper')
    writeFileSync(c.in('alternatives/fixture-alias'), 'Name: fixture-alias\nLink: /usr/bin/fixture-alias\nSlaves:\n fixture-alias.1.gz /usr/share/man/man1/fixture-alias.1.gz\nStatus: auto\nBest: /usr/bin/helper\nValue: /usr/bin/helper\n\nAlternative: /usr/bin/helper\nPriority: 1\nSlaves:\n fixture-alias.1.gz /usr/share/man/man1/helper.1.gz\n')
    writeFileSync(c.in('dpkg-slim.conf'), 'path-exclude /usr/share/man/*\n')
    c.capture()
    c.composed()
    expect(existsSync(f.outAt('/usr/share/man'))).toBe(false)
  })

  test('current policy resources survive final composition', () => {
    const anchors = ['/etc/systemd/system/mica-load-extensions.service', '/etc/systemd/system/usr-local-lib-systemd-system.mount',
      '/etc/systemd/system/etc-containers-systemd.mount', '/etc/tmpfiles.d/mica-var.conf']
    for (const path of anchors) f.write(path, shippedSync(c, path))
    f.rules.consumers['mica-system']!.roots.push({ paths: anchors, kind: 'resource', reason: 'current policy resources' })
    f.writeRules()
    f.captureOwnership()
    writeFileSync(c.in('info/mica-system.list'), readFileSync(join(f.db, 'mica-system.list')))
    c.capture()
    c.composed()
    for (const path of anchors) expect(readFileSync(f.outAt(path)).toString('hex')).toBe(Buffer.from(shippedSync(c, path)).toString('hex'))
  })

  test('readline generated configuration binds capture and final bytes', () => {
    c.readlineConfiguration()
    const row = get(c.composed(), 'provenance', 'files', '/etc/inputrc')
    const digest = sha256(readFileSync(f.at('/etc/inputrc')))
    expect(get(row, 'configured', 'sha256')).toBe(digest)
    expect(get(row, 'final', 'sha256')).toBe(digest)
    expect(['mode', 'uid', 'gid'].map(k => get(row, 'final', k))).toEqual([0o644n, 0n, 0n])
    f.verified()
  })

  test('lost generated readline configuration refuses', () => {
    c.readlineConfiguration()
    f.unlink('/etc/inputrc')
    c.refused('missing path: /etc/inputrc')
  })

  test('generated login profile survives final composition', () => {
    // base-files installs /etc/profile from its postinst, so no ownership list names it.
    const rule = policy().consumers['mica-system']!.roots.find(r => r.paths.includes('/etc/profile'))!
    expect('generated' in rule).toBe(true)
    f.rules.consumers['mica-system']!.roots.push(rule)
    f.writeRules()
    f.write('/etc/profile', 'fixture login shell defaults\n')
    c.capture()
    c.composed()
    expect(text(f.outAt('/etc/profile'))).toBe('fixture login shell defaults\n')
  })

  test('owned profile fragment survives final composition', () => {
    const rule = policy().consumers['mica-system']!.roots.find(r => r.paths.includes('/etc/profile.d/*.sh'))!
    expect(rule.packages).toEqual(['mica-system'])
    f.write('/etc/profile.d/mica-shell.sh', 'fixture interactive shell profile\n')
    f.rules.consumers['mica-system']!.roots.push(rule)
    f.writeRules()
    f.captureOwnership()
    writeFileSync(c.in('info/mica-system.list'), readFileSync(join(f.db, 'mica-system.list')))
    c.capture()
    c.composed()
    expect(text(f.outAt('/etc/profile.d/mica-shell.sh'))).toBe('fixture interactive shell profile\n')
  })

  test('current public manifest and conditional marker survive', () => {
    c.publicMetadata(bytes('DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n'))
    c.capture()
    const report = c.composed()
    for (const path of ['/usr/share/mica/meta/updates/manifest.json', '/usr/share/mica/meta/GENERATED', '/usr/lib/mica/product.conf']) {
      expect(readFileSync(f.outAt(path))).toEqual(readFileSync(f.at(path)))
      const provenance = get(report, 'provenance', 'files', path)
      expect(get(provenance, 'configured', 'sha256')).toBe(get(provenance, 'final', 'sha256'))
      expect(get(provenance, 'generators')).toEqual(['rootfs/build.sh public-meta staging; compose-install.sh meta_install'])
      expect(get(provenance, 'final', 'mode')).toBe(0o644n)
    }
  })

  test('absent public marker stays absent', () => {
    c.publicMetadata()
    c.capture()
    c.composed()
    expect(existsSync(f.outAt('/usr/share/mica/meta/GENERATED'))).toBe(false)
  })

  test('changed or lost public input refuses', () => {
    c.publicMetadata(bytes('DEVELOPMENT-GRADE\nDOMAINS=boot\n'))
    c.capture()
    f.unlink('/usr/share/mica/meta/GENERATED')
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('public metadata')
  })

  test('public manifest tamper refuses', () => {
    c.publicMetadata()
    c.capture()
    f.write('/usr/share/mica/meta/updates/manifest.json', '{}')
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('public metadata')
  })

  test('empty installed public marker refuses', () => {
    c.publicMetadata(bytes(''))
    c.capture()
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('public metadata')
  })

  test('uncaptured public metadata refuses', () => {
    f.write('/usr/share/mica/meta/fixture.json', '{}')
    c.capture()
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('undeclared public metadata: /usr/share/mica/meta/fixture.json')
  })

  test('unknown public metadata directory refuses', () => {
    c.publicMetadata()
    mkdirSync(f.at('/usr/share/mica/meta/unapproved'))
    c.capture()
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('undeclared public metadata: /usr/share/mica/meta/unapproved')
  })

  test('missing native producer capture refuses', () => {
    writeFileSync(c.in('enablement/fixture.service.dsh-also'), '/etc/systemd/system/fixture.service\n')
    c.capture()
    rmSync(c.in('enablement/fixture.service.dsh-also'))
    const r = c.compose()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('captured native outputs changed: enablement')
  })

  test('allocated bytes measure the selected destination', () => {
    const sparse = f.at('/var/lib/sparse')
    const fd = openSync(sparse, 'w')
    writeSync(fd, Buffer.from('x'), 0, 1, 1024 * 1024)
    closeSync(fd)
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/var/lib/sparse'], kind: 'resource', reason: 'sparse fixture', generated: 'fixture' })
    f.writeRules()
    c.capture()
    const report = c.composed()
    const groups = new Set((get(report, 'files') as Obj[]).filter(r => r.type === 'file').map(r => r.hardlink as string))
    let actual = 0n
    for (const p of groups) actual += statSync(f.outAt(p), { bigint: true }).blocks * 512n
    expect(get(report, 'measurements', 'allocated_file_bytes')).toBe(actual)
  })

  test('packed measurement binds prefix and complete image', () => {
    c.capture()
    c.composed()
    const data = Buffer.from('fixture compressed root'), hashes = Buffer.from('fixture verity hash bytes')
    writeFileSync(join(f.base, 'rootfs-verity.img'), Buffer.concat([data, hashes]))
    writeFileSync(join(f.base, 'rootfs-verity.env'), `SQUASHFS_BYTES=${data.length}\nIMAGE_BYTES=${data.length + hashes.length}\n`)
    let r = c.command('measure-packed', { root: f.out, out: f.base })
    expect(r.exitCode, r.stderr).toBe(0)
    const m = get(parse(text(f.report)), 'measurements')
    expect(get(m, 'squashfs', 'sha256')).toBe(sha256(data))
    expect(get(m, 'verity_image', 'sha256')).toBe(sha256(Buffer.concat([data, hashes])))
    writeFileSync(f.outAt('/usr/bin/app'), 'changed')
    r = c.command('measure-packed', { root: f.out, out: f.base })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('metadata or bytes changed')
  })

  test('current transform exclusions are exact', () => {
    appendFileSync(join(f.db, 'mica-system.list'), '/usr/bin/systemd-hwdb\n/usr/sbin/pam_getenv\n')
    f.rules.consumers['mica-system']!.roots.push({ paths: ['/usr/bin/systemd-hwdb', '/usr/sbin/pam_getenv', '/usr/bin/app'], packages: ['mica-system'], kind: 'executable', reason: 'approved transformation survivors' })
    let r = f.command()
    expect(r.exitCode, r.stderr).toBe(0)
    f.reset()
    appendFileSync(join(f.db, 'mica-system.list'), '/usr/bin/required-new-tool\n')
    const roots = f.rules.consumers['mica-system']!.roots
    roots[roots.length - 1]!.paths.push('/usr/bin/required-new-tool')
    r = f.command()
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('required-new-tool')
  })

  test('actual docker pack uses final selection', () => {
    const dockerfile = text(join(REPO, 'stages/compose/90-pack.Dockerfile'))
    const selection = dockerfile.indexOf('bun /mica-runtime/compose.ts compose')
    const squash = dockerfile.indexOf('sh /mica-scripts/pack-squashfs.sh')
    expect(selection).toBeGreaterThanOrEqual(0)
    expect(selection).toBeLessThan(squash)
    const before = dockerfile.slice(0, selection)
    expect(before.slice(before.lastIndexOf('\n#'))).toContain('RUN --network=none')
    expect(dockerfile).toContain('COPY --from=pack /runtime/ /')
    expect(dockerfile).toContain('rootfs-report.runtime.json')
    expect(text(join(REPO, 'stages/compose/scripts/pack-squashfs.sh'))).toContain('mksquashfs /runtime ')
  })
})
