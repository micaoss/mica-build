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
// The port of tools/oci.sh (deleted 2026-09-22), message for message. The transport is the `curl` on PATH,
// as it was: tests/gates/pool-test.sh answers the registry with a curl of its own, and the reader that goes
// through fetch instead arrives with that gate's port to bun, where the registry is the test process.
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

/** curl -sS -o <out> -w '%{http_code}' <args...>: the status, or 000 when nothing answered. MICA_CURL names another
 * curl: tests/gates/pool-test.sh answers the registry with one of its own, under the tree, so it is seen on both
 * routes of bin/bun.sh. */
const CURL = process.env.MICA_CURL || 'curl'
function curl(args: string[], out: string): string {
  const r = Bun.spawnSync([CURL, '-sS', '-o', out, '-w', '%{http_code}', ...args], { stdout: 'pipe', stderr: 'inherit' })
  return r.exitCode === 0 ? r.stdout.toString().trim() : '000'
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
function get(repository: string, path: string, out: string, accept: string): void {
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
    const code = curl(['--max-time', '60', `https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io`], tokenFile)
    if (code !== '200') throw new OciError(`the token endpoint of ghcr.io answered ${code} for ${repository} (000: not reached)`)
    let token = ''
    try { const t = JSON.parse(readFileSync(tokenFile, 'utf8')) as { token?: string, access_token?: string }; token = t.token || t.access_token || '' }
    catch { token = '' }
    if (token === '') throw new OciError(`ghcr.io issued no pull token for ${repository}`)
    // A transport failure is retried at the same location; the bytes are checked against the digest either way.
    const status = curl(['-L', '--retry', '3', '--retry-all-errors', '--max-time', '1800', '-H', `Authorization: Bearer ${token}`, '-H', `Accept: ${accept}`, `https://ghcr.io/v2/${repository}/${path}`], out)
    if (status !== '200') throw new OciError(`reading ghcr.io/${repository} ${path} answered ${status} (000: not reached)`)
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

export function manifest(reference: string): string {
  const m = GHCR.exec(reference) ?? LOCAL.exec(reference)
  if (m === null) throw new OciError('usage: manifest <ghcr.io/<owner>/<name>|local/<repository>>[:<tag>]@sha256:<hex>')
  const repository = m[1]!, digest = m[3]!
  const out = join(CACHE, `${digest}.json`)
  if (!existsSync(out) || `sha256:${sha256(readFileSync(out))}` !== digest) {
    mkdirSync(CACHE, { recursive: true })
    get(repository, `manifests/${digest}`, `${out}.part`, 'application/vnd.oci.image.manifest.v1+json')
    if (`sha256:${sha256(readFileSync(`${out}.part`))}` !== digest) { rmSync(`${out}.part`, { force: true }); throw new OciError(`${repository} served a manifest for ${digest} with other bytes`) }
    renameSync(`${out}.part`, out)
  }
  return out
}

export function blob(repository: string, digest: string, out: string): void {
  if (!/^[0-9a-f]{64}$/.test(digest) || !(/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository) || /^local\/[a-z0-9-]+$/.test(repository)))
    throw new OciError('usage: blob <ghcr.io/<owner>/<name>|local/<repository>> <sha256> <out>')

  const name = repository.startsWith('ghcr.io/') ? repository.slice('ghcr.io/'.length) : repository
  get(name, `blobs/sha256:${digest}`, `${out}.part`, 'application/octet-stream')
  if (sha256(readFileSync(`${out}.part`)) !== digest) { rmSync(`${out}.part`, { force: true }); throw new OciError(`${repository} served a blob for sha256:${digest} with other bytes`) }
  renameSync(`${out}.part`, out)
}

export function main(argv: string[]): number {
  try {
    if (argv[0] === 'manifest' && argv.length === 2) console.log(manifest(argv[1]!))
    else if (argv[0] === 'blob' && argv.length === 4) blob(argv[1]!, argv[2]!, argv[3]!)
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

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
