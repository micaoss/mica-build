// DATA encryption (field-20261109 W1, mica-core's contract W1.4): what a product declares in product.env, what the
// signed boot policy carries as its top-level `dataEncryption`, and the refusals between the two.
//
//   product.env  DATA_ENCRYPTION=off|on (off when unnamed), DATA_KEY_PROVIDERS (ordered words, required when on),
//                DATA_ENCRYPTION_NO_PROVIDER=refuse|plain (refuse when unnamed); none of them on an off product
//   boot.json    dataEncryption: {mode: "on", keyProviders, noProvider, cipher, recoveryMemoryKib}, written only for
//                an `on` product; absent means off. Every member required, no other member.
//
// The cipher, the recovery KDF's memory and the key providers the board can have are the board's facts, in its
// boards/<board>/data-encryption.env (not board.env, an input of the board package): DATA_CIPHER,
// DATA_RECOVERY_MEMORY_KIB and DATA_KEY_PROVIDERS_AVAILABLE (a board that names no cipher cannot encrypt DATA).
// Available is not enabled: a product still names its providers.
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

export class DataEncryptionError extends Error {}

/** The product's DATA encryption from its product.env values and its board's data-encryption.env facts (each getter answers
 * '' for an unnamed key): undefined when off, the boot policy's member when on, or a refusal naming what is wrong. */
export function productDataEncryption(get: (key: string) => string, boardFact: (key: string) => string, board: string, storage: 'gpt' | 'ubi'): DataEncryption | undefined {
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
  const cipher = boardFact('DATA_CIPHER'), kibText = boardFact('DATA_RECOVERY_MEMORY_KIB')
  if (cipher === '') fail(`DATA_ENCRYPTION=on on the board ${board}, whose data-encryption.env declares no DATA_CIPHER`)
  if (!(CIPHERS as readonly string[]).includes(cipher)) fail(`the board ${board} declares DATA_CIPHER=${cipher}; it is one of ${CIPHERS.join(', ')}`)
  if (!/^[1-9][0-9]{0,9}$/.test(kibText)) fail(`the board ${board} declares DATA_RECOVERY_MEMORY_KIB=${kibText}; it is a positive number of KiB`)
  const available = boardFact('DATA_KEY_PROVIDERS_AVAILABLE').split(/\s+/).filter(w => w !== '')
  const keyProviders = providersGiven.split(/\s+/).filter(w => w !== '')
  if (keyProviders.length === 0) fail('DATA_ENCRYPTION=on with no DATA_KEY_PROVIDERS: nothing would unlock DATA at boot')
  if (new Set(keyProviders).size !== keyProviders.length) fail(`DATA_KEY_PROVIDERS="${providersGiven}" names a provider twice`)
  for (const p of keyProviders) {
    if (!(KEY_PROVIDERS as readonly string[]).includes(p)) fail(`DATA_KEY_PROVIDERS names '${p}'; the key providers are:${KEY_PROVIDERS.map(k => ` ${k}`).join('')}`)
    if (!available.includes(p)) fail(`DATA_KEY_PROVIDERS names '${p}', which the board ${board} cannot have (DATA_KEY_PROVIDERS_AVAILABLE="${available.join(' ')}")`)
  }
  const noProvider = noProviderGiven || 'refuse'
  if (!(NO_PROVIDER as readonly string[]).includes(noProvider)) fail(`DATA_ENCRYPTION_NO_PROVIDER=${noProvider}; it is refuse or plain`)
  return { mode: 'on', keyProviders, noProvider: noProvider as DataEncryption['noProvider'], cipher: cipher as DataEncryption['cipher'], recoveryMemoryKib: Number(kibText) }
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

/** The policy members a contract case names: a case is a whole boot.json (its `dataEncryption`) or the member. */
function caseMember(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'dataEncryption' in value
    ? (value as Record<string, unknown>)['dataEncryption']
    : value
}

/** This tree's check against mica-core's `dataEncryption` cases (W1.4): every accepted case passes it, every refused
 * one fails it, and what every `on` product writes is accepted. The problems, empty when they agree; none when the
 * fixture has no such cases (a core before W1, which an `on` product is refused against). */
export function fixtureProblems(written: { product: string, member: DataEncryption }[], casesPath = CONTRACT_CASES): string[] {
  if (!coreCarriesDataEncryption(casesPath)) return []
  const section = (JSON.parse(readFileSync(casesPath, 'utf8')) as Record<string, unknown>)['dataEncryption'] as Record<string, unknown>
  const list = (key: string): unknown[] => Array.isArray(section[key]) ? section[key] as unknown[] : []
  const accepted = list('accepted'), refused = list('refused')
  if (accepted.length === 0 || refused.length === 0) return ['cases.json\'s dataEncryption names no accepted or no refused case; the check would prove nothing']
  const out: string[] = []
  for (const [i, c] of accepted.entries()) {
    const problem = policyProblem(caseMember(c))
    if (problem !== undefined) out.push(`accepted case ${i} is refused here: ${problem}`)
  }
  for (const [i, c] of refused.entries()) if (policyProblem(caseMember(c)) === undefined) out.push(`refused case ${i} is accepted here`)
  const shapes = new Set(accepted.map(c => JSON.stringify(Object.keys(caseMember(c) as object).sort())))
  for (const w of written) {
    const problem = policyProblem(w.member)
    if (problem !== undefined) out.push(`${w.product} writes a member the contract refuses: ${problem}`)
    if (!shapes.has(JSON.stringify(Object.keys(w.member).sort()))) out.push(`${w.product} writes members no accepted case has`)
  }
  return out
}

/** The refusal of an `on` product against a core pin without W1; undefined when the build may go on. */
export function coreRefusal(product: string, encryption: DataEncryption | undefined, casesPath = CONTRACT_CASES): string | undefined {
  if (encryption === undefined || coreCarriesDataEncryption(casesPath)) return undefined
  return `product ${product}: DATA_ENCRYPTION=on needs a mica-core pin that reads dataEncryption (W1); the pinned core's contract fixture`
    + ` (tests/fixtures/component-contracts/cases.json) has no dataEncryption cases. Move the pin to a core release with W1 first`
}
