import { expect, test } from 'bun:test'
import type { CoreSet } from '../image/core-set.ts'
import { archiveEnvelope, archiveName, coreIndex, coreRecord, coreRefs, coreReleases, coreTag, isCoreTag, type CoreArchive } from './core.ts'

const LABEL = 'core.general.20261013-0900'
const A = 'a'.repeat(64), B = 'b'.repeat(64), O = 'c'.repeat(64), S = 'd'.repeat(64)
const set = (arch: 'amd64' | 'arm64', over: Partial<CoreSet> = {}) => ({ schema: 'mica/set/v1', kind: 'core', channel: 'general', arch, generation: 4, version: '0.0.8', components: [], ...over }) as CoreSet
const archives = (): CoreArchive[] => [
  { arch: 'amd64', name: archiveName(coreTag(LABEL), 'amd64'), sha256: A, size: 5000000, set: set('amd64') },
  { arch: 'arm64', name: archiveName(coreTag(LABEL), 'arm64'), sha256: B, size: 4900000, set: set('arm64') },
]

test('a core tag is core.<channel>.<YYYYMMDD-HHMM>, and a product tag is none', () => {
  expect(coreTag(LABEL)).toEqual({ channel: 'general', stamp: '20261013-0900' })
  expect(isCoreTag('core.lts-1.20261013-0900')).toBe(true)
  for (const t of ['mini-x64.basic.20261013-0900', 'core.general', 'core.General.20261013-0900', 'core.general.20261013']) expect(isCoreTag(t)).toBe(false)
  expect(() => coreTag('mini-x64.basic.20261013-0900')).toThrow('core.<channel>.<YYYYMMDD-HHMM>')
})

test('a channel\'s releases are its published ones with assets, newest first', () => {
  const r = (tag_name: string, draft = false, assets: unknown[] = [1]) => ({ tag_name, draft, assets })
  expect(coreReleases([r('core.general.20261010-0000'), r('core.lts.20261012-0000'), r('core.general.20261012-0000'), r('core.general.20261013-0000', true),
    r('core.general.20261014-0000', false, []), r('mini-x64.basic.20261015-0000')], 'general')).toEqual(['core.general.20261012-0000', 'core.general.20261010-0000'])
})

test('the envelope is read out of the head of a MICAUPD1 archive', () => {
  const envelope = '{"schema":"mica/update-envelope/v1"}'
  const head = Buffer.alloc(12)
  head.write('MICAUPD1')
  head.writeUInt32BE(envelope.length, 8)
  expect(archiveEnvelope(Buffer.concat([head, Buffer.from(envelope), Buffer.alloc(4)]))).toBe(envelope)
  expect(() => archiveEnvelope(Buffer.concat([head, Buffer.from(envelope.slice(4))]))).toThrow('MICAUPD1')
  expect(() => archiveEnvelope(Buffer.from('not an archive at all'))).toThrow('MICAUPD1')
})

test('the record is the spec\'s: kind core, the channel as the product, one archive per architecture', () => {
  const key = (arch: string) => `mica/core.general/20261013-0900/mica-core.general-20261013-0900.${arch}.micaupd`
  expect(coreRecord(LABEL, archives())).toEqual({
    release: LABEL, kind: 'core', scope: 'core.general', stamp: '20261013-0900', product: 'core.general', channel: 'general', version: '0.0.8', generation: 4,
    assets: [{ kind: 'core', form: 'amd64', path: key('amd64'), sha256: A, size: 5000000 }, { kind: 'core', form: 'arm64', path: key('arm64'), sha256: B, size: 4900000 }],
    cores: [{ arch: 'amd64', archive: key('amd64') }, { arch: 'arm64', archive: key('arm64') }],
  })
})

test('a record of sets that disagree is refused: another channel, architecture, version or generation', () => {
  for (const [over, fragment] of [[{ channel: 'lts' }, 'holds a set of lts'], [{ arch: 'amd64' }, 'holds a set of general for amd64'], [{ version: '0.0.9' }, 'is 0.0.9 generation 4'], [{ generation: 5 }, 'generation 5']] as [Partial<CoreSet>, string][]) {
    const a = archives()
    a[1]!.set = set('arm64', over)
    expect(() => coreRecord(LABEL, a)).toThrow(fragment)
  }
  expect(() => coreRecord(LABEL, [])).toThrow('no archive')
})

const manifest = (over: object = {}) => ({ schema: 'mica/catalog/v1', baseUrl: 'https://res.micaos.dev/', products: [], sets: [
  { kind: 'charts', channel: 'general', arch: 'amd64', latest: { id: LABEL, generation: 4, path: 'mica/charts.general/20261013-0900/amd64/index.json' } },
  { kind: 'core', channel: 'general', arch: 'amd64', latest: { id: LABEL, generation: 4, path: 'mica/core.general/20261013-0900/amd64/index.json' } },
  { kind: 'core', channel: 'lts', arch: 'amd64', latest: { id: 'core.lts.20261001-0000', generation: 9, path: 'mica/core.lts/20261001-0000/amd64/index.json' } },
], ...over })

test('the manifest names the release on the line of the core kind, its channel and architecture, or not yet', () => {
  expect(coreIndex(manifest(), LABEL, 'amd64', 4)).toBe('https://res.micaos.dev/mica/core.general/20261013-0900/amd64/index.json')
  expect(coreIndex(manifest(), LABEL, 'arm64', 4)).toBeUndefined()
  expect(coreIndex(manifest(), LABEL, 'amd64', 5)).toBeUndefined()
  expect(coreIndex(manifest({ schema: 'mica/catalog/v2' }), LABEL, 'amd64', 4)).toBeUndefined()
  expect(coreIndex(manifest({ sets: undefined }), LABEL, 'amd64', 4)).toBeUndefined()
})

test('the release document names the signed set and the object at its baseUrl, or is not this release\'s', () => {
  const index = (over: object = {}) => ({ schema: 'mica/set-release/v1', baseUrl: 'https://res.micaos.dev/mica/core.general/20261013-0900/amd64/', id: LABEL, kind: 'core', channel: 'general', arch: 'amd64', generation: 4,
    set: { path: 'set.json', sha256: S, bytes: 3000 }, objects: [{ sha256: O, bytes: 1, path: `objects/${O}` }], ...over })
  expect(coreRefs(index(), LABEL, 'amd64', 4, O)).toEqual({ set: { url: 'https://res.micaos.dev/mica/core.general/20261013-0900/amd64/set.json', sha256: S }, object: `https://res.micaos.dev/mica/core.general/20261013-0900/amd64/objects/${O}` })
  for (const over of [{ schema: 'mica/release/v1' }, { id: 'core.general.20261012-0000' }, { arch: 'arm64' }, { channel: 'lts' }, { generation: 3 }, { objects: [] }, { kind: 'charts' }, { set: { path: '../set.json', sha256: S } }])
    expect(coreRefs(index(over), LABEL, 'amd64', 4, O)).toBeUndefined()
})
