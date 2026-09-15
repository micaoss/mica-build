import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packArchive } from '../../build/src/component-archive'
import { componentId } from '../../build/src/components'
import { createService } from './app'
import { artifact, deployment, image, small } from './component-fixture'
import { parseConfig } from './config'
import { importArchive, readArchive } from './modules/archive'

const adminToken = 'test-admin-token-with-at-least-32-characters'
const origin = 'http://updates.localhost'
let directory: string
let service: Awaited<ReturnType<typeof createService>>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mica-updates-import-'))
  service = await createService(parseConfig({ ADMIN_TOKEN: adminToken, DATA_DIR: join(directory, 'data'), PUBLIC_URL: origin, MAX_UPLOAD_BYTES: '16384', LOG_LEVEL: 'silent' }))
})
afterEach(async () => {
  service?.close()
  await rm(directory, { recursive: true, force: true })
})

/** A signed x64-dev deployment's objects on disk, packed as the given update kind. */
async function archive(kind: 'full' | 'root' | 'kernel', product = 'x64-dev') {
  for (const name of ['kernel', 'root']) await mkdir(join(directory, name), { recursive: true })
  await writeFile(join(directory, 'kernel/boot.efi'), small)
  await writeFile(join(directory, 'kernel/support.img'), image)
  await writeFile(join(directory, 'kernel/support.roothash.p7s'), small)
  await writeFile(join(directory, 'root/rootfs.img'), image)
  // The root's signature differs from the kernel's, so a root or kernel package carries fewer objects than the full one.
  const rootSignature = Buffer.from('root signature bytes')
  await writeFile(join(directory, 'root/rootfs.roothash.p7s'), rootSignature)
  const d = deployment(1, 'x64', product)
  d.rootfs.content.signature = artifact(rootSignature)
  d.rootfs.id = componentId(d.rootfs)
  const envelope = JSON.stringify(service.service.signer.sign(d))
  const output = join(directory, `${product}.${kind}.micaupd`)
  packArchive(envelope, join(directory, 'kernel'), join(directory, 'root'), [service.service.signer.publicKey], output, kind)
  return output
}
const fetcher = (url: string, init: RequestInit) => service.app.request(url, init)

test('a full update package imports as a complete draft of its product, and publishes', async () => {
  const id = await importArchive(await archive('full'), { origin, token: adminToken, channel: 'stable', fetch: fetcher })
  const release = service.service.view(service.service.get(id))
  expect(release.product).toBe('x64-dev')
  expect(release.objects.every(object => object.available)).toBe(true)
  const published = await service.app.request(`${origin}/api/releases/${id}/publish`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } })
  expect(published.status).toBe(200)
})

test('a root or kernel package is refused before any draft exists: the server serves complete releases', async () => {
  for (const kind of ['root', 'kernel'] as const)
    await expect(importArchive(await archive(kind, `x64-${kind}`), { origin, token: adminToken, channel: 'stable', fetch: fetcher })).rejects.toThrow('not a full update package')
  expect(service.service.list()).toHaveLength(0)
})

test('an archive with altered object bytes is refused by the digest check', async () => {
  const path = await archive('full')
  const { objects } = await readArchive(path)
  const bytes = await readFile(path)
  const offset = objects.find(object => object.bytes === image.length)!.offset
  bytes[offset] = bytes[offset]! ^ 0xFF
  await writeFile(path, bytes)
  await expect(importArchive(path, { origin, token: adminToken, channel: 'stable', fetch: fetcher })).rejects.toThrow('answered 400')
})

test('truncated and trailing archives are refused before anything is sent', async () => {
  const path = await archive('full')
  const bytes = await readFile(path)
  await writeFile(path, bytes.subarray(0, bytes.length - 1))
  await expect(readArchive(path)).rejects.toThrow(/truncated|missing/)
  await writeFile(path, Buffer.concat([bytes, Buffer.from('x')]))
  await expect(readArchive(path)).rejects.toThrow('trailing')
})
