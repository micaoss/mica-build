import type { Config } from './config'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { desc } from 'drizzle-orm'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import pino from 'pino'
import { ZodError } from 'zod'
import { authenticateDeployment, authenticatePayload } from '../../build/src/components'
import { authenticateFirmware } from '../../build/src/firmware'
import { createDb } from './db'
import { audit, catalogs } from './db/schema'
import { Auth } from './modules/auth'
import * as contract from './modules/contract'
import { download } from './modules/download'
import { FirmwareService } from './modules/firmware'
import { ReleaseService } from './modules/releases'
import { loadSigner } from './modules/signing'
import { AppError } from './shared/errors'

export interface Assets { html: string, js: string, css: string }

export async function createService(config: Config, assets?: Assets) {
  await mkdir(join(config.dataDir, 'objects'), { recursive: true, mode: 0o700 })
  const signer = await loadSigner(config)
  const publicKeys = [...new Set([signer.publicKey, ...config.metadataTrustKeys])]
  if (publicKeys.length > 8)
    throw new Error('Metadata trust set exceeds eight keys')
  const store = createDb(config.dataDir)
  const logger = pino({ level: config.logLevel })
  const service = new ReleaseService(store, config, signer, publicKeys)
  const maintenance = new FirmwareService(store, config, signer, publicKeys)
  try {
    const existing = store.db.select().from(catalogs).get()
    if (existing) {
      const previous = JSON.parse(authenticatePayload(existing.envelope, publicKeys, 1048576))
      if (previous.schema !== 'mica/catalog/v1' || previous.revision !== existing.revision)
        throw new Error('Persisted catalog differs from the signed revision')
    }
    // Removing a key requires withdrawing every published manifest that needs
    // it. Installed deployments keep their independent offline boot policy.
    for (const release of service.list().filter(record => record.status === 'published'))
      authenticateDeployment(release.deployment, publicKeys)
    for (const firmware of maintenance.list().filter(record => record.status === 'published'))
      authenticateFirmware(firmware.firmware, publicKeys)
    if (!existing || JSON.parse(existing.envelope).keyId !== signer.keyId)
      service.refresh()
  }
  catch (error) {
    store.close()
    throw error
  }
  const auth = new Auth(store, config)
  const app = new OpenAPIHono({ defaultHook: (result) => {
    if (!result.success)
      throw result.error
  } })
  app.use(requestId())
  app.use(async (c, next) => secureHeaders({
    ...(c.req.path === '/docs' ? {} : { contentSecurityPolicy: { defaultSrc: ['\'none\''], scriptSrc: ['\'self\''], styleSrc: ['\'self\''], connectSrc: ['\'self\''], imgSrc: ['\'self\'', 'data:'], frameAncestors: ['\'none\''], formAction: ['\'self\''], baseUri: ['\'none\''] } }),
    strictTransportSecurity: config.publicUrl.startsWith('https:') ? 'max-age=31536000' : false,
  })(c, next))
  app.use(async (c, next) => {
    const start = performance.now()
    await next()
    logger.info({ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Math.round(performance.now() - start) }, 'request')
  })
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (c.req.path === '/api/session' && (c.req.method === 'GET' || c.req.method === 'POST'))
      return next()
    if (!auth.authenticated(c))
      throw new AppError(401, 'unauthorized', 'Administrator authentication required')
    if (!['GET', 'HEAD'].includes(c.req.method) && !auth.bearer(c))
      auth.requireOrigin(c)
    await next()
  })
  // Artifact bodies bypass the JSON middleware and are bounded while streaming.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'PUT' && /^\/api\/(?:releases|firmware)\/[^/]+\/objects\/[a-f0-9]{64}$/.test(c.req.path))
      return next()
    return bodyLimit({ maxSize: 65536, onError: () => {
      throw new AppError(413, 'body_too_large', 'Request exceeds 64 KiB')
    } })(c, next)
  })
  app.get('/healthz', (c) => {
    service.catalog()
    return c.json({ status: 'ok' })
  })
  app.openapi(createRoute({ method: 'get', path: '/api/session', operationId: 'getSession', responses: { 200: { description: 'Current session', content: contract.json(contract.session) }, ...contract.errors } }), c => c.json({ authenticated: auth.authenticated(c) }, 200))
  app.openapi(createRoute({ method: 'post', path: '/api/session', operationId: 'login', request: { body: { required: true, content: contract.json(contract.login) } }, responses: { 200: { description: 'Session created', content: contract.json(contract.session) }, ...contract.errors } }), (c) => {
    auth.login(c, c.req.valid('json').token)
    return c.json({ authenticated: true }, 200)
  })
  app.openapi(createRoute({ method: 'delete', path: '/api/session', operationId: 'logout', security: contract.security, responses: { 200: { description: 'Session removed', content: contract.json(contract.session) }, ...contract.errors } }), (c) => {
    auth.logout(c)
    return c.json({ authenticated: false }, 200)
  })
  app.openapi(createRoute({ method: 'get', path: '/api/releases', operationId: 'listReleases', security: contract.security, responses: { 200: { description: 'Release list', content: contract.json(z.object({ releases: z.array(contract.releaseView) })) }, ...contract.errors } }), c => c.json({ releases: service.list().map(release => service.view(release)) }, 200))
  app.openapi(createRoute({ method: 'post', path: '/api/releases', operationId: 'createRelease', security: contract.security, request: { body: { required: true, content: contract.json(contract.releaseInput) } }, responses: { 201: { description: 'Draft created', content: contract.json(contract.releaseView) }, ...contract.errors } }), c => c.json(service.create(c.req.valid('json')), 201))
  app.openapi(createRoute({ method: 'put', path: '/api/releases/{id}/objects/{digest}', operationId: 'uploadObject', security: contract.security, request: { params: contract.objectParams, body: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } }, responses: { 200: { description: 'Verified object stored', content: contract.json(contract.releaseView) }, ...contract.errors } }), async (c) => {
    const { id, digest } = c.req.valid('param')
    return c.json(await service.upload(id, digest, c.req.raw), 200)
  })
  for (const action of ['publish', 'withdraw'] as const) {
    app.openapi(createRoute({ method: 'post', path: `/api/releases/{id}/${action}`, operationId: `${action}Release`, security: contract.security, request: { params: contract.id }, responses: { 200: { description: 'Release updated', content: contract.json(contract.releaseView) }, ...contract.errors } }), async c => c.json(await service.transition(c.req.valid('param').id, action), 200))
  }
  app.openapi(createRoute({ method: 'post', path: '/api/metadata/refresh', operationId: 'refreshCatalog', security: contract.security, responses: { 200: { description: 'Catalog refreshed', content: contract.json(contract.revision.extend({ id: z.number().int() })) }, ...contract.errors } }), (c) => {
    const { envelope: _envelope, ...catalog } = service.refresh()
    return c.json(catalog, 200)
  })
  app.openapi(createRoute({ method: 'get', path: '/api/firmware', operationId: 'listFirmware', security: contract.security, responses: { 200: { description: 'Independent firmware maintenance artifacts', content: contract.json(z.object({ firmware: z.array(contract.firmwareView) })) }, ...contract.errors } }), c => c.json({ firmware: maintenance.list().map(record => maintenance.view(record)) }, 200))
  app.openapi(createRoute({ method: 'post', path: '/api/firmware', operationId: 'createFirmware', security: contract.security, request: { body: { required: true, content: contract.json(contract.firmwareInput) } }, responses: { 201: { description: 'Firmware draft created', content: contract.json(contract.firmwareView) }, ...contract.errors } }), c => c.json(maintenance.create(c.req.valid('json')), 201))
  app.openapi(createRoute({ method: 'put', path: '/api/firmware/{id}/objects/{digest}', operationId: 'uploadFirmware', security: contract.security, request: { params: contract.objectParams, body: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } }, responses: { 200: { description: 'Verified firmware stored', content: contract.json(contract.firmwareView) }, ...contract.errors } }), async (c) => {
    const { id, digest } = c.req.valid('param')
    return c.json(await maintenance.upload(id, digest, c.req.raw), 200)
  })
  for (const action of ['publish', 'withdraw'] as const) {
    app.openapi(createRoute({ method: 'post', path: `/api/firmware/{id}/${action}`, operationId: `${action}Firmware`, security: contract.security, request: { params: contract.id }, responses: { 200: { description: 'Firmware publication updated', content: contract.json(contract.firmwareView) }, ...contract.errors } }), async c => c.json(await maintenance.transition(c.req.valid('param').id, action), 200))
  }
  app.openapi(createRoute({ method: 'get', path: '/v1/firmware/{id}', operationId: 'getPublishedFirmware', request: { params: contract.id }, responses: { 200: { description: 'Signed maintenance manifest and object reference', content: contract.json(z.object({ firmware: z.string(), object: z.object({ sha256: contract.digest, bytes: z.number().int(), url: z.string() }) })) }, ...contract.errors } }), (c) => {
    const record = maintenance.get(c.req.valid('param').id)
    if (record.status !== 'published')
      throw new AppError(404, 'not_found', 'Published firmware not found')
    c.header('Cache-Control', 'no-store')
    return c.json({ firmware: record.firmware, object: { sha256: record.artifactSha256, bytes: record.artifactBytes, url: `${config.publicUrl}/v1/objects/${record.artifactSha256}` } }, 200)
  })
  app.openapi(createRoute({ method: 'get', path: '/api/status', operationId: 'getStatus', security: contract.security, responses: { 200: { description: 'Server status', content: contract.json(contract.status) }, ...contract.errors } }), (c) => {
    const { envelope: _envelope, id: _id, ...catalog } = service.catalog()
    return c.json({ ...catalog, expired: Date.now() >= Date.parse(catalog.expiresAt), manifestUrl: `${config.publicUrl}/v1/manifest.json`, maxUploadBytes: config.maxUploadBytes, metadataTtlHours: config.metadataTtlHours, signing: { publicKey: signer.publicKey, keyId: signer.keyId, generated: signer.generated }, protocol: 'mica/catalog/v1' as const }, 200)
  })
  app.openapi(createRoute({ method: 'get', path: '/api/audit', operationId: 'listAudit', security: contract.security, responses: { 200: { description: 'Recent audit events', content: contract.json(z.object({ events: z.array(contract.event) })) }, ...contract.errors } }), c => c.json({ events: store.db.select().from(audit).orderBy(desc(audit.id)).limit(100).all() }, 200))
  app.openapi(createRoute({ method: 'get', path: '/v1/manifest.json', operationId: 'getCatalog', responses: { 200: { description: 'Exact signed catalog envelope', content: contract.json(contract.envelope) }, ...contract.errors } }), (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'application/json')
    return c.json(contract.envelope.parse(JSON.parse(service.catalog().envelope)), 200)
  })
  for (const method of ['get', 'head'] as const) {
    app.openapi(createRoute({ method, path: '/v1/objects/{digest}', operationId: method === 'get' ? 'downloadObject' : 'headObject', request: { params: z.object({ digest: contract.digest }) }, responses: { 200: { description: 'Object bytes or metadata', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 206: { description: 'Partial object bytes' }, 304: { description: 'Not modified' }, 416: { description: 'Unsatisfiable byte range' }, ...contract.errors } }), c => download(c, service))
  }
  if (config.docsEnabled) {
    app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', { type: 'http', scheme: 'bearer' })
    app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', { type: 'apiKey', in: 'cookie', name: 'mica_update_session' })
    app.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'Mica OS Component Update Service', version: '0.1.0' } })
    app.get('/docs', async (c, next) => {
      const nonce = randomUUID()
      c.header('Content-Security-Policy', `default-src 'none'; script-src 'self' https://cdn.jsdelivr.net 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src data:; frame-ancestors 'none'`)
      return Scalar({ url: '/openapi.json', pageTitle: 'Mica OS Component Update API', withDefaultFonts: false, nonce, cdn: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.68.0/dist/browser/standalone.js', defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' } })(c, next)
    })
  }
  if (assets) {
    app.get('/', c => c.html(assets.html))
    app.get('/app.js', (c) => {
      c.header('Content-Type', 'text/javascript')
      return c.body(assets.js)
    })
    app.get('/style.css', (c) => {
      c.header('Content-Type', 'text/css')
      return c.body(assets.css)
    })
  }
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404))
  app.onError((error, c) => {
    if (error instanceof AppError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status)
    if (error instanceof ZodError)
      return c.json({ error: { code: 'validation_error', message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') } }, 400)
    if (error instanceof SyntaxError || error instanceof HTTPException)
      return c.json({ error: { code: 'invalid_request', message: 'Invalid request body' } }, 400)
    logger.error({ err: error, requestId: c.get('requestId') }, 'request failed')
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500)
  })
  return { app, store, service, logger, close: () => store.close() }
}
