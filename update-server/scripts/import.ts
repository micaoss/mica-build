// Import one mica-build full update package into a running update server as a draft release.
//
//   bun scripts/import.ts --channel stable [--notes TEXT] (--archive FILE.micaupd | --oci REFERENCE)
//
// UPDATE_SERVER_URL and ADMIN_TOKEN name the server. --oci reads the full layer of
// mica-build's update.<product>.<release> manifest anonymously from ghcr.io by digest.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { importArchive } from '../src/modules/archive'

const { values } = parseArgs({ options: { channel: { type: 'string' }, notes: { type: 'string' }, archive: { type: 'string' }, oci: { type: 'string' } }, strict: true })
const origin = process.env.UPDATE_SERVER_URL
const token = process.env.ADMIN_TOKEN
if (!origin || !token || !values.channel || !!values.archive === !!values.oci)
  throw new Error('usage: UPDATE_SERVER_URL=... ADMIN_TOKEN=... bun scripts/import.ts --channel CHANNEL [--notes TEXT] (--archive FILE | --oci REFERENCE)')

let path = values.archive
let work: string | undefined
try {
  if (values.oci) {
    const match = /^ghcr\.io\/([a-z0-9-]+\/[a-z0-9._-]+)(?::[\w.-]+)?@(sha256:[0-9a-f]{64})$/.exec(values.oci)
    if (!match)
      throw new Error('--oci must be ghcr.io/<owner>/<name>[:<tag>]@sha256:<digest>')
    const [, repository, digest] = match
    const token = (await (await fetch(`https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io`)).json() as { token: string }).token
    const get = async (what: string, accept: string) => {
      const response = await fetch(`https://ghcr.io/v2/${repository}/${what}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept } })
      if (response.status !== 200)
        throw new Error(`reading ${what} answered ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    }
    const manifestBytes = await get(`manifests/${digest}`, 'application/vnd.oci.image.manifest.v1+json')
    if (`sha256:${createHash('sha256').update(manifestBytes).digest('hex')}` !== digest)
      throw new Error('the manifest bytes are not its digest')
    const manifest = JSON.parse(manifestBytes.toString()) as { layers: { digest: string, annotations?: Record<string, string> }[] }
    const layers = manifest.layers.filter(layer => layer.annotations?.['mica.update-kind'] === 'full')
    if (layers.length !== 1)
      throw new Error('the manifest has no single full update layer')
    work = await mkdtemp(join(tmpdir(), 'mica-import-'))
    path = join(work, 'update.micaupd')
    const blob = await fetch(`https://ghcr.io/v2/${repository}/blobs/${layers[0]!.digest}`, { headers: { Authorization: `Bearer ${token}` } })
    if (blob.status !== 200)
      throw new Error(`reading the full layer answered ${blob.status}`)
    await Bun.write(path, blob)
    const hash = createHash('sha256')
    for await (const chunk of Bun.file(path).stream())
      hash.update(chunk)
    if (`sha256:${hash.digest('hex')}` !== layers[0]!.digest)
      throw new Error('the layer bytes are not its digest')
  }
  const id = await importArchive(path!, { origin, token, channel: values.channel, notes: values.notes })
  process.stdout.write(`Imported draft release ${id}; publish it after review.\n`)
}
finally {
  if (work)
    await rm(work, { recursive: true, force: true })
}
