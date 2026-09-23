// The public metadata a product ships (products/<name>/meta/), validated before the composer stages it into
// the root: exactly updates/manifest.json and an optional GENERATED marker, regular non-symlink files with no
// private key material, and a manifest that is the mica/meta/v1 document, key for key.
//
//   bun src/cli.ts validate-public-meta <meta dir>
//
// The port of rootfs/scripts/validate-public-meta.sh (deleted 2026-09-23), refusal for refusal; the manifest
// checks the shell ran as a bun script inside the base image run here in-process.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export class PublicMetaError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

function fail(message: string, code = 1): never {
  throw new PublicMetaError(`error: ${message}`, code)
}

/** bash's %q of a name: printable ASCII words as they are, anything else quoted. */
function q(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, '\'\\\'\'')}'`
}

const FILENAME = 'updates/manifest.json'

type Json = unknown
type JsonObject = Record<string, Json>

function isObject(value: Json): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The manifest document, checked as the shell's embedded bun script checked it. */
export function validateManifest(bytes: Uint8Array): void {
  const manifestFail = (path: string, reason: string): never => fail(`${FILENAME}: ${path}: ${reason}`)
  const safeKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key))
  const keyPath = (path: string, key: string) => `${path}.${safeKey(key)}`
  const exactObject = (value: Json, path: string, keys: string[]): JsonObject => {
    if (!isObject(value)) return manifestFail(path, 'must be an object')
    for (const key of keys) if (!Object.hasOwn(value, key)) manifestFail(keyPath(path, key), 'required key is missing')
    for (const key of Object.keys(value)) if (!keys.includes(key)) manifestFail(keyPath(path, key), 'unknown key')
    return value
  }
  const string = (value: Json, path: string) => { if (typeof value !== 'string') manifestFail(path, 'must be a string') }
  const nullableString = (value: Json, path: string) => { if (value !== null && typeof value !== 'string') manifestFail(path, 'must be a string or null') }
  let text = ''
  try {
    // Preserve a BOM for JSON validation; never replace malformed byte sequences.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  catch { manifestFail('document', 'invalid UTF-8') }
  let intervalSource: string | undefined
  let document: Json
  try {
    // Track decoded member names before JSON.parse can discard duplicates. Whole string tokens keep key-like
    // text out of the structural stack; JSON.parse below remains responsible for the complete JSON grammar.
    const stack: { path: string, keys: Set<string> | null, key: string, needsKey: boolean, index: number }[] = []
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g)) {
      const token = match[0]
      const parent = stack.at(-1)
      if (token === '{' || token === '[') {
        const path = !parent ? 'manifest' : parent.keys ? keyPath(parent.path, parent.key) : `${parent.path}[${parent.index}]`
        stack.push({ path, keys: token === '{' ? new Set() : null, key: '', needsKey: true, index: 0 })
      }
      else if (token === '}' || token === ']') { stack.pop() }
      else if (token === ',' && parent) { parent.needsKey = true; parent.index += 1 }
      else if (token.startsWith('"') && parent?.keys && parent.needsKey) {
        const key = JSON.parse(token) as string
        if (parent.keys.has(key)) manifestFail(keyPath(parent.path, key), 'duplicate key')
        parent.keys.add(key)
        parent.key = key
        parent.needsKey = false
      }
    }
    document = JSON.parse(text, (key, value, context?: { source?: string }) => {
      if (key === 'checkIntervalMinutes' && typeof value === 'number') intervalSource = context?.source
      return value as Json
    }) as Json
  }
  catch (e) {
    if (e instanceof PublicMetaError) throw e
    manifestFail('document', 'invalid JSON')
  }
  const doc = exactObject(document, 'manifest', ['schema', 'product', 'update', 'http', 'fleet'])
  const product = exactObject(doc.product, 'product', ['vendor', 'model'])
  const update = exactObject(doc.update, 'update', ['source', 'channel', 'policy', 'checkIntervalMinutes'])
  const http = exactObject(doc.http, 'http', ['credentialHosts'])
  const fleet = exactObject(doc.fleet, 'fleet', ['enabled', 'url'])
  if (doc.schema !== 'mica/meta/v1') manifestFail('schema', 'must equal the current schema mica/meta/v1')
  string(product.vendor, 'product.vendor')
  string(product.model, 'product.model')
  nullableString(update.source, 'update.source')
  string(update.channel, 'update.channel')
  if ((update.channel as string).trim() === '') manifestFail('update.channel', 'must not be empty')
  if (!['off', 'check', 'auto'].includes(update.policy as string)) manifestFail('update.policy', 'must be one of off, check, or auto')
  if (typeof update.checkIntervalMinutes !== 'number' || !/^(0|[1-9][0-9]*)$/.test(intervalSource ?? '')) manifestFail('update.checkIntervalMinutes', 'must be a non-negative integer')
  if (BigInt(intervalSource!) > 18446744073709551615n) manifestFail('update.checkIntervalMinutes', 'must fit the unsigned 64-bit range')
  const hosts: Json = http.credentialHosts
  if (!Array.isArray(hosts)) manifestFail('http.credentialHosts', 'must be an array')
  ;(hosts as Json[]).forEach((v, index) => string(v, `http.credentialHosts[${index}]`))
  if (typeof fleet.enabled !== 'boolean') manifestFail('fleet.enabled', 'must be a boolean')
  nullableString(fleet.url, 'fleet.url')
}

/** The public metadata directory: its entries, their kinds, no key material, and the manifest. */
export function validatePublicMeta(given: string): void {
  let metaDir = given
  while (metaDir !== '/' && metaDir.endsWith('/')) metaDir = metaDir.slice(0, -1)
  // Inspect the supplied spelling before resolving dot components or symlinks.
  let inputPath = isAbsolute(metaDir) ? metaDir : `${process.cwd()}/${metaDir}`
  while (inputPath !== '' && inputPath !== '/') {
    inputPath = inputPath.replace(/\/$/, '')
    if (existsSync(inputPath) && lstatSync(inputPath).isSymbolicLink()) fail(`public metadata directory has a symlink component: ${q(inputPath)}`)
    inputPath = inputPath.slice(0, inputPath.lastIndexOf('/'))
  }
  if (!existsSync(metaDir) || lstatSync(metaDir).isSymbolicLink() || !lstatSync(metaDir).isDirectory()) fail('public metadata directory is missing or is a symlink')
  for (const name of readdirSync(metaDir)) if (name !== 'updates' && name !== 'GENERATED') fail(`unexpected public metadata entry: ${q(name)}`)
  const updates = `${metaDir}/updates`
  if (!existsSync(updates) || lstatSync(updates).isSymbolicLink() || !lstatSync(updates).isDirectory()) fail('updates must be a regular non-symlink directory')
  for (const name of readdirSync(updates)) if (name !== 'manifest.json') fail(`unexpected public metadata entry: ${q(`updates/${name}`)}`)
  const manifest = `${updates}/manifest.json`
  if (!existsSync(manifest) || lstatSync(manifest).isSymbolicLink() || !lstatSync(manifest).isFile()) fail('updates/manifest.json is missing or is not a regular non-symlink file')
  if (lstatSync(manifest).size === 0) fail('updates/manifest.json is empty')
  const marker = `${metaDir}/GENERATED`
  if (existsSync(marker) || (() => {
    try { lstatSync(marker); return true }
    catch { return false }
  })())
    if (lstatSync(marker).isSymbolicLink() || !lstatSync(marker).isFile()) fail('GENERATED is not a regular non-symlink file')

  for (const relative of ['updates/manifest.json', 'GENERATED']) {
    const file = `${metaDir}/${relative}`
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'latin1')
    if (/BEGIN [^-\x00-\x1f\x7f]*PRIVATE KEY|"privateKey"|"private_key"/.test(text)) fail(`${relative} contains private key material`)
  }
  validateManifest(new Uint8Array(readFileSync(manifest)))
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 1) fail('validate-public-meta requires one public metadata directory', 2)
    validatePublicMeta(argv[0]!)
    return 0
  }
  catch (e) {
    if (e instanceof PublicMetaError) { console.error(e.message); return e.code }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
