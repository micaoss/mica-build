// Reads by digest only: anonymous from ghcr.io, or from an offline build's OCI layout.
//
//   bun src/cli.ts oci manifest <ghcr.io/<owner>/<name>|local/<repository>>[:<tag>]@sha256:<hex>
//       the image manifest, hashed to its digest and kept under _out/cache/oci/<digest>.json; prints its path
//   bun src/cli.ts oci blob <ghcr.io/<owner>/<name>|local/<repository>> <sha256> <out>
//       one blob into <out>, hashed to its digest
//
// A local/<repository> reference (an offline lock, mica:docs/design/release-lock.md section 6) resolves only
// inside <CHECKOUT>/_out/offline/oci/ of that repository's offline pin, and is refused under CI.
//
// A MANIFEST DIGEST IS NOT A CONTENT IDENTITY. It covers the annotations too, and those carry the release, the
// source commit and the build time, so the same bytes published twice have two digests. Anything asking "did
// this component change" compares LAYER digests out of the manifest this prints, never the reference it was
// fetched by.
//
// The tag of a reference is informational; the digest is what is read. A refused token, a status other than
// 200 or bytes other than the digest stop the read, with no fallback. MICA_OCI_CACHE overrides _out/cache/oci.
// The port of tools/oci.sh (deleted 2026-09-22), message for message. The transport is fetch; the registry is
// https://ghcr.io, or the one MICA_OCI_REGISTRY names (tests/gates/pool.test.ts answers as ghcr.io itself).
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inputs, mode } from '../locks/locks.ts'

export class OciError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, '../..')
const CACHE = process.env.MICA_OCI_CACHE || join(REPO_ROOT, '_out/cache/oci')
const GHCR = /^ghcr\.io\/([a-z0-9-]+\/[a-z0-9._-]+)(:[A-Za-z0-9._-]+)?@(sha256:[0-9a-f]{64})$/
const LOCAL = /^(local\/[a-z0-9-]+)(:[A-Za-z0-9._-]+)?@(sha256:[0-9a-f]{64})$/

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

const REGISTRY = process.env.MICA_OCI_REGISTRY || 'https://ghcr.io'

/** GET <url> into <out>: the status as curl printed it, 000 when nothing answered. A transport failure or a
 * server error is retried at the same location; the bytes are checked against the digest either way. */
async function get(url: string, headers: Record<string, string>, out: string, timeout: number, retries: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    let response: Response
    try { response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' }) }
    catch (e) {
      if (attempt < retries) { await Bun.sleep(1000 * (attempt + 1)); continue }
      console.error(`oci: ${url}: ${e instanceof Error ? e.message : String(e)}`)
      return '000'
    }
    if (response.status >= 500 && attempt < retries) { await response.arrayBuffer().catch(() => undefined); await Bun.sleep(1000 * (attempt + 1)); continue }
    await Bun.write(out, response)
    return String(response.status)
  }
}

/** The offline checkout an offline pin names for a repository, or a refusal. */
function offlineCheckout(repository: string): string {
  const records = inputs()
  const checkouts = [...new Set(Object.entries(records).filter(([n]) => n.split('.')[0] === repository).map(([, [v]]) => v.CHECKOUT ?? ''))].sort()
  if (checkouts.length !== 1) throw new OciError(`locks/ names no offline checkout of ${repository} (${repository} has no one offline pin CHECKOUT in locks/ (found ${checkouts.length}))`)
  if (checkouts[0] === '') throw new OciError(`locks/pins/${repository}.pin is not an offline pin, so local/${repository} names nothing`)
  return checkouts[0]!
}

/** GET <path> of a repository: a local layout's blob by digest, or ghcr.io through its anonymous pull token. */
async function read(repository: string, path: string, out: string, accept: string): Promise<void> {
  if (repository.startsWith('local/')) {
    if (mode() === 'ci') throw new OciError(`${repository} is an offline build; CI reads published releases only`)
    const checkout = offlineCheckout(repository.slice('local/'.length))
    const digest = path.slice(path.lastIndexOf('sha256:') + 'sha256:'.length)
    const blob = join(checkout, '_out/offline/oci/blobs/sha256', digest)
    if (!existsSync(blob)) throw new OciError(`${checkout}/_out/offline/oci holds no blob ${path.slice(path.lastIndexOf('/') + 1)}`)
    copyFileSync(blob, out)
    return
  }
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.oci.'))
  try {
    const tokenFile = join(work, 'token.json')
    const code = await get(`${REGISTRY}/token?scope=repository:${repository}:pull&service=ghcr.io`, {}, tokenFile, 60000, 0)
    if (code !== '200') throw new OciError(`the token endpoint of ghcr.io answered ${code} for ${repository} (000: not reached)`)
    let token = ''
    try { const t = JSON.parse(readFileSync(tokenFile, 'utf8')) as { token?: string, access_token?: string }; token = t.token || t.access_token || '' }
    catch { token = '' }
    if (token === '') throw new OciError(`ghcr.io issued no pull token for ${repository}`)
    const status = await get(`${REGISTRY}/v2/${repository}/${path}`, { Authorization: `Bearer ${token}`, Accept: accept }, out, 1800000, 3)
    if (status !== '200') throw new OciError(`reading ghcr.io/${repository} ${path} answered ${status} (000: not reached)`)
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

export async function manifest(reference: string): Promise<string> {
  const m = GHCR.exec(reference) ?? LOCAL.exec(reference)
  if (m === null) throw new OciError('usage: manifest <ghcr.io/<owner>/<name>|local/<repository>>[:<tag>]@sha256:<hex>')
  const repository = m[1]!, digest = m[3]!
  const out = join(CACHE, `${digest}.json`)
  if (!existsSync(out) || `sha256:${sha256(readFileSync(out))}` !== digest) {
    mkdirSync(CACHE, { recursive: true })
    await read(repository, `manifests/${digest}`, `${out}.part`, 'application/vnd.oci.image.manifest.v1+json')
    if (`sha256:${sha256(readFileSync(`${out}.part`))}` !== digest) { rmSync(`${out}.part`, { force: true }); throw new OciError(`${repository} served a manifest for ${digest} with other bytes`) }
    renameSync(`${out}.part`, out)
  }
  return out
}

export async function blob(repository: string, digest: string, out: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(digest) || !(/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository) || /^local\/[a-z0-9-]+$/.test(repository)))
    throw new OciError('usage: blob <ghcr.io/<owner>/<name>|local/<repository>> <sha256> <out>')

  const name = repository.startsWith('ghcr.io/') ? repository.slice('ghcr.io/'.length) : repository
  await read(name, `blobs/sha256:${digest}`, `${out}.part`, 'application/octet-stream')
  if (sha256(readFileSync(`${out}.part`)) !== digest) { rmSync(`${out}.part`, { force: true }); throw new OciError(`${repository} served a blob for sha256:${digest} with other bytes`) }
  renameSync(`${out}.part`, out)
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'manifest' && argv.length === 2) console.log(await manifest(argv[1]!))
    else if (argv[0] === 'blob' && argv.length === 4) await blob(argv[1]!, argv[2]!, argv[3]!)
    else if (argv[0] === 'manifest') throw new OciError('usage: manifest <ghcr.io/<owner>/<name>|local/<repository>>[:<tag>]@sha256:<hex>')
    else if (argv[0] === 'blob') throw new OciError('usage: blob <ghcr.io/<owner>/<name>|local/<repository>> <sha256> <out>')
    else throw new OciError('usage: oci manifest <reference@digest> | blob <repository> <sha256> <out>')
    return 0
  }
  catch (e) {
    if (e instanceof OciError) { console.error(`oci: error: ${e.message}`); return 1 }
    if (e instanceof Error && (e.constructor.name === 'Exit' || e.constructor.name === 'Refused')) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
