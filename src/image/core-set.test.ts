// src/image/core-set.ts against mica-core's vector (tests/fixtures/component-contracts/core-set.json): the core set
// mica-build signs and publishes is the one a device reads.
import { describe, expect, test } from 'bun:test'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Signer } from '../shared/update-envelope.ts'
import { authenticateCoreSet, buildCoreSet, coreSetId, parseCoreSet, type CoreSet } from './core-set.ts'

const vector = JSON.parse(readFileSync(join(import.meta.dir, '../../tests/fixtures/component-contracts/core-set.json'), 'utf8')) as
  { publicKey: string, payload: string, coreSetId: string, envelope: string }
const golden = JSON.parse(vector.payload) as CoreSet

describe('the vector', () => {
  test('its payload parses, and its id is the sha256 of the signed bytes', () => {
    expect(parseCoreSet(vector.payload).components.map(c => c.package)).toEqual(['mica-apid-ui', 'micad'])
    expect(coreSetId(vector.payload)).toBe(vector.coreSetId)
  })
  test('its envelope authenticates with its key and no other', () => {
    expect(authenticateCoreSet(vector.envelope, [vector.publicKey]).generation).toBe(golden.generation)
    expect(() => authenticateCoreSet(vector.envelope, ['A'.repeat(43) + '='])).toThrow()
  })
})

describe('refusals', () => {
  const edited = (edit: (s: Record<string, unknown>) => void) => {
    const s = JSON.parse(vector.payload) as Record<string, unknown>
    edit(s)
    return JSON.stringify(s)
  }
  for (const [name, payload, refusal] of [
    ['another schema', edited((s) => { s.schema = 'mica/core-set/v2' }), 'wrong core set schema'],
    ['a channel out of form', edited((s) => { s.channel = 'General' }), 'invalid core channel'],
    ['no component', edited((s) => { s.components = [] }), 'a core set carries no component'],
    ['components out of order', edited((s) => { (s.components as unknown[]).reverse() }), 'core components not unique and sorted by package'],
    ['a need not in the set', edited((s) => { (s.components as unknown[]).pop() }), 'a core component\'s need is not in the core set'],
  ] as const) test(name, () => expect(() => parseCoreSet(payload)).toThrow(refusal))
})

describe('building and signing', () => {
  test('the golden fields build the golden bytes, and a signed build authenticates', () => {
    const built = buildCoreSet({ channel: golden.channel, arch: golden.arch, generation: golden.generation, version: golden.version, components: [...golden.components].reverse() })
    expect(built).toBe(vector.payload)
    const { privateKey } = generateKeyPairSync('ed25519')
    const signer = new Signer(createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })), false)
    const envelope = JSON.stringify(signer.sign(JSON.parse(built)))
    expect(authenticateCoreSet(envelope, [signer.publicKey]).channel).toBe('general')
  })
})
