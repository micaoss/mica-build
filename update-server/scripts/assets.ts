import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
await mkdir(join(root, '.generated'), { recursive: true })
const result = await Bun.build({
  entrypoints: [join(root, 'web/app.ts')],
  target: 'browser',
  minify: true,
})
if (!result.success)
  throw new AggregateError(result.logs, 'Console build failed')
const output = result.outputs[0]
if (!output)
  throw new Error('Console build produced no JavaScript')
await Bun.write(join(root, '.generated/client.js'), output)
