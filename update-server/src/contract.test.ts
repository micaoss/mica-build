import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from './app'
import { parseConfig } from './config'

test('OpenAPI describes the component protocol and serves the reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mica-contract-'))
  const service = await createService(parseConfig({ ADMIN_TOKEN: 'contract-test-token-with-at-least-32-characters', DATA_DIR: directory, DOCS_ENABLED: 'true', LOG_LEVEL: 'silent' }))
  try {
    const response = await service.app.request('/openapi.json')
    expect(response.status).toBe(200)
    const contract = await response.json()
    expect(contract.openapi).toBe('3.1.0')
    expect(contract.paths['/api/releases/{id}/objects/{digest}'].put.operationId).toBe('uploadObject')
    expect(contract.paths['/api/releases/{id}/artifact']).toBeUndefined()
    expect(contract).toMatchSnapshot()
    const docs = await service.app.request('/docs')
    expect(docs.status).toBe(200)
    expect(docs.headers.get('content-security-policy')).toContain('https://cdn.jsdelivr.net')
    expect(await docs.text()).toContain('/openapi.json')
  }
  finally {
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
