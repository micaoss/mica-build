import { afterEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, componentId } from '../../build/src/components'
import { authenticateFirmware } from '../../build/src/firmware'
import { createService } from './app'
import { artifact } from './component-fixture'
import { parseConfig } from './config'

const token = 'firmware-test-administrator-token-32-characters'
const origin = 'http://updates.localhost'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mica-firmware-'))
  const service = await createService(parseConfig({ ADMIN_TOKEN: token, DATA_DIR: directory, PUBLIC_URL: origin, MAX_UPLOAD_BYTES: '16384', LOG_LEVEL: 'silent' }))
  cleanup.push(async () => {
    service.close()
    await rm(directory, { recursive: true, force: true })
  })
  const bytes = Buffer.from('isolated-firmware-object')
  const request = (path: string, method = 'GET', body?: unknown) => service.app.request(origin + path, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const draft = async (generation = 1) => {
    const manifest = { schema: 'mica/firmware/v1', id: '', board: 'cx3576', arch: 'arm64', generation, version: `firmware-${generation}`, artifact: artifact(bytes), target: { format: 'rockchip-loader', diskOffset: 32768, maxBytes: 16744448 } }
    manifest.id = componentId(manifest)
    const firmware = JSON.stringify(service.service.signer.sign(JSON.parse(canonicalJson(manifest))))
    return request('/api/firmware', 'POST', { channel: 'dev', firmware })
  }
  const upload = (id: string, body = bytes) => service.app.request(`${origin}/api/firmware/${id}/objects/${artifact(bytes).sha256}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(body),
  })
  return { service, directory, bytes, request, draft, upload }
}

test('firmware publication is independent of deployment selection and preserves signed ranges', async () => {
  const { service, bytes, request, draft, upload } = await fixture()
  const created = await draft()
  expect(created.status).toBe(201)
  const record = await created.json()
  expect((await request(`/api/firmware/${record.id}/publish`, 'POST')).status).toBe(409)
  expect((await upload(record.id, Buffer.from('tampered'))).status).toBe(400)
  expect((await upload(record.id)).status).toBe(200)
  expect((await upload(record.id)).status).toBe(409)
  expect((await request(`/api/firmware/${record.id}/publish`, 'POST')).status).toBe(200)
  const published = await (await request(`/v1/firmware/${record.id}`)).json()
  expect(authenticateFirmware(published.firmware, [service.service.signer.publicKey]).target).toEqual({ format: 'rockchip-loader', diskOffset: 32768, maxBytes: 16744448 })
  const catalog = await (await request('/v1/manifest.json')).json()
  expect(JSON.parse(Buffer.from(catalog.payload, 'base64').toString()).releases).toEqual([])
  const object = await request(`/v1/objects/${artifact(bytes).sha256}`)
  expect(object.status).toBe(200)
  expect(Buffer.from(await object.arrayBuffer())).toEqual(bytes)
  expect((await request(`/api/firmware/${record.id}/withdraw`, 'POST')).status).toBe(200)
  expect((await request(`/v1/firmware/${record.id}`)).status).toBe(404)
  expect((await request(`/v1/objects/${artifact(bytes).sha256}`)).status).toBe(404)
})

test('firmware publication checks duplicate generations, object reuse and stored corruption', async () => {
  const { directory, bytes, request, draft, upload } = await fixture()
  const first = await (await draft()).json()
  expect((await draft()).status).toBe(409)
  expect((await upload(first.id)).status).toBe(200)
  expect((await request(`/api/firmware/${first.id}/publish`, 'POST')).status).toBe(200)
  const second = await (await draft(2)).json()
  expect(second.objects[0].available).toBe(true)
  await writeFile(join(directory, 'objects', artifact(bytes).sha256), 'damaged')
  expect((await request(`/api/firmware/${second.id}/publish`, 'POST')).status).toBe(409)
  expect((await request('/api/firmware', 'POST', { channel: 'dev', firmware: '{}' })).status).toBe(400)
})
