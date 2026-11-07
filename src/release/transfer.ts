// The transfer index and chunks of a release directory, published to res beside the objects the device fetches
// (src/release/chunks.ts): <dir>/objects/<sha256>.index for every object and <dir>/chunks/<digest> for every chunk
// they cut into. The device takes an object's index at its URL + ".index" and a chunk at "../chunks/<digest>" from it,
// so every chunk the release's objects need is under the release's own directory.
//
// A chunk some object of the namespace already holds (res's digest lookup, /blob/<aa>/<sha256>) is published by its
// digest, a copy inside the store; only the others are uploaded. Chunks go first, in batches, and the indexes last in
// one batch: a device that reads an index finds its chunks. Every step is idempotent, so a failed run is rerun whole.
import { call } from './res.ts'
import { transfer, type ArchiveObject } from './chunks.ts'

const BATCH = 200
const PARALLEL = 8
const say = (l: string) => console.log(l)
const base = () => process.env['MICA_RES_BASE'] || 'https://res.micaos.dev'

/** Run `work` over `items`, at most PARALLEL at a time. */
async function pool<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all([...Array(Math.min(PARALLEL, items.length)).keys()].map(async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

/** Whether an object of `namespace` already holds `sha256`, by res's digest lookup. */
async function held(namespace: string, sha256: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`${base()}/blob/${sha256.slice(0, 2)}/${sha256}`, { method: 'HEAD', redirect: 'manual' })
      if (r.status === 404) return false
      const location = r.headers.get('location')
      if (r.status >= 300 && r.status < 400 && location !== null) return new URL(location).pathname.startsWith(`/${namespace}/`)
    }
    catch { /* retried */ }
    await Bun.sleep(1000 * 2 ** attempt)
  }
  return false
}

/** Stage `bytes` through a presigned PUT (or the service, when the store cannot presign); the upload's id. */
async function upload(namespace: string, sha256: string, bytes: Uint8Array): Promise<string> {
  const u = await call<{ id: string, url: string, headers: Record<string, string>, direct?: boolean }>('POST', `/res/namespaces/${namespace}/uploads`,
    { sha256, size: bytes.length, contentType: 'application/octet-stream' }, 6)
  const headers = u.data.direct === true ? { ...u.data.headers, Authorization: `Bearer ${process.env['MICA_RES_TOKEN'] ?? ''}` } : u.data.headers
  for (let attempt = 0; ; attempt++) {
    const put = await fetch(u.data.url, { method: 'PUT', headers, body: bytes }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }))
    if (put.ok) return u.data.id
    if (attempt >= 4) throw new Error(`res: upload of ${sha256} answered HTTP ${put.status}: ${(await put.text()).slice(0, 300)}`)
    await Bun.sleep(2000 * 2 ** attempt)
  }
}

type Item = { path: string, source: { uploadId: string } | { sha256: string }, contentType: string }

async function batch(namespace: string, items: Item[]): Promise<number> {
  let changed = 0
  for (let i = 0; i < items.length; i += BATCH) {
    const r = await call<{ objects: { outcome: string }[] }>('POST', `/res/namespaces/${namespace}/batch`, { objects: items.slice(i, i + BATCH) }, 3)
    changed += r.data.objects.filter(o => o.outcome !== 'unchanged').length
  }
  return changed
}

export type TransferOutcome = { objects: number, chunks: number, uploaded: number, uploadedBytes: number, copied: number, changed: number }

/** Publish the indexes and chunks of `objects` under `<namespace>/<dir>/`, then read one index and one chunk back. */
export async function publishTransfer(namespace: string, dir: string, objects: ArchiveObject[]): Promise<TransferOutcome> {
  const t = transfer(objects)
  const items: Item[] = []
  let uploaded = 0, uploadedBytes = 0
  await pool(t.chunks, async (c) => {
    if (await held(namespace, c.sha256)) { items.push({ path: `${dir}/${c.path}`, source: { sha256: c.sha256 }, contentType: 'application/octet-stream' }) }
    else {
      items.push({ path: `${dir}/${c.path}`, source: { uploadId: await upload(namespace, c.sha256, c.bytes) }, contentType: 'application/octet-stream' })
      uploaded++
      uploadedBytes += c.bytes.length
    }
  })
  items.sort((a, b) => (a.path < b.path ? -1 : 1))
  let changed = await batch(namespace, items)
  const indexes: Item[] = []
  for (const i of t.indexes)
    indexes.push({ path: `${dir}/${i.path}`, source: { uploadId: await upload(namespace, new Bun.CryptoHasher('sha256').update(i.bytes).digest('hex'), i.bytes) }, contentType: 'application/octet-stream' })
  changed += await batch(namespace, indexes)
  const outcome = { objects: t.indexes.length, chunks: t.chunks.length, uploaded, uploadedBytes, copied: t.chunks.length - uploaded, changed }
  say(`res: transfer of ${namespace}/${dir}/: ${outcome.objects} index(es), ${outcome.chunks} chunk(s), ${uploaded} uploaded (${uploadedBytes} bytes), ${outcome.copied} by digest, ${changed} changed`)

  // Read back what a device reads: the index of the largest object and its first chunk, each by its digest.
  const largest = objects.reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a))
  const index = t.indexes.find(i => i.path === `objects/${largest.sha256}.index`)!
  const first = index.bytes.subarray(84, 148).toString()
  const want = [[`objects/${largest.sha256}.index`, new Bun.CryptoHasher('sha256').update(index.bytes).digest('hex')], [`chunks/${first}`, first]] as const
  for (const [path, sha] of want) {
    let got = ''
    for (let i = 0; i < 24 && got !== sha; i++) {
      if (i > 0) await Bun.sleep(5000)
      const r = await fetch(`${base()}/${namespace}/${dir}/${path}`, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } }).catch(() => undefined)
      got = r?.ok ? new Bun.CryptoHasher('sha256').update(new Uint8Array(await r.arrayBuffer())).digest('hex') : `HTTP ${r?.status ?? 0}`
    }
    if (got !== sha) throw new Error(`res: ${namespace}/${dir}/${path} reads back as ${got}, not ${sha}`)
    say(`res: ${namespace}/${dir}/${path} reads back with its digest`)
  }
  return outcome
}
