// An update catalog for core-sets.sh, served to the guest over HTTP: mica/catalog/v1 with a `sets` line of the core kind per channel
// and a product line, each release document listing every object its signed descriptor names (mica-core:
// crates/mica-deploy/src/catalog.rs). The documents are canonical JSON, as the device requires.
//
//   bun core-catalog.ts WWW BASE_URL [--core SET_DIR]... [--product DEPLOY_DIR] [--objects DIR]...
//
//   SET_DIR      a core-set.ts output: core-set.json and cores/
//   DEPLOY_DIR   an update.ts offline tree: deployment.json and objects/
//   --objects    directories searched for the bytes of objects a descriptor names but its tree does not carry
//
// Writes WWW/v1/manifest.json and the documents and objects below WWW; BASE_URL is the URL WWW is served at.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Artifact } from '../../../src/image/components.ts'
import { canonicalJson, componentId } from '../../../src/image/components.ts'
import { coreSetId } from '../../../src/image/core-set.ts'

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
  core: { type: 'string', multiple: true, default: [] },
  product: { type: 'string' },
  objects: { type: 'string', multiple: true, default: [] },
} })
const [wwwArg, baseUrl] = positionals
if (!wwwArg || !baseUrl?.endsWith('/'))
  throw new Error('Usage: core-catalog.ts WWW BASE_URL [--core SET_DIR]... [--product DEPLOY_DIR] [--objects DIR]...')
const www = resolve(wwwArg)
mkdirSync(join(www, 'v1'), { recursive: true })
mkdirSync(join(www, 'objects'), { recursive: true })

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const payloadOf = (envelope: string) => JSON.parse(Buffer.from(JSON.parse(envelope).payload, 'base64').toString('utf8'))
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [])

// Every object a descriptor names, copied to objects/<sha256> from the first searched file with its length and digest.
function publish(artifacts: Artifact[], search: string[]) {
  const candidates = search.filter(existsSync).flatMap(files)
  const objects = new Map(artifacts.map(a => [a.sha256, a]))
  for (const a of objects.values()) {
    const target = join(www, 'objects', a.sha256)
    if (existsSync(target)) continue
    const source = candidates.find(f => statSync(f).size === a.bytes && sha256(readFileSync(f)) === a.sha256)
    if (source === undefined) throw new Error(`no file holds object ${a.sha256} (${a.bytes} bytes)`)
    copyFileSync(source, target)
  }
  return [...objects.values()].map(a => ({ sha256: a.sha256, bytes: a.bytes, path: `objects/${a.sha256}` }))
}
const contentArtifacts = (c: { content: { image: Artifact, signature: Artifact } }) => [c.content.image, c.content.signature]

const cores = []
for (const dir of values.core) {
  const envelope = readFileSync(join(dir, 'core-set.json'), 'utf8')
  const set = payloadOf(envelope)
  const id = coreSetId(Buffer.from(JSON.parse(envelope).payload, 'base64').toString('utf8'))
  const path = `core/${set.channel}/${set.arch}/${set.generation}`
  mkdirSync(join(www, path), { recursive: true })
  writeFileSync(join(www, path, 'set.json'), envelope)
  const release = { schema: 'mica/set-release/v1', baseUrl, id, kind: 'core', channel: set.channel, arch: set.arch, generation: set.generation, version: set.version,
    set: { path: `${path}/set.json`, sha256: sha256(Buffer.from(envelope)), bytes: Buffer.byteLength(envelope) },
    objects: publish(set.components.flatMap(contentArtifacts), [join(dir, 'cores')]) }
  writeFileSync(join(www, path, 'index.json'), canonicalJson(release))
  cores.push({ kind: 'core', channel: set.channel, arch: set.arch, latest: { id, generation: set.generation, path: `${path}/index.json` } })
}

const products = []
if (values.product !== undefined) {
  const envelope = readFileSync(join(values.product, 'deployment.json'), 'utf8')
  const d = payloadOf(envelope)
  const id = componentId(d)
  const path = `releases/${id}`
  mkdirSync(join(www, path), { recursive: true })
  writeFileSync(join(www, path, 'deployment.json'), envelope)
  const artifacts = [d.kernel.boot.artifact, d.kernel.support.image, d.kernel.support.signature, ...contentArtifacts(d.rootfs)]
  const release = { schema: 'mica/release/v1', baseUrl, id, product: d.product, board: d.board, generation: d.generation, notes: '',
    deployment: { path: `${path}/deployment.json`, sha256: sha256(Buffer.from(envelope)), bytes: Buffer.byteLength(envelope) },
    objects: publish(artifacts, [join(values.product, 'objects'), ...values.objects]) }
  writeFileSync(join(www, path, 'index.json'), canonicalJson(release))
  products.push({ product: d.product, board: d.board, latest: { id, generation: d.generation, notes: '', path: `${path}/index.json` } })
}

writeFileSync(join(www, 'v1', 'manifest.json'), canonicalJson({ schema: 'mica/catalog/v1', revision: 1, baseUrl, products, sets: cores }))
console.log(`FILE_AB_CATALOG_READY: ${cores.length} core lines, ${products.length} product lines`)
