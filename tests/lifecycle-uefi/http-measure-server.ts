// Measure completed public response bodies while executing the production service.
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createService } from '../../update-server/src/app.ts'
import { parseConfig } from '../../update-server/src/config.ts'

const [workArg, evidenceArg, origin] = Bun.argv.slice(2)
if (!workArg || !evidenceArg || !origin) throw new Error('Usage: http-measure-server.ts WORK EVIDENCE HTTP_ORIGIN')
const work = resolve(workArg), evidence = resolve(evidenceArg), url = new URL(origin)
if (url.protocol !== 'http:' || !url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected explicit local HTTP origin and port')
const service = await createService(parseConfig({
  ADMIN_TOKEN: readFileSync(join(work, 'admin-token'), 'utf8').trim(),
  HOST: '0.0.0.0', PORT: url.port, PUBLIC_URL: url.origin, DATA_DIR: join(work, 'data'),
  SIGNING_KEY_FILE: join(evidence, 'metadata.key.pem'),
  METADATA_TRUST_KEYS: JSON.stringify([readFileSync(join(evidence, 'metadata.pub'), 'utf8').trim()]),
  LOG_LEVEL: 'silent', NODE_ENV: 'production',
}))
const server = Bun.serve({ hostname: '0.0.0.0', port: Number(url.port), maxRequestBodySize: 1024 ** 3, idleTimeout: 60,
  async fetch(request) {
    const response = await service.app.fetch(request)
    const path = new URL(request.url).pathname
    if (request.method !== 'GET' || !path.startsWith('/v1/') || !response.body) return response
    let bytes = 0
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk) },
      flush() { appendFileSync(join(work, 'responses.jsonl'), `${JSON.stringify({ path, status: response.status, bytes })}\n`) },
    }))
    return new Response(counted, { status: response.status, headers: response.headers })
  },
})
console.log(`FILE_AB_HTTP_SERVER_READY: ${server.port}`)
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await server.stop(true)
  service.close()
}
process.on('SIGTERM', () => { void stop() })
process.on('SIGINT', () => { void stop() })
