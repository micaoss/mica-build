import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'
import { allZero, coreCarriesDataEncryption, coreRefusal, type DataEncryption, fixtureProblems, policyProblem, productDataEncryption } from './data-encryption.ts'

const SCRATCH = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'data-encryption-test.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const ON: DataEncryption = { mode: 'on', keyProviders: ['tpm2'], noProvider: 'refuse', cipher: 'aes-xts-plain64', recoveryMemoryKib: 262144 }
const env = (values: Record<string, string>) => (key: string) => values[key] ?? ''
const X64 = env({ DATA_CIPHER: 'aes-xts-plain64', DATA_RECOVERY_MEMORY_KIB: '262144', DATA_KEY_PROVIDERS_AVAILABLE: 'tpm2' })
const ARM = env({ DATA_CIPHER: 'aes-xts-plain64', DATA_RECOVERY_MEMORY_KIB: '65536' })

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
    expect(productDataEncryption(env({}), X64, 'uefi-x64', 'gpt')).toBeUndefined()
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'off' }), X64, 'uefi-x64', 'gpt')).toBeUndefined()
  })
  test('on takes the board\'s cipher and KDF memory, and refuse when no provider policy is named', () => {
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }), X64, 'uefi-x64', 'gpt')).toEqual(ON)
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2', DATA_ENCRYPTION_NO_PROVIDER: 'plain' }), X64, 'uefi-x64', 'gpt')?.noProvider).toBe('plain')
  })
  test('what it writes is what the policy check accepts', () => {
    expect(policyProblem(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }), X64, 'uefi-x64', 'gpt'))).toBeUndefined()
  })
  test.each([
    ['no provider', { DATA_ENCRYPTION: 'on' }, X64, 'board-a', 'gpt', 'with no DATA_KEY_PROVIDERS'],
    ['a provider the board cannot have', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, ARM, 'board-b', 'gpt', 'which the board board-b cannot have'],
    ['a UBI board', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, X64, 'board-c', 'ubi', 'on the UBI board board-c'],
    ['a board with no DATA cipher', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, env({}), 'board-d', 'gpt', 'declares no DATA_CIPHER'],
    ['a board with an unknown cipher', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, env({ DATA_CIPHER: 'aes-cbc', DATA_RECOVERY_MEMORY_KIB: '1' }), 'board-e', 'gpt', 'DATA_CIPHER=aes-cbc'],
    ['a board with no KDF memory', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }, env({ DATA_CIPHER: 'aes-xts-plain64', DATA_KEY_PROVIDERS_AVAILABLE: 'tpm2' }), 'board-f', 'gpt', 'DATA_RECOVERY_MEMORY_KIB='],
    ['a provider twice', { DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2 tpm2' }, X64, 'board-a', 'gpt', 'names a provider twice'],
    ['a no-provider policy on an off product', { DATA_ENCRYPTION_NO_PROVIDER: 'plain' }, X64, 'board-a', 'gpt', 'DATA_ENCRYPTION is off'],
  ] as const)('%s is refused', (_label, values, facts, board, storage, fragment) => {
    expect(() => productDataEncryption(env(values), facts, board, storage)).toThrow(fragment)
  })
  test('a small board takes its own KDF memory', () => {
    expect(productDataEncryption(env({ DATA_ENCRYPTION: 'on', DATA_KEY_PROVIDERS: 'tpm2' }), env({ DATA_CIPHER: 'xchacha12,aes-adiantum-plain64', DATA_RECOVERY_MEMORY_KIB: '65536', DATA_KEY_PROVIDERS_AVAILABLE: 'tpm2' }), 'board-g', 'gpt'))
      .toEqual({ ...ON, cipher: 'xchacha12,aes-adiantum-plain64', recoveryMemoryKib: 65536 })
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
  test('this tree\'s check agrees with the contract cases, whole boot.json or the member alone, and catches a drift', () => {
    const good = cases('good', { dataEncryption: { accepted: [{ identity: {}, dataEncryption: ON }, { ...ON, cipher: 'xchacha12,aes-adiantum-plain64' }],
      refused: [{ ...ON, keyProviders: [] }, { ...ON, extra: 1 }] } })
    expect(fixtureProblems([{ product: 'uefi-x64.gcp-tpm2', member: ON }], good)).toEqual([])
    const drift = cases('drift', { dataEncryption: { accepted: [{ ...ON, cipher: 'aes-cbc' }], refused: [ON] } })
    expect(fixtureProblems([], drift)).toEqual(['accepted case 0 is refused here: dataEncryption.cipher is not one of aes-xts-plain64, xchacha12,aes-adiantum-plain64', 'refused case 0 is accepted here'])
    expect(fixtureProblems([], cases('empty', { dataEncryption: { accepted: [], refused: [] } }))[0]).toContain('no accepted or no refused case')
    expect(fixtureProblems([{ product: 'p', member: ON }], cases('none', { boardPolicies: {} }))).toEqual([])
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
