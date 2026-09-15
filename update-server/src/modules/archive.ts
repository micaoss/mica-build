import type { Deployment } from '../../../build/src/components'
import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'

/** One object of a MICAUPD1 archive: its digest, length and byte offset in the file. */
export interface ArchiveObject { sha256: string, bytes: number, offset: number }

/**
 * The signed descriptor and object table of a MICAUPD1 archive (mica-build's
 * full update package, or the full layer of its OCI update manifest), read
 * without the object bytes: descriptor length (u32 BE), descriptor, object count
 * (u32 BE), then per object 64 hex digest, u64 BE size and the bytes.
 */
export async function readArchive(path: string): Promise<{ envelope: string, objects: ArchiveObject[] }> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const read = async (offset: number, length: number) => {
      if (offset + length > size)
        throw new Error('truncated component archive')
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, offset)
      return buffer
    }
    if ((await read(0, 8)).toString() !== 'MICAUPD1')
      throw new Error('not a MICAUPD1 component archive')
    const length = (await read(8, 4)).readUInt32BE()
    if (length === 0 || length > 24576)
      throw new Error('archive descriptor exceeds bound')
    const envelope = (await read(12, length)).toString('utf8')
    let offset = 12 + length
    const count = (await read(offset, 4)).readUInt32BE()
    offset += 4
    const objects: ArchiveObject[] = []
    for (let i = 0; i < count; i++) {
      const sha256 = (await read(offset, 64)).toString('latin1')
      const bytes = Number((await read(offset + 64, 8)).readBigUInt64BE())
      if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || objects.some(object => object.sha256 === sha256))
        throw new Error('invalid or duplicate archive object')
      objects.push({ sha256, bytes, offset: offset + 72 })
      offset += 72 + bytes
    }
    if (offset !== size)
      throw new Error('trailing or missing archive bytes')
    return { envelope, objects }
  }
  finally { await file.close() }
}

type Fetch = (url: string, init: RequestInit) => Response | Promise<Response>

/**
 * Create a draft release from a full archive through the administrative API and
 * upload every object it carries; the server checks the signature, each
 * digest and length, and that the archive binds every object of the descriptor.
 * A root or kernel package is refused: the server serves complete releases.
 */
export async function importArchive(path: string, options: { origin: string, token: string, channel: string, notes?: string | undefined, fetch?: Fetch }) {
  const call = options.fetch ?? ((url, init) => fetch(url, init))
  const headers = { Authorization: `Bearer ${options.token}` }
  const { envelope, objects } = await readArchive(path)
  // A full package carries every object its descriptor binds; the descriptor's shape is read here to refuse a
  // root or kernel package before a draft exists, and the server authenticates it on creation.
  const d = JSON.parse(Buffer.from(JSON.parse(envelope).payload, 'base64').toString('utf8')) as Deployment
  const bound = new Set([d.kernel.boot.artifact, d.kernel.support.image, d.kernel.support.signature, d.rootfs.content.image, d.rootfs.content.signature]
    .map(artifact => `${artifact.sha256}:${artifact.bytes}`))
  const carried = new Set(objects.map(object => `${object.sha256}:${object.bytes}`))
  if (carried.size !== bound.size || [...bound].some(object => !carried.has(object)))
    throw new Error(`the archive is not a full update package: it does not carry exactly the ${bound.size} objects its descriptor binds`)
  const body = JSON.stringify({ channel: options.channel, deployment: envelope, notes: options.notes ?? '' })
  const created = await call(`${options.origin}/api/releases`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body })
  if (created.status !== 201)
    throw new Error(`creating the release answered ${created.status}: ${await created.text()}`)
  const release = await created.json() as { id: string }
  for (const object of objects) {
    const bytes = Bun.file(path).slice(object.offset, object.offset + object.bytes)
    const upload = { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.bytes) }, body: bytes.stream() }
    const response = await call(`${options.origin}/api/releases/${release.id}/objects/${object.sha256}`, upload)
    if (response.status !== 200 && response.status !== 409)
      throw new Error(`uploading ${object.sha256} answered ${response.status}: ${await response.text()}`)
  }
  return release.id
}
