// What the publisher gates share: a registry (the upstream registry:3.1.1 image locks/mica-build-env.lock
// lists, a sibling container spoken to over plain HTTP by name on the test network), a scratch clone of the
// working tree, committed and tagged there (the tags never leave the clone), previous releases served from
// file:// (releases.json and download/<tag>/mica-build.lock), fixture archives, and the commands run in the
// clone for one release.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolve as resolveImage } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'

export const REPO_ROOT = resolve(import.meta.dir, '../..')
export const MT = 'application/vnd.oci.image.manifest.v1+json'

export function sh(argv: string[], options: { cwd?: string, env?: Record<string, string> } = {}): { code: number, out: string } {
  const r = Bun.spawnSync(argv, { cwd: options.cwd, env: options.env ? { ...process.env as Record<string, string>, ...options.env } : undefined, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

export function must(argv: string[], options: { cwd?: string, env?: Record<string, string> } = {}): string {
  const r = sh(argv, options)
  if (r.code !== 0) throw new Error(`${argv.join(' ')} failed:\n${r.out}`)
  return r.out
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The registry sibling: started, waited for, stopped. */
export class Registry {
  readonly name = `ai-agent-publish-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`
  get host(): string { return `${this.name}:5000` }
  get url(): string { return `http://${this.host}` }

  async start(): Promise<void> {
    const image = resolveImage('upstream:registry:3.1.1', inputs())
    must(['docker', 'run', '-d', '--rm', '--label', 'ai-agent=true', '--name', this.name, '--network', process.env.MICA_TEST_NETWORK || 'traefik', '-e', 'REGISTRY_STORAGE_DELETE_ENABLED=true', image])
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${this.url}/v2/`, { signal: AbortSignal.timeout(2000) })).status === 200) return }
      catch { /* not yet */ }
      await Bun.sleep(1000)
    }
    throw new Error(`the registry ${this.name} did not answer`)
  }

  stop(): void {
    sh(['docker', 'rm', '-f', this.name])
  }

  async manifest(repo: string, ref: string): Promise<{ status: number, bytes: Uint8Array }> {
    const r = await fetch(`${this.url}/v2/${repo}/manifests/${ref}`, { headers: { Accept: MT } })
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }
  }

  /** "sha256:<hex>" of the manifest served under <ref>, or '' when none is. */
  async served(repo: string, ref: string): Promise<string> {
    const m = await this.manifest(repo, ref)
    return m.status === 200 ? `sha256:${sha256(m.bytes)}` : ''
  }

  async putManifest(repo: string, ref: string, bytes: Uint8Array | string): Promise<number> {
    return (await fetch(`${this.url}/v2/${repo}/manifests/${ref}`, { method: 'PUT', headers: { 'Content-Type': MT }, body: bytes })).status
  }

  async putBlob(repo: string, bytes: Uint8Array): Promise<string> {
    const digest = `sha256:${sha256(bytes)}`
    const start = await fetch(`${this.url}/v2/${repo}/blobs/uploads/`, { method: 'POST' })
    let location = start.headers.get('location') ?? ''
    if (!location.startsWith('http')) location = `${this.url}${location}`
    location += (location.includes('?') ? '&' : '?') + `digest=${digest}`
    const put = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (put.status !== 201) throw new Error(`putting a blob answered ${put.status}`)
    return digest
  }

  async deleteBlob(repo: string, digest: string): Promise<number> {
    return (await fetch(`${this.url}/v2/${repo}/blobs/${digest}`, { method: 'DELETE' })).status
  }

  async tags(repo: string): Promise<string[]> {
    const r = await fetch(`${this.url}/v2/${repo}/tags/list`)
    return ((await r.json()) as { tags: string[] | null }).tags ?? []
  }
}

/** A scratch clone of the working tree under _out/, with the tracked files (and, when asked, the untracked
 * ones) overlaid and committed, so an uncommitted change is what is tested. */
export function cloneTree(work: string, options: { untracked?: boolean } = {}): string {
  const clone = join(work, 'repo')
  must(['git', 'clone', '-q', REPO_ROOT, clone])
  must(['git', '-C', clone, 'remote', 'set-url', 'origin', 'https://example.invalid/testorg/mica-build.git'])
  const list = must(['git', 'ls-files', '-z', ...(options.untracked ? ['--cached', '--others', '--exclude-standard'] : [])], { cwd: REPO_ROOT })
  const tar = Bun.spawnSync(['tar', '--null', '-T', '-', '-cf', '-'], { cwd: REPO_ROOT, stdin: Buffer.from(list), stdout: 'pipe', stderr: 'pipe' })
  if (tar.exitCode !== 0) throw new Error(`tar of the working tree failed: ${tar.stderr.toString()}`)
  const untar = Bun.spawnSync(['tar', '-xf', '-', '-C', clone], { stdin: tar.stdout, stdout: 'pipe', stderr: 'pipe' })
  if (untar.exitCode !== 0) throw new Error(`untar into the clone failed: ${untar.stderr.toString()}`)
  commit(clone, 'the working tree under test')
  return clone
}

export function commit(clone: string, message: string): void {
  must(['git', '-C', clone, 'add', '-A'])
  must(['git', '-C', clone, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message, '--allow-empty'])
}

/** Previous releases, served from file://: releases.json and download/<tag>/mica-build.lock. */
export class Releases {
  readonly dir: string
  constructor(work: string) {
    this.dir = join(work, 'releases')
    mkdirSync(join(this.dir, 'download'), { recursive: true })
    this.set([])
  }

  /** Exactly these releases are published. */
  set(entries: [tag: string, lock: string][]): void {
    const json = entries.map(([tag, lock]) => {
      mkdirSync(join(this.dir, 'download', tag), { recursive: true })
      writeFileSync(join(this.dir, 'download', tag, 'mica-build.lock'), lock)
      return { tag_name: tag, draft: false, assets: [{ name: 'mica-build.lock' }, { name: 'SHA256SUMS' }] }
    })
    writeFileSync(join(this.dir, 'releases.json'), JSON.stringify(json) + '\n')
  }

  /** One more published release the next one may reuse from. */
  add(tag: string, lock: string): void {
    const json = JSON.parse(readFileSync(join(this.dir, 'releases.json'), 'utf8')) as object[]
    mkdirSync(join(this.dir, 'download', tag), { recursive: true })
    writeFileSync(join(this.dir, 'download', tag, 'mica-build.lock'), lock)
    json.push({ tag_name: tag, draft: false, assets: [{ name: 'mica-build.lock' }, { name: 'SHA256SUMS' }] })
    writeFileSync(join(this.dir, 'releases.json'), JSON.stringify(json) + '\n')
  }

  env(): Record<string, string> {
    return { MICA_RELEASE_LIST: `file://${join(this.dir, 'releases.json')}`, MICA_RELEASE_DOWNLOAD: `file://${join(this.dir, 'download')}` }
  }
}

/** The registry.env of a test run: <registry host>/<owner>. */
export function registryEnv(work: string, registry: Registry, owner: string): string {
  const path = join(work, 'registry.env')
  writeFileSync(path, `MICA_REGISTRY=${registry.host}/${owner}\nMICA_REGISTRY_USER=nobody\nMICA_RELEASE_TOKEN_VAR=PUBLISH_TEST_TOKEN\nMICA_SOURCE_URL=https://example.invalid/testorg\n`)
  return path
}

/** The environment a publisher runs in for the release <tag> in the clone. */
export function releaseEnv(work: string, registry: Registry, owner: string, tag: string, releases: Releases, rows: string): Record<string, string> {
  return { MICA_REGISTRY_ENV: registryEnv(work, registry, owner), MICA_REGISTRY_PLAIN_HTTP: '1', MICA_RELEASE_NO_GH: '1', PUBLISH_TEST_TOKEN: 'fixture',
    MICA_RELEASE_TAG: tag, MICA_LOCK_ROWS: rows, ...releases.env() }
}

/** A command of the clone's own tree, run there. */
export function inClone(clone: string, argv: string[], env: Record<string, string>): { code: number, out: string } {
  return sh([process.execPath, join(clone, 'src/cli.ts'), ...argv], { cwd: clone, env })
}

/** The lock a release's rows make, as tools/release.sh publish writes it. */
export function lockOf(rows: string): string {
  const read = (name: string) => existsSync(join(rows, name)) ? readFileSync(join(rows, name), 'utf8').split('\n').filter(l => l !== '').map(l => l.split('\t')) : []
  const byKey = (a: string[], b: string[]) => (a[1]! + '\t' + a[2]!).localeCompare(b[1]! + '\t' + b[2]!)
  return ['# mica-lock v1',
    ...read('pool.tsv').map(r => `pool\t${r[0]}\tghcr.io/micaoss/mica-build:${r[1]}@${r[2]}`),
    ...read('package.tsv').sort(byKey).map(r => `package\t${r[0]}\t${r[1]}\t${r[2]}\t${r[3]}`),
    ...read('board.tsv').sort(byKey).map(r => `board\t${r[0]}\t${r[1]}\t${r[2]}\tghcr.io/micaoss/mica-build:${r[3]}@${r[4]}`),
  ].join('\n') + '\n'
}

/** A fixture archive of <pkg> at <arch> and <version>, packed by this host's dpkg-deb. */
export function fixtureDeb(work: string, out: string, pkg: string, arch: string, version: string, files: Record<string, string> = {}): void {
  const root = mkdtempSync(join(work, 'deb-'))
  mkdirSync(join(root, 'DEBIAN'), { recursive: true })
  writeFileSync(join(root, 'DEBIAN/control'), `Package: ${pkg}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: test <test@invalid>\nDescription: fixture\nMica-Source-Repo: mica-build\n`)
  for (const [path, body] of Object.entries({ [`usr/share/doc/${pkg}/copyright`]: 'fixture\n', ...files })) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body) }
  mkdirSync(join(out, '..'), { recursive: true })
  must(['dpkg-deb', '--root-owner-group', '-Zgzip', '--build', root, out])
  rmSync(root, { recursive: true, force: true })
}
