// The composer's lock rule, exercised through src/rootfs/lineage.ts (bun src/cli.ts lineage).
//
// A fixture repository that builds no package, a pool of declared-version archives, and a lock that imports
// mica-imported and mica-base; each source commit is the release row of the lock. Every refusal is by name;
// every acceptance writes a record that validates again on the way back in.
//
// The port of tests/gates/rootfs-runtime/source_lineage_test.py (deleted 2026-09-22), case for case.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { version } from '../../../src/release/version.ts'
import { lutimesNs } from '../../../src/rootfs/runtime/fsx.ts'
import { canonical, validate } from '../../../src/rootfs/runtime/lineage.ts'
import { compact, parse, type Value } from '../../../src/rootfs/runtime/pyjson.ts'
import { get, REPO, run, sha256, text, type Obj, type Run } from './fixture.ts'

const HELPER = join(REPO, 'src/rootfs/lineage.ts')

type Archive = { archive: string, sha: string, version: string, arch: string, repo: string, commit: string }
type Row = [string, string, string, string, string, string]

class Lineage {
  readonly work: string
  readonly tree: string
  readonly env: Record<string, string>
  readonly commitId: string
  readonly version: string
  readonly pool: string
  readonly importedCommit = 'b'.repeat(40)
  readonly importedVersion = '2.0.0-1'
  readonly baseCommit = 'c'.repeat(40)
  readonly archives = new Map<string, Archive>()
  rows: string[] = []
  output: string

  constructor() {
    this.work = mkdtempSync(join(tmpdir(), 'mica-lineage-'))
    this.tree = join(this.work, 'tree')
    mkdirSync(this.tree)
    this.env = { ...process.env as Record<string, string>, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-02T00:00:00Z' }
    for (const [name, content] of Object.entries({ '.gitignore': '_out/\n', 'Makefile': '# fixture\n', 'VERSION': '0.1.0\n' })) {
      const at = join(this.tree, name); mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, content)
    }
    this.must('git', 'init', '-q', this.tree)
    this.commit()
    this.commitId = this.must('git', '-C', this.tree, 'rev-parse', 'HEAD').trim()
    this.version = version(this.tree)
    this.pool = join(this.tree, '_out/debs/amd64')
    mkdirSync(join(this.pool, 'pool'), { recursive: true })
    this.build('mica-imported', this.importedVersion, 'amd64', 'mica-imported', this.importedCommit)
    this.build('mica-base', '1.0.0-mica1', 'all', 'mica-system-base', this.baseCommit)
    this.index()
    this.lock([['mica-imported', this.importedVersion, 'amd64', this.archives.get('mica-imported')!.sha, 'mica-imported', this.importedCommit]])
    this.output = join(this.work, 'lineage.json')
  }

  cleanup(): void {
    rmSync(this.work, { recursive: true, force: true })
  }

  must(...args: string[]): string {
    const result = run(args, { env: this.env })
    expect(result.exitCode, result.stderr).toBe(0)
    return result.stdout
  }

  commit(): void {
    this.must('git', '-C', this.tree, 'add', '.')
    this.must('git', '-C', this.tree, 'commit', '-qm', 'Freeze fixture')
  }

  build(name: string, version: string, arch: string, repo: string, commit: string, controlExtra = ''): void {
    const root = join(this.work, 'deb-' + name)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'DEBIAN'), { recursive: true })
    mkdirSync(join(root, 'usr/bin'), { recursive: true })
    writeFileSync(join(root, 'usr/bin', name), name + ' bytes\n')
    writeFileSync(join(root, 'DEBIAN/control'), `Package: ${name}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: Fixture <fixture@example.invalid>\n`
    + `Description: isolated package\nMica-Source-Repo: ${repo}\n${controlExtra}`)
    for (const old of readdirSync(join(this.pool, 'pool')).filter(f => f.startsWith(name + '_') && f.endsWith('.deb'))) rmSync(join(this.pool, 'pool', old))
    const archive = join(this.pool, 'pool', `${name}_${version}_${arch}.deb`)
    // -Zxz: the archive reader (src/pool/deb.ts) reads gzip and xz members; this host's dpkg-deb defaults to zstd.
    this.must('dpkg-deb', '-Zxz', '--build', root, archive)
    this.archives.set(name, { archive, sha: sha256(readFileSync(archive)), version, arch, repo, commit })
  }

  index(): void {
    const rows = [...this.archives.values()].sort((a, b) => (a.archive < b.archive ? -1 : a.archive > b.archive ? 1 : 0))
    const base = (r: Archive): string => r.archive.slice(r.archive.lastIndexOf('/') + 1)
    writeFileSync(join(this.pool, 'SHA256SUMS'), rows.map(r => `${r.sha}  pool/${base(r)}\n`).join(''))
    writeFileSync(join(this.pool, 'Packages'), rows.map(r => `Package: ${base(r).split('_')[0]}\nVersion: ${r.version}\nArchitecture: ${r.arch}\nFilename: pool/${base(r)}\nSHA256: ${r.sha}\n\n`).join(''))
    writeFileSync(join(this.pool, 'manifest.txt'), '#package\tversion\tarchitecture\tinstalled-size\tsha256\tfile\tsource-repo\tsource-commit\n'
    + rows.map(r => `${base(r).split('_')[0]}\t${r.version}\t${r.arch}\t1\t${r.sha}\tpool/${base(r)}\t${r.repo}\t${r.commit}\n`).join(''))
  }

  /** The package rows of the pool, as src/cli.ts pool rows --arch prints them; the mica-system-base row is always one. */
  lock(rows: Row[]): void {
    this.rows = rows.map(([name, version, arch, sha, repo, commit]) => `${name}\t${version}\t${arch}\t${sha}\t${repo}\t${commit}\t${name}_${version}_${arch}.deb\n`)
    this.rows.push(this.baseRow())
  }

  baseRow(): string {
    const { sha, version, arch, repo, commit } = this.archives.get('mica-base')!
    return `mica-base\t${version}\t${arch}\t${sha}\t${repo}\t${commit}\tmica-base_${version}_${arch}.deb\n`
  }

  invoke(options: { unlocked?: string, tree?: string, rows?: string } = {}): Run {
    rmSync(this.output, { force: true })
    const path = join(this.work, 'pool-rows.tsv')
    writeFileSync(path, options.rows ?? this.rows.join(''))
    return run([process.execPath, HELPER, '--composition-source', options.tree ?? this.tree, '--pool', this.pool, '--arch', 'amd64', '--epoch', '1577836800',
      '--rows', path, '--unlocked', options.unlocked ?? '', '--output', this.output], { env: this.env })
  }

  record(): Obj {
    return parse(text(this.output)) as Obj
  }

  refuses(message: string, options: { unlocked?: string, tree?: string, rows?: string } = {}): void {
    const result = this.invoke(options)
    expect(result.exitCode, message).not.toBe(0)
    expect(result.stderr, message).toContain('source lineage refused')
    expect(result.stderr, message).toContain(message)
    expect(existsSync(this.output), message).toBe(false)
  }

  rebuilt(name: string, sha: string): void {
    const a = this.archives.get(name)!
    this.archives.set(name, { ...a, sha })
  }
}

const EPOCH = 1577836800n

describe('source lineage', () => {
  let l: Lineage
  beforeEach(() => { l = new Lineage() })
  afterEach(() => { l.cleanup() })

  test('locked pool accepts and the record validates again', () => {
    const result = l.invoke()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(l.version)
    const record = l.record()
    expect(record.schema).toBe('mica/source-lineage/v1')
    expect(get(record, 'package_source', 'commit')).toBe(l.commitId)
    expect(record.unlocked).toEqual([])
    expect((record.lock as Obj[]).map(r => r.package)).toEqual(['mica-base', 'mica-imported'])
    const byName = new Map((get(record, 'pool', 'packages') as Obj[]).map(r => [r.package as string, r]))
    expect(byName.get('mica-imported')!.source_commit).toBe(l.importedCommit)
    expect(byName.get('mica-base')!.source_repo).toBe('mica-system-base')
    expect(validate(parse(text(l.output)), 'amd64', EPOCH) as Obj).toEqual(record)
    const again = l.invoke(); expect(again.exitCode, again.stderr).toBe(0)
    expect(readFileSync(l.output).toString('hex')).toBe(Buffer.from(canonical(record)).toString('hex'))
  })

  test('locked archive with one byte changed refuses by name', () => {
    const archive = l.archives.get('mica-imported')!.archive
    const data = readFileSync(archive); data[data.length - 1] = data[data.length - 1]! ^ 1; writeFileSync(archive, data)
    l.rebuilt('mica-imported', sha256(data))
    l.index()
    l.refuses('locked archive differs from the lock: mica-imported')
  })

  test('locked archive at another version refuses by name', () => {
    l.build('mica-imported', '2.0.1-1', 'amd64', 'mica-imported', l.importedCommit)
    l.index()
    l.refuses('locked archive differs from the lock: mica-imported')
  })

  test('locked archive from another repository refuses by name', () => {
    l.build('mica-imported', l.importedVersion, 'amd64', 'mica-other', l.importedCommit)
    l.index()
    l.lock([['mica-imported', l.importedVersion, 'amd64', l.archives.get('mica-imported')!.sha, 'mica-imported', l.importedCommit]])
    l.refuses('locked archive source repository differs from the lock: mica-imported')
  })

  test('the source commit is the release row and no archive field is read', () => {
    // A package reused from an earlier release is pinned by a later release row; a stray control field naming
    // another commit is not consulted.
    l.build('mica-imported', l.importedVersion, 'amd64', 'mica-imported', 'e'.repeat(40), 'Mica-Source-Commit: ' + 'd'.repeat(40) + '\n')
    l.index()
    l.lock([['mica-imported', l.importedVersion, 'amd64', l.archives.get('mica-imported')!.sha, 'mica-imported', 'e'.repeat(40)]])
    const result = l.invoke()
    expect(result.exitCode, result.stderr).toBe(0)
    const commits = new Map((get(l.record(), 'pool', 'packages') as Obj[]).map(r => [r.package as string, r.source_commit]))
    expect(commits.get('mica-imported')).toBe('e'.repeat(40))
  })

  test('archive not in the lock refuses by name', () => {
    l.build('mica-stray', '1.0.0-1', 'amd64', 'mica-build', l.commitId)
    l.index()
    l.refuses('archive not in the lock: mica-stray')
  })

  test('locked archive missing from the pool refuses', () => {
    rmSync(l.archives.get('mica-imported')!.archive)
    l.archives.delete('mica-imported')
    l.index()
    l.refuses('locked archive missing from the pool: mica-imported')
  })

  test('unlocked waives the digest and is recorded', () => {
    l.build('mica-imported', '2.0.1-1', 'amd64', 'mica-imported', l.importedCommit)
    l.index()
    l.refuses('locked archive differs from the lock: mica-imported')
    const result = l.invoke({ unlocked: 'mica-imported' })
    expect(result.exitCode, result.stderr).toBe(0)
    const record = l.record()
    expect(record.unlocked).toEqual(['mica-imported'])
    const versions = new Map((get(record, 'pool', 'packages') as Obj[]).map(r => [r.package as string, r.version]))
    expect(versions.get('mica-imported')).toBe('2.0.1-1')
    expect(validate(record, 'amd64', EPOCH) as Obj).toEqual(record)
    record.unlocked = []
    expect(() => validate(record, 'amd64', EPOCH)).toThrow()
  })

  test('unlocked naming an unlocked package refuses', () => {
    l.refuses('MICA_POOL_UNLOCKED names mica-fixture, which the lock does not import', { unlocked: 'mica-fixture' })
    l.refuses('MICA_POOL_UNLOCKED names mica-other, which the lock does not import', { unlocked: 'mica-other' })
  })

  test('missing source repository refuses', () => {
    const root = join(l.work, 'deb-mica-imported')
    const control = join(root, 'DEBIAN/control')
    writeFileSync(control, text(control).split('\n').filter(line => line !== '' && !line.startsWith('Mica-Source-Repo')).join('\n') + '\n')
    const archive = l.archives.get('mica-imported')!.archive
    l.must('dpkg-deb', '-Zxz', '--build', root, archive)
    l.rebuilt('mica-imported', sha256(readFileSync(archive)))
    l.index()
    l.refuses('source repository name')
  })

  test('base pool rows are imported', () => {
    const result = l.invoke()
    expect(result.exitCode, result.stderr).toBe(0)
    expect((l.record().lock as Obj[]).map(r => r.package)).toContain('mica-base')
    l.refuses('no pool rows', { rows: '' })
    l.refuses('locked archive differs from the lock: mica-base', { rows: l.rows.join('').replaceAll(l.archives.get('mica-base')!.sha, '0'.repeat(64)) })
    l.refuses('locked archive source repository differs from the lock: mica-base', { rows: l.rows.join('').replaceAll('\tmica-system-base\t', '\tmica-other\t') })
  })

  test('dirty tree and malformed lock refuse', () => {
    writeFileSync(join(l.tree, 'Makefile'), '# edited\n')
    l.refuses('dirty source checkout')
    l.must('git', '-C', l.tree, 'checkout', '--', 'Makefile')
    const row = l.rows.find(r => r.startsWith('mica-imported\t'))!
    const cases: [string, string, string][] = [
      ['digest', row.replaceAll(l.archives.get('mica-imported')!.sha, 'z'.repeat(64)), 'malformed digest'],
      ['version', row.replaceAll('\t' + l.importedVersion + '\t', '\tv2\t'), 'package version: v2'],
      ['columns', row.replaceAll('\tmica-imported\t', '\t'), 'pool row: '],
      ['file', row.replaceAll('mica-imported_', 'other_'), 'pool row file name'],
      ['architecture', row.replaceAll('\tamd64\t', '\tarm64\t'), 'pool row architecture'],
      ['twice', row + row, 'a package has two rows in one pool: mica-imported'],
    ]
    for (const [, bad, message] of cases) l.refuses(message, { rows: l.rows.filter(r => r !== row).join('') + bad })
  })

  test('stale index and membership refuse', () => {
    const archive = l.archives.get('mica-imported')!.archive
    lutimesNs(archive, (2n ** 40n) * 10n ** 9n)
    l.refuses('stale pool index')
    lutimesNs(archive, 0n)
    writeFileSync(join(l.pool, 'SHA256SUMS'), '')
    l.refuses('archive checksum membership')
  })

  test('validate refuses shape mutations', () => {
    expect(l.invoke().exitCode).toBe(0)
    const record = l.record()
    const cases: Record<string, (r: Obj) => void> = {
      'schema': (r) => { r.schema = 'mica/source-lineage/join-v1' },
      'unknown-field': (r) => { r.producer_join = {} },
      'missing-lock': (r) => { delete r.lock },
      'unsorted-lock': (r) => { (r.lock as Obj[]).push({ ...(r.lock as Obj[])[0]!, package: 'aaa' }) },
      'unlocked-unknown': (r) => { r.unlocked = ['mica-fixture'] },
      'lock-row-differs': (r) => { (r.lock as Obj[])[0]!.sha256 = '0'.repeat(64) },
      'not-in-lock': (r) => { const p = get(r, 'pool', 'packages') as Obj[]; p.push({ ...p[0]!, package: 'mica-stray', archive: 'pool/mica-stray.deb' }) },
      'commit-differs': (r) => { (get(r, 'pool', 'packages') as Obj[])[1]!.source_commit = 'f'.repeat(40) },
      'source-differs': (r) => { (r.package_source as Obj).epoch = 1n },
      'arch': (r) => { r.architecture = 'arm64' },
      'epoch': (r) => { r.root_epoch = 1n },
    }
    for (const [name, mutate] of Object.entries(cases)) {
      const changed = parse(compact(record as Value)) as Obj
      mutate(changed)
      expect(() => validate(changed, 'amd64', EPOCH), name).toThrow()
    }
  })
})
