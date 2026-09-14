import { randomBytes } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const path = join(import.meta.dir, '..', '.env')
const file = await open(path, 'wx', 0o600).catch((error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    process.stdout.write('Configuration already exists; no files changed.\n')
    return null
  }
  throw error
})
if (file) {
  try {
    await file.writeFile([
      `ADMIN_TOKEN=${randomBytes(32).toString('hex')}`,
      '# Set PUBLIC_URL to the exact external origin when deploying behind HTTPS.',
      '# In development, the origin is discovered from NSL_URL.',
      'HOST=127.0.0.1',
      'PORT=3000',
      'DATA_DIR=.data',
      'METADATA_TTL_HOURS=168',
      'MAX_UPLOAD_BYTES=1073741824',
      'LOG_LEVEL=info',
      '',
    ].join('\n'))
    await file.sync()
    process.stdout.write('Created .env with a private administrator token. Run bun run dev, then use ADMIN_TOKEN from .env to sign in.\n')
  }
  finally {
    await file.close()
  }
}
