import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticatePayload, canonicalJson } from '../../build/src/components'
import { Signer } from '../../shared/update-envelope'
import { createService } from './app'
import { artifact, deployment, image, small } from './component-fixture'
import { parseConfig } from './config'

test('metadata rotation requires explicit overlap and withdrawal before removing a retained key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mica-key-rotation-'))
  const first = generateKeyPairSync('ed25519').privateKey
  const second = generateKeyPairSync('ed25519').privateKey
  const firstSigner = new Signer(first, false)
  const secondSigner = new Signer(second, false)
  const oldPath = join(directory, 'old.pem')
  const newPath = join(directory, 'new.pem')
  await writeFile(oldPath, first.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  await writeFile(newPath, second.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const environment = { ADMIN_TOKEN: 'rotation-test-admin-token-32-characters', DATA_DIR: directory, SIGNING_KEY_FILE: oldPath, LOG_LEVEL: 'silent' }
  let service = await createService(parseConfig(environment))
  try {
    const record = service.service.create({ channel: 'dev', notes: '', deployment: JSON.stringify(firstSigner.sign(JSON.parse(canonicalJson(deployment())))) })
    for (const bytes of [image, small]) {
      await service.service.upload(record.id, artifact(bytes).sha256, new Request('http://test', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(bytes),
      }))
    }
    await service.service.transition(record.id, 'publish')
    service.close()
    const rotated = { ...environment, SIGNING_KEY_FILE: newPath }
    await expect(createService(parseConfig(rotated))).rejects.toThrow()
    service = await createService(parseConfig({ ...rotated, METADATA_TRUST_KEYS: JSON.stringify([firstSigner.publicKey]) }))
    const catalog = service.service.catalog()
    expect(JSON.parse(catalog.envelope).keyId).toBe(secondSigner.keyId)
    expect(JSON.parse(authenticatePayload(catalog.envelope, [firstSigner.publicKey, secondSigner.publicKey], 1048576)).releases).toHaveLength(1)
    service.close()
    await expect(createService(parseConfig(rotated))).rejects.toThrow()
    service = await createService(parseConfig({ ...rotated, METADATA_TRUST_KEYS: JSON.stringify([firstSigner.publicKey]) }))
    await service.service.transition(record.id, 'withdraw')
    service.close()
    service = await createService(parseConfig(rotated))
    expect(JSON.parse(authenticatePayload(service.service.catalog().envelope, [secondSigner.publicKey], 1048576)).releases).toEqual([])
  }
  finally {
    service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
