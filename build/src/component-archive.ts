import { createHash } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { authenticateDeployment } from './components'

/** The objects an update package carries: every object (full), or only the root's or the kernel's. */
export type UpdateKind = 'full' | 'root' | 'kernel'

/**
 * Stream the signed descriptor and the objects of one update kind (MICAUPD1).
 * A root or kernel archive carries the same descriptor as the full one and only
 * that component's objects; the device takes the others from its store and
 * refuses the archive when they are not there ("deployment objects are incomplete").
 */
export function packArchive(envelope: string, kernel: string, root: string, keys: string[], output: string, kind: UpdateKind = 'full') {
  const d = authenticateDeployment(envelope, keys)
  const objects = new Map<string, { bytes: number, path: string }>()
  const kernelObjects = [
    [d.kernel.boot.artifact, join(kernel, d.kernel.boot.format === 'uki' ? 'boot.efi' : 'boot.itb')],
    [d.kernel.support.image, join(kernel, 'support.img')],
    [d.kernel.support.signature, join(kernel, 'support.roothash.p7s')],
  ] as const
  const rootObjects = [
    [d.rootfs.content.image, join(root, 'rootfs.img')],
    [d.rootfs.content.signature, join(root, 'rootfs.roothash.p7s')],
  ] as const
  for (const [artifact, path] of [...(kind === 'root' ? [] : kernelObjects), ...(kind === 'kernel' ? [] : rootObjects)]) {
    const existing = objects.get(artifact.sha256)
    if (existing && existing.bytes !== artifact.bytes) throw new Error('Conflicting object lengths')
    if (!existing) objects.set(artifact.sha256, { bytes: artifact.bytes, path })
  }
  const temporary = `${output}.partial`
  const destination = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(destination, 'MICAUPD1')
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
    // A signed update archive is a public release asset: readable by whoever copies it on.
    fchmodSync(destination, 0o644)
    fsyncSync(destination)
  } finally { closeSync(destination) }
  linkSync(temporary, output)
  unlinkSync(temporary)
  const parent = openSync(dirname(output), 'r')
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
