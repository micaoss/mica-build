import { expect, test } from 'bun:test'
import { latestIndex, outcomeTable, postableReleases, releaseRecord, releaseRefs, type Descriptor, type Layer } from './res.ts'

const A = 'a'.repeat(64), B = 'b'.repeat(64), R = 'c'.repeat(64), K = 'd'.repeat(64)
const LABEL = 'mini-x64.basic.20260929-0107'
const rows = [
  ['product', 'mini-x64.basic', 'mini-x64', 'prod', '7', 'e'.repeat(64), 'f'.repeat(64), '0'.repeat(64)],
  ['asset', 'mini-x64.basic', 'image', 'disk', 'mica-mini-x64.basic-20260929-0107.img.gz', A],
  ['asset', 'mini-x64.basic', 'update', 'full', 'mica-mini-x64.basic-20260929-0107.micaupd', B],
]
const layers = new Map<string, Layer>([
  [A, { digest: `sha256:${A}`, size: 83000000, annotations: { 'mica.uncompressed-sha256': R, 'mica.uncompressed-size': '268435456' } }],
  [B, { digest: `sha256:${B}`, size: 81000000 }],
])
const descriptor: Descriptor = { version: '20260929-0107', generation: 7, product: 'mini-x64.basic', kernel: { boot: { artifact: { sha256: K } } } }

test('the record is the spec\'s: keys under mica/<product>/<stamp>/, sizes and raw identities from the bundles, the full archive', () => {
  expect(releaseRecord(LABEL, rows, layers, descriptor).record).toEqual({
    release: LABEL, scope: 'mini-x64.basic', stamp: '20260929-0107', product: 'mini-x64.basic', board: 'mini-x64', variant: 'basic',
    version: '20260929-0107', generation: 7,
    assets: [
      { kind: 'image', form: 'disk', path: 'mica/mini-x64.basic/20260929-0107/mica-mini-x64.basic-20260929-0107.img.gz', sha256: A, size: 83000000, uncompressedSha256: R, uncompressedSize: 268435456 },
      { kind: 'update', form: 'full', path: 'mica/mini-x64.basic/20260929-0107/mica-mini-x64.basic-20260929-0107.micaupd', sha256: B, size: 81000000 },
    ],
    update: { archive: 'mica/mini-x64.basic/20260929-0107/mica-mini-x64.basic-20260929-0107.micaupd' },
  })
})

test('a descriptor of another generation, a release without a full archive, an asset in no bundle and an image without its raw identity are refused', () => {
  expect(() => releaseRecord(LABEL, rows, layers, { ...descriptor, generation: 6 })).toThrow('not the lock\'s mini-x64.basic generation 7')
  expect(() => releaseRecord(LABEL, rows.filter(r => r[3] !== 'full'), layers, descriptor)).toThrow('has no full update archive')
  expect(() => releaseRecord(LABEL, rows, new Map([[A, layers.get(A)!]]), descriptor)).toThrow('is in no bundle')
  expect(() => releaseRecord(LABEL, rows, new Map([...layers, [A, { digest: `sha256:${A}`, size: 1 }]]), descriptor)).toThrow('carries no raw image identity')
})

test('the device manifest read back is mica/catalog/v2: the product\'s latest is the release, its document at baseUrl + path', () => {
  const line = { product: 'mini-x64.basic', board: 'mini-x64', variant: 'basic', latest: { id: LABEL, generation: 7, notes: '', path: 'mica/mini-x64.basic/20260929-0107/index.json' } }
  const manifest = { schema: 'mica/catalog/v2', revision: 3, baseUrl: 'https://dl.res.micaos.dev/', products: [line] }
  expect(latestIndex(manifest, LABEL, 'mini-x64.basic', 7)).toBe('https://dl.res.micaos.dev/mica/mini-x64.basic/20260929-0107/index.json')
  expect(latestIndex({ ...manifest, schema: 'mica/catalog/v1' }, LABEL, 'mini-x64.basic', 7)).toBeUndefined()
  expect(latestIndex(manifest, LABEL, 'mini-x64.basic', 8)).toBeUndefined()
  expect(latestIndex(manifest, 'mini-x64.basic.20260928-0000', 'mini-x64.basic', 7)).toBeUndefined()
  expect(latestIndex({ ...manifest, baseUrl: 'https://dl.res.micaos.dev' }, LABEL, 'mini-x64.basic', 7)).toBeUndefined()
  expect(latestIndex({ ...manifest, products: [{ ...line, latest: { ...line.latest, path: '../index.json' } }] }, LABEL, 'mini-x64.basic', 7)).toBeUndefined()
})

test('the release document read back is mica/release/v1 of the release: its descriptor and the URL of the object', () => {
  const base = 'https://dl.res.micaos.dev/mica/mini-x64.basic/20260929-0107/'
  const index = { schema: 'mica/release/v1', baseUrl: base, id: LABEL, product: 'mini-x64.basic', board: 'mini-x64', variant: 'basic', generation: 7,
    deployment: { path: 'deployment.json', sha256: R, bytes: 900 }, objects: [{ sha256: K, bytes: 10, path: `objects/${K}` }] }
  expect(releaseRefs(index, LABEL, 'mini-x64.basic', 7, K)).toEqual({ deployment: { url: `${base}deployment.json`, sha256: R, bytes: 900 }, object: `${base}objects/${K}` })
  expect(releaseRefs({ ...index, schema: 'mica/release/v2' }, LABEL, 'mini-x64.basic', 7, K)).toBeUndefined()
  expect(releaseRefs({ ...index, id: 'other' }, LABEL, 'mini-x64.basic', 7, K)).toBeUndefined()
  expect(releaseRefs(index, LABEL, 'mini-x64.basic', 8, K)).toBeUndefined()
  expect(releaseRefs(index, LABEL, 'mini-x64.basic', 7, A)).toBeUndefined()
  expect(releaseRefs({ ...index, deployment: { path: '/deployment.json', sha256: R, bytes: 900 } }, LABEL, 'mini-x64.basic', 7, K)).toBeUndefined()
})

test('the releases posted are the published ones with assets and a release tag, oldest first, or the one named', () => {
  const asset = [{}]
  const releases = [
    { draft: false, tag_name: 'uefi-x64.basic.20261003-0900', assets: asset },
    { draft: false, tag_name: 'cx3576.full.20261002-1200', assets: asset },
    { draft: false, tag_name: 'mini-x64.basic.20261002-1200', assets: asset },
    { draft: true, tag_name: 'uefi-x64.full.20261001-0800', assets: asset },
    { draft: false, tag_name: 'uefi-x64.full.20261001-0700', assets: [] },
    { draft: false, tag_name: 'v1.0.0', assets: asset },
  ]
  expect(postableReleases(releases)).toEqual(['cx3576.full.20261002-1200', 'mini-x64.basic.20261002-1200', 'uefi-x64.basic.20261003-0900'])
  expect(postableReleases(releases, 'mini-x64.basic.20261002-1200')).toEqual(['mini-x64.basic.20261002-1200'])
  expect(() => postableReleases(releases, 'uefi-x64.full.20261001-0800')).toThrow('is not a published release')
  expect(postableReleases([])).toEqual([])
})

test('the job summary has one row per release, its outcome on one line', () => {
  const table = outcomeTable([{ release: LABEL, outcome: 'unchanged' }, { release: 'cx3576.full.20261002-1200', outcome: 'failed: a | b\nc' }], false)
  expect(table).toContain(`| ${LABEL} | unchanged |`)
  expect(table).toContain('| cx3576.full.20261002-1200 | failed: a \\| b c |')
  expect(outcomeTable([], true)).toContain('dry run (nothing posted)')
})
