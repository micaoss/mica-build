import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../app'
import { parseConfig } from '../config'
import { loadSigner, Signer } from './signing'

test('concurrent first starts share one atomically published private key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mica-key-test-'))
  try {
    const config = parseConfig({ ADMIN_TOKEN: 'test-token-with-at-least-32-characters', DATA_DIR: directory })
    const [first, second] = await Promise.all([loadSigner(config), loadSigner(config)])
    expect(first.publicKey).toBe(second.publicKey)
    expect(first.sign({ test: 1 })).toEqual(second.sign({ test: 1 }))
    expect((await stat(join(directory, 'metadata-signing.pem'))).mode & 0o777).toBe(0o600)
    expect((await readFile(join(directory, 'metadata-signing.pem'))).length).toBeGreaterThan(0)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('non-Ed25519 keys and corrupt configured keys are rejected', async () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  expect(() => new Signer(key, false)).toThrow('Ed25519')
  const directory = await mkdtemp(join(tmpdir(), 'mica-invalid-key-'))
  try {
    const path = join(directory, 'key.pem')
    await writeFile(path, 'invalid key')
    const config = parseConfig({ ADMIN_TOKEN: 'test-token-with-at-least-32-characters', DATA_DIR: directory, SIGNING_KEY_FILE: path })
    await expect(loadSigner(config)).rejects.toThrow()
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a replacement key cannot silently take over an existing catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mica-key-change-'))
  try {
    const config = parseConfig({ ADMIN_TOKEN: 'test-token-with-at-least-32-characters', DATA_DIR: directory, LOG_LEVEL: 'silent' })
    const first = await createService(config)
    first.close()
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
    await writeFile(join(directory, 'other.pem'), other)
    await expect(createService({ ...config, signingKeyFile: join(directory, 'other.pem') })).rejects.toThrow('untrusted metadata key')
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})
