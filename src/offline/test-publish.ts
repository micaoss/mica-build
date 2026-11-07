// A hand-over published to res's test channel, without a release: images and their small files, for testers.
//
//   bin/test-publish <hand-over directory>      (bin/local-build.sh <product> --publish-test, after staging)
//
//   reads   the hand-over: SHA256SUMS and every file it lists but the raw .img (testers check with
//           `sha256sum -c --ignore-missing`), each verified against it first; the token of a res:publish user
//           granted the namespace test, from MICA_RES_TEST_TOKEN_FILE (default /srv/micaoss/.secrets/res-test-token), sent
//           as a header and never printed
//   writes  test/<product>/<id>/<file> in one batch, <id> the hand-over's git id out of the image's name
//           (gitc4c1117d592f), with test/<product>/latest/, a stable link: aliases under names without version
//           or id (mica-<product>[.<kind>].img.gz, the small files under their own names) -> the id's files, the
//           object latest/SHA256SUMS over those names and the object latest/ID holding the id; then reads them
//           back: the namespace's listing (sha256, size) and every object downloaded from the download host
//   and     when the hand-over carries its full update archive (<name>.micaupd), the update source a device fetches
//           from instead of the archive itself: test/<product>/<id>/v1/manifest.json (mica/catalog/v1), the release
//           document and signed descriptor under releases/<deployment id>/, and every object of the archive at
//           objects/<sha256> with its transfer index (src/release/chunks.ts), whose chunks the download host serves
//           at chunks/<digest> (mica-core:crates/mica-deploy/src/catalog.rs; `mica-deploy fetch --source
//           https://dl.res.micaos.dev/test/<product>/<id>/`); one chunk is read back
//
// Every file goes up as a multipart upload (mica-res:docs/modules/resource.md, Multipart uploads): parts strictly
// in order, a failed or interrupted part resumed from the upload's status, the upload started over when res finds
// the whole file's sha256 differs or the upload expired, and aborted when it cannot finish.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { canonicalJson, componentId } from '../image/components.ts'
import { products } from '../product/product.ts'
import { archiveObjects, transfer } from '../release/chunks.ts'

export class TestPublishError extends Error {}

function die(message: string): never {
  throw new TestPublishError(`test-publish: error: ${message}`)
}

export const NAMESPACE = 'test'
export const API = 'https://res.micaos.dev/admin/api'
export const SITE = 'https://res.micaos.dev'
export const DOWNLOAD = 'https://dl.res.micaos.dev'
const MiB = 1024 * 1024

export type File = { name: string, path: string, sha256: string, size: number }
export type Plan = { product: string, id: string, files: File[], update?: File }

/** The sha256 of a file, read as a stream. */
export async function sha256File(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest('hex')
}

/** The product, git id and image kind of a hand-over image's name: mica-<product>-<version>+<id>-<revision>[.<kind>].img.gz. */
export function imageId(name: string): { product: string, id: string, kind: string } | undefined {
  const m = /^mica-([a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*?)-[0-9][^+/]*\+(git[0-9a-f]+)-[0-9]+(\.[a-z0-9-]+)?\.img\.gz$/.exec(name)
  return m === null ? undefined : { product: m[1]!, id: m[2]!, kind: m[3] ?? '' }
}

/** A file's name under latest/, which no build changes: an image's without version and id, any other file's own. */
export function stableName(name: string): string {
  const i = imageId(name)
  return i === undefined ? name : `mica-${i.product}${i.kind}.img.gz`
}

/** latest/: an alias per file but SHA256SUMS, under its stable name, and the SHA256SUMS over those names. */
export function latest(p: Plan): { aliases: { name: string, target: string }[], sums: string } {
  const files = p.files.filter(f => f.name !== 'SHA256SUMS'), names = files.map(f => stableName(f.name))
  const twice = names.filter((n, i) => names.indexOf(n) !== i)
  if (twice.length > 0) die(`two files of the hand-over have the stable name ${twice[0]}`)
  return {
    aliases: files.map((f, i) => ({ name: names[i]!, target: `${p.product}/${p.id}/${f.name}` })),
    sums: files.map((f, i) => `${f.sha256}  ${names[i]}\n`).join(''),
  }
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
  const files: File[] = [], archives: File[] = []
  for (const f of listed.filter(f => !f.name.endsWith('.img'))) {
    const path = join(dir, f.name)
    if (!existsSync(path)) die(`${path}, listed in SHA256SUMS, does not exist`)
    const actual = await sha256File(path)
    if (actual !== f.sha256) die(`${path} is ${actual}, SHA256SUMS says ${f.sha256}`)
    ;(f.name.endsWith('.micaupd') ? archives : files).push({ name: f.name, path, sha256: actual, size: Bun.file(path).size })
  }
  if (archives.length > 1) die(`${sums} lists more than one update archive: ${archives.map(a => a.name).join(', ')}`)
  files.push({ name: 'SHA256SUMS', path: sums, sha256: await sha256File(sums), size: Bun.file(sums).size })
  return archives.length === 0 ? { product, id, files } : { product, id, files, update: archives[0]! }
}

export function contentType(name: string): string {
  if (/(^|\/)[0-9a-f]{64}(\.index)?$/.test(name)) return 'application/octet-stream'
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

/** The update source of a full update archive, as a device reads it at `baseUrl`: the manifest with the archive's
 * product line, its release document listing every object of the archive (the core set's included), the signed
 * descriptor, the objects and their transfer indexes. Paths relative to `baseUrl`. */
export function updateTree(archive: Uint8Array, baseUrl: string): { name: string, bytes: Uint8Array }[] {
  const a = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  if (a.subarray(0, 8).toString() !== 'MICAUPD1' || a.length < 12 + a.readUInt32BE(8)) die('the update archive is not MICAUPD1, or its descriptor is cut short')
  const envelope = a.subarray(12, 12 + a.readUInt32BE(8))
  const d = JSON.parse(Buffer.from((JSON.parse(envelope.toString()) as { payload: string }).payload, 'base64').toString()) as { product: string, board: string, generation: number }
  const id = componentId(d), objects = archiveObjects(archive), dir = `releases/${id}`
  const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
  const release = { schema: 'mica/release/v1', baseUrl, id, product: d.product, board: d.board, generation: d.generation, notes: '',
    deployment: { path: `${dir}/deployment.json`, sha256: sha(envelope), bytes: envelope.length },
    objects: objects.map(o => ({ sha256: o.sha256, bytes: o.bytes.length, path: `objects/${o.sha256}` })) }
  const manifest = { schema: 'mica/catalog/v1', revision: 1, baseUrl, sets: [],
    products: [{ product: d.product, board: d.board, latest: { id, generation: d.generation, notes: '', path: `${dir}/index.json` } }] }
  const text = (v: unknown) => new TextEncoder().encode(canonicalJson(v))
  return [...objects.map(o => ({ name: `objects/${o.sha256}`, bytes: o.bytes })), ...transfer(objects).indexes.map(i => ({ name: i.path, bytes: new Uint8Array(i.bytes) })),
    { name: `${dir}/deployment.json`, bytes: new Uint8Array(envelope) }, { name: `${dir}/index.json`, bytes: text(release) }, { name: 'v1/manifest.json', bytes: text(manifest) }]
}

/** The URLs a tester uses. */
export function urls(p: Plan): string[] {
  const base = `${NAMESPACE}/${p.product}`
  return [`${SITE}/${base}/`, ...p.files.map(f => `${DOWNLOAD}/${base}/${p.id}/${f.name}`), ...(p.update === undefined ? [] : [`${DOWNLOAD}/${base}/${p.id}/ (update source)`]),
    ...latest(p).aliases.map(a => `${SITE}/${base}/latest/${a.name}`), `${DOWNLOAD}/${base}/latest/SHA256SUMS`, `${DOWNLOAD}/${base}/latest/ID`]
}

/** Upload, publish in one batch, read back. */
export async function publish(p: Plan, o: Options): Promise<string[]> {
  const c = new Client(o), l = latest(p)
  // latest/SHA256SUMS and latest/ID are made here, not taken from the hand-over.
  const tmp = mkdtempSync(join(tmpdir(), 'test-publish-'))
  const generated = (name: string, text: string): File => {
    const path = join(tmp, name), bytes = new TextEncoder().encode(text)
    writeFileSync(path, bytes)
    return { name, path, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'), size: bytes.length }
  }
  const uploads: { path: string, uploadId: string, f: File }[] = []
  const tree = p.update === undefined ? [] : updateTree(new Uint8Array(readFileSync(p.update.path)), `${DOWNLOAD}/${NAMESPACE}/${p.product}/${p.id}/`)
  try {
    for (const f of p.files) {
      c.log(`test-publish: uploading ${f.name} (${f.size} bytes)`)
      uploads.push({ path: `${p.product}/${p.id}/${f.name}`, uploadId: await c.upload(f), f })
    }
    for (const f of [generated('SHA256SUMS', l.sums), generated('ID', `${p.id}\n`)])
      uploads.push({ path: `${p.product}/latest/${f.name}`, uploadId: await c.upload(f), f })
    if (p.update !== undefined) c.log(`test-publish: the update source of ${p.update.name}: ${tree.length} files`)
    for (const t of tree) {
      const file = { name: t.name, path: join(tmp, t.name.replace(/\//g, '_')), sha256: new Bun.CryptoHasher('sha256').update(t.bytes).digest('hex'), size: t.bytes.length }
      writeFileSync(file.path, t.bytes)
      uploads.push({ path: `${p.product}/${p.id}/${t.name}`, uploadId: await c.upload(file), f: file })
    }
  }
  finally { rmSync(tmp, { recursive: true, force: true }) }
  await c.must('POST', `/res/namespaces/${NAMESPACE}/batch`, {
    objects: uploads.map(u => ({ path: u.path, source: { uploadId: u.uploadId }, contentType: contentType(u.f.name) })),
    aliases: l.aliases.map(a => ({ path: `${p.product}/latest/${a.name}`, target: a.target })),
  })
  c.log(`test-publish: published ${uploads.length} objects and ${l.aliases.length} aliases in one batch`)

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
  // A chunk, which the download host cuts out of its object by the published index: the first of the largest object.
  if (tree.length > 0) {
    const largest = tree.filter(t => /^objects\/[0-9a-f]{64}$/.test(t.name)).reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a))
    const chunk = Buffer.from(tree.find(t => t.name === `${largest.name}.index`)!.bytes.subarray(84, 148)).toString()
    const url = `${DOWNLOAD}/${NAMESPACE}/${p.product}/${p.id}/chunks/${chunk}`
    let got = ''
    for (let t = 0; t < tries && got !== chunk; t++) {
      if (t > 0) await sleep(10000)
      try {
        const r = await fetcher(url, { headers: { 'Cache-Control': 'no-cache' } })
        got = r.status === 200 ? new Bun.CryptoHasher('sha256').update(new Uint8Array(await r.arrayBuffer())).digest('hex') : `status ${r.status}`
      }
      catch (e) { got = (e as Error).message }
    }
    if (got !== chunk) die(`${url} reads back as ${got}, not the chunk ${chunk} of ${largest.name}`)
  }
  // The aliases, as the res host answers them: a redirect to the id's file.
  for (const a of l.aliases) {
    const url = `${SITE}/${NAMESPACE}/${p.product}/latest/${a.name}`, want = `/${NAMESPACE}/${a.target}`
    let got = '', ok = false
    for (let t = 0; t < tries && !ok; t++) {
      if (t > 0) await sleep(10000)
      try {
        const r = await fetcher(url, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } })
        await r.body?.cancel()
        const location = r.headers.get('location') ?? ''
        got = `${r.status} ${location}`
        ok = r.status >= 300 && r.status < 400 && decodeURIComponent(new URL(location, url).pathname) === want
      }
      catch (e) { got = (e as Error).message }
    }
    if (!ok) die(`${url} answers ${got}, not a redirect to ${want}`)
  }
  c.log(`test-publish: read back ${uploads.length} objects from the listing and the download host, and ${l.aliases.length} latest aliases`)
  return urls(p)
}

export function tokenFrom(file = process.env['MICA_RES_TEST_TOKEN_FILE'] ?? '/srv/micaoss/.secrets/res-test-token'): string {
  if (!existsSync(file)) die(`${file} does not exist; it holds the res:publish token of the namespace test`)
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
