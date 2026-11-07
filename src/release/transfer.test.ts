import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { cut } from './chunks.ts'
import { publishTransfer } from './transfer.ts'

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const BASE = 'https://res.example.test'

// A res of one namespace: staged uploads, published keys, the digest lookup over what is published.
type Fake = { staged: Map<string, Uint8Array>, published: Map<string, Uint8Array>, sources: Map<string, string>, batches: number }
let fake: Fake
const realFetch = globalThis.fetch
const env = { ...process.env }

beforeEach(() => {
  fake = { staged: new Map(), published: new Map(), sources: new Map(), batches: 0 }
  process.env['MICA_RES_BASE'] = BASE
  process.env['MICA_RES_DOWNLOAD'] = 'https://dl.example.test'
  process.env['MICA_RES_TOKEN'] = 'test-token'
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 300, data }), { status })
    if (url.pathname.startsWith('/blob/')) {
      const sha = url.pathname.split('/')[3]!
      const key = [...fake.published].find(([, b]) => sha256(b) === sha)?.[0]
      return key === undefined ? new Response(null, { status: 404 }) : new Response(null, { status: 302, headers: { location: `https://dl.example.test/${key}` } })
    }
    if (url.pathname === '/admin/api/res/namespaces/mica/uploads' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { sha256: string }
      return json({ id: `u-${body.sha256}`, url: `https://r2.example.test/${body.sha256}`, headers: {}, direct: false }, 201)
    }
    if (url.host === 'r2.example.test' && method === 'PUT') {
      const bytes = new Uint8Array(init!.body as Uint8Array)
      if (sha256(bytes) !== url.pathname.slice(1)) return new Response('checksum', { status: 400 })
      fake.staged.set(`u-${url.pathname.slice(1)}`, bytes)
      return new Response(null, { status: 200 })
    }
    if (url.pathname === '/admin/api/res/namespaces/mica/batch') {
      fake.batches++
      const body = JSON.parse(String(init!.body)) as { objects: { path: string, source: { uploadId?: string, sha256?: string } }[] }
      expect(body.objects.length).toBeLessThanOrEqual(500)
      const outcomes = body.objects.map((o) => {
        const bytes = o.source.uploadId !== undefined
          ? fake.staged.get(o.source.uploadId)
          : [...fake.published.values()].find(b => sha256(b) === o.source.sha256)
        if (bytes === undefined) throw new Error(`no source for ${o.path}`)
        fake.sources.set(`mica/${o.path}`, o.source.uploadId !== undefined ? 'upload' : 'digest')
        const had = fake.published.has(`mica/${o.path}`)
        fake.published.set(`mica/${o.path}`, bytes)
        return { outcome: had ? 'unchanged' : 'created' }
      })
      return json({ objects: outcomes })
    }
    // The download host: a published key, or <dir>/chunks/<digest> as a range of an object of <dir> by its index.
    const m = /^\/(.+)\/chunks\/([0-9a-f]{64})$/.exec(url.pathname)
    if (url.host === 'dl.example.test' && m !== null) {
      for (const [key, index] of fake.published) {
        if (!key.startsWith(`${m[1]}/objects/`) || !key.endsWith('.index')) continue
        const object = fake.published.get(key.slice(0, -'.index'.length))
        let offset = 0
        for (let at = 84; at < index.length; at += 68) {
          const length = Buffer.from(index).readUInt32BE(at + 64)
          if (Buffer.from(index.subarray(at, at + 64)).toString() === m[2] && object !== undefined) return new Response(object.subarray(offset, offset + length))
          offset += length
        }
      }
      return new Response(null, { status: 404 })
    }
    const bytes = fake.published.get(url.pathname.slice(1))
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...env }
})

// The objects themselves, as the release's batch publishes them beside the indexes.
function release(dir: string, objects: { sha256: string, bytes: Uint8Array }[]): void {
  for (const o of objects) fake.published.set(`mica/${dir}/objects/${o.sha256}`, o.bytes)
}

test('every object\'s index is published under the release directory, no chunk is, and a chunk reads back from the download host', async () => {
  const root = new Uint8Array(randomBytes(300000)), signature = new Uint8Array(randomBytes(417))
  const objects = [{ sha256: sha256(root), bytes: root }, { sha256: sha256(signature), bytes: signature }]
  release('p.basic/20261107-1200', objects)
  const outcome = await publishTransfer('mica', 'p.basic/20261107-1200', objects)
  const chunks = [...cut(root), ...cut(signature)]
  expect(outcome).toEqual({ objects: 2, chunks: chunks.length, changed: 2 })
  for (const o of objects) {
    const index = fake.published.get(`mica/p.basic/20261107-1200/objects/${o.sha256}.index`)!
    expect(Buffer.from(index.subarray(0, 8)).toString()).toBe('MICAIDX1')
    expect(Buffer.from(index.subarray(8, 72)).toString()).toBe(o.sha256)
  }
  expect([...fake.published.keys()].filter(k => k.includes('/chunks/'))).toEqual([])
  const rerun = await publishTransfer('mica', 'p.basic/20261107-1200', objects)
  expect(rerun.changed).toBe(0)
})
