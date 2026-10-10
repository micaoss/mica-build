import { createHash } from 'node:crypto'
import { closeSync, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { authenticateDeployment, canonicalJson, componentId, type Artifact, type Deployment } from './components'
import { authenticateCoreSet } from './core-set'

/** The objects an update package carries: every object (full), or only the root's, the kernel's or the core components'. */
export type UpdateKind = 'full' | 'root' | 'kernel' | 'core'

/**
 * Stream the signed descriptor and the objects of one update kind (MICAUPD1).
 * A root, kernel or core archive carries the same descriptor as the full one and only
 * those components' objects; the device takes the others from its store and
 * refuses the archive when they are not there ("deployment objects are incomplete").
 * `cores` is the cores directory: one signed core component per package.
 */
export function packArchive(envelope: string, kernel: string, root: string, cores: string, keys: string[], output: string, kind: UpdateKind = 'full') {
  const d = authenticateDeployment(envelope, keys)
  const kernelObjects = [
    [d.kernel.boot.artifact, join(kernel, d.kernel.boot.format === 'uki' ? 'boot.efi' : 'boot.itb')],
    [d.kernel.support.image, join(kernel, 'support.img')],
    [d.kernel.support.signature, join(kernel, 'support.roothash.p7s')],
  ] as const
  const rootObjects = [
    [d.rootfs.content.image, join(root, 'rootfs.img')],
    [d.rootfs.content.signature, join(root, 'rootfs.roothash.p7s')],
  ] as const
  const coreObjects = (d.core ?? []).flatMap(c => [
    [c.content.image, join(cores, c.package, 'core.img')],
    [c.content.signature, join(cores, c.package, 'core.roothash.p7s')],
  ] as const)
  writeArchive(envelope, { full: [...kernelObjects, ...rootObjects, ...coreObjects], root: rootObjects, kernel: kernelObjects, core: coreObjects }[kind], output)
}

/**
 * A core set's archive (MICAUPD1, mica-core:docs/mica-core.md 6.2 "Core sets"): the signed mica/core-set/v1 as its
 * envelope and exactly the objects the set names, each component's image and root-hash signature out of `cores`,
 * one directory per package as packCore leaves them.
 */
export function packCoreArchive(envelope: string, cores: string, keys: string[], output: string) {
  const set = authenticateCoreSet(envelope, keys)
  writeArchive(envelope, set.components.flatMap(c => [
    [c.content.image, join(cores, c.package, 'core.img')],
    [c.content.signature, join(cores, c.package, 'core.roothash.p7s')],
  ] as const), output)
}

/** MICAUPD1: the envelope, then each distinct object by digest order, each checked against its length and digest. */
function writeArchive(envelope: string, carried: readonly (readonly [Artifact, string])[], output: string) {
  const objects = new Map<string, { bytes: number, path: string }>()
  for (const [artifact, path] of carried) {
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
      }
      finally { closeSync(source) }
      if (total !== artifact.bytes || hash.digest('hex') !== sha) throw new Error('Object digest mismatch')
    }
    // A signed update archive is a public release asset: readable by whoever copies it on.
    fchmodSync(destination, 0o644)
    fsyncSync(destination)
  }
  finally { closeSync(destination) }
  linkSync(temporary, output)
  unlinkSync(temporary)
  const parent = openSync(dirname(output), 'r')
  try { fsyncSync(parent) }
  finally { closeSync(parent) }
}

/**
 * The kernel and root components of a signed update archive, as the component builders leave them: the kernel's
 * boot artifact, support image, root-hash signature and record (boot.json holding the boot identity the
 * descriptor states), and the root's image, signature and record. Every object is verified by length and
 * digest against the authenticated descriptor; an archive that lacks one is refused.
 */
export function unpackArchive(file: string, keys: string[], kernel: string, root: string): Deployment {
  const source = openSync(file, 'r')
  try {
    let offset = 0
    const read = (length: number) => {
      const buffer = Buffer.alloc(length)
      if (readSync(source, buffer, 0, length, offset) !== length) throw new Error('Truncated update archive')
      offset += length
      return buffer
    }
    if (read(8).toString() !== 'MICAUPD1') throw new Error('Not a MICAUPD1 archive')
    const envelope = read(read(4).readUInt32BE(0)).toString()
    const d = authenticateDeployment(envelope, keys)
    const count = read(4).readUInt32BE(0)
    const work = `${kernel}.objects`
    mkdirSync(work)
    try {
      const buffer = Buffer.alloc(65536)
      for (let i = 0; i < count; i++) {
        const sha = read(64).toString()
        const bytes = Number(read(8).readBigUInt64BE(0))
        if (!/^[0-9a-f]{64}$/.test(sha) || !Number.isSafeInteger(bytes)) throw new Error('Invalid archive object header')
        const target = openSync(join(work, sha), 'wx', 0o644)
        const hash = createHash('sha256')
        try {
          for (let left = bytes; left > 0;) {
            const count = readSync(source, buffer, 0, Math.min(left, buffer.length), offset)
            if (count === 0) throw new Error('Truncated update archive')
            offset += count; left -= count
            hash.update(buffer.subarray(0, count))
            writeFileSync(target, buffer.subarray(0, count))
          }
        }
        finally { closeSync(target) }
        if (hash.digest('hex') !== sha) throw new Error('Object digest mismatch')
      }
      const place = (artifact: { bytes: number, sha256: string }, path: string) => {
        const object = join(work, artifact.sha256)
        if (!lstatSync(object, { throwIfNoEntry: false })?.isFile() || lstatSync(object).size !== artifact.bytes) throw new Error(`The archive lacks the object ${artifact.sha256}`)
        linkSync(object, path)
      }
      for (const directory of [kernel, root]) mkdirSync(directory)
      place(d.kernel.boot.artifact, join(kernel, d.kernel.boot.format === 'uki' ? 'boot.efi' : 'boot.itb'))
      place(d.kernel.support.image, join(kernel, 'support.img'))
      place(d.kernel.support.signature, join(kernel, 'support.roothash.p7s'))
      writeFileSync(join(kernel, 'support.roothash'), d.kernel.support.rootHash)
      writeFileSync(join(kernel, 'kernel.json'), canonicalJson(d.kernel))
      writeFileSync(join(kernel, 'boot.json'), canonicalJson({ identity: { board: d.board, arch: d.arch, kernelBuildId: d.kernel.buildId,
        kernelRelease: d.kernel.release, supportId: componentId(d.kernel.support) } }))
      place(d.rootfs.content.image, join(root, 'rootfs.img'))
      place(d.rootfs.content.signature, join(root, 'rootfs.roothash.p7s'))
      writeFileSync(join(root, 'rootfs.roothash'), d.rootfs.content.rootHash)
      writeFileSync(join(root, 'rootfs.json'), canonicalJson(d.rootfs))
    }
    finally { rmSync(work, { recursive: true, force: true }) }
    return d
  }
  finally { closeSync(source) }
}
