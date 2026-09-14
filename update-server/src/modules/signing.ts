import type { Config } from '../config'
import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { link, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Signer } from '../../../shared/update-envelope'

export { digest, Signer } from '../../../shared/update-envelope'
export type { Envelope } from '../../../shared/update-envelope'

export async function loadSigner(config: Config) {
  const path = config.signingKeyFile ?? join(config.dataDir, 'metadata-signing.pem')
  try {
    return new Signer(createPrivateKey(await readFile(path)), !config.signingKeyFile)
  }
  catch (error) {
    if (config.signingKeyFile || !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    const { privateKey } = generateKeyPairSync('ed25519')
    await file.writeFile(privateKey.export({ type: 'pkcs8', format: 'pem' }))
    await file.sync()
    await file.close()
    // Publish complete bytes without replacing a concurrently created key.
    try {
      await link(temporary, path)
    }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
        throw error
    }
    const directory = await open(config.dataDir, 'r')
    try {
      await directory.sync()
    }
    finally {
      await directory.close()
    }
  }
  finally {
    await file.close()
    await unlink(temporary)
  }
  return new Signer(createPrivateKey(await readFile(path)), !config.signingKeyFile)
}
