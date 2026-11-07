// The transfer index of every object of a release directory, published to res beside the objects the device fetches
// (src/release/chunks.ts): <dir>/objects/<sha256>.index. The device takes an object's index at its URL + ".index" and
// a chunk at "../chunks/<digest>" from it; the download host serves <dir>/chunks/<digest> as a range of the
// directory's own objects/<sha256>, found through these indexes, so no chunk is stored. Publishing is idempotent, so a
// failed run is rerun whole.
import { call } from './res.ts'
import { transfer, type ArchiveObject } from './chunks.ts'

const BATCH = 200
const say = (l: string) => console.log(l)
const download = () => process.env['MICA_RES_DOWNLOAD'] || 'https://dl.res.micaos.dev'
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')

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

type Item = { path: string, source: { uploadId: string }, contentType: string }

async function batch(namespace: string, items: Item[]): Promise<number> {
  let changed = 0
  for (let i = 0; i < items.length; i += BATCH) {
    const r = await call<{ objects: { outcome: string }[] }>('POST', `/res/namespaces/${namespace}/batch`, { objects: items.slice(i, i + BATCH) }, 3)
    changed += r.data.objects.filter(o => o.outcome !== 'unchanged').length
  }
  return changed
}

export type TransferOutcome = { objects: number, chunks: number, changed: number }

/** Publish the index of each of `objects` under `<namespace>/<dir>/`, then read back what a device reads: the index
 * of the largest object and its first chunk, from the download host. */
export async function publishTransfer(namespace: string, dir: string, objects: ArchiveObject[]): Promise<TransferOutcome> {
  const t = transfer(objects)
  const indexes: Item[] = []
  for (const i of t.indexes)
    indexes.push({ path: `${dir}/${i.path}`, source: { uploadId: await upload(namespace, sha256(i.bytes), i.bytes) }, contentType: 'application/octet-stream' })
  const changed = await batch(namespace, indexes)
  const outcome = { objects: t.indexes.length, chunks: t.chunks.length, changed }
  say(`res: transfer of ${namespace}/${dir}/: ${outcome.objects} index(es) over ${outcome.chunks} chunk(s), ${changed} changed`)

  const largest = objects.reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a))
  const index = t.indexes.find(i => i.path === `objects/${largest.sha256}.index`)!
  const first = Buffer.from(index.bytes.subarray(84, 148)).toString()
  const want = [[`${download()}/${namespace}/${dir}/objects/${largest.sha256}.index`, sha256(index.bytes)], [`${download()}/${namespace}/${dir}/chunks/${first}`, first]] as const
  for (const [url, sha] of want) {
    let got = ''
    for (let i = 0; i < 24 && got !== sha; i++) {
      if (i > 0) await Bun.sleep(5000)
      const r = await fetch(url, { redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } }).catch(() => undefined)
      got = r?.ok ? sha256(new Uint8Array(await r.arrayBuffer())) : `HTTP ${r?.status ?? 0}`
    }
    if (got !== sha) throw new Error(`res: ${url} reads back as ${got}, not ${sha}`)
    say(`res: ${url} reads back with its digest`)
  }
  return outcome
}
