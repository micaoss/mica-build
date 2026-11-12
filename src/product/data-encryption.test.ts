import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'
import { allZero, BOARDS, coreCarriesDataEncryption, coreRefusal, type DataEncryption, policyProblem, productDataEncryption } from './data-encryption.ts'

const SCRATCH = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'data-encryption-test.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const ON: DataEncryption = { mode: 'on', keyProviders: ['tpm2'], noProvider: 'refuse', cipher: 'aes-xts-plain64', recoveryMemoryKib: 262144 }
const env = (values: Record<string, string>) => (key: string) => values[key] ?? ''

describe('the boot policy member (W1.4)', () => {
  test('the member an on product writes is accepted, with either cipher and either no-provider policy', () => {
    expect(policyProblem(ON)).toBeUndefined()
    expect(policyProblem({ ...ON, cipher: 'xchacha12,aes-adiantum-plain64', noProvider: 'plain' })).toBeUndefined()
  })
  test.each([
    ['an unknown member', { ...ON, keySlots: 2 }, 'unknown member(s) keySlots'],
    ['a missing member', (({ cipher: _, ...rest }) => rest)(ON), 'lacks cipher'],
    ['mode off', { ...ON, mode: 'off' }, 'mode is not "on"'],
    ['no providers', { ...ON, keyProviders: [] }, 'keyProviders'],
    ['an unknown provider', { ...ON, keyProviders: ['fido2'] }, 'keyProviders'],
    ['a provider twice', { ...ON, keyProviders: ['tpm2', 'tpm2'] }, 'keyProviders'],
    ['an unknown no-provider policy', { ...ON, noProvider: 'warn' }, 'noProvider'],
    ['an unknown cipher', { ...ON, cipher: 'aes-cbc-essiv:sha256' }, 'cipher'],
    ['a fractional KDF memory', { ...ON, recoveryMemoryKib: 1.5 }, 'recoveryMemoryKib'],
    ['a zero KDF memory', { ...ON, recoveryMemoryKib: 0 }, 'recoveryMemoryKib'],
    ['not an object', ['on'], 'not an object'],
  ])('%s is refused', (_label, value, fragment) => {
    expect(policyProblem(value)).toContain(fragment)
  })
})

describe('the product.env keys', () => {
  test('unnamed is off, and off carries nothing into the policy', () => {
    expect(productDataEncryption(env({}), 'uefi-x64', 'gpt')).toBeUndefined()
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'off' }), 'uefi-x64', 'gpt')).toBeUndefined()
  })
  test('on takes the board\'s cipher and KDF memory, and refuse when no provider policy is named', () => {
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }), 'uefi-x64', 'gpt')).toEqual(ON)
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2', DATA_ENCRYPTION_NO_PROVIDER: 'plain' }), 'uefi-x64', 'gpt')?.noProvider).toBe('plain')
  })
  test('what it writes is what the policy check accepts', () => {
    expect(policyProblem(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }), 'uefi-x64', 'gpt'))).toBeUndefined()
  })
  test.each([
    ['no provider', { DATA_ENCRYPTION: 'on' }, 'uefi-x64', 'gpt', 'with no DATA_KEY_PROVIDERS'],
    ['a provider the board cannot have', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, 'mini-x64', 'gpt', 'which the board mini-x64 cannot have'],
    ['a UBI board', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, 'ssd202d', 'ubi', 'on the UBI board ssd202d'],
    ['a board with no DATA cipher', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, 'newboard', 'gpt', 'declares no DATA cipher'],
    ['a provider twice', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2 tpm2' }, 'uefi-x64', 'gpt', 'names a provider twice'],
    ['a no-provider policy on an off product', { DATA_ENCRYPTION_NO_PROVIDER: 'plain' }, 'uefi-x64', 'gpt', 'DATA_ENCRYPTION is off'],
  ] as const)('%s is refused', (_label, values, board, storage, fragment) => {
    expect(() => productDataEncryption(env(values), board, storage)).toThrow(fragment)
  })
  test('only uefi-x64 has a key provider today', () => {
    expect(Object.entries(BOARDS).filter(([, b]) => b.providers.length > 0).map(([n]) => n)).toEqual(['uefi-x64'])
  })
})

describe('the core pin', () => {
  const cases = (name: string, body: object) => {
    const path = join(SCRATCH, `${name}.json`)
    writeFileSync(path, JSON.stringify(body))
    return path
  }
  test('a contract fixture without dataEncryption cases refuses an on product by name, and lets an off one through', () => {
    const without = cases('without', { boardPolicies: {} })
    expect(coreCarriesDataEncryption(without)).toBe(false)
    expect(coreRefusal('uefi-x64.gcp-tpm2', ON, without)).toContain('product uefi-x64.gcp-tpm2: DATA_ENCRYPTION=on needs a mica-core pin that reads dataEncryption')
    expect(coreRefusal('uefi-x64.gcp', undefined, without)).toBeUndefined()
  })
  test('a contract fixture with them lets an on product through', () => {
    const withCases = cases('with', { boardPolicies: {}, dataEncryption: { accepted: [ON], refused: [] } })
    expect(coreCarriesDataEncryption(withCases)).toBe(true)
    expect(coreRefusal('uefi-x64.gcp-tpm2', ON, withCases)).toBeUndefined()
  })
  test('a missing fixture is a core without W1', () => {
    expect(coreCarriesDataEncryption(join(SCRATCH, 'absent.json'))).toBe(false)
  })
})

describe('a zeroed DATA partition', () => {
  test('all zeros across chunk boundaries is zeroed; one byte anywhere is not', () => {
    const file = join(SCRATCH, 'data.img')
    const bytes = Buffer.alloc(9 * 1024 * 1024)
    writeFileSync(file, bytes)
    expect(allZero(file)).toBe(true)
    bytes[bytes.length - 1] = 1
    writeFileSync(file, bytes)
    expect(allZero(file)).toBe(false)
  })
})
