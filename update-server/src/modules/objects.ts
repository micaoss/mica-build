import type { Artifact } from '../../../build/src/components'
import type { Config } from '../config'
import type { Store } from '../db'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { objects } from '../db/schema'
import { AppError } from '../shared/errors'

export async function acceptObject(config: Config, expected: Artifact, request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream')
    throw new AppError(415, 'content_type', 'Upload application/octet-stream bytes')
  const declared = request.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) !== expected.bytes))
    throw new AppError(400, 'length_mismatch', 'Content-Length differs from the manifest')
  if (!request.body)
    throw new AppError(400, 'empty_object', 'Object must not be empty')
  const directory = join(config.dataDir, 'objects')
  const temporary = join(directory, `${randomUUID()}.partial`)
  const file = await open(temporary, 'wx', 0o600)
  const hasher = createHash('sha256')
  let bytes = 0
  let renamed = false
  try {
    for await (const chunk of request.body) {
      bytes += chunk.byteLength
      if (bytes > expected.bytes)
        throw new AppError(413, 'upload_too_large', 'Object exceeds its authenticated length')
      hasher.update(chunk)
      await file.writeFile(chunk)
    }
    if (bytes !== expected.bytes || hasher.digest('hex') !== expected.sha256)
      throw new AppError(400, 'integrity_mismatch', 'Object length or digest differs from the manifest')
    await file.sync()
    await file.close()
    // All writers reaching this path have verified identical immutable bytes.
    await rename(temporary, join(directory, expected.sha256))
    renamed = true
    const parent = await open(directory, 'r')
    try {
      await parent.sync()
    }
    finally { await parent.close() }
  }
  finally {
    await file.close()
    if (!renamed)
      await unlink(temporary)
  }
}

export async function verifyStoredObject(store: Store, config: Config, expected: Artifact) {
  const object = store.db.select().from(objects).where(eq(objects.sha256, expected.sha256)).get()
  if (!object || object.bytes !== expected.bytes)
    throw new AppError(409, 'not_publishable', 'All manifest objects must be uploaded')
  const path = join(config.dataDir, 'objects', object.sha256)
  const metadata = await lstat(path).catch(() => null)
  if (!metadata?.isFile() || metadata.size !== expected.bytes)
    throw new AppError(409, 'invalid_object', 'A stored object is missing or damaged')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
  }
  if (size !== expected.bytes || hash.digest('hex') !== expected.sha256)
    throw new AppError(409, 'invalid_object', 'A stored object is missing or damaged')
}
