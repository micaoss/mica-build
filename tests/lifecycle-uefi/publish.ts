// Publish the exact acceptance deployment through the production HTTP API.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { authenticateDeployment } from '../../build/src/components.ts'

const [evidence, generation, origin, tokenFile] = Bun.argv.slice(2)
if (!evidence || !generation || !origin || !tokenFile) throw new Error('Usage: publish.ts EVIDENCE GENERATION ORIGIN TOKEN_FILE')
const output = join(evidence, 'updates', generation)
const inputs = JSON.parse(readFileSync(join(output, 'inputs.json'), 'utf8'))
const descriptor = readFileSync(join(output, 'offline/deployment.json'), 'utf8')
const publicKey = readFileSync(join(evidence, 'metadata.pub'), 'utf8')
const deployment = authenticateDeployment(descriptor, [publicKey])
const headers = { authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}` }
async function request(path: string, init: RequestInit) {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { ...headers, ...init.headers } })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>>
}
const listed = await request('/api/releases', { method: 'GET' })
const existing = (listed.releases as Record<string, unknown>[]).find(record => record.deploymentId === inputs.id && record.channel === 'stable')
if (existing && (existing.status !== 'draft' || existing.deployment !== descriptor)) throw new Error('Expected the exact draft deployment')
const release = existing ?? await request('/api/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'stable', deployment: descriptor }) })
const id = release.id as string
const missing = new Set((release.objects as { sha256: string, available: boolean }[])
  .filter(object => !object.available).map(object => object.sha256))
for (const [file, artifact] of [
  [join(inputs.kernelDirectory, 'boot.efi'), deployment.kernel.boot.artifact],
  [join(inputs.kernelDirectory, 'support.img'), deployment.kernel.support.image],
  [join(inputs.kernelDirectory, 'support.roothash.p7s'), deployment.kernel.support.signature],
  [join(inputs.rootDirectory, 'rootfs.img'), deployment.rootfs.content.image],
  [join(inputs.rootDirectory, 'rootfs.roothash.p7s'), deployment.rootfs.content.signature],
] as const) {
  if (!missing.delete(artifact.sha256)) continue
  await request(`/api/releases/${id}/objects/${artifact.sha256}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Bun.file(file) })
}
if (missing.size) throw new Error('Required release objects were not supplied')
await request(`/api/releases/${id}/publish`, { method: 'POST' })
writeFileSync(join(evidence, 'offline/source-url'), `${origin}/v1/manifest.json`)
console.log(`FILE_AB_PUBLISH_PASS: ${inputs.id}`)
