import type { z } from '@hono/zod-openapi'
import type { Artifact } from '../../../build/src/components'
import type { Config } from '../config'
import type { Store } from '../db'
import type { Release } from '../db/schema'
import type { releaseInput } from './contract'
import type { Signer } from './signing'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { authenticateDeployment, canonicalJson, componentId } from '../../../build/src/components'
import { audit, catalogs, firmware, objects, releaseObjects, releases } from '../db/schema'
import { AppError } from '../shared/errors'
import { acceptObject, verifyStoredObject } from './objects'

export class ReleaseService {
  constructor(readonly store: Store, readonly config: Config, readonly signer: Signer, readonly publicKeys: readonly string[]) {}

  list() {
    return this.store.db.select().from(releases).orderBy(desc(releases.generation), desc(releases.createdAt)).all()
  }

  get(id: string): Release {
    const release = this.store.db.select().from(releases).where(eq(releases.id, id)).get()
    if (!release)
      throw new AppError(404, 'not_found', 'Release not found')
    return release
  }

  required(id: string) {
    return this.store.db.select().from(releaseObjects).where(eq(releaseObjects.releaseId, id)).all()
  }

  view(release: Release) {
    return { ...release, objects: this.required(release.id).map(({ sha256, bytes }) => ({
      sha256,
      bytes,
      available: !!this.store.db.select().from(objects).where(eq(objects.sha256, sha256)).get(),
    })) }
  }

  log(action: string, releaseId: string | null, detail: string) {
    this.store.db.insert(audit).values({ action, releaseId, detail, createdAt: new Date().toISOString() }).run()
  }

  create(input: z.infer<typeof releaseInput>) {
    let d
    try {
      d = authenticateDeployment(input.deployment, this.publicKeys)
    }
    catch { throw new AppError(400, 'invalid_deployment', 'Invalid deployment component metadata') }
    const required = new Map<string, Artifact>()
    for (const artifact of [d.kernel.boot.artifact, d.kernel.support.image, d.kernel.support.signature, d.rootfs.content.image, d.rootfs.content.signature]) {
      if (required.has(artifact.sha256) && required.get(artifact.sha256)!.bytes !== artifact.bytes)
        throw new AppError(400, 'conflicting_object', 'A digest has conflicting object lengths')
      if (artifact.bytes > this.config.maxUploadBytes)
        throw new AppError(413, 'upload_too_large', 'A component exceeds the upload limit')
      required.set(artifact.sha256, artifact)
    }
    return this.store.db.transaction(() => {
      const existing = this.store.db.select().from(releases).where(and(eq(releases.board, d.board), eq(releases.channel, input.channel), eq(releases.generation, d.generation))).get()
      if (existing)
        throw new AppError(409, 'duplicate_generation', 'This board/channel generation already exists')
      const id = randomUUID()
      this.store.db.insert(releases).values({ id, board: d.board, arch: d.arch, channel: input.channel, version: d.version, generation: d.generation, deploymentId: componentId(d), deployment: input.deployment, notes: input.notes, status: 'draft', createdAt: new Date().toISOString() }).run()
      this.store.db.insert(releaseObjects).values([...required.values()].map(artifact => ({ releaseId: id, ...artifact }))).run()
      this.log('create', id, `${d.board} / ${input.channel} / ${d.version}`)
      return this.view(this.get(id))
    }, { behavior: 'immediate' })
  }

  async upload(id: string, digest: string, request: Request) {
    const release = this.get(id)
    const expected = this.required(id).find(object => object.sha256 === digest)
    if (!expected)
      throw new AppError(400, 'unlisted_object', 'Object is not bound by this deployment')
    if (release.status !== 'draft' || this.store.db.select().from(objects).where(eq(objects.sha256, digest)).get())
      throw new AppError(409, 'immutable_object', 'Only a missing draft object can be uploaded')
    await acceptObject(this.config, expected, request)
    return this.store.db.transaction(() => {
      if (this.get(id).status !== 'draft' || this.store.db.select().from(objects).where(eq(objects.sha256, digest)).get())
        throw new AppError(409, 'immutable_object', 'Object has already been uploaded')
      this.store.db.insert(objects).values({ sha256: digest, bytes: expected.bytes, createdAt: new Date().toISOString() }).run()
      this.log('upload', id, `${expected.bytes} bytes / ${digest}`)
      return this.view(this.get(id))
    }, { behavior: 'immediate' })
  }

  downloadable(digest: string) {
    const object = this.store.db.select({ sha256: objects.sha256, bytes: objects.bytes }).from(objects).innerJoin(releaseObjects, eq(releaseObjects.sha256, objects.sha256)).innerJoin(releases, eq(releases.id, releaseObjects.releaseId)).where(and(eq(objects.sha256, digest), eq(releases.status, 'published'))).get()
    const maintenance = object ? undefined : this.store.db.select({ sha256: objects.sha256, bytes: objects.bytes }).from(objects).innerJoin(firmware, eq(firmware.artifactSha256, objects.sha256)).where(and(eq(objects.sha256, digest), eq(firmware.status, 'published'))).get()
    if (!object && !maintenance)
      throw new AppError(404, 'not_found', 'Object not found')
    return (object ?? maintenance)!
  }

  catalog() {
    const catalog = this.store.db.select().from(catalogs).where(eq(catalogs.id, 1)).get()
    if (!catalog)
      throw new Error('Catalog has not been initialized')
    return catalog
  }

  refreshCatalog() {
    const previous = this.store.db.select().from(catalogs).where(eq(catalogs.id, 1)).get()
    const revision = (previous?.revision ?? 0) + 1
    const issuedAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + this.config.metadataTtlHours * 3600000).toISOString()
    const published = this.list().filter(release => release.status === 'published')
    if (published.length > 128)
      throw new AppError(409, 'catalog_full', 'Withdraw older releases before publishing more metadata')
    const channels: { board: string, channel: string, releaseId: string, generation: number }[] = []
    for (const release of published) {
      if (!channels.some(item => item.board === release.board && item.channel === release.channel))
        channels.push({ board: release.board, channel: release.channel, releaseId: release.id, generation: release.generation })
    }
    const payload = canonicalJson({ schema: 'mica/catalog/v1', revision, issuedAt, expiresAt, channels, releases: published.map(release => ({ id: release.id, channel: release.channel, notes: release.notes, deployment: release.deployment, objects: this.required(release.id).map(({ sha256, bytes }) => ({ sha256, bytes, url: `${this.config.publicUrl}/v1/objects/${sha256}` })) })) })
    if (Buffer.byteLength(payload) > 1048576)
      throw new AppError(409, 'catalog_full', 'Withdraw older releases before publishing more metadata')
    const record = { id: 1, revision, issuedAt, expiresAt, envelope: JSON.stringify(this.signer.sign(JSON.parse(payload))) }
    this.store.db.insert(catalogs).values(record).onConflictDoUpdate({ target: catalogs.id, set: record }).run()
    return record
  }

  refresh() {
    return this.store.db.transaction(() => {
      const result = this.refreshCatalog()
      this.log('refresh', null, `Catalog revision ${result.revision}`)
      return result
    }, { behavior: 'immediate' })
  }

  async transition(id: string, action: 'publish' | 'withdraw') {
    if (action === 'publish') {
      const release = this.get(id)
      try {
        authenticateDeployment(release.deployment, this.publicKeys)
      }
      catch { throw new AppError(409, 'invalid_deployment', 'Deployment no longer has a trusted signature') }
      for (const expected of this.required(id))
        await verifyStoredObject(this.store, this.config, expected)
    }
    return this.store.db.transaction(() => {
      const release = this.get(id)
      if (action === 'publish') {
        if (release.status !== 'draft')
          throw new AppError(409, 'not_publishable', 'Only a complete draft can be published')
        const previous = this.store.db.select().from(releases).where(and(eq(releases.board, release.board), eq(releases.channel, release.channel), isNotNull(releases.publishedAt))).orderBy(desc(releases.generation)).get()
        if (previous && release.generation <= previous.generation)
          throw new AppError(409, 'generation_not_increasing', 'Generation must exceed every previously published generation in this board/channel')
        this.store.db.update(releases).set({ status: 'published', publishedAt: new Date().toISOString() }).where(eq(releases.id, id)).run()
      }
      else {
        if (release.status !== 'published')
          throw new AppError(409, 'not_published', 'Only a published release can be withdrawn')
        this.store.db.update(releases).set({ status: 'withdrawn' }).where(eq(releases.id, id)).run()
      }
      this.refreshCatalog()
      this.log(action, id, `${release.board} / ${release.channel} / ${release.version}`)
      return this.view(this.get(id))
    }, { behavior: 'immediate' })
  }
}
