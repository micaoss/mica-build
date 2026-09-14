import type { KeyObject } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createHash, createPublicKey, sign } from 'node:crypto'

export function digest(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

export interface Envelope {
  schema: 'mos/update-envelope/v1'
  keyId: string
  payload: string
  signature: string
}

export class Signer {
  readonly publicKey: string
  readonly keyId: string

  constructor(private readonly key: KeyObject, readonly generated: boolean) {
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error('Metadata signing key must be Ed25519')
    const jwk = createPublicKey(key).export({ format: 'jwk' })
    if (!jwk.x)
      throw new Error('Metadata signing key has no public component')
    const raw = Buffer.from(jwk.x, 'base64url')
    this.publicKey = raw.toString('base64')
    this.keyId = digest(raw)
  }

  sign(payload: unknown): Envelope {
    const bytes = Buffer.from(JSON.stringify(payload))
    return { schema: 'mos/update-envelope/v1', keyId: this.keyId, payload: bytes.toString('base64'), signature: sign(null, bytes, this.key).toString('base64') }
  }
}
