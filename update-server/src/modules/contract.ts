import { z } from '@hono/zod-openapi'

export const releaseInput = z.strictObject({
  channel: z.enum(['stable', 'beta', 'dev']),
  deployment: z.string().min(1).max(24576).openapi({ description: 'Exact signed mos/deployment/v1 envelope JSON. The publisher retains its original signature.' }),
  notes: z.string().max(10000).default(''),
}).openapi('CreateRelease')

export const digest = z.string().regex(/^[a-f0-9]{64}$/).openapi('Sha256')
export const releaseView = z.object({
  id: z.string(),
  board: z.string(),
  arch: z.string(),
  channel: z.string(),
  version: z.string(),
  generation: z.number().int().positive(),
  deploymentId: digest,
  deployment: z.string(),
  notes: z.string(),
  status: z.enum(['draft', 'published', 'withdrawn']),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  objects: z.array(z.object({ sha256: digest, bytes: z.number().int().positive(), available: z.boolean() })),
}).openapi('Release')
export type ReleaseView = z.infer<typeof releaseView>

export const firmwareInput = z.strictObject({
  channel: z.enum(['stable', 'beta', 'dev']),
  firmware: z.string().min(1).max(6500).openapi({ description: 'Exact signed mos/firmware/v1 envelope with fixed board and maintenance ranges.' }),
  notes: z.string().max(10000).default(''),
}).openapi('CreateFirmware')
export const firmwareView = releaseView.omit({ deploymentId: true, deployment: true }).extend({
  firmwareId: digest,
  firmware: z.string(),
  artifactSha256: digest,
  artifactBytes: z.number().int().positive(),
}).openapi('Firmware')
export type FirmwareView = z.infer<typeof firmwareView>

export const session = z.object({ authenticated: z.boolean() }).openapi('Session')
export const login = z.strictObject({ token: z.string().min(1).max(1024) }).openapi('Login')
export const revision = z.object({ revision: z.number().int(), issuedAt: z.string(), expiresAt: z.string() }).openapi('CatalogRevision')
export const status = revision.extend({
  expired: z.boolean(),
  manifestUrl: z.string(),
  maxUploadBytes: z.number().int(),
  metadataTtlHours: z.number().int(),
  signing: z.object({ publicKey: z.string(), keyId: digest, generated: z.boolean() }),
  protocol: z.literal('mica/catalog/v1'),
}).openapi('Status')
export type Status = z.infer<typeof status>
export const event = z.object({ id: z.number().int(), action: z.string(), releaseId: z.string().nullable(), detail: z.string(), createdAt: z.string() }).openapi('AuditEvent')
export const envelope = z.object({ schema: z.literal('mos/update-envelope/v1'), keyId: digest, payload: z.string(), signature: z.string() }).openapi('SignedEnvelope')
export const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).openapi('Error')
export const id = z.object({ id: z.string().min(1).max(128) })
export const objectParams = id.extend({ digest })
export function json<T extends z.ZodType>(schema: T) {
  return { 'application/json': { schema } }
}
const failure = { description: 'Request refused or storage failure', content: json(error) }
export const errors = { 400: failure, 401: failure, 403: failure, 404: failure, 409: failure, 413: failure, 415: failure, 429: failure, 500: failure, 503: failure }
export const security = [{ bearerAuth: [] }, { cookieAuth: [] }]
