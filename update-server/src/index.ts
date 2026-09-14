import process from 'node:process'
import { createService } from './app'
import { assets } from './assets'
import { parseConfig } from './config'

const config = parseConfig(process.env)
const service = await createService(config, assets)
let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({ hostname: config.host, port: config.port, maxRequestBodySize: config.maxUploadBytes, idleTimeout: 60, fetch: service.app.fetch })
}
catch (error) {
  service.close()
  throw error
}
service.logger.info({ host: config.host, port: server.port, publicUrl: config.publicUrl }, 'update server listening')
let stopping = false
async function shutdown() {
  if (stopping)
    return
  stopping = true
  service.logger.info('update server stopping')
  const deadline = setTimeout(() => {
    void server.stop(true)
  }, 10000)
  deadline.unref()
  await server.stop()
  clearTimeout(deadline)
  service.close()
}
process.on('SIGTERM', () => {
  void shutdown()
})
process.on('SIGINT', () => {
  void shutdown()
})
