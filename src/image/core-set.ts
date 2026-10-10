// The core set (mica/core-set/v1, mica-core:docs/mica-core.md 6.2 "Core sets"): every core component of one channel
// and architecture, signed once and taken by every product of that architecture on that channel. A device composes
// the components its product's features select (selectComponents, core-components.ts). The rules here are
// mica-core's (mica_deploy::core_set), held to its vector (tests/fixtures/component-contracts/core-set.json).
import { createHash } from 'node:crypto'
import { authenticatePayload, canonicalJson, compareVersions, MAX_CORE_COMPONENTS, validateCoreComponent, type CoreComponent } from './components.ts'
import { selectComponents } from './core-components.ts'

export const MAX_CORE_SET_BYTES = 32768
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

export type CoreSet = { schema: 'mica/core-set/v1', channel: string, arch: 'amd64' | 'arm64', generation: number, version: string, components: CoreComponent[] }
export type CoreSetFields = Omit<CoreSet, 'schema'>

export class CoreSetError extends Error {}

function require(ok: unknown, message: string): asserts ok {
  if (!ok) throw new CoreSetError(`Invalid core set: ${message}`)
}

/** Parse a compact, key-sorted payload, as the device does. */
export function parseCoreSet(payload: string): CoreSet {
  require(Buffer.byteLength(payload) <= MAX_CORE_SET_BYTES, 'core set too large')
  const raw = JSON.parse(payload) as Record<string, unknown>
  require(canonicalJson(raw) === payload, 'noncanonical or duplicate JSON fields')
  require(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'expected object')
  const keys = Object.keys(raw).sort().join(',')
  require(keys === 'arch,channel,components,generation,schema,version', 'unknown, missing or invalid fields')
  require(raw.schema === 'mica/core-set/v1', 'wrong core set schema')
  require(typeof raw.channel === 'string' && CHANNEL.test(raw.channel), 'invalid core channel')
  require(raw.arch === 'amd64' || raw.arch === 'arm64', 'unsupported architecture')
  require(Number.isSafeInteger(raw.generation) && (raw.generation as number) > 0, 'invalid integer')
  require(typeof raw.version === 'string' && NAME.test(raw.version), 'invalid identifier')
  require(Array.isArray(raw.components), 'unknown, missing or invalid fields')
  const components = (raw.components as unknown[]).map(c => validateCoreComponent(c, raw.arch as string))
  require(components.length > 0, 'a core set carries no component')
  require(components.length <= MAX_CORE_COMPONENTS, 'too many core components')
  require(components.every((c, i) => i === 0 || components[i - 1]!.package < c.package), 'core components not unique and sorted by package')
  for (const c of components) {
    for (const need of c.needs) {
      const found = components.find(other => other.package === need.package)
      require(found !== undefined, 'a core component\'s need is not in the core set')
      require(compareVersions(found.version, need.min) >= 0 && (need.max === undefined || compareVersions(found.version, need.max) <= 0), 'a core component\'s need is outside its version range')
    }
  }
  return raw as CoreSet
}

/** The payload of `fields`: canonical, its components in package order, and parsed back. */
export function buildCoreSet(fields: CoreSetFields): string {
  const components = [...fields.components].sort((a, b) => (a.package < b.package ? -1 : 1))
  const payload = canonicalJson({ ...fields, components, schema: 'mica/core-set/v1' })
  parseCoreSet(payload)
  return payload
}

/** A core set's identity: the SHA-256 of its signed payload. */
export function coreSetId(payload: string): string {
  return createHash('sha256').update(payload).digest('hex')
}

/** The release key's mica/update-envelope/v1 around a core set, authenticated and parsed. */
export function authenticateCoreSet(envelope: string, publicKeys: readonly string[]): CoreSet {
  return parseCoreSet(authenticatePayload(envelope, publicKeys, MAX_CORE_SET_BYTES))
}

export type ServedProduct = { name: string, arch: string, features: string[] }

/** Hold `set` to every product of its architecture that will take it: each one's selection on a root of
 * `rootLevel` must succeed (mica-core's rule, selectComponents), so a set no product can boot is never offered.
 * The selections, one line per product; a set its architecture has no product for is refused, since passing
 * over nothing would prove nothing. */
export function checkCoreSetForProducts(set: CoreSet, products: readonly ServedProduct[], rootLevel: number): string[] {
  const served = products.filter(p => p.arch === set.arch)
  if (served.length === 0) throw new CoreSetError(`Invalid core set: no released product runs on ${set.arch}, so nothing holds this set to a product`)
  return served.map((p) => {
    try { return `${p.name}: ${selectComponents(set.components, p.features, rootLevel).map(c => c.package).join(' ')}` }
    catch (e) { throw new CoreSetError(`${p.name}: ${(e as Error).message}`) }
  })
}
