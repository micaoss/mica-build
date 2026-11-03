// A hand-over published to res's test channel, without a release: images and their small files, for testers.
//
//   bin/test-publish <hand-over directory>      (bin/local-build.sh <product> --publish-test, after staging)
//
//   reads   the hand-over: SHA256SUMS and every file it lists but the raw .img (testers check with
//           `sha256sum -c --ignore-missing`), each verified against it first; the token of a res:publish user
//           granted mica-test, from MICA_RES_TEST_TOKEN_FILE (default /srv/micaoss/.secrets/res-test-token), sent
//           as a header and never printed
//   writes  mica-test/<product>/<id>/<file> in one batch, <id> the hand-over's git id out of the image's name
//           (gitc4c1117d592f), with the aliases mica-test/<product>/latest/<file> -> the id's files and the object
//           mica-test/<product>/latest/ID holding the id; then reads them back: the namespace's listing (sha256,
//           size) and every file downloaded from the download host
//
// Every file goes up as a multipart upload (mica-res:docs/modules/resource.md, Multipart uploads): parts strictly
// in order, a failed or interrupted part resumed from the upload's status, the upload started over when res finds
// the whole file's sha256 differs or the upload expired, and aborted when it cannot finish.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { products } from '../product/product.ts'

export class TestPublishError extends Error {}

function die(message: string): never {
  throw new TestPublishError(`test-publish: error: ${message}`)
}

export const NAMESPACE = 'mica-test'
export const API = 'https://res.micaos.dev/admin/api'
export const SITE = 'https://res.micaos.dev'
export const DOWNLOAD = 'https://dl.res.micaos.dev'
const MiB = 1024 * 1024

export type File = { name: string, path: string, sha256: string, size: number }
export type Plan = { product: string, id: string, files: File[] }

/** The sha256 of a file, read as a stream. */
export async function sha256File(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

/** The product and git id of a hand-over image's name: mica-<product>-<version>+<id>-<revision>[.<kind>].img.gz. */
export function imageId(name: string): { product: string, id: string } | undefined {
  const m = /^mica-([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*?)-[0-9][^+/]*\+(git[0-9a-f]+)-[0-9]+(?:\.[a-z0-9-]+)?\.img\.gz$/.exec(name)
  return m === null ? undefined : { product: m[1]!, id: m[2]! }
}

/** What a hand-over publishes, every file verified against its SHA256SUMS. */
export async function plan(dirArg: string, known: (product: string) => boolean = p => products().includes(p)): Promise<Plan> {
  const dir = resolve(dirArg), sums = join(dir, 'SHA256SUMS')
  if (!existsSync(sums)) die(`${dir} holds no SHA256SUMS; stage the hand-over first`)
  const listed = readFileSync(sums, 'utf8').split('\n').filter(l => l !== '').map((l) => {
    const m = /^([0-9a-f]{64}) [ *]([^/\s][^/]*)$/.exec(l)
    if (m === null) die(`${sums}: '${l}' is not a line of sha256sum`)
    return { sha256: m[1]!, name: m[2]! }
  })
  const ids = [...new Set(listed.map(f => imageId(f.name)).filter(i => i !== undefined).map(i => `${i.product} ${i.id}`))]
  if (ids.length === 0) die(`${sums} lists no image mica-<product>-<version>+git<id>-<n>.img.gz`)
  if (ids.length > 1) die(`${sums} lists images of more than one build: ${ids.join(', ')}`)
  const [product, id] = ids[0]!.split(' ') as [string, string]
  if (!known(product)) die(`${product}, out of the image's name, is no product of this tree`)
  const files: File[] = []
  for (const f of listed.filter(f => !f.name.endsWith('.img'))) {
    const path = join(dir, f.name)
    if (!existsSync(path)) die(`${path}, listed in SHA256SUMS, does not exist`)
    const actual = await sha256File(path)
    if (actual !== f.sha256) die(`${path} is ${actual}, SHA256SUMS says ${f.sha256}`)
    files.push({ name: f.name, path, sha256: actual, size: Bun.file(path).size })
  }
  files.push({ name: 'SHA256SUMS', path: sums, sha256: await sha256File(sums), size: Bun.file(sums).size })
  return { product, id, files }
}

export function contentType(name: string): string {
  if (name.endsWith('.gz')) return 'application/gzip'
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (name.endsWith('.bin')) return 'application/octet-stream'
  return 'text/plain; charset=utf-8'
}

export type Options = {
  token: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  partSize?: number
  /** How often the download host is asked again while the catalog catches up. */
  readBackTries?: number
}

type Status = { id: string, sha256: string, size: number, partSize: number, parts: number, nextPart: number, completed: boolean }
type Answer = { status: number, code: string, message: string, data: unknown }

class Client {
  readonly fetch: typeof fetch
  readonly sleep: (ms: number) => Promise<void>
  readonly log: (line: string) => void
  constructor(readonly o: Options) {
    this.fetch = o.fetch ?? fetch
    this.sleep = o.sleep ?? (ms => Bun.sleep(ms))
    this.log = o.log ?? (line => console.log(line))
  }

  /** One API request; a network error, a 429 or a 5xx retried with backoff, any other answer returned. */
  async call(method: string, path: string, body?: unknown, bytes?: Uint8Array): Promise<Answer> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.o.token}` }
    if (bytes !== undefined) headers['Content-Type'] = 'application/octet-stream'
    else if (body !== undefined) headers['Content-Type'] = 'application/json'
    let last = ''
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await this.sleep(2000 * 2 ** (attempt - 1))
      let r: Response
      try {
        r = await this.fetch(`${API}${path}`, { method, headers, body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)) })
      }
      catch (e) {
        last = `${method} ${path}: ${(e as Error).message}`
        if (bytes !== undefined) return { status: 0, code: 'NETWORK', message: last, data: null }
        continue
      }
      const text = await r.text()
      let json: { data?: unknown, success?: boolean, error?: { code?: string, message?: string } } = {}
      try { json = JSON.parse(text) as typeof json }
      catch { /* not JSON: the status speaks */ }
      if (r.status === 429 || r.status >= 500) {
        last = `${method} ${path}: ${r.status} ${json.error?.message ?? text.slice(0, 200)}`
        if (bytes !== undefined) return { status: r.status, code: json.error?.code ?? `HTTP_${r.status}`, message: last, data: null }
        continue
      }
      return { status: r.status, code: json.error?.code ?? '', message: json.error?.message ?? text.slice(0, 200), data: json.data }
    }
    die(`${last} (gave up after 6 tries)`)
  }

  async must(method: string, path: string, body?: unknown): Promise<unknown> {
    const a = await this.call(method, path, body)
    if (a.status < 200 || a.status > 299) die(`${method} ${path}: ${a.status} ${a.code} ${a.message}`)
    return a.data
  }

  /** One file sent as a multipart upload; its upload id. Started over once when res refuses the whole file. */
  async upload(f: File): Promise<string> {
    for (let start = 0; start < 2; start++) {
      let s = await this.must('POST', `/res/namespaces/${NAMESPACE}/uploads/multipart`, { sha256: f.sha256, size: f.size, contentType: contentType(f.name), partSize: this.o.partSize ?? 64 * MiB }) as Status
      try {
        let failures = 0
        while (!s.completed && s.nextPart <= s.parts) {
          const n = s.nextPart, from = (n - 1) * s.partSize, to = Math.min(from + s.partSize, f.size)
          const bytes = new Uint8Array(await Bun.file(f.path).slice(from, to).arrayBuffer())
          const a = await this.call('PUT', `/res/uploads/${s.id}/parts/${n}`, undefined, bytes)
          if (a.status === 200) { s = a.data as Status; failures = 0; continue }
          // Interrupted, not stored, or not the part res expects: ask where to go on, then go on from there.
          if (a.status !== 0 && a.status < 500 && a.status !== 429 && a.code !== 'PART_FAILED' && a.code !== 'PART_OUT_OF_ORDER')
            die(`part ${n} of ${f.name}: ${a.status} ${a.code} ${a.message}`)
          if (++failures > 5) die(`part ${n} of ${f.name} failed ${failures} times: ${a.status} ${a.code} ${a.message}`)
          this.log(`test-publish: part ${n} of ${f.name}: ${a.code || a.status}; resuming from the upload's status`)
          await this.sleep(2000 * failures)
          s = await this.must('GET', `/res/uploads/${s.id}`) as Status
        }
        const done = await this.call('POST', `/res/uploads/${s.id}/complete`)
        if (done.status === 200) return s.id
        if (done.code === 'SHA256_MISMATCH' || done.code === 'UPLOAD_EXPIRED') {
          this.log(`test-publish: ${f.name}: ${done.code}; starting its upload over`)
          await this.call('POST', `/res/uploads/${s.id}/abort`).catch(() => undefined)
          continue
        }
        die(`complete ${f.name}: ${done.status} ${done.code} ${done.message}`)
      }
      catch (e) {
        await this.call('POST', `/res/uploads/${s.id}/abort`).catch(() => undefined)
        throw e
      }
    }
    die(`${f.name}: res refused the whole file twice`)
  }
}

/** The URLs a tester uses. */
export function urls(p: Plan): string[] {
  return [`${SITE}/${NAMESPACE}/${p.product}/`, ...p.files.map(f => `${DOWNLOAD}/${NAMESPACE}/${p.product}/${p.id}/${f.name}`),
    ...p.files.map(f => `${SITE}/${NAMESPACE}/${p.product}/latest/${f.name}`), `${DOWNLOAD}/${NAMESPACE}/${p.product}/latest/ID`]
}

/** Upload, publish in one batch, read back. */
export async function publish(p: Plan, o: Options): Promise<string[]> {
  const c = new Client(o)
  const id = { name: 'ID', path: '', sha256: '', size: 0 }
  const idBytes = new TextEncoder().encode(`${p.id}\n`)
  const tmp = join(process.env['TMPDIR'] ?? '/tmp', `test-publish-${process.pid}-ID`)
  await Bun.write(tmp, idBytes)
  Object.assign(id, { path: tmp, sha256: new Bun.CryptoHasher('sha256').update(idBytes).digest('hex'), size: idBytes.length })
  const uploads: { path: string, uploadId: string, f: File }[] = []
  try {
    for (const f of p.files) {
      c.log(`test-publish: uploading ${f.name} (${f.size} bytes)`)
      uploads.push({ path: `${p.product}/${p.id}/${f.name}`, uploadId: await c.upload(f), f })
    }
    uploads.push({ path: `${p.product}/latest/ID`, uploadId: await c.upload(id), f: id })
  }
  finally { rmSync(tmp, { force: true }) }
  await c.must('POST', `/res/namespaces/${NAMESPACE}/batch`, {
    objects: uploads.map(u => ({ path: u.path, source: { uploadId: u.uploadId }, contentType: contentType(u.f.name) })),
    aliases: p.files.map(f => ({ path: `${p.product}/latest/${f.name}`, target: `${p.product}/${p.id}/${f.name}` })),
  })
  c.log(`test-publish: published ${uploads.length} objects and ${p.files.length} aliases in one batch`)

  // The listing: every object at its sha256 and size.
  const listed = await c.must('GET', `/res/namespaces/${NAMESPACE}/objects?prefix=${encodeURIComponent(`${p.product}/`)}&limit=5000`) as { path: string, sha256: string, size: number }[]
  for (const u of uploads) {
    const row = listed.find(r => r.path === u.path)
    if (row === undefined) die(`the listing of ${NAMESPACE}/${p.product}/ has no ${u.path}`)
    if (row.sha256 !== u.f.sha256 || row.size !== u.f.size) die(`${u.path} is listed as ${row.sha256} (${row.size} bytes), not ${u.f.sha256} (${u.f.size} bytes)`)
  }
  // The bytes, from the download host, which follows the catalog within about half a minute.
  const fetcher = o.fetch ?? fetch, sleep = o.sleep ?? (ms => Bun.sleep(ms)), tries = o.readBackTries ?? 10
  for (const u of uploads) {
    const url = `${DOWNLOAD}/${NAMESPACE}/${u.path}`
    let got = ''
    for (let t = 0; t < tries; t++) {
      if (t > 0) await sleep(10000)
      try {
        const r = await fetcher(url, { headers: { 'Cache-Control': 'no-cache' } })
        if (r.status !== 200) { got = `status ${r.status}`; await r.body?.cancel(); continue }
        const hash = new Bun.CryptoHasher('sha256')
        for await (const chunk of r.body!) hash.update(chunk)
        got = hash.digest('hex')
        if (got === u.f.sha256) break
      }
      catch (e) { got = (e as Error).message }
    }
    if (got !== u.f.sha256) die(`${url} reads back as ${got}, not ${u.f.sha256}`)
  }
  c.log(`test-publish: read back ${uploads.length} objects from the listing and the download host`)
  return urls(p)
}

export function tokenFrom(file = process.env['MICA_RES_TEST_TOKEN_FILE'] ?? '/srv/micaoss/.secrets/res-test-token'): string {
  if (!existsSync(file)) die(`${file} does not exist; it holds the res:publish token of mica-test`)
  const token = readFileSync(file, 'utf8').trim()
  if (token === '' || /\s/.test(token)) die(`${file} does not hold one token`)
  return token
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    console.error('usage: bin/test-publish <hand-over directory>')
    return 2
  }
  try {
    const p = await plan(argv[0]!)
    console.log(`test-publish: ${basename(resolve(argv[0]!))}: ${p.product} ${p.id}, ${p.files.length} files verified against SHA256SUMS`)
    for (const url of await publish(p, { token: tokenFrom() })) console.log(url)
    return 0
  }
  catch (e) {
    if (e instanceof TestPublishError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
