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
    const bytes = fake.published.get(url.pathname.slice(1))
    return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  process.env = { ...env }
})

test('every object\'s index and every chunk are published under the release directory, and read back', async () => {
  const root = new Uint8Array(randomBytes(300000)), signature = new Uint8Array(randomBytes(417))
  const objects = [{ sha256: sha256(root), bytes: root }, { sha256: sha256(signature), bytes: signature }]
  const outcome = await publishTransfer('mica', 'p.basic/20261107-1200', objects)
  const chunks = [...cut(root), ...cut(signature)]
  expect(outcome).toEqual({ objects: 2, chunks: chunks.length, uploaded: chunks.length, uploadedBytes: root.length + signature.length, copied: 0, changed: chunks.length + 2 })
  for (const o of objects) {
    const index = fake.published.get(`mica/p.basic/20261107-1200/objects/${o.sha256}.index`)!
    expect(Buffer.from(index.subarray(0, 8)).toString()).toBe('MICAIDX1')
    expect(Buffer.from(index.subarray(8, 72)).toString()).toBe(o.sha256)
  }
  for (const c of chunks) expect(sha256(fake.published.get(`mica/p.basic/20261107-1200/chunks/${c.sha256}`)!)).toBe(c.sha256)
})

test('a chunk the namespace already holds is published by its digest, not uploaded; a rerun changes nothing', async () => {
  const old = new Uint8Array(randomBytes(400000))
  await publishTransfer('mica', 'p.basic/1', [{ sha256: sha256(old), bytes: old }])
  // The next release: the same bytes with a little appended, so all but the last chunks are the old release's.
  const next = new Uint8Array(Buffer.concat([old, randomBytes(5000)]))
  const outcome = await publishTransfer('mica', 'p.basic/2', [{ sha256: sha256(next), bytes: next }])
  const chunks = cut(next)
  expect(outcome.copied).toBeGreaterThanOrEqual(chunks.length - 2)
  expect(outcome.uploadedBytes).toBeLessThan(5000 + 2 * 65536)
  for (const c of chunks) expect(fake.published.has(`mica/p.basic/2/chunks/${c.sha256}`)).toBe(true)
  expect(fake.sources.get(`mica/p.basic/2/chunks/${chunks[0]!.sha256}`)).toBe('digest')
  const rerun = await publishTransfer('mica', 'p.basic/2', [{ sha256: sha256(next), bytes: next }])
  expect(rerun.changed).toBe(0)
})
