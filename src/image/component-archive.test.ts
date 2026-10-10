import { test, expect } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Signer } from '../shared/update-envelope'
import { canonicalJson, componentId, type CoreComponent } from './components'
import { packArchive, packCoreArchive, unpackArchive } from './component-archive'
import { buildCoreSet } from './core-set'

test('offline archive contains the exact signed descriptor and deduplicated bounded objects', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-'))
  try {
    const bytes = Buffer.alloc(12288, 42)
    const artifact = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const d = JSON.parse(readFileSync(new URL('../../tests/fixtures/component-contracts/deployment.json', import.meta.url), 'utf8'))
    d.kernel.boot.artifact = artifact
    d.kernel.support.image = artifact
    d.kernel.support.signature = artifact
    d.rootfs.content.image = artifact
    d.rootfs.content.signature = artifact
    d.kernel.id = componentId(d.kernel)
    d.rootfs.id = componentId(d.rootfs)
    const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
    const envelope = JSON.stringify(signer.sign(JSON.parse(canonicalJson(d))))
    for (const name of ['kernel', 'root']) mkdirSync(join(root, name))
    writeFileSync(join(root, 'kernel/boot.efi'), bytes)
    const output = join(root, 'update.micaupd')
    packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], output)
    expect(statSync(output).mode & 0o777).toBe(0o644)
    const archive = readFileSync(output)
    expect(archive.subarray(0, 8).toString()).toBe('MICAUPD1')
    expect(archive.readUInt32BE(8)).toBe(Buffer.byteLength(envelope))
    const end = 12 + Buffer.byteLength(envelope)
    expect(archive.subarray(12, end).toString()).toBe(envelope)
    expect(archive.readUInt32BE(end)).toBe(1)
    expect(archive.subarray(end + 4, end + 68).toString()).toBe(artifact.sha256)
    expect(archive.readBigUInt64BE(end + 68)).toBe(BigInt(bytes.length))
    expect(archive.subarray(end + 76)).toEqual(bytes)
    writeFileSync(join(root, 'kernel/boot.efi'), Buffer.alloc(bytes.length, 0))
    const corrupt = join(root, 'corrupt.micaupd')
    expect(() => packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], corrupt)).toThrow('digest')
    expect(existsSync(corrupt)).toBe(false)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('root and kernel archives carry the contract\'s object sets of the same signed descriptor', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-kinds-'))
  try {
    const fixtures = JSON.parse(readFileSync(new URL('../../tests/fixtures/component-contracts/cases.json', import.meta.url), 'utf8'))
    const d = JSON.parse(readFileSync(new URL('../../tests/fixtures/component-contracts/deployment.json', import.meta.url), 'utf8'))
    for (const name of ['kernel', 'root']) mkdirSync(join(root, name))
    // Five distinct objects at the five descriptor pointers.
    const files: Record<string, string> = { '/kernel/boot/artifact': 'kernel/boot.efi', '/kernel/support/image': 'kernel/support.img',
      '/kernel/support/signature': 'kernel/support.roothash.p7s', '/rootfs/content/image': 'root/rootfs.img', '/rootfs/content/signature': 'root/rootfs.roothash.p7s' }
    const at = (pointer: string) => pointer.slice(1).split('/').reduce((node: Record<string, unknown>, key) => node[key] as Record<string, unknown>, d) as { bytes: number, sha256: string }
    Object.entries(files).forEach(([pointer, file], i) => {
      const bytes = pointer.endsWith('image') ? Buffer.alloc(at(pointer).bytes, i + 1) : Buffer.alloc(100 + i, i + 1)
      writeFileSync(join(root, file), bytes)
      Object.assign(at(pointer), { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    })
    d.kernel.id = componentId(d.kernel)
    d.rootfs.id = componentId(d.rootfs)
    const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
    const envelope = JSON.stringify(signer.sign(JSON.parse(canonicalJson(d))))
    const objects = (file: string) => {
      const archive = readFileSync(file)
      let offset = 12 + archive.readUInt32BE(8)
      expect(archive.subarray(12, offset).toString()).toBe(envelope)
      const count = archive.readUInt32BE(offset)
      offset += 4
      const digests: string[] = []
      for (let i = 0; i < count; i++) {
        digests.push(archive.subarray(offset, offset + 64).toString())
        offset += 72 + Number(archive.readBigUInt64BE(offset + 64))
      }
      expect(offset).toBe(archive.length)
      return digests.sort()
    }
    for (const [kind, name] of [['full', 'full'], ['root', 'root-only-with-kernel-present'], ['kernel', 'kernel-only-with-root-present']] as const) {
      const expected = fixtures.archives.find((c: { name: string }) => c.name === name)
      expect(expected.result).toBe('accepted')
      const output = join(root, `${kind}.micaupd`)
      packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], output, kind)
      expect(objects(output)).toEqual(expected.archive.map((pointer: string) => at(pointer).sha256).sort())
    }
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('a core archive carries only the core components\' objects; a full one carries them with the kernel and root', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-core-'))
  try {
    const d = JSON.parse(readFileSync(new URL('../../tests/fixtures/component-contracts/deployment.json', import.meta.url), 'utf8'))
    const object = (file: string, fill: number, bytes = 100) => {
      const data = Buffer.alloc(bytes, fill)
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), data)
      return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    }
    d.kernel.boot.artifact = object('kernel/boot.efi', 1)
    d.kernel.support.image = object('kernel/support.img', 2, d.kernel.support.image.bytes)
    d.kernel.support.signature = object('kernel/support.roothash.p7s', 3)
    d.rootfs.content.image = object('root/rootfs.img', 4, d.rootfs.content.image.bytes)
    d.rootfs.content.signature = object('root/rootfs.roothash.p7s', 5)
    d.kernel.id = componentId(d.kernel)
    d.rootfs.id = componentId(d.rootfs)
    const content = { ...structuredClone(d.rootfs.content), image: object('cores/micad/core.img', 6, d.rootfs.content.image.bytes), signature: object('cores/micad/core.roothash.p7s', 7) }
    const core = { schema: 'mica/core/v1', id: '', arch: d.arch, package: 'micad', version: '0.0.10', features: ['micad'], needs: [], root: { min: 1 }, content }
    core.id = componentId(core)
    d.core = [core]
    const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
    const envelope = JSON.stringify(signer.sign(JSON.parse(canonicalJson(d))))
    const count = (file: string) => { const a = readFileSync(file); return a.readUInt32BE(12 + a.readUInt32BE(8)) }
    packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], join(root, 'core.micaupd'), 'core')
    packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], join(root, 'full.micaupd'), 'full')
    expect(count(join(root, 'core.micaupd'))).toBe(2)
    expect(count(join(root, 'full.micaupd'))).toBe(7)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('a full archive unpacks into the kernel and root components it was packed from', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-unpack-'))
  try {
    const d = JSON.parse(readFileSync(new URL('../../tests/fixtures/component-contracts/deployment.json', import.meta.url), 'utf8'))
    const object = (file: string, fill: number, bytes = 100) => {
      const data = Buffer.alloc(bytes, fill)
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), data)
      return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    }
    d.kernel.boot.artifact = object('kernel/boot.efi', 1)
    d.kernel.support.image = object('kernel/support.img', 2, d.kernel.support.image.bytes)
    d.kernel.support.signature = object('kernel/support.roothash.p7s', 3)
    d.rootfs.content.image = object('root/rootfs.img', 4, d.rootfs.content.image.bytes)
    d.rootfs.content.signature = object('root/rootfs.roothash.p7s', 5)
    d.kernel.id = componentId(d.kernel)
    d.rootfs.id = componentId(d.rootfs)
    const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
    const envelope = JSON.stringify(signer.sign(JSON.parse(canonicalJson(d))))
    packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], join(root, 'full.micaupd'))
    unpackArchive(join(root, 'full.micaupd'), [signer.publicKey], join(root, 'k'), join(root, 'r'))
    for (const [from, to] of [['kernel/boot.efi', 'k/boot.efi'], ['kernel/support.img', 'k/support.img'], ['root/rootfs.img', 'r/rootfs.img'], ['root/rootfs.roothash.p7s', 'r/rootfs.roothash.p7s']] as const)
      expect(readFileSync(join(root, to))).toEqual(readFileSync(join(root, from)))
    expect(readFileSync(join(root, 'r/rootfs.json'), 'utf8')).toBe(canonicalJson(d.rootfs))
    expect(JSON.parse(readFileSync(join(root, 'k/boot.json'), 'utf8')).identity.kernelBuildId).toBe(d.kernel.buildId)
    packArchive(envelope, join(root, 'kernel'), join(root, 'root'), join(root, 'cores'), [signer.publicKey], join(root, 'root.micaupd'), 'root')
    expect(() => unpackArchive(join(root, 'root.micaupd'), [signer.publicKey], join(root, 'k2'), join(root, 'r2'))).toThrow('lacks the object')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('a core set archive carries the signed core set and exactly its objects, in digest order', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-set-'))
  try {
    const golden = JSON.parse(readFileSync(new URL('../../tests/fixtures/component-contracts/deployment.json', import.meta.url), 'utf8'))
    const object = (file: string, fill: number, bytes = 100) => {
      const data = Buffer.alloc(bytes, fill)
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), data)
      return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
    }
    const core = (pkg: string, fill: number, features: string[], needs: object[]) => {
      const content = { ...structuredClone(golden.rootfs.content), image: object(`cores/${pkg}/core.img`, fill, golden.rootfs.content.image.bytes), signature: object(`cores/${pkg}/core.roothash.p7s`, fill + 1) }
      const c = { schema: 'mica/core/v1', id: '', arch: golden.arch, package: pkg, version: '0.0.5', features, needs, root: { min: 1 }, content }
      c.id = componentId(c)
      return c as unknown as CoreComponent
    }
    const payload = buildCoreSet({ channel: 'general', arch: golden.arch as 'amd64', generation: 3, version: '0.0.5',
      components: [core('micad', 1, ['micad'], []), core('mica-apid-ui', 3, ['ui'], [{ package: 'micad', min: '0.0.5' }])] })
    const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
    const envelope = JSON.stringify(signer.sign(JSON.parse(payload)))
    const output = join(root, 'core.amd64.micaupd')
    packCoreArchive(envelope, join(root, 'cores'), [signer.publicKey], output)
    const a = readFileSync(output)
    expect(a.subarray(0, 8).toString()).toBe('MICAUPD1')
    const length = a.readUInt32BE(8)
    expect(a.subarray(12, 12 + length).toString()).toBe(envelope)
    expect(a.readUInt32BE(12 + length)).toBe(4)
    const shas: string[] = []
    for (let at = 16 + length; at < a.length;) { shas.push(a.subarray(at, at + 64).toString()); at += 72 + Number(a.readBigUInt64BE(at + 64)) }
    expect(shas).toEqual([...shas].sort())
    expect(new Set(shas)).toEqual(new Set(JSON.parse(payload).components.flatMap((c: { content: { image: { sha256: string }, signature: { sha256: string } } }) => [c.content.image.sha256, c.content.signature.sha256])))
    writeFileSync(join(root, 'cores/micad/core.roothash.p7s'), Buffer.alloc(100, 9))
    expect(() => packCoreArchive(envelope, join(root, 'cores'), [signer.publicKey], join(root, 'corrupt.micaupd'))).toThrow('digest')
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
