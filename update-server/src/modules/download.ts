import type { Context } from 'hono'
import type { ReleaseService } from './releases'
import { join } from 'node:path'
import { AppError } from '../shared/errors'

export async function download(c: Context, service: ReleaseService) {
  const object = service.downloadable(c.req.param('digest') ?? '')
  const file = Bun.file(join(service.config.dataDir, 'objects', object.sha256))
  if (!await file.exists() || file.size !== object.bytes)
    throw new AppError(503, 'object_unavailable', 'Object is unavailable')
  const etag = `"${object.sha256}"`
  c.header('ETag', etag)
  c.header('Accept-Ranges', 'bytes')
  c.header('Cache-Control', 'public, max-age=0, must-revalidate')
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Disposition', `attachment; filename="${object.sha256}"`)
  if (c.req.header('If-None-Match') === etag)
    return c.body(null, 304)
  const range = c.req.header('Range')
  const ifRange = c.req.header('If-Range')
  // Range only applies to GET; HEAD reports the complete representation.
  if (range && c.req.method === 'GET' && (!ifRange || ifRange === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    const first = match?.[1] ?? ''
    const last = match?.[2] ?? ''
    const suffix = first === ''
    const start = suffix ? Math.max(0, file.size - Number(last)) : Number(first)
    const end = suffix || last === '' ? file.size - 1 : Math.min(file.size - 1, Number(last))
    if (!match || (!first && !last) || !Number.isSafeInteger(Number(first)) || !Number.isSafeInteger(Number(last)) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size || (suffix && Number(last) === 0)) {
      c.header('Content-Range', `bytes */${file.size}`)
      return c.body(null, 416)
    }
    c.header('Content-Range', `bytes ${start}-${end}/${file.size}`)
    c.header('Content-Length', String(end - start + 1))
    // Bun 1.4's direct file response path loses slice offsets over HTTP.
    // A bounded stream preserves the requested bytes and backpressure.
    const body = file.slice(start, end + 1).stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
    return c.newResponse(body, 206)
  }
  c.header('Content-Length', String(file.size))
  return new Response(c.req.method === 'HEAD' ? null : file, { status: 200, headers: c.res.headers })
}
