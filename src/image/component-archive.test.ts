import { test, expect } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Signer } from '../shared/update-envelope'
import { canonicalJson, componentId } from './components'
import { packArchive } from './component-archive'

test('offline archive contains the exact signed descriptor and deduplicated bounded objects', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-'))
  try {
    const bytes = Buffer.alloc(12288, 42)
    const artifact = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const d = JSON.parse(readFileSync(new URL('../../tests/component-contracts/deployment.json', import.meta.url), 'utf8'))
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
    packArchive(envelope, join(root, 'kernel'), join(root, 'root'), [signer.publicKey], output)
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
    expect(() => packArchive(envelope, join(root, 'kernel'), join(root, 'root'), [signer.publicKey], corrupt)).toThrow('digest')
    expect(existsSync(corrupt)).toBe(false)
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('root and kernel archives carry the contract\'s object sets of the same signed descriptor', () => {
  const root = mkdtempSync(join(tmpdir(), 'mica-archive-kinds-'))
  try {
    const fixtures = JSON.parse(readFileSync(new URL('../../tests/component-contracts/cases.json', import.meta.url), 'utf8'))
    const d = JSON.parse(readFileSync(new URL('../../tests/component-contracts/deployment.json', import.meta.url), 'utf8'))
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
      packArchive(envelope, join(root, 'kernel'), join(root, 'root'), [signer.publicKey], output, kind)
      expect(objects(output)).toEqual(expected.archive.map((pointer: string) => at(pointer).sha256).sort())
    }
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})
