import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { z } from 'zod'

const trustKeys = z.string().default('[]').transform((value, context) => {
  try {
    return JSON.parse(value) as unknown
  }
  catch {
    context.addIssue({ code: 'custom', message: 'Expected a JSON array of Ed25519 public keys' })
    return z.NEVER
  }
}).pipe(z.array(z.string().refine((key) => {
  const bytes = Buffer.from(key, 'base64')
  return bytes.length === 32 && bytes.toString('base64') === key
}, 'Expected a canonical 32-byte base64 public key')).max(8))

const environmentSchema = z.object({
  ADMIN_TOKEN: z.string().min(32),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000').refine((value) => {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  }, 'PUBLIC_URL must be an HTTP(S) origin without a path or credentials'),
  DATA_DIR: z.string().min(1).default('.data'),
  SIGNING_KEY_FILE: z.string().min(1).optional(),
  METADATA_TRUST_KEYS: trustKeys,
  METADATA_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(8 * 1024 ** 3).default(1024 ** 3),
  DOCS_ENABLED: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
})

export function parseConfig(env: Record<string, string | undefined>) {
  const result = environmentSchema.safeParse({ ...env, PUBLIC_URL: env.PUBLIC_URL ?? env.NSL_URL, DOCS_ENABLED: env.DOCS_ENABLED ?? (env.NODE_ENV === 'production' ? 'false' : 'true') })
  if (!result.success)
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  const value = result.data
  return {
    adminToken: value.ADMIN_TOKEN,
    host: value.HOST,
    port: value.PORT,
    publicUrl: new URL(value.PUBLIC_URL).origin,
    dataDir: resolve(value.DATA_DIR),
    signingKeyFile: value.SIGNING_KEY_FILE ? resolve(value.SIGNING_KEY_FILE) : undefined,
    metadataTrustKeys: value.METADATA_TRUST_KEYS,
    metadataTtlHours: value.METADATA_TTL_HOURS,
    maxUploadBytes: value.MAX_UPLOAD_BYTES,
    logLevel: value.LOG_LEVEL,
    docsEnabled: value.DOCS_ENABLED === 'true',
  }
}

export type Config = ReturnType<typeof parseConfig>
