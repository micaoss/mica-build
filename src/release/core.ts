// A core release (mica-core:docs/mica-core.md 6.2 "Sets", the kind `core`): the core components of this tree's mica-core pin,
// released once per channel for every architecture as core.<channel>.<YYYYMMDD-HHMM>, on their own. No product is
// rebuilt: a device takes the set of its channel beside its system, and a product image carries the published set
// of the general channel as its seed.
//
// A CORE RELEASE IS CUT BY release-core.yml (gh workflow run release-core.yml [-f channel=<channel>]). The workflow
// stamps the tag and runs the steps below.
//
//   bun src/cli.ts core-release plan core.<channel>.<YYYYMMDD-HHMM>
//       the generation and the previous release of the channel (or -): one above the previous release's, 1 for
//       a first release. A generation is the channel's, the same on every architecture
//   bun src/cli.ts core-release build core.<channel>.<YYYYMMDD-HHMM> <generation> <dir>
//       per architecture the pinned core components fetched and signed as one set (src/image/component-cli.ts
//       core-set) under <dir>/<arch>, and the set's archive as
//       <dir>/assets/mica-core.<channel>-<YYYYMMDD-HHMM>.<arch>.micaupd
//   bun src/cli.ts core-release attach core.<channel>.<YYYYMMDD-HHMM> <dir>
//       <dir>/SHA256SUMS listing the archives, and the GitHub Release, created as a draft at this commit; the
//       archives, then SHA256SUMS last; then published and every file read back anonymously. A release that
//       exists is never touched. A core release carries no mica-build.lock: the lock is a product release's
//       (mica-build-tools:docs/spec/release-lock.md 1.2.2), and each archive is its own signed statement
//   bun src/cli.ts core-release res [--dry-run] core.<channel>.<YYYYMMDD-HHMM>
//       the attached release posted to the resource service (mica-res:docs/spec/release-publishing.md "A core
//       release"), and read back: per architecture the manifest's `sets` line of the kind `core`, its mica/set-release/v1, the
//       signed set and one object
//   bun src/cli.ts core-release seed <arch> <dir> [<channel>]
//       the newest published set of the channel (default general) for <arch>, authenticated, as the directory
//       <dir> a product build takes as its seed (MICA_SEED_CORE_SET, src/product/build.ts)
//
//   reads   locks/ (the mica-core pin), meta or MICA_SIGNING_OUTPUT (the verity key and certificate, the updates
//           key and public key); previous releases from the GitHub Releases of micaoss/mica-build, or
//           MICA_RELEASE_HISTORY=<dir> of core.<channel>.<YYYYMMDD-HHMM>/<archive>
//   env     GH_TOKEN for attach, MICA_RES_TOKEN and MICA_RES_BASE for res (src/release/res.ts)
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unpackCoreArchive } from '../image/component-archive.ts'
import { authenticateCoreSet, coreSetId, parseCoreSet, type CoreSet } from '../image/core-set.ts'
import { canonicalJson } from '../image/components.ts'
import { coreRows, fetchPool } from '../pool/pool.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { ARCH_CHOICES, ARCHES, isArch, type Arch } from '../rootfs/runtime/arch.ts'
import { call, eventually, joined } from './res.ts'
import { DOWNLOADS, fetchBytes, ghCreateDraft, ghPublish, ghUpload, listReleases, readsBackAs, ScopedReleaseError, type GithubRelease } from './scoped.ts'

const CLI = join(REPO_ROOT, 'src/cli.ts')
const GITHUB = 'micaoss/mica-build'
const CORE_TAG = /^core\.([a-z0-9][a-z0-9-]{0,63})\.([0-9]{8}-[0-9]{4})$/
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const say = (l: string) => console.log(l)

function die(message: string): never {
  throw new ScopedReleaseError(`core release: error: ${message}`)
}

export type CoreTag = { channel: string, stamp: string }

/** Whether a tag names a core release, core.<channel>.<YYYYMMDD-HHMM>. */
export const isCoreTag = (tag: string): boolean => CORE_TAG.test(tag)

export function coreTag(tag: string): CoreTag {
  const m = CORE_TAG.exec(tag)
  if (m === null) die(`the release tag must be core.<channel>.<YYYYMMDD-HHMM>, not '${tag}'`)
  return { channel: m[1]!, stamp: m[2]! }
}

/** The archive of one architecture in the release of `tag`. */
export const archiveName = (tag: CoreTag, arch: string) => `mica-core.${tag.channel}-${tag.stamp}.${arch}.micaupd`

/** The published core releases of a channel, newest first. */
export function coreReleases(releases: GithubRelease[], channel: string): string[] {
  return releases.filter(r => !r.draft && r.assets.length > 0 && isCoreTag(r.tag_name) && coreTag(r.tag_name).channel === channel)
    .map(r => r.tag_name).sort().reverse()
}

/** The signed envelope at the head of a MICAUPD1 archive. */
export function archiveEnvelope(archive: Uint8Array): string {
  const a = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  if (a.subarray(0, 8).toString() !== 'MICAUPD1' || a.length < 12 + a.readUInt32BE(8)) die('not a MICAUPD1 archive, or its envelope is cut short')
  return a.subarray(12, 12 + a.readUInt32BE(8)).toString()
}

const publicKey = () => readFileSync(join(process.env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta'), 'updates/public.key'), 'utf8').replace(/\n/g, '')

/** The newest published release of a channel, or '' when it has none. */
async function latest(channel: string, self = ''): Promise<string> {
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  const releases: GithubRelease[] = historyDir
    ? readdirSync(historyDir).filter(n => readdirSync(join(historyDir, n)).length > 0).map(n => ({ draft: false, tag_name: n, assets: [n] }))
    : await listReleases()
  return coreReleases(releases, channel).find(t => t !== self) ?? ''
}

/** The architectures a core release carries: each one the mica-core pin has core components for. */
export async function coreArches(): Promise<Arch[]> {
  const out: Arch[] = []
  for (const arch of ARCHES) if ((await coreRows(arch)).length > 0) out.push(arch)
  if (out.length === 0) die('the mica-core pin carries core components for no architecture')
  return out
}

/** One architecture's archive of a published release, whole; with `optional`, undefined where the release has
 * none for the architecture (a release cut before the architecture had core components). */
async function archive(label: string, arch: string, optional?: false): Promise<Uint8Array>
async function archive(label: string, arch: string, optional: true): Promise<Uint8Array | undefined>
async function archive(label: string, arch: string, optional = false): Promise<Uint8Array | undefined> {
  const name = archiveName(coreTag(label), arch)
  const historyDir = process.env['MICA_RELEASE_HISTORY']
  if (historyDir) {
    if (!existsSync(join(historyDir, label, name))) return optional ? undefined : die(`release ${label} has no ${name}`)
    return new Uint8Array(readFileSync(join(historyDir, label, name)))
  }
  const r = await fetchBytes(`${DOWNLOADS()}/${label}/${name}`, {}, 300000, 3)
  if (r.status === 404 && optional) return undefined
  if (r.status !== 200) die(`release ${label} of ${GITHUB} has no readable ${name} (HTTP ${r.status})`)
  return r.body
}

/** An archive's set, held to the release and architecture it is of, and authenticated with this tree's updates
 * key; a post to res reads it as published (`authenticate` false), since res checks the signature it serves. */
function archiveSet(bytes: Uint8Array, label: string, arch: string, authenticate = true): CoreSet {
  let set: CoreSet
  try {
    const envelope = archiveEnvelope(bytes)
    set = authenticate ? authenticateCoreSet(envelope, [publicKey()]) : parseCoreSet(Buffer.from((JSON.parse(envelope) as { payload: string }).payload, 'base64').toString())
  }
  catch (e) {
    if (e instanceof ScopedReleaseError) throw e
    die(`the ${arch} archive of ${label} ${authenticate ? 'does not authenticate with this tree\'s updates key' : 'holds no core set'}: ${(e as Error).message}`)
  }
  if (set.channel !== coreTag(label).channel || set.arch !== arch) die(`the ${arch} archive of ${label} holds a set of ${set.channel} for ${set.arch}`)
  return set
}

export async function plan(tag: CoreTag): Promise<string> {
  const previous = await latest(tag.channel, `core.${tag.channel}.${tag.stamp}`)
  if (previous === '') return '1\t-'
  if (coreTag(previous).stamp >= tag.stamp) die(`release ${previous} is not older than ${tag.stamp}`)
  let generation = 0
  for (const arch of ARCHES) {
    const bytes = await archive(previous, arch, true)
    if (bytes !== undefined) generation = Math.max(generation, archiveSet(bytes, previous, arch).generation)
  }
  return `${generation + 1}\t${previous}`
}

export async function build(tag: CoreTag, generation: string, dir: string): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(generation)) die(`the generation must be a positive decimal, not '${generation}'`)
  const signing = process.env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  const versions = new Set<string>()
  for (const arch of await coreArches()) {
    say(await fetchPool(arch, (await coreRows(arch)).map(r => r[0]), false))
    const r = Bun.spawnSync([process.execPath, CLI, 'components', 'core-set', '--pool', join(REPO_ROOT, '_out/debs', arch, 'pool'), '--arch', arch,
      '--channel', tag.channel, '--generation', generation, '--out', join(dir, arch),
      '--content-key', join(signing, 'verity/signer.key.pem'), '--content-cert', join(signing, 'verity/signer.cert.pem'), '--metadata-key', join(signing, 'updates/signer.key.pem')],
    { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) die(`the ${arch} core set was not built (see above)`)
    const bytes = new Uint8Array(readFileSync(join(dir, arch, `core.${arch}.micaupd`)))
    const set = archiveSet(bytes, `core.${tag.channel}.${tag.stamp}`, arch)
    versions.add(set.version)
    copyFileSync(join(dir, arch, `core.${arch}.micaupd`), join(dir, 'assets', archiveName(tag, arch)))
    say(`core release: ${archiveName(tag, arch)}: set ${coreSetId(canonicalJson(set))}, ${set.version}, generation ${set.generation}, ${set.components.length} component(s), ${bytes.length} bytes`)
  }
  if (versions.size !== 1) die(`the architectures' sets are at ${[...versions].join(' and ')}; a core release is one mica-core release`)
}

export async function attach(tag: CoreTag, dir: string): Promise<void> {
  const label = `core.${tag.channel}.${tag.stamp}`
  const names = (await coreArches()).map(arch => archiveName(tag, arch))
  for (const n of names) if (!existsSync(join(dir, 'assets', n))) die(`${dir}/assets holds no ${n} (core-release build)`)
  const commit = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
  writeFileSync(join(dir, 'SHA256SUMS'), names.map(n => `${sha256(readFileSync(join(dir, 'assets', n)))}  ${n}\n`).join(''))
  const release = await ghCreateDraft(label, commit, 'release-core.yml')
  for (const f of [...names.map(n => join(dir, 'assets', n)), join(dir, 'SHA256SUMS')]) await ghUpload(release.id, f)
  await ghPublish(release.id)
  for (const [name, path] of [...names.map(n => [n, join(dir, 'assets', n)]), ['SHA256SUMS', join(dir, 'SHA256SUMS')]] as [string, string][])
    if (!await readsBackAs(`https://github.com/${GITHUB}/releases/download/${label}/${name}`, sha256(readFileSync(path)))) die(`${name} of release ${label} does not read back anonymously with its bytes`)
  say(`core release: ${label} published at ${commit.slice(0, 12)} and read back`)
}

export type CoreArchive = { arch: string, name: string, sha256: string, size: number, set: CoreSet }

/** The release record of mica-res:docs/spec/release-publishing.md "A core release": one archive per architecture,
 * every set of the release's channel and of one version and generation. */
export function coreRecord(label: string, archives: CoreArchive[]) {
  const tag = coreTag(label)
  const product = `core.${tag.channel}`
  const first = archives[0]
  if (first === undefined) die(`${label} has no archive`)
  for (const a of archives) {
    if (a.set.channel !== tag.channel || a.set.arch !== a.arch) die(`${a.name} holds a set of ${a.set.channel} for ${a.set.arch}`)
    if (a.set.version !== first.set.version || a.set.generation !== first.set.generation)
      die(`${a.name} is ${a.set.version} generation ${a.set.generation}, and ${first.name} is ${first.set.version} generation ${first.set.generation}`)
  }
  const key = (name: string) => `mica/${product}/${tag.stamp}/${name}`
  return {
    release: label, kind: 'core', scope: product, stamp: tag.stamp, product, channel: tag.channel, version: first.set.version, generation: first.set.generation,
    assets: archives.map(a => ({ kind: 'core', form: a.arch, path: key(a.name), sha256: a.sha256, size: a.size })),
    cores: archives.map(a => ({ arch: a.arch, archive: key(a.name) })),
  }
}

/** The URL of an architecture's release document when the manifest's `sets` line of the core kind, the channel and architecture
 * names `label` at `generation` as its latest. Undefined while the manifest does not say so yet. */
export function coreIndex(manifest: unknown, label: string, arch: string, generation: number): string | undefined {
  const m = manifest as { schema?: unknown, baseUrl?: unknown, sets?: { kind?: unknown, channel?: unknown, arch?: unknown, latest?: { id?: unknown, generation?: unknown, path?: unknown } }[] }
  if (m?.schema !== 'mica/catalog/v1') return undefined
  const lines = (m.sets ?? []).filter(c => c.kind === 'core' && c.channel === coreTag(label).channel && c.arch === arch)
  if (lines.length !== 1 || lines[0]!.latest?.id !== label || lines[0]!.latest?.generation !== generation) return undefined
  return joined(m.baseUrl, lines[0]!.latest?.path)
}

export type CoreRefs = { set: { url: string, sha256: string }, object: string }

/** What an architecture's release document names: its signed set and the URL of `object`. Undefined when the
 * document is not this release's, or does not name both. */
export function coreRefs(index: unknown, label: string, arch: string, generation: number, object: string): CoreRefs | undefined {
  const r = index as { schema?: unknown, baseUrl?: unknown, id?: unknown, kind?: unknown, channel?: unknown, arch?: unknown, generation?: unknown,
    set?: { path?: unknown, sha256?: unknown }, objects?: { sha256?: unknown, path?: unknown }[] }
  if (r?.schema !== 'mica/set-release/v1' || r.kind !== 'core' || r.id !== label || r.channel !== coreTag(label).channel || r.arch !== arch || r.generation !== generation) return undefined
  const set = joined(r.baseUrl, r.set?.path)
  const entry = (r.objects ?? []).find(o => o.sha256 === object)
  const url = entry === undefined ? undefined : joined(r.baseUrl, entry.path)
  if (set === undefined || url === undefined || typeof r.set?.sha256 !== 'string') return undefined
  return { set: { url: set, sha256: r.set.sha256 }, object: url }
}

/** Post one published core release; with dryRun, rebuild its record from its published archives and post nothing.
 * Returns res's outcome for the release record (`created`, `unchanged`, ...) or `dry-run`. */
export async function publishCoreToRes(label: string, dryRun = false): Promise<string> {
  const tag = coreTag(label)
  const archives: CoreArchive[] = []
  for (const arch of ARCHES) {
    const bytes = await archive(label, arch, true)
    if (bytes === undefined) continue
    archives.push({ arch, name: archiveName(tag, arch), sha256: sha256(bytes), size: bytes.length, set: archiveSet(bytes, label, arch, false) })
  }
  const record = coreRecord(label, archives)
  if (dryRun) {
    say(`res: ${label}: would post ${record.product} generation ${record.generation} version ${record.version}, ${archives.length} file(s): ${archives.map(a => a.name).join(' ')}`)
    return 'dry-run'
  }
  const contentType = 'application/octet-stream'
  // The steps of a product release (src/release/res.ts): stage, one batch, the record.
  const uploads = new Map<string, string>()
  for (const a of archives) {
    const r = await call<{ id: string }>('POST', '/res/namespaces/mica/uploads/pull', { origin: `https://github.com/${GITHUB}/releases/download/${label}/${a.name}`, sha256: a.sha256, contentType }, 6)
    uploads.set(a.name, r.data.id)
    say(`res: staged ${a.name}`)
  }
  const batch = await call<{ objects: { outcome: string }[] }>('POST', '/res/namespaces/mica/batch',
    { objects: archives.map(a => ({ path: `${record.product}/${tag.stamp}/${a.name}`, source: { uploadId: uploads.get(a.name)! }, contentType })) }, 3)
  say(`res: published ${archives.length} file(s) under mica/${record.product}/${tag.stamp}/ (${batch.data.objects.map(o => o.outcome).join(', ')})`)
  const posted = await call<{ outcome?: string }>('POST', '/res/releases', record, 3)
  const outcome = posted.data.outcome ?? (posted.status === 201 ? 'created' : 'unchanged')
  say(`res: release ${label} recorded (${outcome})`)

  // Read back what a device reads, per architecture.
  const base = process.env['MICA_RES_BASE'] || 'https://res.micaos.dev'
  const json = async (url: string) => (await fetch(url, { cache: 'no-store' })).json()
  const hashed = async (url: string) => {
    const r = await fetch(url, { redirect: 'follow' })
    return r.ok ? sha256(new Uint8Array(await r.arrayBuffer())) : ''
  }
  for (const a of archives) {
    const object = a.set.components[0]!.content.image.sha256
    let index: string | undefined
    await eventually(`the device manifest (mica/catalog/v1) names ${label} for ${a.arch} at generation ${record.generation}`, async () => {
      index = coreIndex(await json(`${base}/update/v1/manifest.json`), label, a.arch, record.generation)
      return index !== undefined
    })
    let refs: CoreRefs | undefined
    await eventually(`the ${a.arch} release document (mica/set-release/v1) names ${label}'s set and ${object.slice(0, 12)}`, async () => {
      refs = coreRefs(await json(index!), label, a.arch, record.generation, object)
      return refs !== undefined
    })
    await eventually(`the signed ${a.arch} set reads back with its digest`, async () => (await hashed(refs!.set.url)) === refs!.set.sha256)
    await eventually(`the object ${object.slice(0, 12)} reads back with its digest`, async () => (await hashed(refs!.object)) === object)
  }
  return outcome
}

export async function seed(arch: string, dir: string, channel: string, work: string): Promise<void> {
  if (!isArch(arch)) die(`the architecture must be one of ${ARCH_CHOICES}, not '${arch}'`)
  const label = await latest(channel)
  if (label === '') die(`the ${channel} channel has no published core release; cut one first (gh workflow run release-core.yml), a product image carries the published set as its seed`)
  const file = join(work, archiveName(coreTag(label), arch))
  const bytes = await archive(label, arch)
  writeFileSync(file, bytes)
  archiveSet(bytes, label, arch)
  let set: CoreSet
  try { set = unpackCoreArchive(file, [publicKey()], dir) }
  catch (e) { die(`the ${arch} archive of ${label} does not unpack: ${(e as Error).message}`) }
  say(`core release: seed ${coreSetId(canonicalJson(set))} of ${label} (${arch}, ${set.version}, generation ${set.generation}) into ${dir}`)
}

export async function main(argv: string[]): Promise<number> {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.core-release.'))
  try {
    const [cmd, ...rest] = argv
    if (cmd === 'plan' && rest.length === 1) { say(await plan(coreTag(rest[0]!))); return 0 }
    if (cmd === 'build' && rest.length === 3) { await build(coreTag(rest[0]!), rest[1]!, rest[2]!); return 0 }
    if (cmd === 'attach' && rest.length === 2) { await attach(coreTag(rest[0]!), rest[1]!); return 0 }
    if (cmd === 'res') {
      const tags = rest.filter(a => a !== '--dry-run')
      if (tags.length === 1 && isCoreTag(tags[0]!)) { say(`res: ${tags[0]}: ${await publishCoreToRes(tags[0]!, rest.includes('--dry-run'))}`); return 0 }
    }
    if (cmd === 'seed' && (rest.length === 2 || rest.length === 3)) { await seed(rest[0]!, rest[1]!, rest[2] ?? 'general', work); return 0 }
    die('usage: bun src/cli.ts core-release plan <tag> | build <tag> <generation> <dir> | attach <tag> <dir> | res [--dry-run] <tag> | seed <arch> <dir> [<channel>]')
  }
  catch (e) {
    if (e instanceof ScopedReleaseError || (e instanceof Error && ['PoolError', 'RegistryError', 'ToolError', 'Refused'].includes(e.constructor.name))) { console.error(e.message); return 1 }
    throw e
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
