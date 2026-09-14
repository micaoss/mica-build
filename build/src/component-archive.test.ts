import { test, expect } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Signer } from '../../shared/update-envelope'
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
    const archive = readFileSync(output)
    expect(archive.subarray(0, 8).toString()).toBe('MOSUPD01')
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
  } finally { rmSync(root, { recursive: true, force: true }) }
})
