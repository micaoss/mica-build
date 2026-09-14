import type { z } from '@hono/zod-openapi'
import type { Config } from '../config'
import type { Store } from '../db'
import type { FirmwareRelease } from '../db/schema'
import type { firmwareInput } from './contract'
import type { Signer } from './signing'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { authenticateFirmware } from '../../../build/src/firmware'
import { audit, firmware, objects } from '../db/schema'
import { AppError } from '../shared/errors'
import { acceptObject, verifyStoredObject } from './objects'

export class FirmwareService {
  constructor(readonly store: Store, readonly config: Config, readonly signer: Signer, readonly publicKeys: readonly string[]) {}

  list() {
    return this.store.db.select().from(firmware).orderBy(desc(firmware.generation), desc(firmware.createdAt)).all()
  }

  get(id: string) {
    const record = this.store.db.select().from(firmware).where(eq(firmware.id, id)).get()
    if (!record)
      throw new AppError(404, 'not_found', 'Firmware not found')
    return record
  }

  view(record: FirmwareRelease) {
    return { ...record, objects: [{ sha256: record.artifactSha256, bytes: record.artifactBytes, available: !!this.store.db.select().from(objects).where(eq(objects.sha256, record.artifactSha256)).get() }] }
  }

  log(action: string, id: string, detail: string) {
    this.store.db.insert(audit).values({ action: `firmware-${action}`, releaseId: id, detail, createdAt: new Date().toISOString() }).run()
  }

  create(input: z.infer<typeof firmwareInput>) {
    let manifest
    try {
      manifest = authenticateFirmware(input.firmware, this.publicKeys)
    }
    catch { throw new AppError(400, 'invalid_firmware', 'Invalid signed firmware manifest') }
    if (manifest.artifact.bytes > this.config.maxUploadBytes)
      throw new AppError(413, 'upload_too_large', 'Firmware exceeds the upload limit')
    const { board, arch, generation, version, artifact } = manifest
    return this.store.db.transaction(() => {
      if (this.store.db.select().from(firmware).where(and(eq(firmware.board, board), eq(firmware.channel, input.channel), eq(firmware.generation, generation))).get())
        throw new AppError(409, 'duplicate_generation', 'This board/channel firmware generation already exists')
      const existing = this.store.db.select().from(objects).where(eq(objects.sha256, artifact.sha256)).get()
      if (existing && existing.bytes !== artifact.bytes)
        throw new AppError(409, 'conflicting_object', 'A digest has conflicting object lengths')
      const id = randomUUID()
      this.store.db.insert(firmware).values({ id, board, arch, generation, version, channel: input.channel, firmwareId: manifest.id, firmware: input.firmware, artifactSha256: artifact.sha256, artifactBytes: artifact.bytes, notes: input.notes, status: 'draft', createdAt: new Date().toISOString() }).run()
      this.log('create', id, `${board} / ${input.channel} / ${version}`)
      return this.view(this.get(id))
    }, { behavior: 'immediate' })
  }

  async upload(id: string, digest: string, request: Request) {
    const record = this.get(id)
    if (record.artifactSha256 !== digest)
      throw new AppError(400, 'unlisted_object', 'Object is not bound by this firmware manifest')
    if (record.status !== 'draft' || this.store.db.select().from(objects).where(eq(objects.sha256, digest)).get())
      throw new AppError(409, 'immutable_object', 'Only a missing draft object can be uploaded')
    await acceptObject(this.config, { sha256: digest, bytes: record.artifactBytes }, request)
    return this.store.db.transaction(() => {
      if (this.get(id).status !== 'draft' || this.store.db.select().from(objects).where(eq(objects.sha256, digest)).get())
        throw new AppError(409, 'immutable_object', 'Object has already been uploaded')
      this.store.db.insert(objects).values({ sha256: digest, bytes: record.artifactBytes, createdAt: new Date().toISOString() }).run()
      this.log('upload', id, `${record.artifactBytes} bytes / ${digest}`)
      return this.view(this.get(id))
    }, { behavior: 'immediate' })
  }

  async transition(id: string, action: 'publish' | 'withdraw') {
    const record = this.get(id)
    if (action === 'publish') {
      try {
        authenticateFirmware(record.firmware, this.publicKeys)
      }
      catch { throw new AppError(409, 'invalid_firmware', 'Firmware no longer has a trusted signature') }
      await verifyStoredObject(this.store, this.config, { sha256: record.artifactSha256, bytes: record.artifactBytes })
    }
    return this.store.db.transaction(() => {
      const current = this.get(id)
      if (action === 'publish') {
        if (current.status !== 'draft')
          throw new AppError(409, 'not_publishable', 'Only a complete draft can be published')
        const previous = this.store.db.select().from(firmware).where(and(eq(firmware.board, current.board), eq(firmware.channel, current.channel), isNotNull(firmware.publishedAt))).orderBy(desc(firmware.generation)).get()
        if (previous && current.generation <= previous.generation)
          throw new AppError(409, 'generation_not_increasing', 'Firmware generation must exceed every previously published generation')
        this.store.db.update(firmware).set({ status: 'published', publishedAt: new Date().toISOString() }).where(eq(firmware.id, id)).run()
      }
      else {
        if (current.status !== 'published')
          throw new AppError(409, 'not_published', 'Only published firmware can be withdrawn')
        this.store.db.update(firmware).set({ status: 'withdrawn' }).where(eq(firmware.id, id)).run()
      }
      this.log(action, id, `${current.board} / ${current.channel} / ${current.version}`)
      return this.view(this.get(id))
    }, { behavior: 'immediate' })
  }
}
