import { afterEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticateDeployment, canonicalJson } from '../../build/src/components'
import { createService } from './app'
import { artifact, deployment, image, small } from './component-fixture'
import { parseConfig } from './config'

const token = 'component-test-administrator-token-32-characters'
const origin = 'http://updates.localhost'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0))
    await close()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mica-components-'))
  const service = await createService(parseConfig({ ADMIN_TOKEN: token, DATA_DIR: directory, PUBLIC_URL: origin, MAX_UPLOAD_BYTES: '16384', LOG_LEVEL: 'silent' }))
  cleanup.push(async () => {
    service.close()
    await rm(directory, { recursive: true, force: true })
  })
  const request = (path: string, method = 'GET', body?: unknown) => service.app.request(origin + path, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const upload = (id: string, bytes: Buffer, digest = artifact(bytes).sha256) => service.app.request(`${origin}/api/releases/${id}/objects/${digest}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  })
  const draft = async (generation = 1) => {
    const envelope = JSON.stringify(service.service.signer.sign(JSON.parse(canonicalJson(deployment(generation)))))
    const response = await request('/api/releases', 'POST', { channel: 'dev', deployment: envelope })
    expect(response.status).toBe(201)
    return response.json()
  }
  return { service, request, upload, draft }
}

test('publish requires every bound component and emits authenticated deployment metadata', async () => {
  const { service, request, upload, draft } = await fixture()
  const release = await draft()
  expect((await request(`/api/releases/${release.id}/publish`, 'POST')).status).toBe(409)
  expect((await upload(release.id, image)).status).toBe(200)
  expect((await request(`/api/releases/${release.id}/publish`, 'POST')).status).toBe(409)
  expect((await upload(release.id, small)).status).toBe(200)
  expect((await request(`/api/releases/${release.id}/publish`, 'POST')).status).toBe(200)
  const envelope = await (await request('/v1/manifest.json')).json()
  const catalog = JSON.parse(Buffer.from(envelope.payload, 'base64').toString())
  expect(catalog.schema).toBe('mica/catalog/v1')
  expect(catalog.releases).toHaveLength(1)
  expect(authenticateDeployment(catalog.releases[0].deployment, [service.service.signer.publicKey])).toEqual(deployment())
  expect(catalog.releases[0].objects).toHaveLength(2)
  for (const bytes of [small, image]) {
    const response = await request(`/v1/objects/${artifact(bytes).sha256}`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  }
})

test('component objects are immutable, integrity checked and reused by subsequent releases', async () => {
  const { request, upload, draft } = await fixture()
  const first = await draft()
  expect((await upload(first.id, small, artifact(image).sha256)).status).toBe(400)
  expect((await upload(first.id, image)).status).toBe(200)
  expect((await upload(first.id, image)).status).toBe(409)
  expect((await upload(first.id, small)).status).toBe(200)
  expect((await request(`/api/releases/${first.id}/publish`, 'POST')).status).toBe(200)
  const second = await draft(2)
  expect((await request(`/api/releases/${second.id}/publish`, 'POST')).status).toBe(200)
  expect((await request(`/api/releases/${first.id}/withdraw`, 'POST')).status).toBe(200)
  expect((await request(`/v1/objects/${artifact(image).sha256}`)).status).toBe(200)
  expect((await request(`/api/releases/${second.id}/withdraw`, 'POST')).status).toBe(200)
  expect((await request(`/v1/objects/${artifact(image).sha256}`)).status).toBe(404)
})

test('reject old bundle inputs, mixed component identities and unauthorized object uploads', async () => {
  const { service, request, draft } = await fixture()
  expect((await request('/api/releases', 'POST', { board: 'x64', channel: 'dev', version: 'old', epoch: 1 })).status).toBe(400)
  const wrong = deployment()
  wrong.kernel.support.rootHash = '0'.repeat(64)
  const invalidEnvelope = JSON.stringify(service.service.signer.sign(JSON.parse(canonicalJson(wrong))))
  expect((await request('/api/releases', 'POST', { channel: 'dev', deployment: invalidEnvelope })).status).toBe(400)
  const release = await draft()
  expect((await request(`/api/releases/${release.id}/artifact`, 'PUT')).status).toBe(404)
  expect((await service.app.request(`${origin}/api/releases/${release.id}/objects/${artifact(image).sha256}`, { method: 'PUT', body: image })).status).toBe(401)
})
