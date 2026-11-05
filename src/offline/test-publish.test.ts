import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API, DOWNLOAD, imageId, latest, NAMESPACE, plan, publish, SITE, stableName, type Plan } from './test-publish.ts'

const work = mkdtempSync(join(tmpdir(), 'test-publish-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex')
const known = (p: string) => p === 'cx3576.full'

/** A hand-over directory: its files and a SHA256SUMS over them. */
function handover(name: string, files: Record<string, string>, sums = files): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body)
  writeFileSync(join(dir, 'SHA256SUMS'), Object.entries(sums).map(([f, body]) => `${sha(body)}  ${f}\n`).join(''))
  return dir
}

const IMG = 'mica-cx3576.full-0.0.1+git38cd20ceaf6e-1'
const files = { [`${IMG}.img`]: 'raw image', [`${IMG}.img.gz`]: 'the compressed image, ten parts or so', 'MiniLoaderAll.bin': 'loader', 'verify.log': 'RESULT: PASS\n' }

type Upload = { id: string, sha256: string, size: number, partSize: number, parts: number, nextPart: number, chunks: Uint8Array[], completed: boolean, aborted: boolean }

/** res's multipart API, the batch, the listing and the download host, in memory. `fault` decides per request. */
class FakeRes {
  uploads: Upload[] = []
  objects = new Map<string, { sha256: string, size: number, bytes: Uint8Array }>()
  aliases = new Map<string, string>()
  batches: { objects: { path: string, source: { uploadId: string } }[], aliases: { path: string, target: string }[] }[] = []
  log: string[] = []
  fault: (what: string, u?: Upload) => 'network-after' | 'part-failed' | 'server-error' | 'sha-mismatch' | 'corrupt' | 'stale' | undefined = () => undefined

  status(u: Upload) {
    return { id: u.id, sha256: u.sha256, size: u.size, partSize: u.partSize, parts: u.parts, nextPart: u.nextPart, received: 0, completed: u.completed, expiresAt: 'later' }
  }

  ok(data: unknown, status = 200) { return new Response(JSON.stringify({ success: true, data }), { status }) }
  err(status: number, code: string) { return new Response(JSON.stringify({ success: false, error: { code, message: code } }), { status }) }

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    if (url.origin === new URL(SITE).origin && !url.pathname.startsWith(new URL(API).pathname)) {
      const target = this.aliases.get(url.pathname.slice(`/${NAMESPACE}/`.length))
      if (target === undefined) return new Response('', { status: 404 })
      return new Response(null, { status: 302, headers: { location: `${DOWNLOAD}/${NAMESPACE}/${this.fault('alias') === 'stale' ? 'x/gitold/f' : target}` } })
    }
    if (url.origin === new URL(DOWNLOAD).origin) {
      const o = this.objects.get(url.pathname.slice(`/${NAMESPACE}/`.length))
      if (o === undefined) return new Response('', { status: 404 })
      return new Response(this.fault('download') === 'corrupt' ? new TextEncoder().encode('other bytes') : o.bytes)
    }
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
    const path = url.pathname.slice(new URL(API).pathname.length)
    this.log.push(`${method} ${path}`)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined
    let m: RegExpExecArray | null
    if (method === 'POST' && path === `/res/namespaces/${NAMESPACE}/uploads/multipart`) {
      const size = body!['size'] as number, partSize = body!['partSize'] as number
      const u: Upload = { id: `u${this.uploads.length + 1}`, sha256: body!['sha256'] as string, size, partSize, parts: Math.ceil(size / partSize), nextPart: 1, chunks: [], completed: false, aborted: false }
      this.uploads.push(u)
      return this.ok(this.status(u), 201)
    }
    const u = this.uploads.find(x => x.id === /^\/res\/uploads\/([^/]+)/.exec(path)?.[1])
    if ((m = /^\/res\/uploads\/[^/]+\/parts\/(\d+)$/.exec(path)) !== null && method === 'PUT') {
      const n = Number(m[1]), bytes = init!.body as Uint8Array
      if (n !== u!.nextPart) return this.err(409, 'PART_OUT_OF_ORDER')
      const f = this.fault(`part ${n}`, u)
      if (f === 'part-failed') return this.err(409, 'PART_FAILED')
      if (f === 'server-error') return this.err(500, 'INTERNAL')
      expect(bytes.length).toBe(n < u!.parts ? u!.partSize : u!.size - u!.partSize * (u!.parts - 1))
      u!.chunks.push(bytes)
      u!.nextPart++
      if (f === 'network-after') throw new Error('connection reset')
      return this.ok(this.status(u!))
    }
    if (method === 'GET' && /^\/res\/uploads\/[^/]+$/.test(path)) return this.ok(this.status(u!))
    if (method === 'POST' && path.endsWith('/abort')) { u!.aborted = true; return this.ok({}) }
    if (method === 'POST' && path.endsWith('/complete')) {
      if (u!.nextPart <= u!.parts) return this.err(409, 'UPLOAD_INCOMPLETE')
      const joined = Buffer.concat(u!.chunks)
      if (this.fault('complete', u) === 'sha-mismatch' || sha(joined) !== u!.sha256) return this.err(409, 'SHA256_MISMATCH')
      u!.completed = true
      return this.ok(this.status(u!))
    }
    if (method === 'POST' && path === `/res/namespaces/${NAMESPACE}/batch`) {
      const b = body as unknown as FakeRes['batches'][number]
      this.batches.push(b)
      for (const o of b.objects) {
        const up = this.uploads.find(x => x.id === o.source.uploadId)!
        expect(up.completed).toBe(true)
        const bytes = new Uint8Array(Buffer.concat(up.chunks))
        this.objects.set(o.path, { sha256: up.sha256, size: up.size, bytes })
      }
      for (const a of b.aliases) this.aliases.set(a.path, a.target)
      return this.ok({ objects: [], catalog: 'published' })
    }
    if (method === 'GET' && path === `/res/namespaces/${NAMESPACE}/objects`) {
      const prefix = url.searchParams.get('prefix') ?? ''
      return this.ok([...this.objects].filter(([p]) => p.startsWith(prefix)).map(([p, o]) => ({ path: p, sha256: o.sha256, size: o.size })))
    }
    return this.err(404, 'NOT_FOUND')
  }) as typeof fetch
}

const run = (res: FakeRes, p: Plan, lines: string[] = []) =>
  publish(p, { token: 'tok', fetch: res.fetch, sleep: async () => {}, log: l => lines.push(l), partSize: 8, readBackTries: 2 })

describe('the plan', () => {
  test('the product and git id out of an image name, a kind suffix allowed', () => {
    expect(imageId(`${IMG}.img.gz`)).toEqual({ product: 'cx3576.full', id: 'git38cd20ceaf6e', kind: '' })
    expect(imageId('mica-s905x5m.sd-full-0.0.1+gitc2f8e64d55d8-1.sd-boot.img.gz')).toEqual({ product: 's905x5m.sd-full', id: 'gitc2f8e64d55d8', kind: '.sd-boot' })
    expect(imageId('mica-qemu-armhf.basic-0.0.1+git0a1b-1.img.gz')).toEqual({ product: 'qemu-armhf.basic', id: 'git0a1b', kind: '' })
    expect(imageId(`${IMG}.img`)).toBeUndefined()
  })

  test('latest/ names drop the version and id: the images by product and kind, the small files by their own names', () => {
    expect(stableName(`${IMG}.img.gz`)).toBe('mica-cx3576.full.img.gz')
    expect(stableName('mica-s905x5m.sd-full-0.0.1+gitc2f8e64d55d8-1.sd-boot.img.gz')).toBe('mica-s905x5m.sd-full.sd-boot.img.gz')
    expect(stableName('loader.bin')).toBe('loader.bin')
  })

  test('every listed file but the raw image, and SHA256SUMS itself, each verified', async () => {
    const p = await plan(handover('ok', files), known)
    expect([p.product, p.id]).toEqual(['cx3576.full', 'git38cd20ceaf6e'])
    expect(p.files.map(f => f.name)).toEqual([`${IMG}.img.gz`, 'MiniLoaderAll.bin', 'verify.log', 'SHA256SUMS'])
  })

  test('refused before any request: a file that differs from SHA256SUMS, a missing one, an unknown product, two builds', async () => {
    await expect(plan(handover('tampered', { ...files, 'verify.log': 'changed' }, files), known)).rejects.toThrow('verify.log is')
    const { 'verify.log': _gone, ...without } = files
    await expect(plan(handover('missing', without, files), known)).rejects.toThrow('does not exist')
    await expect(plan(handover('unknown', files), () => false)).rejects.toThrow('is no product of this tree')
    await expect(plan(handover('two', { ...files, 'mica-cx3576.full-0.0.1+git111111-1.img.gz': 'other' }), known)).rejects.toThrow('more than one build')
  })
})

describe('the publication', () => {
  test('parts in order, one batch of the files, latest/ID and the latest aliases, read back', async () => {
    const res = new FakeRes(), p = await plan(handover('pub', files), known)
    const urls = await run(res, p)
    const gz = res.uploads[0]!
    expect(gz.parts).toBe(Math.ceil(files[`${IMG}.img.gz`].length / 8))
    expect(res.log.filter(l => l.startsWith(`PUT /res/uploads/${gz.id}/`))).toEqual([...Array(gz.parts).keys()].map(i => `PUT /res/uploads/${gz.id}/parts/${i + 1}`))
    expect(res.batches).toHaveLength(1)
    expect(res.batches[0]!.objects.map(o => o.path)).toEqual([
      `cx3576.full/git38cd20ceaf6e/${IMG}.img.gz`, 'cx3576.full/git38cd20ceaf6e/MiniLoaderAll.bin', 'cx3576.full/git38cd20ceaf6e/verify.log',
      'cx3576.full/git38cd20ceaf6e/SHA256SUMS', 'cx3576.full/latest/SHA256SUMS', 'cx3576.full/latest/ID'])
    expect(res.batches[0]!.aliases).toEqual([
      { path: 'cx3576.full/latest/mica-cx3576.full.img.gz', target: `cx3576.full/git38cd20ceaf6e/${IMG}.img.gz` },
      { path: 'cx3576.full/latest/MiniLoaderAll.bin', target: 'cx3576.full/git38cd20ceaf6e/MiniLoaderAll.bin' },
      { path: 'cx3576.full/latest/verify.log', target: 'cx3576.full/git38cd20ceaf6e/verify.log' },
    ])
    expect(new TextDecoder().decode(res.objects.get('cx3576.full/latest/ID')!.bytes)).toBe('git38cd20ceaf6e\n')
    // latest/SHA256SUMS: the stable names, each at the bytes its alias reaches.
    expect(new TextDecoder().decode(res.objects.get('cx3576.full/latest/SHA256SUMS')!.bytes)).toBe(
      `${sha(files[`${IMG}.img.gz`])}  mica-cx3576.full.img.gz\n${sha('loader')}  MiniLoaderAll.bin\n${sha('RESULT: PASS\n')}  verify.log\n`)
    expect(latest(p).sums).toBe(new TextDecoder().decode(res.objects.get('cx3576.full/latest/SHA256SUMS')!.bytes))
    expect(Buffer.from(res.objects.get(`cx3576.full/git38cd20ceaf6e/${IMG}.img.gz`)!.bytes).toString()).toBe(files[`${IMG}.img.gz`])
    expect(urls).toContain(`${DOWNLOAD}/test/cx3576.full/git38cd20ceaf6e/${IMG}.img.gz`)
    expect(urls).toContain(`${SITE}/test/cx3576.full/latest/mica-cx3576.full.img.gz`)
    expect(urls).toContain(`${DOWNLOAD}/test/cx3576.full/latest/SHA256SUMS`)
  })

  test('resumed: a part whose answer was lost goes on from the status, a part res failed is sent again', async () => {
    const res = new FakeRes(), p = await plan(handover('resume', files), known), lines: string[] = []
    const seen = new Set<string>()
    res.fault = (what, u) => {
      const key = `${u?.id} ${what}`
      if (seen.has(key)) return undefined
      seen.add(key)
      return u?.id === 'u1' && what === 'part 2' ? 'network-after' : u?.id === 'u1' && what === 'part 3' ? 'part-failed' : undefined
    }
    await run(res, p, lines)
    expect(Buffer.from(res.objects.get(`cx3576.full/git38cd20ceaf6e/${IMG}.img.gz`)!.bytes).toString()).toBe(files[`${IMG}.img.gz`])
    expect(res.log).toContain('GET /res/uploads/u1')
    expect(res.log.filter(l => l === 'PUT /res/uploads/u1/parts/2')).toHaveLength(1)
    expect(res.log.filter(l => l === 'PUT /res/uploads/u1/parts/3')).toHaveLength(2)
    expect(lines.filter(l => l.includes('resuming'))).toHaveLength(2)
  })

  test('started over when res finds the whole file differs, the first upload aborted', async () => {
    const res = new FakeRes(), p = await plan(handover('mismatch', files), known)
    let once = false
    res.fault = (what, u) => (what === 'complete' && u?.id === 'u1' && !once ? ((once = true), 'sha-mismatch') : undefined)
    await run(res, p)
    expect(res.uploads[0]!.aborted).toBe(true)
    expect(res.uploads[1]!.completed).toBe(true)
    expect(res.batches[0]!.objects[0]!.source.uploadId).toBe('u2')
  })

  test('aborted, and nothing published, when a part keeps failing', async () => {
    const res = new FakeRes(), p = await plan(handover('fail', files), known)
    res.fault = what => (what === 'part 2' ? 'server-error' : undefined)
    await expect(run(res, p)).rejects.toThrow('part 2 of')
    expect(res.uploads[0]!.aborted).toBe(true)
    expect(res.batches).toHaveLength(0)
  })

  test('refused when a latest alias does not redirect to the id\'s file', async () => {
    const res = new FakeRes(), p = await plan(handover('alias', files), known)
    res.fault = what => (what === 'alias' ? 'stale' : undefined)
    await expect(run(res, p)).rejects.toThrow('not a redirect to /test/cx3576.full/git38cd20ceaf6e/')
  })

  test('refused when the download host does not serve the bytes', async () => {
    const res = new FakeRes(), p = await plan(handover('readback', files), known)
    res.fault = what => (what === 'download' ? 'corrupt' : undefined)
    await expect(run(res, p)).rejects.toThrow('reads back as')
  })
})
