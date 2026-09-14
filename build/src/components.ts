import { Buffer } from 'node:buffer'
import { createHash, createPublicKey, verify } from 'node:crypto'

export const MAX_DEPLOYMENT_BYTES = 16384
const MAX_ENVELOPE_BYTES = 24576
const HEX = /^[0-9a-f]{64}$/
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/

export interface Artifact { bytes: number, sha256: string }
export interface VerityImage {
  image: Artifact
  rootHash: string
  signature: Artifact
  verity: {
    version: 1, algorithm: 'sha256', dataBlockSize: 4096, hashBlockSize: 4096,
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
  version: string
  content: VerityImage
}
export interface Deployment {
  schema: 'mica/deployment/v1'
  board: string
  arch: string
  generation: number
  version: string
  dataPolicy: 'unchanged'
  kernel: KernelComponent
  rootfs: RootComponent
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
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)]))
    }
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

export function parseDeployment(payload: string): Deployment {
  requireValue(Buffer.byteLength(payload) <= MAX_DEPLOYMENT_BYTES, 'deployment too large')
  const raw: unknown = JSON.parse(payload)
  requireValue(canonicalJson(raw) === payload, 'noncanonical or duplicate JSON fields')
  const d = object(raw, ['schema', 'board', 'arch', 'generation', 'version', 'dataPolicy', 'kernel', 'rootfs'])
  requireValue(d.schema === 'mica/deployment/v1' && d.dataPolicy === 'unchanged', 'unsupported deployment schema or DATA policy')
  // The envelope names its board and architecture; which board has which
  // architecture is the board's fact (board.env), checked where the facts are
  // at hand (the assembler, the verifier), not a table here.
  text(d.board, NAME)
  requireValue(d.arch === 'amd64' || d.arch === 'arm64', 'board/architecture mismatch')
  integer(d.generation)
  text(d.version, NAME)
  const k = object(d.kernel, ['schema', 'id', 'board', 'arch', 'buildId', 'release', 'boot', 'support'])
  const r = object(d.rootfs, ['schema', 'id', 'arch', 'version', 'content'])
  requireValue(k.schema === 'mica/kernel/v1' && r.schema === 'mica/rootfs/v1', 'wrong component schema')
  requireValue(k.board === d.board && k.arch === d.arch && r.arch === d.arch, 'component target mismatch')
  text(k.id, HEX)
  text(r.id, HEX)
  text(k.buildId, HEX)
  text(k.release, NAME)
  text(r.version, NAME)
  const boot = object(k.boot, ['format', 'artifact'])
  requireValue(boot.format === 'uki' || boot.format === 'fit', 'wrong boot format')
  artifact(boot.artifact)
  validateVerityImage(k.support)
  validateVerityImage(r.content)
  requireValue(componentId(k) === k.id && componentId(r) === r.id, 'component identity mismatch')
  return raw as Deployment
}

function base64(value: unknown, length?: number): Buffer {
  requireValue(typeof value === 'string', 'expected base64')
  const bytes = Buffer.from(value, 'base64')
  requireValue(bytes.toString('base64') === value && (length === undefined || bytes.length === length), 'invalid base64 or length')
  return bytes
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
  }
}

/** Publication/download integrity check; early boot uses signed dm-verity. */
export function verifyObject(bytes: Uint8Array, expected: Artifact): void {
  artifact(expected)
  requireValue(bytes.byteLength === expected.bytes && sha256(bytes) === expected.sha256, 'artifact length or digest mismatch')
}
