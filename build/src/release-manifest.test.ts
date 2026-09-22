import { builderImagesAt } from './images.ts'
import { boardFactsFrom } from './board-facts.ts'
import { boardEnvPath, REPO_ROOT } from './paths.ts'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync, constants as zstdConstants } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Signer } from '../../shared/update-envelope.ts'
import { canonicalJson, componentId } from './components.ts'
import { packArchive } from './component-archive.ts'
import { assembleRelease, gateRelease, sourceLineage, treeLockRows, verifyArchive, type ReleaseInputs } from './release-manifest.ts'
import { releaseBoard, sourceIdentity } from './release-cli.ts'
import { acceptProvenance } from '../../tests/lifecycle-uefi/provenance-acceptance.ts'
import { Toolbox } from './toolbox.ts'
import { OPEN_TIMEOUT_MS } from './testing.ts'

const IMAGE = 'mica-uefi-x64-20260909-164233.img'
let work: string
let inputs: ReleaseInputs
let keys: string[]
const read = (name: string) => JSON.parse(readFileSync(join(work, 'release', name), 'utf8'))
const write = (name: string, value: unknown) => writeFileSync(join(work, 'release', name), `${JSON.stringify(value, null, 2)}\n`)
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function repin(name: string) {
  const manifest = read('manifest.json')
  for (const filename of [name, 'SHA256SUMS']) {
    if (filename === 'SHA256SUMS') writeFileSync(join(work, 'release/SHA256SUMS'), manifest.artifacts.filter((a: { filename: string }) => a.filename !== 'SHA256SUMS').map((a: { filename: string, sha256: string }) => `${a.sha256}  ${a.filename}\n`).join(''))
    const a = manifest.artifacts.find((a: { filename: string }) => a.filename === filename)
    const bytes = readFileSync(join(work, 'release', filename))
    a.bytes = bytes.length; a.sha256 = hash(bytes)
  }
  write('manifest.json', manifest)
}
// Produce the input through the real selector/composition entry, using only a
// small installed fixture. Its measured byte image is not a SquashFS/boot claim.
function runtimeFixture(arch = 'amd64'): void {
  const result = spawnSync('python3', ['-c', `
import hashlib, json, os, pathlib, shutil, struct, sys
sys.dont_write_bytecode = True
repo, work = map(pathlib.Path, sys.argv[1:3])
arch = sys.argv[3]
sys.path.insert(0, str(repo / 'tests/rootfs-runtime'))
from composition_test import CompositionTest
from selection_test import CAP
case = CompositionTest()
case.setUp()
try:
    marker = work / 'meta/GENERATED'
    case.public_metadata(marker.read_bytes() if marker.exists() else None)
    case.f.write('/usr/share/mica/meta/updates/manifest.json', (work / 'meta/updates/manifest.json').read_bytes())
    if arch == 'arm64':
        for path in case.f.root.rglob('*'):
            if not path.is_symlink() and path.is_file() and path.read_bytes().startswith(b'\\x7fELF'):
                data = bytearray(path.read_bytes()); struct.pack_into('<H', data, 18, 183); path.write_bytes(data)
        os.setxattr(case.f.root / 'usr/bin/captool', 'security.capability', bytes.fromhex(CAP))
        for path in [case.f.manifest, case.inputs / 'manifest.tsv', case.inputs / 'upstream.tsv', case.f.root / 'usr/share/mica/manifest.tsv']:
            path.write_text(path.read_text().replace('amd64', 'arm64'))
        for directory in [case.f.db, case.inputs / 'info']:
            (directory / 'libfixture:amd64.list').rename(directory / 'libfixture:arm64.list')
    case.lineage(arch)
    case.capture()
    app = case.f.root / 'usr/bin/app'
    data = bytearray(app.read_bytes()); data[-1] = 44; app.write_bytes(data)
    counterpart = case.debug / '.build-id/ab/cd.debug'
    counterpart.parent.mkdir(parents=True); counterpart.write_bytes(b'fixture debug counterpart')
    (case.debug / 'manifest.tsv').write_text('/usr/bin/app\\tabcd\\t.build-id/ab/cd.debug\\t2048\\t2048\\t' + hashlib.sha256(data).hexdigest() + '\\n')
    result = case.command('compose', root=case.f.root, output=case.f.out, inputs=case.inputs, rules=case.f.rules_path, arch=arch, epoch=1000000000, debug=case.debug, report=case.f.report)
    assert result.returncode == 0, result.stderr
    (case.f.base / 'rootfs-verity.img').write_bytes(bytes([42]) * 12288)
    (case.f.base / 'rootfs-verity.env').write_text('SQUASHFS_BYTES=8192\\nIMAGE_BYTES=12288\\nVERITY_ROOT_HASH=' + 'a' * 64 + '\\nVERITY_SALT=' + 'c' * 64 + '\\nVERITY_HASH_ALGO=sha256\\nVERITY_DATA_BLOCK_SIZE=4096\\nVERITY_HASH_BLOCK_SIZE=4096\\nVERITY_DATA_BLOCKS=2\\nVERITY_HASH_START_BLOCK=2\\nVERITY_DATA_SECTORS=16\\n')
    result = case.command('measure-packed', root=case.f.out, out=case.f.base)
    assert result.returncode == 0, result.stderr
    shutil.copyfile(case.f.report, work / 'runtime-report.json')
    shutil.copyfile(case.f.out / 'usr/share/mica/manifest.tsv', work / 'packages.tsv')
finally:
    case.doCleanups()
`, new URL('../../', import.meta.url).pathname, work, arch], { encoding: 'utf8', timeout: 15000 })
  expect(result.status, result.stderr).toBe(0)
}
function runtime() {
  return JSON.parse(readFileSync(inputs.runtimeReport, 'utf8'))
}
function writeRuntime(value: unknown): void {
  writeFileSync(inputs.runtimeReport, JSON.stringify(value))
}
beforeEach(() => {
  const scratch = new URL('../../.tmp/', import.meta.url).pathname
  mkdirSync(scratch, { recursive: true })
  work = mkdtempSync(join(scratch, 'release-test-'))
  for (const dir of ['kernel', 'root', 'firmware', 'meta/updates']) mkdirSync(join(work, dir), { recursive: true })
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, true)
  keys = [signer.publicKey]
  const bytes = Buffer.alloc(12288, 42)
  const artifact = { bytes: bytes.length, sha256: hash(bytes) }
  const d = JSON.parse(readFileSync(new URL('../../tests/component-contracts/deployment.json', import.meta.url), 'utf8'))
  d.kernel.boot.artifact = d.kernel.support.image = d.kernel.support.signature = d.rootfs.content.image = d.rootfs.content.signature = artifact
  d.kernel.id = componentId(d.kernel); d.rootfs.id = componentId(d.rootfs)
  writeFileSync(join(work, 'kernel/boot.efi'), bytes)
  packArchive(JSON.stringify(signer.sign(JSON.parse(canonicalJson(d)))), join(work, 'kernel'), join(work, 'root'), keys, join(work, 'update.micaupd'))
  const f = { schema: 'mica/firmware/v1', id: '', board: 'uefi-x64', arch: 'amd64', generation: 1, version: 'one', artifact, target: { format: 'efi', partition: 1, path: 'EFI/BOOT/BOOTX64.EFI' } }
  f.id = componentId(f)
  writeFileSync(join(work, 'firmware/firmware.json'), JSON.stringify(signer.sign(JSON.parse(canonicalJson(f)))))
  writeFileSync(join(work, 'firmware/BOOTX64.EFI'), bytes)
  writeFileSync(join(work, IMAGE), 'fixture image; image boot acceptance is separate\n')
  writeFileSync(join(work, 'packages.tsv'), '#package\tversion\tarchitecture\nmica-system\t1\tall\nlibc6\t2.41\tamd64\n')
  writeFileSync(join(work, 'meta/updates/manifest.json'), readFileSync(new URL('../../meta.example/updates/manifest.json', import.meta.url)))
  writeFileSync(join(work, 'meta/GENERATED'), 'DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n')
  writeFileSync(join(work, 'notes.md'), '# Current release\n\nDevelopment evidence only.\n')
  runtimeFixture()
  inputs = { runtimeReport: join(work, 'runtime-report.json'), out: join(work, 'release'), board: 'uefi-x64', version: d.version, channel: 'development', profile: 'dev',
    source: { commit: 'a'.repeat(40), dirty: false }, builderImages: { 'upstream:test@index': 'example@sha256:' + 'a'.repeat(64) },
    image: join(work, IMAGE), update: join(work, 'update.micaupd'), firmware: join(work, 'firmware'),
    packages: join(work, 'packages.tsv'), meta: join(work, 'meta'), notes: join(work, 'notes.md'),
    evidence: new URL('../../_out/boards/uefi-x64/evidence.json', import.meta.url).pathname, keys }
})
afterEach(() => rmSync(work, { recursive: true, force: true }))

test('release preserves the build timestamp in the factory image name', () => {
  const filename = 'mica-uefi-x64-20260910-010203.img'
  const image = join(work, filename)
  renameSync(inputs.image, image)
  assembleRelease({ ...inputs, image })
  expect(read('manifest.json').artifacts.find((a: { role: string }) => a.role === 'image').filename).toBe(filename)
  expect(read('provenance.json').inputs.find((a: { role: string }) => a.role === 'image').filename).toBe(filename)
  expect(readFileSync(join(inputs.out, 'SHA256SUMS'), 'utf8')).toContain(`  ${filename}\n`)
})

test.each(['disk.img', 'image.img', 'mica-cx3576-20260909-164233.img', 'mica-uefi-x64-20260230-164233.img'])(
  'release refuses invalid factory image name %s', filename => {
    const image = join(work, filename)
    renameSync(inputs.image, image)
    expect(() => assembleRelease({ ...inputs, image })).toThrow('factory image filename')
  },
)

test('release gate refuses generic image names and duplicate image roles', () => {
  assembleRelease(inputs)
  const m = read('manifest.json')
  const image = m.artifacts.find((a: { role: string }) => a.role === 'image')
  image.filename = 'image.img'
  write('manifest.json', m)
  expect(() => gateRelease(inputs.out, keys)).toThrow('artifact filename or role')
  image.filename = IMAGE
  m.artifacts[1] = { ...image, filename: 'mica-uefi-x64-20260910-010203.img' }
  write('manifest.json', m)
  expect(() => gateRelease(inputs.out, keys)).toThrow('artifact filename or role')
})

test('current release binds independent artifacts and derives inventory and provenance', () => {
  assembleRelease(inputs)
  const report = gateRelease(inputs.out, keys)
  expect(report.manifest.schema).toBe('mica/release/v1')
  expect(report.manifest.board).toBe('uefi-x64')
  expect(read('sbom.cdx.json').components.map((c: { name: string }) => c.name)).toEqual(['libfixture', 'mica-system'])
  expect(read('provenance.json').source).toEqual(inputs.source)
  expect(() => assembleRelease(inputs)).toThrow('exists')
})
test('missing, changed and unlisted release files are refused', () => {
  assembleRelease(inputs)
  writeFileSync(join(inputs.out, 'unlisted'), 'extra')
  expect(() => gateRelease(inputs.out, keys)).toThrow('file set')
  rmSync(join(inputs.out, 'unlisted'))
  writeFileSync(join(inputs.out, IMAGE), 'changed')
  expect(() => gateRelease(inputs.out, keys)).toThrow('digest or length')
  rmSync(join(inputs.out, IMAGE))
  expect(() => gateRelease(inputs.out, keys)).toThrow('file set')
})
test('symlink artifacts and parent traversal never satisfy the gate', () => {
  assembleRelease(inputs)
  rmSync(join(inputs.out, IMAGE)); symlinkSync(join(work, IMAGE), join(inputs.out, IMAGE))
  expect(() => gateRelease(inputs.out, keys)).toThrow('regular file')
  const m = read('manifest.json'); m.artifacts[0].filename = '../image.img'; write('manifest.json', m)
  expect(() => gateRelease(inputs.out, keys)).toThrow('artifact')
})
test('unknown release schema, fields and duplicate roles are refused', () => {
  assembleRelease(inputs)
  const m = read('manifest.json')
  write('manifest.json', { ...m, schema: 'mica/release/v0' }); expect(() => gateRelease(inputs.out, keys)).toThrow('schema')
  write('manifest.json', { ...m, trust: {} }); expect(() => gateRelease(inputs.out, keys)).toThrow('fields')
  m.artifacts[0].role = m.artifacts[1].role; write('manifest.json', m)
  expect(() => gateRelease(inputs.out, keys)).toThrow('artifact')
})
test('development markers refuse customer channels and malformed domain declarations', () => {
  expect(() => assembleRelease({ ...inputs, channel: 'stable' })).toThrow('development')
  writeFileSync(join(work, 'meta/GENERATED'), 'DEVELOPMENT-GRADE\nDOMAINS=boot\nDOMAINS=boot verity updates\n')
  expect(() => assembleRelease(inputs)).toThrow('development marker')
})
test('empty notes and duplicate package inventory are refused before output', () => {
  writeFileSync(inputs.notes, ' \n')
  expect(() => assembleRelease(inputs)).toThrow('notes')
  writeFileSync(inputs.notes, '# Notes')
  writeFileSync(inputs.packages, 'mica-system\t1\tall\nmica-system\t2\tall\n')
  expect(() => assembleRelease(inputs)).toThrow('duplicate package')
})
test('signed artifacts refuse unknown metadata keys and forged archive bytes even when repinned', () => {
  assembleRelease(inputs)
  const stranger = new Signer(generateKeyPairSync('ed25519').privateKey, true)
  expect(() => gateRelease(inputs.out, [stranger.publicKey])).toThrow()
  const path = join(inputs.out, 'update.micaupd'); const bytes = readFileSync(path); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; writeFileSync(path, bytes); repin('update.micaupd')
  expect(() => gateRelease(inputs.out, keys)).toThrow('object digest')
})
test('archive truncation and trailing data are refused even when repinned', () => {
  assembleRelease(inputs)
  const path = join(inputs.out, 'update.micaupd'); const bytes = readFileSync(path)
  writeFileSync(path, Buffer.concat([bytes, Buffer.from('extra')])); repin('update.micaupd')
  expect(() => gateRelease(inputs.out, keys)).toThrow('trailing')
  writeFileSync(path, bytes.subarray(0, -1)); repin('update.micaupd')
  expect(() => gateRelease(inputs.out, keys)).toThrow('truncated')
})
test('derived records cannot diverge from their measured inputs', () => {
  assembleRelease(inputs)
  const sbom = read('sbom.cdx.json'); sbom.components = []; write('sbom.cdx.json', sbom); repin('sbom.cdx.json')
  expect(() => gateRelease(inputs.out, keys)).toThrow('derived record')
})
test('firmware and evidence must match the release board', () => {
  expect(() => assembleRelease({ ...inputs, board: 'cx3576' })).toThrow('board')
  const ev = JSON.parse(readFileSync(inputs.evidence, 'utf8')); ev.bootAssurance = 'I4'; ev.evidenceRefs = [{ class: 'verity-root', ref: 'test' }]
  writeFileSync(join(work, 'evidence.json'), JSON.stringify(ev))
  expect(() => assembleRelease({ ...inputs, evidence: join(work, 'evidence.json') })).toThrow('evidence')
})

// Freeze the actual CLI and its relative imports in the fixture checkout. A
// dirty developer checkout cannot stand in for a clean composition source.
/** Make the frozen checkout the lineage's source: its packages become lock rows at their own versions, and the lock file text those rows are. */
function lockFixture(lineage: Record<string, any>, commit: string, tree: string, epoch: number) {
  lineage.composition_source = { commit, tree, epoch }
  lineage.package_source = { ...lineage.composition_source, version: '0.1.0+git' + commit.slice(0, 12) + '-1' }
  lineage.lock = lineage.pool.packages.map((p: Record<string, string>) => ({ package: p.package, version: p.version, architecture: p.architecture, sha256: p.sha256, source_repo: p.source_repo, source_commit: p.source_commit }))
    .sort((a: { package: string }, b: { package: string }) => a.package.localeCompare(b.package))
  return lineage.lock as LockRowLike[]
}
type LockRowLike = { package: string, version: string, architecture: string, sha256: string, source_repo: string, source_commit: string }
/** Write rows as a locks/ directory: one release lock and pin per source repository, every row in the pool of its architecture, an `all` archive in both. */
function writeLocks(directory: string, rows: LockRowLike[]) {
  rmSync(directory, { recursive: true, force: true }); mkdirSync(join(directory, 'pins'), { recursive: true })
  for (const repository of [...new Set(rows.map(r => r.source_repo))]) {
    const own = rows.filter(r => r.source_repo === repository)
    // mica-boards and mica-build release per scope (mica:docs/design/release-lock.md 1.0).
    const scope = ['mica-boards', 'mica-build'].includes(repository) ? 'fixture' : ''
    const input = scope ? `${repository}.${scope}` : repository
    const packages = own.flatMap(r => (r.architecture === 'all' ? ['amd64', 'arm64'] : [r.architecture]).map(arch => ['package', r.package, arch, r.version, r.sha256].join('\t')))
    const lines = ['# mica-lock v1', ['release', repository, scope ? `${scope}.20260101-0000` : '20260101-0000', own[0]!.source_commit].join('\t'),
      ...['amd64', 'arm64'].map(arch => `pool\t${arch}\tghcr.io/micaoss/${repository}:pool.${scope ? scope + '.' : ''}${arch}.20260101-0000@sha256:${'0'.repeat(64)}`),
      ...packages.sort((x, y) => Buffer.compare(Buffer.from(x.split('\t').slice(1, 3).join('\0')), Buffer.from(y.split('\t').slice(1, 3).join('\0'))))]
    writeFileSync(join(directory, `${input}.lock`), lines.join('\n') + '\n')
    writeFileSync(join(directory, 'pins', `${input}.pin`), `# mica-pin v1\nREPOSITORY=${repository}\n${scope ? `SCOPE=${scope}\n` : ''}RELEASE=20260101-0000\nSHA256SUMS=${'0'.repeat(64)}\n`)
  }
}
function copyReleaseCli(root: string, destination: string) {
  const copied = new Set<string>(), parser = new Bun.Transpiler({ loader: 'ts' })
  const copy = (name: string) => {
    if (copied.has(name)) return
    copied.add(name)
    const bytes = readFileSync(join(root, name))
    mkdirSync(dirname(join(destination, name)), { recursive: true })
    writeFileSync(join(destination, name), bytes)
    if (name.endsWith('.ts')) for (const imported of parser.scanImports(bytes)) {
      if (imported.path.startsWith('.')) copy(join(dirname(name), imported.path))
    }
  }
  for (const name of ['build/src/release-cli.ts', 'Makefile', 'build/package.json', 'verify/package.json',
    'tools/from.sh', 'tools/locks.py', 'tools/pool.sh', 'tools/deb/producers.sh',
    // One producer, so that tools/pool.sh own reads the checkout's own archives (none) rather than refusing a tree with no producer.
    'producers/radio-wifi/producer.env', 'producers/radio-wifi/Dockerfile', 'producers/radio-wifi/version.env', 'producers/radio-wifi/control/mica-wifi.control', 'producers/radio-wifi/control/mica-wifi-ap.control',
    'locks/mica-build-env.lock', 'locks/pins/mica-build-env.pin', '_out/boards/uefi-x64/board.env', '_out/boards/uefi-x64/evidence.json']) copy(name)
}

test.each(['ordinary', 'linked'])('shipped release CLI and documented verification commands execute (%s checkout)', async (kind) => {
  const repo = new URL('../../', import.meta.url).pathname
  const ordinary = join(work, 'checkout')
  const linked = join(work, 'linked')
  const fixtureGit = await Toolbox.open({ key: 'release-git-fixture', imageKey: 'upstream:alpine:3.24.1', manager: 'apk', packages: ['git'], tools: ['git'] }, { mounts: [work] })
  let commit: string, compositionTree = '', compositionEpoch = 0
  const checkout = kind === 'ordinary' ? ordinary : linked
  try {
    const git = async (...args: string[]) => (await fixtureGit.must(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })).stdout.trim()
    await git('init', '--initial-branch=fixture', ordinary)
    writeFileSync(join(ordinary, 'tracked.txt'), 'initial fixture\n')
    // The tree's locks, which the CLI compares the record's rows against.
    writeLocks(join(ordinary, 'locks'), lockFixture(JSON.parse(JSON.stringify(runtime().provenance.source_lineage)), 'a'.repeat(40), 'b'.repeat(40), 1))
    copyReleaseCli(repo, ordinary)
    await git('-C', ordinary, 'add', '.')
    await git('-C', ordinary, 'commit', '--no-gpg-sign', '-m', 'Create isolated source fixture')
    const commonHead = await git('-C', ordinary, 'rev-parse', 'HEAD')
    await git('-C', ordinary, 'worktree', 'add', '--detach', linked, 'HEAD')
    if (kind === 'linked') {
      writeFileSync(join(linked, 'tracked.txt'), 'linked fixture baseline\n')
      await git('-C', linked, 'commit', '-am', 'Advance isolated linked fixture', '--no-gpg-sign')
    }
    commit = await git('-C', checkout, 'rev-parse', 'HEAD')
    compositionTree = await git('-C', checkout, 'rev-parse', 'HEAD^{tree}')
    compositionEpoch = Number(await git('-C', checkout, 'show', '-s', '--format=%ct', 'HEAD'))
    if (kind === 'linked') expect(commit).not.toBe(commonHead)
    expect(await sourceIdentity(checkout)).toEqual({ commit, dirty: false })
    writeFileSync(join(checkout, 'tracked.txt'), 'modified fixture\n')
    expect(await sourceIdentity(checkout)).toEqual({ commit, dirty: true })
    if (kind === 'linked') {
      writeFileSync(join(linked, '.git'), 'gitdir: ../checkout/.git/worktrees/linked\n')
      expect(await sourceIdentity(checkout)).toEqual({ commit, dirty: true })
    }
    console.log(`source identity ${kind} checkout HEAD/clean/dirty control passed`)
  } finally { await fixtureGit.close() }

  // Observe the real sourceIdentity toolbox, not a stand-in mount declaration.
  // All attempted writes target this test's Git metadata, never the user's.
  const open = Toolbox.open.bind(Toolbox)
  const observed = spyOn(Toolbox, 'open').mockImplementation(async (toolset, options) => {
    const tb = await open(toolset, options)
    try {
      const metadata = join(ordinary, '.git')
      const paths = kind === 'ordinary' ? [metadata] : [metadata, join(metadata, 'worktrees/linked')]
      for (const path of paths) {
        const result = await tb.run(['sh', '-c', 'printf probe > "$1/write-probe"', 'sh', path])
        expect(result.exitCode, result.stderr).not.toBe(0)
        expect(result.stderr).toMatch(/Read-only file system/i)
      }
      if (kind === 'linked') {
        const result = await tb.run(['sh', '-c', 'printf probe > "$1/.git"', 'sh', linked])
        expect(result.exitCode, result.stderr).not.toBe(0)
        expect(result.stderr).toMatch(/Read-only file system/i)
      }
      return tb
    } catch (error) { await tb.close(); throw error }
  })
  try {
    expect(await sourceIdentity(checkout)).toEqual({ commit, dirty: true })
  } finally { observed.mockRestore() }
  writeFileSync(join(checkout, 'tracked.txt'), kind === 'ordinary' ? 'initial fixture\n' : 'linked fixture baseline\n')
  expect(await sourceIdentity(checkout)).toEqual({ commit, dirty: false })
  const report = runtime(), lineage = report.provenance.source_lineage
  lockFixture(lineage, commit, compositionTree, compositionEpoch)
  report.provenance.capture_sha256['source-lineage.json'] = hash(Buffer.from(canonicalJson(lineage) + '\n'))
  writeRuntime(report)

  const publicKey = join(work, 'metadata.pub'); writeFileSync(publicKey, keys[0]!)
  const args = ['run', 'src/release-cli.ts', 'assemble', '--board', inputs.board, '--version', inputs.version,
    '--image', inputs.image, '--update', inputs.update, '--firmware', inputs.firmware,
    '--package-manifest', inputs.packages, '--runtime-report', inputs.runtimeReport, '--baked-meta', inputs.meta, '--notes', inputs.notes,
    '--out', inputs.out, '--public-key', publicKey]
  const result = spawnSync(process.execPath, args, { cwd: join(checkout, 'build'), encoding: 'utf8' })
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  expect(result.stdout).toContain('RELEASE_GATE_PASS')
  const doc = readFileSync(join(repo, 'build/release-verify.md'), 'utf8')
  const section = doc.split('<!-- release-verify-test:start -->')[1]!.split('<!-- release-verify-test:end -->')[0]!
  const commands = section.match(/```bash\n([\s\S]*?)```/)![1]!
  expect(commands).toContain('sha256sum -c SHA256SUMS')
  expect(commands).toContain('--release gate')
  const env = { ...process.env, REPO: repo, RELEASE: inputs.out, METADATA_PUBLIC_KEY: publicKey }
  const checked = spawnSync('bash', ['-euo', 'pipefail', '-c', commands], { env, encoding: 'utf8' })
  expect(checked.status, `${checked.stdout}${checked.stderr}`).toBe(0)
  expect(checked.stdout).toContain('RELEASE_GATE_PASS')
  writeFileSync(join(inputs.out, IMAGE), 'tampered')
  expect(spawnSync('bash', ['-euo', 'pipefail', '-c', commands], { env, stdio: 'ignore' }).status).not.toBe(0)
}, OPEN_TIMEOUT_MS)

test('an empty marker file cannot promote development inputs to candidate', () => {
  writeFileSync(join(work, 'meta/GENERATED'), '')
  expect(() => assembleRelease({ ...inputs, channel: 'candidate' })).toThrow('development marker')
})
test('unmarked inputs still require signed objects and complete records on candidate', () => {
  rmSync(join(work, 'meta/GENERATED'))
  runtimeFixture()
  assembleRelease({ ...inputs, channel: 'candidate' })
  expect(gateRelease(inputs.out, keys).manifest.developmentDomains).toEqual([])
  const bytes = readFileSync(join(inputs.out, 'firmware.bin')); bytes[0] = bytes[0]! ^ 1
  writeFileSync(join(inputs.out, 'firmware.bin'), bytes); repin('firmware.bin')
  expect(() => gateRelease(inputs.out, keys)).toThrow('firmware digest')
})

test('a dangling development marker is refused as a nonregular input', () => {
  rmSync(join(work, 'meta/GENERATED'))
  symlinkSync(join(work, 'missing-marker'), join(work, 'meta/GENERATED'))
  expect(() => assembleRelease({ ...inputs, channel: 'candidate' })).toThrow('regular file')
})


test('runtime report is mandatory and missing input never creates a release', () => {
  const { runtimeReport: _report, ...missing } = inputs
  expect(() => assembleRelease(missing as ReleaseInputs)).toThrow('runtime report')
  expect(existsSync(inputs.out)).toBe(false)
})


test('runtime report joins actual file owners, sources, licenses and build-only packages', () => {
  assembleRelease(inputs)
  expect(read('manifest.json').artifacts.find((a: { role: string }) => a.role === 'runtime-report').filename).toBe('rootfs-report.runtime.json')
  const provenance = read('provenance.json').runtime
  expect(provenance.buildPackages.map((p: { package: string }) => p.package)).toContain('unused')
  expect(provenance.shippedPackages.map((p: { package: string }) => p.package)).not.toContain('unused')
  expect(provenance.files['/usr/bin/app'].archives[0].source).toEqual({ package: 'mica-system', version: '1.0.0-1' })
  expect(read('licenses.json').packages.find((p: { name: string }) => p.name === 'libfixture').resources[0].sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(provenance.files['/usr/bin/app'].debug.path).toBe('.build-id/ab/cd.debug')
  expect(provenance.files['/usr/bin/app'].configured.sha256).not.toBe(provenance.files['/usr/bin/app'].final.sha256)
  expect(readFileSync(join(inputs.out, 'development-marker.txt'))).toEqual(readFileSync(join(inputs.meta, 'GENERATED')))
  expect(read('provenance.json').inputs.some((a: { role: string }) => a.role === 'runtime-report')).toBe(true)
})

test.each([
  ['architecture', (r: ReturnType<typeof runtime>) => { r.architecture = 'arm64' }],
  ['package identity', (r: ReturnType<typeof runtime>) => { r.provenance.shipped_packages[0].version = 'wrong' }],
  ['archive identity', (r: ReturnType<typeof runtime>) => { r.provenance.files['/usr/bin/app'].archives[0].archive_sha256 = '0'.repeat(64) }],
  ['file digest', (r: ReturnType<typeof runtime>) => { r.provenance.files['/usr/bin/app'].final.sha256 = '0'.repeat(64) }],
  ['missing file', (r: ReturnType<typeof runtime>) => { delete r.provenance.files['/usr/bin/app'] }],
  ['duplicate path', (r: ReturnType<typeof runtime>) => { r.files.push(r.files[0]) }],
  ['traversal path', (r: ReturnType<typeof runtime>) => { r.files[0].path = '/../outside' }],
  ['missing owner', (r: ReturnType<typeof runtime>) => { r.files.find((f: { path: string }) => f.path === '/usr/bin/app').origins = [] }],
  ['capture digest', (r: ReturnType<typeof runtime>) => { r.provenance.capture_sha256['manifest.tsv'] = '0'.repeat(64) }],
  ['signed root', (r: ReturnType<typeof runtime>) => { r.measurements.verity_image.sha256 = '0'.repeat(64) }],
  ['verity geometry', (r: ReturnType<typeof runtime>) => { r.measurements.verity_image.geometry.VERITY_ROOT_HASH = '0'.repeat(64) }],
  ['missing packed measurement', (r: ReturnType<typeof runtime>) => { delete r.measurements.verity_image }],
  ['incorrect measurement', (r: ReturnType<typeof runtime>) => { r.measurements.unique_file_bytes += 1 }],
  ['debug mapping', (r: ReturnType<typeof runtime>) => { r.provenance.files['/usr/bin/app'].debug = { build_id: 'abcd', path: '.build-id/wrong.debug' } }],
])('runtime report refuses %s before output', (_name, mutate) => {
  const report = runtime(); (mutate as (r: ReturnType<typeof runtime>) => void)(report); writeRuntime(report)
  expect(() => assembleRelease(inputs)).toThrow()
  expect(existsSync(inputs.out)).toBe(false)
})

test('runtime report rejects a different public manifest', () => {
  writeFileSync(join(inputs.meta, 'updates/manifest.json'), '{}')
  expect(() => assembleRelease(inputs)).toThrow('public metadata')
  expect(existsSync(inputs.out)).toBe(false)
})

test('runtime report tampering still refuses after outer artifact digests are repinned', () => {
  assembleRelease(inputs)
  const report = read('rootfs-report.runtime.json')
  report.provenance.files['/usr/bin/app'].generators.push('forged origin')
  write('rootfs-report.runtime.json', report); repin('rootfs-report.runtime.json')
  expect(() => gateRelease(inputs.out, keys)).toThrow('runtime')
})


test('runtime report rejects a different shipped package inventory before output', () => {
  writeFileSync(inputs.packages, 'mica-system\twrong\tall\n')
  expect(() => assembleRelease(inputs)).toThrow('runtime shipped inventory')
  expect(existsSync(inputs.out)).toBe(false)
})

test.each(['absent', 'malformed', 'duplicate-key', 'invalid-utf8', 'symlink'])(
  'runtime report refuses %s input before output', kind => {
    if (kind === 'absent') rmSync(inputs.runtimeReport)
    if (kind === 'malformed') writeFileSync(inputs.runtimeReport, '{')
    if (kind === 'duplicate-key') {
      const text = readFileSync(inputs.runtimeReport, 'utf8')
      writeFileSync(inputs.runtimeReport, text.replace('{', '{"architecture":"amd64",'))
    }
    if (kind === 'invalid-utf8') writeFileSync(inputs.runtimeReport, Buffer.from([0xff]))
    if (kind === 'symlink') { renameSync(inputs.runtimeReport, inputs.runtimeReport + '.real'); symlinkSync(inputs.runtimeReport + '.real', inputs.runtimeReport) }
    expect(() => assembleRelease(inputs)).toThrow()
    expect(existsSync(inputs.out)).toBe(false)
  },
)

test('runtime report CLI requires the new argument without opening source identity', () => {
  const publicKey = join(work, 'public.key'); writeFileSync(publicKey, keys[0]!)
  const result = spawnSync(process.execPath, ['run', 'src/release-cli.ts', 'assemble', '--board', 'uefi-x64', '--public-key', publicKey], {
    cwd: new URL('../', import.meta.url).pathname, encoding: 'utf8', timeout: 15000,
  })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Missing --runtime-report')
  expect(existsSync(inputs.out)).toBe(false)
})

test('runtime report keeps runtime measurement claims pending their separate evidence', () => {
  const report = runtime(); report.measurements.rss = 'PASS'; writeRuntime(report)
  expect(() => assembleRelease(inputs)).toThrow('runtime measurement evidence')
  expect(existsSync(inputs.out)).toBe(false)
})

test('runtime report preserves epoch nanoseconds and refuses one-nanosecond divergence', () => {
  const text = readFileSync(inputs.runtimeReport, 'utf8')
  expect(text).toContain('"mtime_ns": 1000000000000000000')
  assembleRelease(inputs)
  expect(read('provenance.json').runtime.files['/usr/bin/app'].final.mtime_ns).toBe('1000000000000000000')
  const path = join(inputs.out, 'rootfs-report.runtime.json')
  const exported = readFileSync(path, 'utf8')
  const filesAt = exported.indexOf('"files": [')
  expect(filesAt).toBeGreaterThan(0)
  writeFileSync(path, exported.slice(0, filesAt) + exported.slice(filesAt).replace('"mtime_ns": 1000000000000000000', '"mtime_ns": 1000000000000000001'))
  repin('rootfs-report.runtime.json')
  expect(() => gateRelease(inputs.out, keys)).toThrow('runtime final file metadata')
})

// These signed byte fixtures exercise artifact/provenance checks, not guest boot.
async function virtAcceptanceFixture() {
  const repo = new URL('../../', import.meta.url).pathname
  const checkout = join(work, 'frozen-checkout')
  for (const dir of ['_out/boards/uefi-arm64', '_out/boards/uefi-x64', 'locks/pins', 'tools/deb', 'producers/radio-wifi/control']) mkdirSync(join(checkout, dir), { recursive: true })
  // The frozen checkout declares its board no release target: that policy is what this consumer accepts against,
  // and the working tree's uefi-arm64 is a release target since the generic arm64 image (user, 2026-09-16).
  for (const path of ['_out/boards/uefi-arm64/board.env', '_out/boards/uefi-arm64/evidence.json', '_out/boards/uefi-x64/board.env',
    'tools/locks.py', 'tools/pool.sh', 'tools/deb/producers.sh', 'producers/radio-wifi/producer.env', 'producers/radio-wifi/Dockerfile', 'producers/radio-wifi/version.env',
    'producers/radio-wifi/control/mica-wifi.control', 'producers/radio-wifi/control/mica-wifi-ap.control', 'locks/mica-build-env.lock', 'locks/pins/mica-build-env.pin']) {
    writeFileSync(join(checkout, path), readFileSync(join(repo, path)))
  }
  const frozenBoardEnv = join(checkout, '_out/boards/uefi-arm64/board.env')
  writeFileSync(frozenBoardEnv, readFileSync(frozenBoardEnv, 'utf8').replace(/^BOARD_RELEASE_TARGET=.*$/m, 'BOARD_RELEASE_TARGET=0'))
  let compositionTree = '', compositionEpoch = 0
  const tb = await Toolbox.open({ key: 'release-git-fixture', imageKey: 'upstream:alpine:3.24.1', manager: 'apk', packages: ['git'], tools: ['git'] }, { mounts: [checkout] })
  try {
    const git = (...args: string[]) => tb.must(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', checkout, ...args], {
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    await git('init', '--initial-branch=fixture')
    await git('add', '.')
    await git('commit', '--no-gpg-sign', '-m', 'Freeze isolated acceptance fixture')
    compositionTree = (await git('rev-parse', 'HEAD^{tree}')).stdout.trim()
    compositionEpoch = Number((await git('show', '-s', '--format=%ct', 'HEAD')).stdout.trim())
  } finally { await tb.close() }
  inputs.source = await sourceIdentity(checkout)
  inputs.builderImages = builderImagesAt(checkout)
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, true)
  keys = inputs.keys = [signer.publicKey]
  const bytes = readFileSync(join(work, 'kernel/boot.efi'))
  const artifact = { bytes: bytes.length, sha256: hash(bytes) }
  const d = JSON.parse(readFileSync(join(repo, 'tests/component-contracts/deployment.json'), 'utf8'))
  d.board = d.kernel.board = 'uefi-arm64'
  d.arch = d.kernel.arch = d.rootfs.arch = 'arm64'
  d.kernel.boot.artifact = d.kernel.support.image = d.kernel.support.signature = d.rootfs.content.image = d.rootfs.content.signature = artifact
  d.kernel.id = componentId(d.kernel); d.rootfs.id = componentId(d.rootfs)
  rmSync(inputs.update)
  packArchive(JSON.stringify(signer.sign(JSON.parse(canonicalJson(d)))), join(work, 'kernel'), join(work, 'root'), keys, inputs.update)
  const f = { schema: 'mica/firmware/v1', id: '', board: 'uefi-arm64', arch: 'arm64', generation: 1, version: 'one', artifact, target: { format: 'efi', partition: 1, path: 'EFI/BOOT/BOOTAA64.EFI' } }
  f.id = componentId(f)
  writeFileSync(join(inputs.firmware, 'firmware.json'), JSON.stringify(signer.sign(JSON.parse(canonicalJson(f)))))
  renameSync(join(inputs.firmware, 'BOOTX64.EFI'), join(inputs.firmware, 'BOOTAA64.EFI'))
  const image = join(work, 'mica-uefi-arm64-20260911-020000.img')
  renameSync(inputs.image, image)
  Object.assign(inputs, { board: 'uefi-arm64', image, evidence: join(checkout, '_out/boards/uefi-arm64/evidence.json') })
  runtimeFixture('arm64')
  const report = runtime(), lineage = report.provenance.source_lineage
  // The frozen checkout is the source; the fixture's packages become imports
  // (lock rows at their own versions), since none carries that checkout's stamp.
  lockFixture(lineage, inputs.source.commit, compositionTree, compositionEpoch)
  report.provenance.capture_sha256['source-lineage.json'] = hash(Buffer.from(canonicalJson(lineage) + '\n'))
  writeRuntime(report)
  return checkout
}

// The guard itself, over a real board.env in both directions. It is asserted here
// and not through a board name, because no board of this tree is obliged to keep
// BOARD_RELEASE_TARGET=0 for a test's benefit -- s905x5m was the last one that
// did, and it is being opened for release. The refusal must stay demonstrable
// after that, by decision rather than by accident.
test('the publication-target guard refuses a board.env that declares no target, and passes one that does', () => {
  const declared = readFileSync(boardEnvPath('uefi-x64'), 'utf8')
  expect(declared).toMatch(/^BOARD_RELEASE_TARGET=1$/m)
  const target = join(work, 'target.board.env')
  const noTarget = join(work, 'no-target.board.env')
  writeFileSync(target, declared)
  writeFileSync(noTarget, declared.replace(/^BOARD_RELEASE_TARGET=.*$/m, 'BOARD_RELEASE_TARGET=0'))
  expect(() => releaseBoard(boardFactsFrom(noTarget))).toThrow('Board uefi-x64 has no release publication target')
  expect(() => releaseBoard(boardFactsFrom(target))).not.toThrow()
})

test('non-publication acceptance records a candidate whose frozen source declares no publication target', async () => {
  const checkout = await virtAcceptanceFixture()
  // Independently establish that the low-level candidate is otherwise valid.
  const valid = assembleRelease({ ...inputs, out: join(work, 'control') })
  expect(valid.manifest.board).toBe('uefi-arm64')
  const repo = new URL('../../', import.meta.url).pathname
  const publicKey = join(work, 'metadata.pub'); writeFileSync(publicKey, keys[0]!)
  const printed = spyOn(console, 'log')
  try {
    await acceptProvenance(inputs, checkout)
    expect(printed.mock.calls.flat().join(' ')).toContain('NON_PUBLICATION_ARTIFACT_ACCEPTANCE')
    expect(printed.mock.calls.flat().join(' ')).not.toContain('RELEASE_GATE_PASS')
  } finally { printed.mockRestore() }
  const record = JSON.parse(readFileSync(`${inputs.out}.acceptance.json`, 'utf8'))
  expect(record.publicationEligible).toBe(false)
  expect(record.source).toEqual(inputs.source)
  expect(record.manifestSha256).toBe(hash(readFileSync(join(inputs.out, 'manifest.json'))))
  expect(record.artifacts).toEqual(read('manifest.json').artifacts)
  expect(read('manifest.json').artifacts).toEqual(valid.manifest.artifacts)
  // The gate reads the working tree, where uefi-arm64 became a release target with the generic arm64 image, so
  // the same candidate now passes it: what the acceptance record states is the FROZEN source's policy, not this
  // tree's. The production refusal is asserted by its own case, over a board.env that declares no target.
  const gate = spawnSync(process.execPath, [join(repo, 'build/src/release-cli.ts'), 'gate', '--dir', inputs.out, '--public-key', publicKey], { encoding: 'utf8', timeout: 30000 })
  expect(gate.stdout).toContain('RELEASE_GATE_PASS')
  // The frozen checkout's policy, which is the one this record is ABOUT, and the only board.env this case
  // reads: the working tree's is whatever the pins say today, and an assertion about it belonged to the
  // refusal case that now has its own board.env. s905x5m carried that assertion until it was opened for
  // release, which is the second time this case has been tied to a board's policy by accident.
  expect(readFileSync(join(checkout, '_out/boards/uefi-arm64/board.env'), 'utf8')).toMatch(/^BOARD_RELEASE_TARGET=0$/m)
}, OPEN_TIMEOUT_MS)

test('non-publication acceptance refuses false source, dirty checkout, policy widening and reused evidence', async () => {
  const checkout = await virtAcceptanceFixture()
  await expect(acceptProvenance({ ...inputs, source: { commit: '0'.repeat(40), dirty: false } }, checkout)).rejects.toThrow('frozen source')
  // uefi-x64 is a release target in the frozen checkout, so accepting its artifacts here is the widening.
  await expect(acceptProvenance({ ...inputs, board: 'uefi-x64' } as ReleaseInputs, checkout)).rejects.toThrow('non-publication board policy')
  for (const change of [{ channel: 'candidate' }, { profile: 'prod' }]) {
    await expect(acceptProvenance({ ...inputs, ...change } as ReleaseInputs, checkout)).rejects.toThrow('development/dev')
  }
  await expect(acceptProvenance({ ...inputs, builderImages: { 'upstream:test@index': 'wrong' } }, checkout)).rejects.toThrow('builder image')
  const evidence = join(work, 'changed-evidence.json')
  writeFileSync(evidence, readFileSync(inputs.evidence, 'utf8') + '\n')
  await expect(acceptProvenance({ ...inputs, evidence }, checkout)).rejects.toThrow('committed board evidence')
  const dirty = join(checkout, 'untracked')
  writeFileSync(dirty, 'uncommitted')
  await expect(acceptProvenance(inputs, checkout)).rejects.toThrow('frozen source')
  rmSync(dirty)
  writeFileSync(`${inputs.out}.acceptance.json`, 'existing evidence')
  await expect(acceptProvenance(inputs, checkout)).rejects.toThrow('exists')
  expect(existsSync(inputs.out)).toBe(false)
}, OPEN_TIMEOUT_MS)

test('non-publication acceptance retains runtime and repinned artifact tamper refusals', async () => {
  const checkout = await virtAcceptanceFixture()
  const original = runtime()
  writeRuntime({ ...original, architecture: 'amd64' })
  await expect(acceptProvenance(inputs, checkout)).rejects.toThrow('architecture')
  expect(existsSync(inputs.out)).toBe(false)
  writeRuntime(original)
  await acceptProvenance(inputs, checkout)
  for (const name of ['rootfs-report.runtime.json', 'provenance.json', 'firmware.json', 'board-evidence.json']) {
    const bytes = readFileSync(join(inputs.out, name))
    const record = read(name)
    if (name === 'rootfs-report.runtime.json') record.measurements.verity_image.sha256 = '0'.repeat(64)
    if (name === 'provenance.json') record.source.commit = '0'.repeat(40)
    if (name === 'firmware.json') record.signature = 'tampered'
    if (name === 'board-evidence.json') record.board = 'uefi-x64'
    write(name, record); repin(name)
    expect(() => gateRelease(inputs.out, keys)).toThrow()
    writeFileSync(join(inputs.out, name), bytes); repin(name)
    expect(() => gateRelease(inputs.out, keys)).not.toThrow()
  }
  for (const name of ['update.micaupd', 'firmware.bin']) {
    const bytes = readFileSync(join(inputs.out, name)); const changed = Buffer.from(bytes)
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    writeFileSync(join(inputs.out, name), changed); repin(name)
    expect(() => gateRelease(inputs.out, keys)).toThrow()
    writeFileSync(join(inputs.out, name), bytes); repin(name)
    expect(() => gateRelease(inputs.out, keys)).not.toThrow()
  }
  writeFileSync(join(inputs.out, 'mica-uefi-arm64-20260911-020000.img'), 'tampered image')
  expect(() => gateRelease(inputs.out, keys)).toThrow('digest or length')
}, OPEN_TIMEOUT_MS)


const IMPORTED = { package: 'mica-imported', version: '2.0.0-1', architecture: 'amd64', sha256: 'e'.repeat(64), source_repo: 'mica-imported', source_commit: 'b'.repeat(40) }
/** The fixture composition's own import (tests/rootfs-runtime/composition_test.py). */
const SYSTEM = { package: 'mica-system', version: '1.0.0-1', architecture: 'all', sha256: 'c'.repeat(64), source_repo: 'mica-system-base', source_commit: 'e'.repeat(40) }
/** Add one imported archive to the fixture's runtime report: a lock row and the pool package it names. */
function importOne(r: ReturnType<typeof runtime>, lock = IMPORTED, pool = IMPORTED) {
  const lineage = r.provenance.source_lineage
  lineage.pool.files['pool/mica-imported.deb'] = pool.sha256
  lineage.pool.packages.push({ ...pool, archive: 'pool/mica-imported.deb', control_sha256: 'f'.repeat(64) })
  lineage.lock = [{ ...lock }, ...lineage.lock.filter((row: { package: string }) => row.package !== lock.package)]
  r.provenance.capture_sha256['source-lineage.json'] = hash(Buffer.from(canonicalJson(lineage) + '\n'))
  return lineage
}

test('runtime source lineage records the lock rows and derives composition provenance', () => {
  const r = runtime(), lineage = importOne(r)
  writeRuntime(r)
  assembleRelease(inputs); gateRelease(inputs.out, keys)
  const provenance = read('provenance.json').runtime
  expect(provenance.sourceLineage).toEqual(lineage)
  expect(provenance.lock).toEqual([IMPORTED, SYSTEM])
  expect(provenance.unlocked).toEqual([])
  expect(lineage.package_source.commit).toBe('a'.repeat(40))
})

test.each(['missing', 'unknown', 'source', 'split-source', 'pool', 'stamp', 'epoch', 'capture', 'dirty',
  'lock-differs', 'lock-unsorted', 'lock-version', 'unlocked-unknown', 'not-in-lock', 'locked-missing', 'no-source', 'commit-differs'])('runtime source lineage refuses %s even with a recomputed report hash', mutation => {
  const r = runtime(), lineage = importOne(r)
  if (mutation === 'missing') delete r.provenance.source_lineage
  if (mutation === 'unknown') lineage.producer_join = { schema: 'mica/producer-join/v1' }
  if (mutation === 'source') lineage.composition_source.commit = 'b'.repeat(40)
  if (mutation === 'split-source') { lineage.composition_source.commit = 'b'.repeat(40); inputs.source.commit = 'b'.repeat(40) }
  if (mutation === 'pool') lineage.pool.files.Packages = 'b'.repeat(64)
  if (mutation === 'stamp') lineage.package_source.version = '0.1.0+git' + 'b'.repeat(12) + '-1'
  if (mutation === 'epoch') lineage.root_epoch++
  if (mutation === 'lock-differs') lineage.lock[0].sha256 = '0'.repeat(64)
  if (mutation === 'lock-unsorted') lineage.lock.unshift({ ...IMPORTED, package: 'zzz' })
  if (mutation === 'lock-version') { lineage.lock[0].version = 'v2'; lineage.pool.packages.at(-1).version = lineage.lock[0].version }
  if (mutation === 'unlocked-unknown') lineage.unlocked = ['mica-other']
  if (mutation === 'not-in-lock') lineage.lock = lineage.lock.filter((row: { package: string }) => row.package !== 'mica-system')
  if (mutation === 'commit-differs') lineage.pool.packages.at(-1).source_commit = 'c'.repeat(40)
  if (mutation === 'locked-missing') { lineage.pool.packages.pop(); delete lineage.pool.files['pool/mica-imported.deb'] }
  if (mutation === 'no-source') delete lineage.pool.packages[0].source_commit
  if (mutation === 'capture') r.provenance.capture_sha256['source-lineage.json'] = '0'.repeat(64)
  else if (mutation !== 'missing') r.provenance.capture_sha256['source-lineage.json'] = hash(Buffer.from(canonicalJson(lineage) + '\n'))
  if (mutation === 'dirty') inputs.source.dirty = true
  writeRuntime(r)
  expect(() => assembleRelease(inputs)).toThrow()
  expect(existsSync(inputs.out)).toBe(false)
})

test('an unlocked import is accepted on development and refused on customer channels, at assembly and at the gate', () => {
  const r = runtime()
  const lineage = importOne(r, IMPORTED, { ...IMPORTED, version: '2.0.1-1', sha256: '9'.repeat(64), source_commit: 'c'.repeat(40) })
  expect(() => { writeRuntime(r); assembleRelease(inputs) }).toThrow('runtime lineage locked archive mica-imported')
  lineage.unlocked = ['mica-imported']
  r.provenance.capture_sha256['source-lineage.json'] = hash(Buffer.from(canonicalJson(lineage) + '\n'))
  writeRuntime(r)
  assembleRelease(inputs); gateRelease(inputs.out, keys)
  expect(read('provenance.json').runtime.unlocked).toEqual(['mica-imported'])
  rmSync(inputs.out, { recursive: true })
  // Without a development marker the channel rule is the waiver's alone: a
  // runtime composed without the marker, the same import waived.
  rmSync(join(work, 'meta/GENERATED'))
  runtimeFixture()
  const bare = runtime()
  importOne(bare, IMPORTED, { ...IMPORTED, version: '2.0.1-1', sha256: '9'.repeat(64), source_commit: 'c'.repeat(40) }).unlocked = ['mica-imported']
  bare.provenance.capture_sha256['source-lineage.json'] = hash(Buffer.from(canonicalJson(bare.provenance.source_lineage) + '\n'))
  writeRuntime(bare)
  assembleRelease(inputs); gateRelease(inputs.out, keys)
  const manifest = read('manifest.json'); manifest.channel = 'candidate'; write('manifest.json', manifest)
  expect(() => gateRelease(inputs.out, keys)).toThrow('unlocked packages cannot use customer channels')
  rmSync(inputs.out, { recursive: true })
  for (const channel of ['candidate', 'stable'] as const) {
    expect(() => assembleRelease({ ...inputs, channel })).toThrow('unlocked packages cannot use customer channels')
    expect(existsSync(inputs.out)).toBe(false)
  }
})

test('the release lock must equal the package rows of the tree locks for the board architecture when a locks directory is given', () => {
  const r = runtime(); importOne(r); writeRuntime(r)
  const lock = join(work, 'locks')
  const pool = join(work, 'no-own-archives'); mkdirSync(pool, { recursive: true })
  writeLocks(lock, [IMPORTED, SYSTEM, { ...IMPORTED, package: 'mica-arm-only', architecture: 'arm64' }])
  expect(() => assembleRelease({ ...inputs, lock })).toThrow('needs the pool directory')
  assembleRelease({ ...inputs, lock, pool }); rmSync(inputs.out, { recursive: true })
  writeLocks(lock, [{ ...IMPORTED, sha256: '0'.repeat(64) }, SYSTEM])
  expect(() => assembleRelease({ ...inputs, lock, pool })).toThrow('release lock differs from the tree lock')
  writeLocks(lock, [])
  expect(() => assembleRelease({ ...inputs, lock, pool })).toThrow('release lock differs from the tree lock')
  expect(existsSync(inputs.out)).toBe(false)
})

test('tree lock rows are read per pool, an all archive in both, and a lock that breaks a rule is refused', () => {
  const dir = join(work, 'locks')
  const emptyPool = join(work, 'no-own-archives'); mkdirSync(emptyPool, { recursive: true })
  const a = { package: 'mica-a', version: '1.0-1', architecture: 'all', sha256: 'a'.repeat(64), source_repo: 'repo', source_commit: 'a'.repeat(40) }
  const b = { ...a, package: 'mica-b', architecture: 'arm64', sha256: 'b'.repeat(64), source_repo: 'mica-system-base', source_commit: 'c'.repeat(40) }
  writeLocks(dir, [a, b])
  expect(treeLockRows(dir, 'amd64', emptyPool)).toEqual([{ package: 'mica-a', version: a.version, sha256: a.sha256, source_repo: 'repo', source_commit: 'a'.repeat(40) }])
  // The same archive pinned by two scoped locks of one repository is one row.
  const shared = { package: 'mica-shared', version: '1.0-1', architecture: 'arm64', sha256: 'd'.repeat(64), source_repo: 'mica-build', source_commit: 'e'.repeat(40) }
  writeLocks(join(dir, 'scoped'), [shared])
  writeFileSync(join(dir, 'scoped/mica-build.other.lock'), readFileSync(join(dir, 'scoped/mica-build.fixture.lock'), 'utf8').replaceAll('fixture', 'other'))
  writeFileSync(join(dir, 'scoped/pins/mica-build.other.pin'), readFileSync(join(dir, 'scoped/pins/mica-build.fixture.pin'), 'utf8').replaceAll('fixture', 'other'))
  expect(treeLockRows(join(dir, 'scoped'), 'arm64', emptyPool).map(r => r.package)).toEqual(['mica-shared'])
  expect(treeLockRows(dir, 'arm64', emptyPool).map(r => `${r.package} ${r.source_repo}`)).toEqual(['mica-a repo', 'mica-b mica-system-base'])
  writeFileSync(join(dir, 'repo.lock'), readFileSync(join(dir, 'repo.lock'), 'utf8').replace('a'.repeat(64), 'z'.repeat(64)))
  expect(() => treeLockRows(dir, 'amd64', emptyPool)).toThrow('refused')
  writeLocks(dir, [a]); rmSync(join(dir, 'pins/repo.pin'))
  expect(() => treeLockRows(dir, 'amd64', emptyPool)).toThrow('lock-without-pin')
})

test('the tree lock carries the archives this tree built into the pool, as rows of mica-build at HEAD', () => {
  const dir = join(work, 'locks-with-own')
  const a = { package: 'mica-a', version: '1.0-1', architecture: 'all', sha256: 'a'.repeat(64), source_repo: 'repo', source_commit: 'a'.repeat(40) }
  writeLocks(dir, [a])
  // One of the tree's own producers (tools/deb/producers.sh) at its declared version, as make board-pool leaves it:
  // the radio-wifi producer's mica-wifi, an `all` archive, so it is a row of the amd64 pool.
  const [producer, pkg, arch] = ['radio-wifi', 'mica-wifi', 'all']
  const version = spawnSync('bash', [join(REPO_ROOT, 'tools/deb/producers.sh'), '--version-for', producer], { encoding: 'utf8' }).stdout.split(/\s+/)[0]!
  expect(version).toMatch(/^[0-9]/)
  const pool = join(work, 'own-archives'); mkdirSync(join(pool, 'amd64/pool'), { recursive: true })
  writeFileSync(join(pool, `amd64/pool/${pkg}_${version}_${arch}.deb`), 'not a real archive; the row carries its digest')
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const rows = treeLockRows(dir, 'amd64', pool)
  expect(rows.map(r => r.package)).toEqual(['mica-a', pkg].sort())
  const own = rows.find(r => r.package === pkg)!
  expect(own).toEqual({ package: pkg, version, sha256: createHash('sha256').update('not a real archive; the row carries its digest').digest('hex'), source_repo: 'mica-build', source_commit: head })
  // The same name imported and built is a naming defect, refused by name.
  writeLocks(dir, [{ ...a, package: pkg }])
  expect(() => treeLockRows(dir, 'amd64', pool)).toThrow('is both imported by locks/ and built by this tree')
})
