// src/image/core-set.ts against mica-core's vector (tests/fixtures/component-contracts/set.json): the core set
// mica-build signs and publishes is the one a device reads.
import { describe, expect, test } from 'bun:test'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Signer } from '../shared/update-envelope.ts'
import { authenticateCoreSet, buildCoreSet, checkCoreSetForProduct, coreSetId, parseCoreSet, type CoreSet } from './core-set.ts'

const vector = JSON.parse(readFileSync(join(import.meta.dir, '../../tests/fixtures/component-contracts/set.json'), 'utf8')) as
  { publicKey: string, payload: string, setId: string, envelope: string }
const golden = JSON.parse(vector.payload) as CoreSet

describe('the vector', () => {
  test('its payload parses, and its id is the sha256 of the signed bytes', () => {
    expect(parseCoreSet(vector.payload).components.map(c => c.package)).toEqual(['mica-apid-ui', 'micad'])
    expect(coreSetId(vector.payload)).toBe(vector.setId)
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
    ['another schema', edited((s) => { s.schema = 'mica/set/v2' }), 'wrong set schema'],
    ['another kind', edited((s) => { s.kind = 'charts' }), 'unsupported set kind'],
    ['no kind', edited((s) => { delete s.kind }), 'unknown, missing or invalid fields'],
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

describe('checking a set against a product it meets', () => {
  const set = parseCoreSet(vector.payload)
  test('the product\'s features select by what the components declare', () => {
    expect(checkCoreSetForProduct(set, { name: 'x.full', arch: 'amd64', features: ['micad', 'ui', 'ssh'] }, { level: 1 })).toBe('x.full: mica-apid-ui micad')
    expect(checkCoreSetForProduct(set, { name: 'x.basic', arch: 'amd64', features: ['micad', 'ssh'] }, { level: 1 })).toBe('x.basic: micad')
    expect(checkCoreSetForProduct(set, { name: 'x.none', arch: 'amd64', features: ['ssh'] }, { level: 1 })).toBe('x.none: ')
  })
  test('a product the set cannot serve refuses the set, by name', () => {
    expect(() => checkCoreSetForProduct(set, { name: 'x.console', arch: 'amd64', features: ['ui'] }, { level: 1 }))
      .toThrow('x.console: a selected core component\'s need is not selected')
  })
  test('the product\'s root is held only to what a component declares of it: its level, and the packages it requires', () => {
    expect(checkCoreSetForProduct(set, { name: 'x.full', arch: 'amd64', features: ['micad'] }, { level: 1, provides: { 'mica-podman': '6.1.4-8' } })).toBe('x.full: micad')
    expect(checkCoreSetForProduct(set, { name: 'x.slim', arch: 'amd64', features: ['micad'] }, { level: 1, provides: { 'mica-system': '13.8-mica2' } })).toBe('x.slim: micad')
    expect(() => checkCoreSetForProduct(set, { name: 'x.old', arch: 'amd64', features: ['micad'] }, { level: 1, provides: { 'mica-podman': '6.1.4-5' } }))
      .toThrow('x.old: a selected core component\'s root requirement does not hold: micad 0.0.1 requires mica-podman >= 6.1.4-7, the root provides 6.1.4-5')
    expect(() => checkCoreSetForProduct(set, { name: 'x.next', arch: 'amd64', features: ['micad'] }, { level: 3 }))
      .toThrow('x.next: a selected core component does not run on this root\'s interface level')
  })
  test('a product of another architecture refuses the set', () => {
    expect(() => checkCoreSetForProduct(set, { name: 'y.full', arch: 'arm64', features: ['micad'] }, { level: 1 })).toThrow('is for amd64, and y.full runs on arm64')
  })
})
