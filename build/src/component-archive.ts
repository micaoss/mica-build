import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { authenticateDeployment } from './components'

/** Stream the same authenticated component set used by online acquisition. */
export function packArchive(envelope: string, kernel: string, root: string, keys: string[], output: string) {
  const d = authenticateDeployment(envelope, keys)
  const objects = new Map<string, { bytes: number, path: string }>()
  for (const [artifact, path] of [
    [d.kernel.boot.artifact, join(kernel, d.kernel.boot.format === 'uki' ? 'boot.efi' : 'boot.itb')],
    [d.kernel.support.image, join(kernel, 'support.img')],
    [d.kernel.support.signature, join(kernel, 'support.roothash.p7s')],
    [d.rootfs.content.image, join(root, 'rootfs.img')],
    [d.rootfs.content.signature, join(root, 'rootfs.roothash.p7s')],
  ] as const) {
    const existing = objects.get(artifact.sha256)
    if (existing && existing.bytes !== artifact.bytes) throw new Error('Conflicting object lengths')
    if (!existing) objects.set(artifact.sha256, { bytes: artifact.bytes, path })
  }
  const temporary = `${output}.partial`
  const destination = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(destination, 'MOSUPD01')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(Buffer.byteLength(envelope))
    writeFileSync(destination, length)
    writeFileSync(destination, envelope)
    length.writeUInt32BE(objects.size)
    writeFileSync(destination, length)
    const buffer = Buffer.alloc(65536)
    for (const [sha, artifact] of [...objects].sort(([a], [b]) => a.localeCompare(b))) {
      const metadata = lstatSync(artifact.path)
      if (!metadata.isFile() || metadata.size !== artifact.bytes) throw new Error('Object length or type mismatch')
      writeFileSync(destination, sha)
      const size = Buffer.alloc(8)
      size.writeBigUInt64BE(BigInt(artifact.bytes))
      writeFileSync(destination, size)
      const source = openSync(artifact.path, 'r')
      const hash = createHash('sha256')
      let total = 0
      try {
        for (;;) {
          const count = readSync(source, buffer)
          if (!count) break
          total += count
          if (total > artifact.bytes) throw new Error('Object exceeded byte bound')
          const chunk = buffer.subarray(0, count)
          hash.update(chunk)
          writeFileSync(destination, chunk)
        }
      } finally { closeSync(source) }
      if (total !== artifact.bytes || hash.digest('hex') !== sha) throw new Error('Object digest mismatch')
    }
    fsyncSync(destination)
  } finally { closeSync(destination) }
  linkSync(temporary, output)
  unlinkSync(temporary)
  const parent = openSync(dirname(output), 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
