import type { Release } from './db/schema'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from './app'
import { artifact, deployment, image, small } from './component-fixture'
import { parseConfig } from './config'
import { catalogs, sessions } from './db/schema'

const adminToken = 'test-admin-token-with-at-least-32-characters'
const origin = 'http://updates.localhost'
let directory: string
let service: Awaited<ReturnType<typeof createService>>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mica-updates-test-'))
  service = await createService(parseConfig({ ADMIN_TOKEN: adminToken, DATA_DIR: directory, PUBLIC_URL: origin, MAX_UPLOAD_BYTES: '16384', LOG_LEVEL: 'silent' }))
})
afterEach(async () => {
  service?.close()
  await rm(directory, { recursive: true, force: true })
})

function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
  return service.app.request(`${origin}${path}`, {
    method,
    headers: { ...(authenticated ? { Authorization: `Bearer ${adminToken}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('administrative operations require authentication', async () => {
  expect((await request('/api/releases', 'GET', undefined, false)).status).toBe(401)
  expect((await request('/api/releases', 'POST', {}, false)).status).toBe(401)
})

function releaseInput(generation = 1, board = 'uefi-x64', channel = 'stable', product = `${board}-dev`) {
  return { channel, deployment: JSON.stringify(service.service.signer.sign(deployment(generation, board, product))) }
}
async function draft(generation = 1, board = 'uefi-x64', channel = 'stable', product = `${board}-dev`): Promise<Release> {
  const response = await request('/api/releases', 'POST', releaseInput(generation, board, channel, product))
  expect(response.status).toBe(201)
  return response.json()
}
function upload(id: string, body: BodyInit | null = new Uint8Array(small), headers: Record<string, string> = {}, digest = artifact(small).sha256) {
  return service.app.request(`${origin}/api/releases/${id}/objects/${digest}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream', ...headers },
    body,
  })
}
async function uploadAll(id: string) {
  for (const bytes of [small, image]) {
    if (!service.service.view(service.service.get(id)).objects.find(object => object.sha256 === artifact(bytes).sha256)?.available)
      expect((await upload(id, new Uint8Array(bytes), {}, artifact(bytes).sha256)).status).toBe(200)
  }
}
async function published(generation = 1, board = 'uefi-x64', channel = 'stable', product = `${board}-dev`) {
  const release = await draft(generation, board, channel, product)
  await uploadAll(release.id)
  expect((await request(`/api/releases/${release.id}/publish`, 'POST')).status).toBe(200)
  return release
}

test('catalog signatures bind the exact payload, release identity and download digest', async () => {
  await published()
  const envelope = await (await request('/v1/manifest.json')).json()
  const status = await (await request('/api/status')).json()
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(status.signing.publicKey, 'base64').toString('base64url') }, format: 'jwk' })
  const payload = Buffer.from(envelope.payload, 'base64')
  expect(verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))).toBe(true)
  const document = JSON.parse(payload.toString())
  expect(document.schema).toBe('mica/catalog/v2')
  expect(document.releases[0].objects.find((object: { bytes: number }) => object.bytes === 10).sha256).toBe('84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882')
  document.releases[0].deployment = 'tampered'
  expect(verify(null, Buffer.from(JSON.stringify(document)), key, Buffer.from(envelope.signature, 'base64'))).toBe(false)
  expect(envelope.keyId).toBe(status.signing.keyId)
})

test('catalog reads never renew metadata, including after expiry and restart', async () => {
  const before = await (await request('/v1/manifest.json')).text()
  using _clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 86400000)
  expect((await (await request('/api/status')).json()).expired).toBe(true)
  expect(await (await request('/v1/manifest.json')).text()).toBe(before)
  service.close()
  service = await createService(parseConfig({ ADMIN_TOKEN: adminToken, DATA_DIR: directory, PUBLIC_URL: origin, LOG_LEVEL: 'silent' }))
  expect(await (await request('/v1/manifest.json')).text()).toBe(before)
  expect((await request('/api/metadata/refresh', 'POST')).status).toBe(200)
  expect(await (await request('/v1/manifest.json')).text()).not.toBe(before)
  expect((await (await request('/api/status')).json()).expired).toBe(false)
})

test('higher generations become channel heads without crossing board, product or channel boundaries', async () => {
  const first = await published(1, 'cx3576')
  const second = await published(2, 'cx3576')
  const beta = await published(1, 'cx3576', 'beta')
  const generic = await published(1, 'uefi-x64')
  // Two products of one board and channel keep separate heads, each at its own generation 1.
  const other = await published(1, 'uefi-x64', 'stable', 'uefi-x64-prod')
  const decode = async () => JSON.parse(Buffer.from((await (await request('/v1/manifest.json')).json()).payload, 'base64').toString())
  expect((await decode()).channels).toHaveLength(4)
  expect((await decode()).channels).toEqual(expect.arrayContaining([
    { board: 'cx3576', product: 'cx3576-dev', channel: 'stable', releaseId: second.id, generation: 2 },
    { board: 'cx3576', product: 'cx3576-dev', channel: 'beta', releaseId: beta.id, generation: 1 },
    { board: 'uefi-x64', product: 'uefi-x64-dev', channel: 'stable', releaseId: generic.id, generation: 1 },
    { board: 'uefi-x64', product: 'uefi-x64-prod', channel: 'stable', releaseId: other.id, generation: 1 },
  ]))
  await request(`/api/releases/${second.id}/withdraw`, 'POST')
  expect((await decode()).channels).toContainEqual({ board: 'cx3576', product: 'cx3576-dev', channel: 'stable', releaseId: first.id, generation: 1 })
  expect((await request(`/api/releases/${second.id}/publish`, 'POST')).status).toBe(409)
})

test('withdrawal does not reset the highest published generation', async () => {
  const higher = await published(10)
  await request(`/api/releases/${higher.id}/withdraw`, 'POST')
  const lower = await draft(9)
  await uploadAll(lower.id)
  const response = await request(`/api/releases/${lower.id}/publish`, 'POST')
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe('generation_not_increasing')
})

test('duplicate generations, unknown fields and invalid release identities are rejected', async () => {
  await draft()
  expect((await request('/api/releases', 'POST', releaseInput())).status).toBe(409)
  for (const extra of [{ channel: 'unknown' }, { admin: true }, { notes: 'x'.repeat(10001) }])
    expect((await request('/api/releases', 'POST', { ...releaseInput(2), ...extra })).status).toBe(400)
  for (const change of [{ generation: 0 }, { generation: 1.5 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { board: '../uefi-x64' }, { version: '<script>' }]) {
    const signed = service.service.signer.sign({ ...deployment(2), ...change })
    expect((await request('/api/releases', 'POST', { channel: 'stable', deployment: JSON.stringify(signed) })).status).toBe(400)
  }
})

test('failed signing rolls back publication, audit entry and catalog together', async () => {
  const release = await draft()
  await uploadAll(release.id)
  const before = await (await request('/v1/manifest.json')).text()
  const beforeAudit = await (await request('/api/audit')).text()
  using _failingSigner = spyOn(service.service.signer, 'sign').mockImplementation(() => {
    throw new Error('test signing failure')
  })
  expect((await request(`/api/releases/${release.id}/publish`, 'POST')).status).toBe(500)
  expect(service.service.get(release.id).status).toBe('draft')
  expect(await (await request('/v1/manifest.json')).text()).toBe(before)
  expect(await (await request('/api/audit')).text()).toBe(beforeAudit)
})

test('unknown releases and invalid state transitions fail explicitly', async () => {
  expect((await request('/api/releases/missing/publish', 'POST')).status).toBe(404)
  expect((await upload('missing')).status).toBe(404)
  expect((await request('/missing')).status).toBe(404)
  const release = await draft()
  expect((await request(`/api/releases/${release.id}/withdraw`, 'POST')).status).toBe(409)
  await uploadAll(release.id)
  expect((await upload(release.id)).status).toBe(409)
})

test('uploads bound streamed bytes without trusting Content-Length and remove failed files', async () => {
  const release = await draft()
  expect((await upload(release.id, 'x'.repeat(11))).status).toBe(413)
  for (const length of ['2048', 'invalid', '2'])
    expect((await upload(release.id, 'x', { 'Content-Length': length })).status).toBe(400)
  for (const body of ['', null, 'wrongbytes'])
    expect((await upload(release.id, body)).status).toBe(400)
  expect((await upload(release.id, 'x', { 'Content-Type': 'text/plain' })).status).toBe(415)
  expect(await readdir(join(directory, 'objects'))).toHaveLength(0)
  expect(service.service.view(service.service.get(release.id)).objects.every(object => !object.available)).toBe(true)
  expect((await upload(release.id)).status).toBe(200)
})

test('two concurrent uploads commit exactly one immutable object', async () => {
  const release = await draft()
  let releaseStream: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    releaseStream = resolve
  })
  const stream = () => new ReadableStream<Uint8Array>({ async start(controller) {
    await gate
    controller.enqueue(new Uint8Array(small))
    controller.close()
  } })
  const first = upload(release.id, stream())
  const second = upload(release.id, stream())
  releaseStream?.()
  const responses = await Promise.all([first, second])
  expect(responses.map(item => item.status).sort()).toEqual([200, 409])
  expect(await readdir(join(directory, 'objects'))).toHaveLength(1)
  expect(service.service.view(service.service.get(release.id)).objects.filter(object => object.available)).toHaveLength(1)
})

test.each([
  ['bytes=2-5', 206, '2345'],
  ['bytes=7-', 206, '789'],
  ['bytes=-3', 206, '789'],
  ['bytes=0-100', 206, '0123456789'],
  ['bytes=10-', 416, ''],
  ['bytes=5-2', 416, ''],
  ['bytes=-0', 416, ''],
  ['bytes=-', 416, ''],
  ['bytes=0-1,3-4', 416, ''],
  ['invalid', 416, ''],
  ['bytes=9007199254740992-', 416, ''],
  ['bytes=-999999999999999999999', 416, ''],
])('download range %s returns %s', async (range, code, expected) => {
  await published()
  const response = await service.app.request(`${origin}/v1/objects/${artifact(small).sha256}`, { headers: { Range: range } })
  expect(response.status).toBe(code)
  expect(await response.text()).toBe(expected)
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  if (code === 416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
})

test('HEAD, conditional requests and If-Range preserve HTTP semantics', async () => {
  await published()
  const path = `${origin}/v1/objects/${artifact(small).sha256}`
  const full = await service.app.request(path)
  const etag = full.headers.get('etag') ?? ''
  expect(etag).not.toBe('')
  expect((await service.app.request(path, { headers: { 'If-None-Match': etag } })).status).toBe(304)
  const head = await service.app.request(path, { method: 'HEAD', headers: { Range: 'bytes=0-1' } })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-length')).toBe('10')
  expect(await head.text()).toBe('')
  const changed = await service.app.request(path, { headers: { 'Range': 'bytes=0-1', 'If-Range': '"old"' } })
  expect(changed.status).toBe(200)
  expect(await changed.text()).toBe('0123456789')
})

test('missing or truncated storage does not return a successful download', async () => {
  await published()
  const name = artifact(small).sha256
  await writeFile(join(directory, 'objects', name), 'short')
  expect((await request(`/v1/objects/${artifact(small).sha256}`)).status).toBe(503)
  await rm(join(directory, 'objects', name))
  expect((await request(`/v1/objects/${artifact(small).sha256}`)).status).toBe(503)
})

async function login(token = adminToken, requestOrigin = origin) {
  return service.app.request(`${origin}/api/session`, { method: 'POST', headers: { 'Origin': requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
}

test('cookie sessions are HttpOnly and same-origin mutations are required', async () => {
  expect((await login(adminToken, 'http://foreign.localhost')).status).toBe(403)
  expect((await login('wrong')).status).toBe(401)
  const response = await login()
  expect(response.status).toBe(200)
  const header = response.headers.get('set-cookie') ?? ''
  expect(header).toContain('HttpOnly')
  expect(header).toContain('SameSite=Strict')
  const cookie = header.split(';')[0] ?? ''
  const authenticated = await service.app.request(`${origin}/api/releases`, { headers: { Cookie: cookie } })
  expect(authenticated.status).toBe(200)
  const rejected = await service.app.request(`${origin}/api/metadata/refresh`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://foreign.localhost' } })
  expect(rejected.status).toBe(403)
  const accepted = await service.app.request(`${origin}/api/metadata/refresh`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } })
  expect(accepted.status).toBe(200)
  expect((await service.app.request(`${origin}/api/session`, { method: 'DELETE', headers: { Cookie: cookie, Origin: origin } })).status).toBe(200)
  expect((await service.app.request(`${origin}/api/releases`, { headers: { Cookie: cookie } })).status).toBe(401)
})

test('session expiry and administrator-token changes invalidate previous cookies', async () => {
  const cookie = (await login()).headers.get('set-cookie')?.split(';')[0] ?? ''
  expect((await service.app.request(`${origin}/api/releases`, { headers: { Cookie: cookie } })).status).toBe(200)
  service.store.db.update(sessions).set({ expiresAt: Date.now() - 1 }).run()
  expect((await service.app.request(`${origin}/api/releases`, { headers: { Cookie: cookie } })).status).toBe(401)
  const freshCookie = (await login()).headers.get('set-cookie')?.split(';')[0] ?? ''
  service.close()
  service = await createService(parseConfig({ ADMIN_TOKEN: `${adminToken}-rotated`, DATA_DIR: directory, PUBLIC_URL: origin, LOG_LEVEL: 'silent' }))
  expect((await service.app.request(`${origin}/api/releases`, { headers: { Cookie: freshCookie } })).status).toBe(401)
})

test('failed logins are rate limited and the window resets', async () => {
  for (let attempt = 0; attempt < 20; attempt++)
    expect((await login('wrong')).status).toBe(401)
  const limited = await login('wrong')
  expect(limited.status).toBe(429)
  expect(limited.headers.get('retry-after')).toBe('60')
  using _clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61000)
  expect((await login()).status).toBe(200)
})

test('malformed and oversized JSON requests fail safely', async () => {
  const invalid = await service.app.request(`${origin}/api/releases`, { method: 'POST', headers: { 'Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: '{' })
  expect(invalid.status).toBe(400)
  const large = await request('/api/releases', 'POST', { notes: 'x'.repeat(70000) })
  expect(large.status).toBe(413)
  expect((await request('/healthz', 'GET', undefined, false)).status).toBe(200)
  expect((await request('/v1/manifest.json')).headers.get('cache-control')).toBe('no-store')
})

test('database failures do not expose SQL or paths to the client', async () => {
  service.store.db.delete(catalogs).run()
  const response = await request('/healthz')
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: { code: 'internal_error', message: 'Internal server error' } })
})

test('embedded console assets receive restrictive security headers', async () => {
  const app = await createService(parseConfig({ ADMIN_TOKEN: adminToken, DATA_DIR: directory, PUBLIC_URL: origin, LOG_LEVEL: 'silent' }), { html: '<html>console</html>', css: 'body{}', js: 'document.title="console"' })
  try {
    const response = await app.app.request(`${origin}/`)
    expect(await response.text()).toBe('<html>console</html>')
    expect(response.headers.get('content-security-policy')).toContain('script-src \'self\'')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await app.app.request(`${origin}/style.css`)).headers.get('content-type')).toBe('text/css')
    expect((await app.app.request(`${origin}/app.js`)).headers.get('content-type')).toBe('text/javascript')
  }
  finally {
    app.close()
  }
})
