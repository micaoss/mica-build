// Shared by src/pool/publish.ts and src/pool/version-guard.ts: the registry declaration, the token, the release
// this checkout is, the latest published lock carrying a row, the lock rows directory, and an OCI registry
// client -- what the publishers need of the Distribution API: manifests and blobs read and pushed with
// fetch, nothing else on the host.
//
// Every artifact is a manifest of layers in the package of the repository that publishes it
// (tools/deb/registry.env: MICA_REGISTRY=<host>/<owner>), pushed only by that repository's CI with its own
// token. What the artifact is sits in the tag -- <kind>[.<name>]*.<release>, where <release> is the UTC
// release YYYYMMDD-HHMM: pool.<board>.<arch>.<release>, kernel.<board>.<release> -- and its manifest's
// artifactType is application/vnd.mica.<kind>. Names are [a-z0-9-], so the '.' separator is unambiguous. A
// tag is never re-pointed; a pin names the digest, and a blob is content-addressed.
//
// Authentication is the token challenge of the Distribution API: a 401 with WWW-Authenticate names the
// realm, the scope is asked for with the basic credentials (MICA_REGISTRY_USER, the token), once per
// request; a refused token is the token endpoint's status (401/403), never a transport 000. A registry that
// never challenges (the test registry) is talked to as it is. The token is never printed.
//
// The port of the publishers' half of tools/deb/registry.sh and tools/deb/oci.sh, message for message; the
// shell files stay until tools/reuse.sh and tools/publish-components.sh, which source them, are ported.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv, REPO_ROOT } from './producers.ts'

export class RegistryError extends Error {}

export const OCI_EMPTY_CONFIG_DIGEST = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
export const OCI_MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json'

/** Where the publishers leave the rows of the release lock: <dir>/pool.tsv (arch, tag, digest), <dir>/package.tsv
 * (name, arch, version, sha256), <dir>/board.tsv (board, arch, tag, digest). */
export const LOCK_ROWS = process.env.MICA_LOCK_ROWS || join(REPO_ROOT, '_out/release/rows')

export type Registry = { host: string, base: string, url: string, user: string, tokenVar: string, sourceUrl: string }

function run(argv: string[]): { code: number, out: string } {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  return { code: r.exitCode, out: r.stdout.toString() }
}

/** tools/deb/registry.env (MICA_REGISTRY_ENV overrides), checked to be plain KEY=value. */
export function registryLoad(): Registry {
  const path = process.env.MICA_REGISTRY_ENV || join(REPO_ROOT, 'tools/deb/registry.env')
  if (!existsSync(path)) throw new RegistryError(`error: ${path} does not exist; it declares where artifacts are published`)
  let env: Record<string, string>
  try { env = readEnv(path, {}, path) }
  catch (e) { throw new RegistryError(e instanceof Error ? e.message : String(e)) }
  for (const v of ['MICA_REGISTRY', 'MICA_REGISTRY_USER', 'MICA_RELEASE_TOKEN_VAR', 'MICA_SOURCE_URL']) if (!env[v]) throw new RegistryError(`error: ${path} declares no ${v}`)
  const m = /^([A-Za-z0-9.-]+(:[0-9]+)?)\/([A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9])$/.exec(env.MICA_REGISTRY!)
  if (m === null) throw new RegistryError(`error: MICA_REGISTRY='${env.MICA_REGISTRY}' is not <host>[:port]/<owner>`)
  const host = m[1]!, base = m[3]!
  let url: string
  if (process.env.MICA_REGISTRY_PLAIN_HTTP === '1') {
    if (!/^(127\.0\.0\.1|localhost)/.test(host) && !host.endsWith('.local') && !host.includes(':') && !/^[a-z0-9-]+(:[0-9]+)?$/.test(host))
      throw new RegistryError(`error: MICA_REGISTRY_PLAIN_HTTP=1 is for a local test registry, not ${host}`)
    url = `http://${host}`
  }
  else { url = `https://${host}` }
  return { host, base, url, user: env.MICA_REGISTRY_USER!, tokenVar: env.MICA_RELEASE_TOKEN_VAR!, sourceUrl: env.MICA_SOURCE_URL! }
}

/** The token, from the variable registry.env names, else `gh auth token`, else none: a read needs no token;
 * a write refuses without one. Never printed. */
export function registryToken(reg: Registry, write = false): string {
  let token = process.env[reg.tokenVar] ?? ''
  if (token === '' && !process.env.MICA_RELEASE_NO_GH) {
    const r = run(['gh', 'auth', 'token'])
    if (r.code === 0) token = r.out.trim()
  }
  if (write && token === '') throw new RegistryError(`error: ${reg.tokenVar} is unset or empty and \`gh auth token\` gave nothing. Publishing to ${reg.host} needs a token with write:packages in that variable (tools/deb/registry.env names it); publishing is CI's, whose own token has it`)
  return token
}

/** The repository this checkout is: MICA_SOURCE_REPO, else the basename of origin -- the same rule the package
 * build writes into Mica-Source-Repo. */
export function repoName(root = REPO_ROOT): string {
  let name = process.env.MICA_SOURCE_REPO ?? ''
  if (name === '') {
    const r = run(['git', '-C', root, 'remote', 'get-url', 'origin'])
    const url = r.code === 0 ? r.out.trim() : ''
    name = url.replace(/\/$/, '').replace(/^.*\//, '').replace(/^.*:/, '').replace(/\.git$/, '')
    if (url === '' || name === '') throw new RegistryError(`error: ${root} has no 'origin' remote, so the repository name cannot be derived; set MICA_SOURCE_REPO=<name>`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new RegistryError(`error: '${name}' is not a plain repository name`)
  return name
}

/** The board of a scope: the scope itself when boards/boards.tsv lists it, else the BOARD of
 * products/<scope>/product.env. A scope that is neither is refused. */
export function scopeBoard(scope: string, root = REPO_ROOT): string {
  const boards = run(['bash', join(root, 'tools/boards.sh'), 'list']).out.split('\n').filter(l => l !== '')
  if (boards.includes(scope)) return scope
  const productEnv = join(root, 'products', scope, 'product.env')
  if (existsSync(productEnv)) {
    const board = (/^BOARD=(.*)$/m.exec(readFileSync(productEnv, 'utf8'))?.[1] ?? '').replace(/"/g, '')
    if (run(['bash', join(root, 'tools/boards.sh'), 'arch', board]).code !== 0) throw new RegistryError(`error: boards/boards.tsv lists no board ${board} (the BOARD of products/${scope}/product.env)`)
    return board
  }
  throw new RegistryError(`error: the scope ${scope} is neither a board of boards/boards.tsv nor a product of products/`)
}

export type Release = { label: string, scope: string, board: string, stamp: string, commit: string, created: string }

/** The release this checkout is: a clean tree whose HEAD carries the scoped release tag <scope>.<YYYYMMDD-HHMM>
 * (created on GitHub by `gh release create`), the scope a board of boards/boards.tsv or a product of products/
 * (whose board is then the release's board). MICA_RELEASE_TAG (the release event's tag) names it, and must when
 * HEAD carries several. */
export function releaseLoad(root = REPO_ROOT): Release {
  if (run(['git', '-C', root, 'status', '--porcelain']).out !== '') throw new RegistryError(`error: ${root} has uncommitted changes; only a clean checkout of a release is published`)
  const commit = run(['git', '-C', root, 'rev-parse', 'HEAD']).out.trim()
  const created = run(['git', '-C', root, 'show', '-s', '--format=%cI', 'HEAD']).out.trim()
  const tags = run(['git', '-C', root, 'tag', '--points-at', 'HEAD']).out.split('\n').filter(t => /^[a-z0-9][a-z0-9-]*\.[0-9]{8}-[0-9]{4}$/.test(t))
  if (tags.length === 0) throw new RegistryError(`error: HEAD ${commit.slice(0, 12)} carries no release tag <board>.YYYYMMDD-HHMM; publishing runs only for a release (gh release create <board>.<YYYYMMDD-HHMM> --target <commit>)`)
  let label: string
  const wanted = process.env.MICA_RELEASE_TAG ?? ''
  if (wanted !== '') {
    if (!tags.includes(wanted)) throw new RegistryError(`error: the release event names ${wanted}, and HEAD carries ${tags.join(' ')} `)
    label = wanted
  }
  else {
    if (tags.length !== 1) throw new RegistryError(`error: HEAD ${commit.slice(0, 12)} carries several release tags (${tags.join(' ')} ); MICA_RELEASE_TAG names the one to publish`)
    label = tags[0]!
  }
  const scope = label.slice(0, label.lastIndexOf('.')), stamp = label.slice(label.lastIndexOf('.') + 1)
  return { label, scope, board: scopeBoard(scope, root), stamp, commit, created }
}

/** GET a URL as bytes: a file:// URL (a test's releases) is read, anything else fetched. */
async function getUrl(url: string, headers: Record<string, string> = {}): Promise<{ status: number, bytes: Uint8Array }> {
  if (url.startsWith('file://')) {
    const path = url.slice('file://'.length)
    if (!existsSync(path)) return { status: 404, bytes: new Uint8Array() }
    return { status: 200, bytes: new Uint8Array(readFileSync(path)) }
  }
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(120000) })
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }
  }
  catch { return { status: 0, bytes: new Uint8Array() } }
}

/** The newest published release whose mica-build.lock carries a row of <kind> for <board> (a `board <board>
 * <component>` row, or a `pool` row of the board's architecture published under pool.<board>.<arch>.<stamp>):
 * a board-scoped release, or a product-scoped release of one of the board's products, since both publish the
 * board's components and pool under their own tag. The release being published (<skip>) is never the answer.
 * Read anonymously from GitHub, or from MICA_RELEASE_LIST and MICA_RELEASE_DOWNLOAD (a test's file://
 * releases). Undefined when no release carries one. */
export async function latestLockWith(reg: Registry, repo: string, kind: 'board' | 'pool', board: string, what: string, skip = ''): Promise<{ label: string, lock: string } | undefined> {
  const slug = `${reg.sourceUrl.replace(/^https:\/\/github\.com\//, '')}/${repo}`
  const list = process.env.MICA_RELEASE_LIST || `https://api.github.com/repos/${slug}/releases?per_page=100`
  const download = process.env.MICA_RELEASE_DOWNLOAD || `https://github.com/${slug}/releases/download`
  // The listing is release metadata from the GitHub API, whose anonymous rate limit is shared by every job on
  // a runner's address: a token, when the workflow hands it in (GITHUB_TOKEN, or GH_TOKEN as the publish step
  // sets it), only raises that limit. The locks and artifacts are read anonymously.
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const headers: Record<string, string> = list.startsWith('https://api.github.com/') && token !== '' ? { Authorization: `Bearer ${token}` } : {}
  const listed = await getUrl(list, headers)
  if (listed.status !== 200) throw new RegistryError(`error: listing the releases of ${slug} failed`)
  type Rel = { draft: boolean, tag_name: string, assets: { name: string }[] }
  // Newest stamp first, whatever the scope; the index releases mica.* carry no board rows and are skipped.
  const labels = (JSON.parse(new TextDecoder().decode(listed.bytes)) as Rel[])
    .filter(r => r.draft === false && r.tag_name !== skip && /^[a-z0-9][a-z0-9-]*\.[0-9]{8}-[0-9]{4}$/.test(r.tag_name) && !r.tag_name.startsWith('mica.') && r.assets.some(a => a.name === 'mica-build.lock'))
    .map(r => r.tag_name).sort((a, b) => { const x = a.split('.')[1]!, y = b.split('.')[1]!; return x < y ? 1 : x > y ? -1 : 0 })
  for (const label of labels) {
    const got = await getUrl(`${download}/${label}/mica-build.lock`)
    if (got.status !== 200) throw new RegistryError(`error: downloading mica-build.lock of ${label} failed`)
    const lock = new TextDecoder().decode(got.bytes)
    const rows = lock.split('\n').map(l => l.split('\t'))
    const carries = kind === 'board'
      ? rows.some(r => r[0] === 'board' && r[1] === board && r[2] === what)
      : rows.some(r => r[0] === 'pool' && r[1] === what && (r[2] ?? '').includes(`:pool.${board}.${what}.`))
    if (carries) return { label, lock }
  }
  return undefined
}

/** The annotations every artifact carries: the commit it was built from, when that commit was made, and which
 * repository built it. */
export function artifactAnnotations(reg: Registry, repo: string, commit: string, created: string, release: string): Record<string, string> {
  return { 'org.opencontainers.image.revision': commit, 'org.opencontainers.image.created': created, 'org.opencontainers.image.source': `${reg.sourceUrl.replace(/\/$/, '')}/${repo}`,
    'org.opencontainers.image.version': release, 'mica.source-repo': repo, 'mica.source-commit': commit }
}

/** The annotations of a pool manifest: only what does not change with the release (mica:docs/design/release-lock.md section 2). */
export function poolAnnotations(repo: string, arch: string): Record<string, string> {
  return { 'mica.source-repo': repo, 'mica.arch': arch }
}

export function manifestDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export type Layer = { file: string, mediaType: string, title: string, inputs?: string }

/** The OCI client of one registry, with or without a token. */
export class Oci {
  constructor(readonly reg: Registry, readonly token = '') {}

  /** "<owner>/<repository>": the publishing repository's package. */
  repo(name: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new RegistryError(`error: '${name}' is not a repository name a package can carry ([a-z0-9-])`)
    return `${this.reg.base}/${name}`
  }

  /** "<name>.<name>.<release>": what one artifact is, within it. */
  tag(...parts: string[]): string {
    return parts.join('.')
  }

  private async challenge(repo: string): Promise<string> {
    try {
      const r = await fetch(`${this.reg.url}/v2/${repo}/tags/list`, { signal: AbortSignal.timeout(60000) })
      await r.arrayBuffer().catch(() => undefined)
      const h = r.headers.get('www-authenticate') ?? ''
      return /^bearer/i.test(h) ? h : ''
    }
    catch { return '' }
  }

  /** A bearer for <repo> with <actions> (pull | pull,push), from the challenge the registry gives an
   * unauthenticated request: [200, bearer] (the bearer empty when the registry does not challenge), or the token
   * endpoint's own status and no bearer -- 401/403 when it refuses, 0 when it cannot be reached -- so a refusal
   * reaches the caller as what it is. */
  async bearer(repo: string, actions: string): Promise<[number, string]> {
    const challenge = await this.challenge(repo)
    if (challenge === '') return [200, '']
    const realm = /realm="([^"]*)"/.exec(challenge)?.[1] ?? '', service = /service="([^"]*)"/.exec(challenge)?.[1] ?? ''
    if (realm === '') { console.error(`error: ${this.reg.host} challenged with no realm: ${challenge}`); return [0, ''] }
    // With a token, as that identity; without one, anonymously -- a public artifact is read that way, and a
    // private one is refused here.
    const headers: Record<string, string> = this.token !== '' ? { Authorization: `Basic ${Buffer.from(`${this.reg.user}:${this.token}`).toString('base64')}` } : {}
    const url = new URL(realm)
    url.searchParams.set('service', service); url.searchParams.set('scope', `repository:${repo}:${actions}`)
    let code = 0, token = ''
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) })
      code = r.status
      try { const j = await r.json() as { token?: string, access_token?: string }; token = j.token || j.access_token || '' }
      catch { token = '' }
    }
    catch { code = 0 }
    if (code === 200 && token !== '') return [200, token]
    if (code === 200) code = 0
    console.error(`error: ${realm} answered ${code} for repository:${repo}:${actions}, issuing no token${this.token !== '' ? `; ${this.reg.tokenVar} does not grant it` : ' (anonymously: the package is private or does not exist)'}`)
    return [code, '']
  }

  /** <method> <path under v2/repo> -> status and body (and headers). */
  async request(method: string, repo: string, actions: string, path: string, init: { headers?: Record<string, string>, body?: Uint8Array | string } = {}): Promise<{ status: number, body: Uint8Array, headers: Headers }> {
    const [code, bearer] = await this.bearer(repo, actions)
    if (code !== 200) return { status: code, body: new Uint8Array(), headers: new Headers() }
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (bearer !== '') headers.Authorization = `Bearer ${bearer}`
    try {
      const r = await fetch(`${this.reg.url}/v2/${repo}/${path}`, { method, headers, body: init.body, redirect: 'follow', signal: AbortSignal.timeout(1800000) })
      return { status: r.status, body: new Uint8Array(await r.arrayBuffer()), headers: r.headers }
    }
    catch { return { status: 0, body: new Uint8Array(), headers: new Headers() } }
  }

  async manifestGet(repo: string, ref: string): Promise<{ status: number, body: Uint8Array }> {
    return this.request('GET', repo, 'pull', `manifests/${ref}`, { headers: { Accept: OCI_MANIFEST_TYPE } })
  }

  async blobGet(repo: string, digest: string): Promise<{ status: number, body: Uint8Array }> {
    return this.request('GET', repo, 'pull', `blobs/${digest}`)
  }

  async blobHead(repo: string, digest: string): Promise<number> {
    return (await this.request('HEAD', repo, 'pull', `blobs/${digest}`)).status
  }

  /** Whether <repo>:<ref> is readable with no credential at all: the anonymous token the realm issues, then the
   * manifest. Every publisher runs it after a push, so an artifact that went out private is a red job naming the
   * package to make public, not a consumer's 401 a week later. */
  async isPublic(repo: string, ref: string): Promise<boolean> {
    const anonymous = new Oci(this.reg, '')
    return (await anonymous.manifestGet(repo, ref)).status === 200
  }

  async requirePublic(repo: string, ref: string): Promise<void> {
    if (await this.isPublic(repo, ref)) return
    throw new RegistryError(`error: ${this.reg.host}/${repo}:${ref} was published and cannot be pulled anonymously: the package ${repo} is private. Every Mica OS package is public; set it once at https://github.com/orgs/${this.reg.base}/packages/container/package/${repo.slice(this.reg.base.length + 1)} (Package settings, Danger Zone, Change visibility: Public) and rerun -- every later artifact of this repository is public from then on`)
  }

  /** Upload the blob unless the registry has it. */
  async blobPut(repo: string, file: string, digest: string): Promise<void> {
    if (await this.blobHead(repo, digest) === 200) return
    const start = await this.request('POST', repo, 'pull,push', 'blobs/uploads/', { headers: { 'Content-Length': '0' } })
    if (start.status !== 202) throw new RegistryError(`error: starting an upload to ${this.reg.host}/${repo} answered HTTP ${start.status}: ${new TextDecoder().decode(start.body.subarray(0, 200))}`)
    let location = start.headers.get('location') ?? ''
    if (location === '') throw new RegistryError(`error: the upload to ${this.reg.host}/${repo} came with no Location`)
    if (location.startsWith('/')) location = `${this.reg.url}${location}`
    location += (location.includes('?') ? '&' : '?') + `digest=${digest}`
    const [code, bearer] = await this.bearer(repo, 'pull,push')
    if (code !== 200) throw new RegistryError(`error: uploading ${digest} to ${this.reg.host}/${repo}: the token endpoint answered ${code}`)
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' }
    if (bearer !== '') headers.Authorization = `Bearer ${bearer}`
    let status = 0, text = ''
    try {
      const r = await fetch(location, { method: 'PUT', headers, body: new Uint8Array(readFileSync(file)), signal: AbortSignal.timeout(1800000) })
      status = r.status; text = (await r.text()).slice(0, 200)
    }
    catch { status = 0 }
    if (status !== 201) throw new RegistryError(`error: uploading ${digest} to ${this.reg.host}/${repo} answered HTTP ${status}: ${text}`)
  }

  /** The manifest of <layers> under <tag>: uploads the layers and the manifest unless the tag holds it. Returns
   * "pushed <digest>" or "present <digest>"; a tag holding another digest is refused, never re-pointed. */
  async publish(repo: string, tag: string, artifactType: string, annotations: Record<string, string>, layers: Layer[]): Promise<string> {
    await this.blobPut(repo, emptyConfig(), OCI_EMPTY_CONFIG_DIGEST)
    const descriptors = []
    for (const l of layers) {
      const digest = `sha256:${createHash('sha256').update(readFileSync(l.file)).digest('hex')}`
      await this.blobPut(repo, l.file, digest)
      descriptors.push({ mediaType: l.mediaType, digest, size: statSync(l.file).size, annotations: { 'org.opencontainers.image.title': l.title, ...(l.inputs ? { 'mica.inputs': l.inputs } : {}) } })
    }
    const manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, artifactType, config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: OCI_EMPTY_CONFIG_DIGEST, size: 2 }, layers: descriptors, annotations }
    return this.tagManifest(repo, tag, new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n'))
  }

  /** The manifest under <tag>, whose layers the registry already holds (a reused component's manifest is put
   * under the new release's tag this way). A tag that already exists must hold exactly that digest. */
  async tagManifest(repo: string, tag: string, manifest: Uint8Array): Promise<string> {
    const digest = manifestDigest(manifest)
    const existing = await this.manifestGet(repo, tag)
    if (existing.status === 200) {
      const have = manifestDigest(existing.body)
      if (have !== digest) throw new RegistryError(`error: ${this.reg.host}/${repo}:${tag} already holds ${have}, and this build's manifest is ${digest}; a published tag is never re-pointed, and nothing was published`)
      return `present ${digest}`
    }
    if (existing.status === 404) {
      const put = await this.request('PUT', repo, 'pull,push', `manifests/${tag}`, { headers: { 'Content-Type': OCI_MANIFEST_TYPE }, body: manifest })
      if (put.status !== 201) throw new RegistryError(`error: putting the manifest ${tag} to ${this.reg.host}/${repo} answered HTTP ${put.status}: ${new TextDecoder().decode(put.body.subarray(0, 200))}`)
      return `pushed ${digest}`
    }
    if (existing.status === 401 || existing.status === 403) throw new RegistryError(`error: the registry answered ${existing.status} for ${this.reg.host}/${repo}; ${this.reg.tokenVar || 'the token'} does not grant access`)
    if (existing.status === 0) throw new RegistryError(`error: ${this.reg.host} could not be reached (transport failure)`)
    throw new RegistryError(`error: reading ${this.reg.host}/${repo}:${tag} answered HTTP ${existing.status}`)
  }
}

/** The empty config blob every artifact shares, written once under .tmp/ for the upload. */
export function emptyConfig(): string {
  mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
  const path = join(REPO_ROOT, '.tmp', 'empty-config.json')
  if (!existsSync(path) || readFileSync(path, 'utf8') !== '{}') writeFileSync(path, '{}')
  return path
}
