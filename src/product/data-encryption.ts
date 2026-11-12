// DATA encryption (field-20261109 W1, mica-core's contract W1.4): what a product declares in product.env, what the
// signed boot policy carries as its top-level `dataEncryption`, and the refusals between the two.
//
//   product.env  DATA_ENCRYPTION=off|on (off when unnamed), DATA_KEY_PROVIDERS (ordered words, required when on),
//                DATA_ENCRYPTION_NO_PROVIDER=refuse|plain (refuse when unnamed); none of them on an off product
//   boot.json    dataEncryption: {mode: "on", keyProviders, noProvider, cipher, recoveryMemoryKib}, written only for
//                an `on` product; absent means off. Every member required, no other member.
//
// The cipher and the recovery KDF's memory are the board's (BOARDS below), as is the set of key providers it can
// have. They live here and not in board.env, which travels in the board component: a key added there would change
// every product of the board.
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

export const CIPHERS = ['aes-xts-plain64', 'xchacha12,aes-adiantum-plain64'] as const
export const KEY_PROVIDERS = ['tpm2'] as const
export const NO_PROVIDER = ['refuse', 'plain'] as const
export const MEMBERS = ['mode', 'keyProviders', 'noProvider', 'cipher', 'recoveryMemoryKib'] as const

export type DataEncryption = {
  mode: 'on'
  keyProviders: string[]
  noProvider: (typeof NO_PROVIDER)[number]
  cipher: (typeof CIPHERS)[number]
  recoveryMemoryKib: number
}

type BoardEncryption = { providers: string[], cipher: (typeof CIPHERS)[number], recoveryMemoryKib: number }

/** The boards whose DATA can be encrypted: GPT boards only (a UBI board has no block device to put LUKS2 on). Only
 * uefi-x64 has a key provider today: its TPM 2.0 (a vTPM on Compute Engine). */
export const BOARDS: Readonly<Record<string, BoardEncryption>> = {
  'uefi-x64': { providers: ['tpm2'], cipher: 'aes-xts-plain64', recoveryMemoryKib: 262144 },
  'mini-x64': { providers: [], cipher: 'aes-xts-plain64', recoveryMemoryKib: 262144 },
  'uefi-arm64': { providers: [], cipher: 'aes-xts-plain64', recoveryMemoryKib: 262144 },
  'cx3576': { providers: [], cipher: 'aes-xts-plain64', recoveryMemoryKib: 65536 },
  's905x5m': { providers: [], cipher: 'aes-xts-plain64', recoveryMemoryKib: 65536 },
}

export class DataEncryptionError extends Error {}

/** The product's DATA encryption from its product.env values (`get` answers '' for an unnamed key): undefined when
 * off, the boot policy's member when on, or a refusal naming what is wrong. */
export function productDataEncryption(get: (key: string) => string, board: string, storage: 'gpt' | 'ubi'): DataEncryption | undefined {
  const fail = (message: string): never => { throw new DataEncryptionError(message) }
  const mode = get('DATA_ENCRYPTION') || 'off'
  if (mode !== 'on' && mode !== 'off') fail(`DATA_ENCRYPTION=${mode}; it is on or off`)
  const providersGiven = get('DATA_KEY_PROVIDERS'), noProviderGiven = get('DATA_ENCRYPTION_NO_PROVIDER')
  if (mode === 'off') {
    if (providersGiven !== '') fail(`DATA_KEY_PROVIDERS="${providersGiven}" names key providers, and DATA_ENCRYPTION is off`)
    if (noProviderGiven !== '') fail(`DATA_ENCRYPTION_NO_PROVIDER=${noProviderGiven} is set, and DATA_ENCRYPTION is off`)
    return undefined
  }
  if (storage === 'ubi') fail(`DATA_ENCRYPTION=on on the UBI board ${board}: its DATA is a UBI volume, which LUKS2 cannot hold`)
  const facts = BOARDS[board] ?? fail(`DATA_ENCRYPTION=on on the board ${board}, which declares no DATA cipher (src/product/data-encryption.ts)`)
  const keyProviders = providersGiven.split(/\s+/).filter(w => w !== '')
  if (keyProviders.length === 0) fail('DATA_ENCRYPTION=on with no DATA_KEY_PROVIDERS: nothing would unlock DATA at boot')
  if (new Set(keyProviders).size !== keyProviders.length) fail(`DATA_KEY_PROVIDERS="${providersGiven}" names a provider twice`)
  for (const p of keyProviders) {
    if (!(KEY_PROVIDERS as readonly string[]).includes(p)) fail(`DATA_KEY_PROVIDERS names '${p}'; the key providers are:${KEY_PROVIDERS.map(k => ` ${k}`).join('')}`)
    if (!facts.providers.includes(p)) fail(`DATA_KEY_PROVIDERS names '${p}', which the board ${board} cannot have (it has: ${facts.providers.join(' ') || 'none'})`)
  }
  const noProvider = noProviderGiven || 'refuse'
  if (!(NO_PROVIDER as readonly string[]).includes(noProvider)) fail(`DATA_ENCRYPTION_NO_PROVIDER=${noProvider}; it is refuse or plain`)
  return { mode: 'on', keyProviders, noProvider: noProvider as DataEncryption['noProvider'], cipher: facts.cipher, recoveryMemoryKib: facts.recoveryMemoryKib }
}

/** The boot policy's `dataEncryption` member held to W1.4: undefined when it is one, else what is wrong. */
export function policyProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'dataEncryption is not an object'
  const o = value as Record<string, unknown>
  const unknown = Object.keys(o).filter(k => !(MEMBERS as readonly string[]).includes(k))
  if (unknown.length > 0) return `dataEncryption carries unknown member(s) ${unknown.join(', ')}`
  const missing = MEMBERS.filter(k => !(k in o))
  if (missing.length > 0) return `dataEncryption lacks ${missing.join(', ')}`
  if (o['mode'] !== 'on') return 'dataEncryption.mode is not "on" (an off product carries no dataEncryption)'
  const providers = o['keyProviders']
  if (!Array.isArray(providers) || providers.length === 0 || !providers.every(p => (KEY_PROVIDERS as readonly unknown[]).includes(p)) || new Set(providers).size !== providers.length)
    return `dataEncryption.keyProviders is not a non-empty list of distinct known providers (${KEY_PROVIDERS.join(' ')})`
  if (!(NO_PROVIDER as readonly unknown[]).includes(o['noProvider'])) return `dataEncryption.noProvider is not one of ${NO_PROVIDER.join(', ')}`
  if (!(CIPHERS as readonly unknown[]).includes(o['cipher'])) return `dataEncryption.cipher is not one of ${CIPHERS.join(', ')}`
  const kib = o['recoveryMemoryKib']
  if (typeof kib !== 'number' || !Number.isSafeInteger(kib) || kib <= 0) return 'dataEncryption.recoveryMemoryKib is not a positive integer'
  return undefined
}

/** Whether every byte of a file is zero, read in 4 MiB chunks: an encrypted product's factory DATA partition. */
export function allZero(file: string): boolean {
  const fd = openSync(file, 'r')
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024)
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) return true
      for (let i = 0; i < n; i++) if (chunk[i] !== 0) return false
    }
  }
  finally { closeSync(fd) }
}

/** The contract fixture mica-core's pin brings (tests/fixtures/component-contracts/cases.json, deploy-pool --refresh). */
export const CONTRACT_CASES = join(import.meta.dir, '../../tests/fixtures/component-contracts/cases.json')

/** Whether the pinned mica-core reads `dataEncryption`: its contract fixture carries the member's cases (W1.4). An
 * `on` product is refused against a core that does not, by name. */
export function coreCarriesDataEncryption(casesPath = CONTRACT_CASES): boolean {
  if (!existsSync(casesPath)) return false
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Record<string, unknown>
  return cases['dataEncryption'] !== undefined && cases['dataEncryption'] !== null
}

/** The refusal of an `on` product against a core pin without W1; undefined when the build may go on. */
export function coreRefusal(product: string, encryption: DataEncryption | undefined, casesPath = CONTRACT_CASES): string | undefined {
  if (encryption === undefined || coreCarriesDataEncryption(casesPath)) return undefined
  return `product ${product}: DATA_ENCRYPTION=on needs a mica-core pin that reads dataEncryption (W1); the pinned core's contract fixture`
    + ` (tests/fixtures/component-contracts/cases.json) has no dataEncryption cases. Move the pin to a core release with W1 first`
}
