import { Buffer } from 'node:buffer'
import { createHash, createPublicKey, verify } from 'node:crypto'

export const MAX_DEPLOYMENT_BYTES = 16384
/** The longest core component list a deployment carries. */
export const MAX_CORE_COMPONENTS = 16
const MAX_ENVELOPE_BYTES = 24576
const HEX = /^[0-9a-f]{64}$/
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/

export interface Artifact { bytes: number, sha256: string }
export interface VerityImage {
  image: Artifact
  rootHash: string
  signature: Artifact
  verity: {
    version: 1, algorithm: 'sha256', dataBlockSize: 4096, hashBlockSize: 4096
    dataBlocks: number, hashOffset: number, salt: string
  }
}
export interface KernelComponent {
  schema: 'mica/kernel/v1'
  id: string
  board: string
  arch: string
  buildId: string
  release: string
  boot: { format: 'uki' | 'fit', artifact: Artifact }
  support: VerityImage
}
export interface RootComponent {
  schema: 'mica/rootfs/v1'
  id: string
  arch: string
  content: VerityImage
  /** The root interface level the core components run on, 1 or more (mica-core:docs/mica-core.md 6.5). */
  interfaceLevel: number
}
/** One of mica-core's packages as a component of the deployment, composed over the root at boot. */
export interface CoreComponent {
  schema: 'mica/core/v1'
  id: string
  arch: string
  package: string
  /** Dotted numbers. */
  version: string
  /** The product features it serves. */
  features: string[]
  /** The other core components it needs in the same deployment, and the versions it accepts. */
  needs: { package: string, min: string, max?: string }[]
  /** The root interface levels it runs on, inclusive; no max has no upper bound yet. */
  root: { min: number, max?: number }
  content: VerityImage
}
export interface Deployment {
  schema: 'mica/deployment/v1'
  board: string
  arch: string
  /** The product the deployment installs on (boards/<board>/products/<variant>, <board>.<variant>): the device refuses another. */
  product: string
  generation: number
  version: string
  dataPolicy: 'unchanged'
  kernel: KernelComponent
  rootfs: RootComponent
  /** The core components, sorted by package; optional. */
  core?: CoreComponent[]
}
export interface BootIdentity {
  board: string
  arch: string
  kernelBuildId: string
  kernelRelease: string
  supportId: string
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid component contract: ${message}`)
}

function object(value: unknown, fields: string[]): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  const result = value as Record<string, unknown>
  requireValue(Object.keys(result).sort().join(',') === fields.sort().join(','), 'unknown or missing fields')
  return result
}

function text(value: unknown, pattern: RegExp): asserts value is string {
  requireValue(typeof value === 'string' && pattern.test(value), 'invalid identifier or digest')
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum, 'invalid integer')
}

/** Compact JSON with recursively sorted keys; the wire contract has no floats. */
export function canonicalJson(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)]))

    return item
  }
  const result = JSON.stringify(sorted(value))
  requireValue(typeof result === 'string', 'not JSON')
  return result
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A component excludes its own ID; a deployment has no self-reference. */
export function componentId(value: object): string {
  const { id: _id, ...content } = value as Record<string, unknown>
  return sha256(canonicalJson(content))
}

function artifact(value: unknown, maximum = Number.MAX_SAFE_INTEGER): void {
  const a = object(value, ['bytes', 'sha256'])
  integer(a.bytes, maximum)
  text(a.sha256, HEX)
}

export function validateVerityImage(value: unknown): void {
  const v = object(value, ['image', 'rootHash', 'signature', 'verity'])
  artifact(v.image)
  artifact(v.signature, 65536)
  text(v.rootHash, HEX)
  const g = object(v.verity, ['version', 'algorithm', 'dataBlockSize', 'hashBlockSize', 'dataBlocks', 'hashOffset', 'salt'])
  requireValue(g.version === 1 && g.algorithm === 'sha256' && g.dataBlockSize === 4096 && g.hashBlockSize === 4096, 'unsupported verity geometry')
  integer(g.dataBlocks, Math.floor(Number.MAX_SAFE_INTEGER / 4096))
  integer(g.hashOffset)
  text(g.salt, HEX)
  requireValue(g.hashOffset === g.dataBlocks * 4096, 'hash tree must immediately follow data')
  let blocks = g.dataBlocks
  let treeBlocks = 0
  while (blocks > 1) {
    blocks = Math.ceil(blocks / 128)
    treeBlocks += blocks
  }
  const bytes = g.hashOffset + treeBlocks * 4096
  integer(bytes)
  requireValue((v.image as Artifact).bytes === bytes, 'image length does not match verity tree')
}

function level(value: unknown): asserts value is number {
  requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'invalid interface level')
}

/** A package version as its dotted numbers, for ordering. */
export function versionKey(value: unknown): number[] {
  requireValue(typeof value === 'string' && /^[0-9]{1,9}(\.[0-9]{1,9}){0,3}$/.test(value), 'invalid version')
  return value.split('.').map(Number)
}

export function compareVersions(a: string, b: string): number {
  const x = versionKey(a), y = versionKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1)
  return 0
}

/** Whether a core component runs on a root of interface `rootLevel`. */
export function runsOn(core: Pick<CoreComponent, 'root'>, rootLevel: number): boolean {
  return rootLevel >= core.root.min && (core.root.max === undefined || rootLevel <= core.root.max)
}

/** A mica/core/v1 component of a deployment on `arch`: its fields, verity image and identity. */
export function validateCoreComponent(value: unknown, arch: string): CoreComponent {
  const c = object(value, ['schema', 'id', 'arch', 'package', 'version', 'features', 'needs', 'root', 'content'])
  requireValue(c.schema === 'mica/core/v1', 'wrong component schema')
  requireValue(c.arch === arch, 'component target mismatch')
  text(c.id, HEX)
  text(c.package, NAME)
  versionKey(c.version)
  requireValue(Array.isArray(c.features) && c.features.length > 0 && c.features.length <= 16, 'invalid core features')
  for (const feature of c.features as unknown[]) text(feature, NAME)
  requireValue(Array.isArray(c.needs) && c.needs.length <= MAX_CORE_COMPONENTS, 'invalid core needs')
  for (const item of c.needs as unknown[]) {
    const need = object(item, Object.hasOwn(item as object, 'max') ? ['package', 'min', 'max'] : ['package', 'min'])
    text(need.package, NAME)
    requireValue(need.package !== c.package, 'a core component needs itself')
    versionKey(need.min)
    if (need.max !== undefined) requireValue(compareVersions(need.max as string, need.min as string) >= 0, 'empty version range')
  }
  const root = object(c.root, Object.hasOwn(c.root as object, 'max') ? ['min', 'max'] : ['min'])
  level(root.min)
  if (root.max !== undefined) { level(root.max); requireValue(root.max >= root.min, 'empty root interface range') }
  validateVerityImage(c.content)
  requireValue(componentId(c) === c.id, 'component identity mismatch')
  return c as unknown as CoreComponent
}

export function parseDeployment(payload: string): Deployment {
  requireValue(Buffer.byteLength(payload) <= MAX_DEPLOYMENT_BYTES, 'deployment too large')
  const raw: unknown = JSON.parse(payload)
  requireValue(canonicalJson(raw) === payload, 'noncanonical or duplicate JSON fields')
  const fields = ['schema', 'board', 'arch', 'product', 'generation', 'version', 'dataPolicy', 'kernel', 'rootfs']
  const d = object(raw, raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'core') ? [...fields, 'core'] : fields)
  requireValue(d.schema === 'mica/deployment/v1' && d.dataPolicy === 'unchanged', 'unsupported deployment schema or DATA policy')
  // The envelope names its board and architecture; which board has which
  // architecture is the board's fact (board.env), checked where the facts are
  // at hand (the assembler, the verifier), not a table here.
  text(d.board, NAME)
  text(d.product, NAME)
  requireValue(d.arch === 'amd64' || d.arch === 'arm64', 'board/architecture mismatch')
  integer(d.generation)
  text(d.version, NAME)
  const k = object(d.kernel, ['schema', 'id', 'board', 'arch', 'buildId', 'release', 'boot', 'support'])
  const r = object(d.rootfs, ['schema', 'id', 'arch', 'content', 'interfaceLevel'])
  const core = d.core ?? []
  requireValue(Array.isArray(core), 'invalid core components')
  requireValue(k.schema === 'mica/kernel/v1' && r.schema === 'mica/rootfs/v1', 'wrong component schema')
  requireValue(k.board === d.board && k.arch === d.arch && r.arch === d.arch, 'component target mismatch')
  text(k.id, HEX)
  text(r.id, HEX)
  text(k.buildId, HEX)
  text(k.release, NAME)
  const boot = object(k.boot, ['format', 'artifact'])
  requireValue(boot.format === 'uki' || boot.format === 'fit', 'wrong boot format')
  artifact(boot.artifact)
  validateVerityImage(k.support)
  validateVerityImage(r.content)
  level(r.interfaceLevel)
  requireValue(r.interfaceLevel >= 1, 'invalid interface level')
  requireValue(componentId(k) === k.id && componentId(r) === r.id, 'component identity mismatch')
  // The core components agree with one another and with this deployment's own root: one per package, in package
  // order, each on this architecture and this root's interface level, each need met here.
  requireValue(core.length <= MAX_CORE_COMPONENTS, 'too many core components')
  const cores = core.map(c => validateCoreComponent(c, d.arch as string))
  requireValue(cores.every((c, i) => i === 0 || cores[i - 1]!.package < c.package), 'core components not unique and sorted by package')
  for (const c of cores) {
    requireValue(runsOn(c, r.interfaceLevel), 'a core component does not run on this root\'s interface level')
    for (const need of c.needs) {
      const found = cores.find(other => other.package === need.package)
      requireValue(found !== undefined, 'a core component\'s need is not in the deployment')
      requireValue(compareVersions(found.version, need.min) >= 0 && (need.max === undefined || compareVersions(found.version, need.max) <= 0), 'a core component\'s need is outside its version range')
    }
  }
  return raw as Deployment
}

function base64(value: unknown, length?: number): Buffer {
  requireValue(typeof value === 'string', 'expected base64')
  const bytes = Buffer.from(value, 'base64')
  requireValue(bytes.toString('base64') === value && (length === undefined || bytes.length === length), 'invalid base64 or length')
  return bytes
}

/**
 * The device's product: the single unquoted PRODUCT=<name> line of
 * /usr/lib/mica/product.conf in the running root (other lines are ignored), as
 * mica-deploy reads it; a missing, repeated, quoted or malformed line is refused.
 */
export function productFromConf(conf: string): string {
  const lines = conf.split('\n').filter(line => line.startsWith('PRODUCT='))
  requireValue(lines.length === 1, 'product.conf must carry exactly one PRODUCT= line')
  const product = lines[0]!.slice('PRODUCT='.length)
  text(product, NAME)
  return product
}

/** Authenticate the bounded envelope before parsing its component schema. */
export function authenticatePayload(bytes: string, publicKeys: readonly string[], limit = MAX_DEPLOYMENT_BYTES): string {
  requireValue(Buffer.byteLength(bytes) <= Math.max(MAX_ENVELOPE_BYTES, Math.floor(limit * 4 / 3) + 1024), 'envelope too large')
  const raw: unknown = JSON.parse(bytes)
  const e = object(raw, ['schema', 'keyId', 'payload', 'signature'])
  requireValue(JSON.stringify({ schema: e.schema, keyId: e.keyId, payload: e.payload, signature: e.signature }) === bytes, 'noncanonical or duplicate envelope fields')
  requireValue(e.schema === 'mica/update-envelope/v1', 'wrong envelope schema')
  text(e.keyId, HEX)
  requireValue(publicKeys.length > 0 && publicKeys.length <= 8, 'invalid trust set')
  const keys = publicKeys.map(key => base64(key, 32))
  const key = keys.find(key => sha256(key) === e.keyId)
  requireValue(key, 'untrusted metadata key')
  const payload = base64(e.payload)
  requireValue(payload.length <= limit, 'payload too large')
  const signature = base64(e.signature, 64)
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') }, format: 'jwk' })
  requireValue(verify(null, payload, publicKey, signature), 'metadata signature rejected')
  return new TextDecoder('utf-8', { fatal: true }).decode(payload)
}

/** Authenticate a descriptor before publication or component acquisition. */
export function authenticateDeployment(bytes: string, publicKeys: readonly string[]): Deployment {
  return parseDeployment(authenticatePayload(bytes, publicKeys))
}

/** The identities a release lock's product row records, out of an authenticated descriptor. */
export function deploymentIdentity(bytes: string, publicKeys: readonly string[]) {
  const d = authenticateDeployment(bytes, publicKeys)
  return { product: d.product, board: d.board, generation: d.generation, deployment: componentId(d), kernel: d.kernel.id, rootfs: d.rootfs.id, kernelBuildId: d.kernel.buildId }
}

/** Bind authenticated metadata to the running UKI/FIT inputs. */
export function verifyDeployment(bytes: string, publicKeys: readonly string[], running: BootIdentity): Deployment {
  const d = authenticateDeployment(bytes, publicKeys)
  requireValue(d.board === running.board && d.arch === running.arch && d.kernel.buildId === running.kernelBuildId
    && d.kernel.release === running.kernelRelease && componentId(d.kernel.support) === running.supportId, 'running kernel/support mismatch')
  return d
}

/** Relative paths under SYSTEM, except the UEFI boot path under ESP. */
export function deploymentPaths(descriptor: Deployment) {
  const d = parseDeployment(canonicalJson(descriptor))
  return {
    rootfs: `roots/${d.rootfs.id}/rootfs.img`,
    support: `kernels/${d.kernel.id}/support.img`,
    boot: d.kernel.boot.format === 'uki' ? `EFI/mica/kernels/${d.kernel.id}.efi` : `kernels/${d.kernel.id}/boot.itb`,
    core: (d.core ?? []).map(c => ({ package: c.package, image: `cores/${c.id}/core.img`, signature: `cores/${c.id}/core.roothash.p7s` })),
  }
}

/** Publication/download integrity check; early boot uses signed dm-verity. */
export function verifyObject(bytes: Uint8Array, expected: Artifact): void {
  artifact(expected)
  requireValue(bytes.byteLength === expected.bytes && sha256(bytes) === expected.sha256, 'artifact length or digest mismatch')
}
