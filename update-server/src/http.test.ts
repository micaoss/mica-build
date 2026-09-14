import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from './app'
import { artifact, deployment, image, small } from './component-fixture'
import { parseConfig } from './config'

test('real HTTP transport preserves object byte ranges and HEAD lengths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mica-http-test-'))
  const token = 'http-test-administrator-token-with-32-characters'
  const service = await createService(parseConfig({ ADMIN_TOKEN: token, DATA_DIR: directory, LOG_LEVEL: 'silent' }))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: service.app.fetch })
  const base = `http://127.0.0.1:${server.port}`
  const authorization = { Authorization: `Bearer ${token}` }
  try {
    const created = await fetch(`${base}/api/releases`, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'stable', deployment: JSON.stringify(service.service.signer.sign(deployment())) }) })
    const release = await created.json()
    for (const bytes of [small, image]) {
      const uploaded = await fetch(`${base}/api/releases/${release.id}/objects/${artifact(bytes).sha256}`, { method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) })
      expect(uploaded.status).toBe(200)
    }
    expect((await fetch(`${base}/api/releases/${release.id}/publish`, { method: 'POST', headers: authorization })).status).toBe(200)
    for (const [range, expected] of [['bytes=2-5', '2345'], ['bytes=7-', '789'], ['bytes=-3', '789']] as const) {
      const response = await fetch(`${base}/v1/objects/${artifact(small).sha256}`, { headers: { Range: range } })
      expect(response.status).toBe(206)
      expect(await response.text()).toBe(expected)
      expect(response.headers.get('content-length')).toBe(String(expected.length))
    }
    const head = await fetch(`${base}/v1/objects/${artifact(small).sha256}`, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
  }
  finally {
    await server.stop(true)
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
