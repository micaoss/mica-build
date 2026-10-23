// The images of an offline pin made usable by docker and buildx, for a local build only.
//
// An offline lock names its images `local/<repository>[:<tag>]@sha256:<digest>` (mica-build-tools release-lock.md
// section 6), and they resolve only inside `<CHECKOUT>/_out/offline/oci/` of that repository's pin. No registry
// serves them, so:
//   - `docker run` and `docker create` take the image from the daemon's store: loadLocalImage hands docker the
//     image's blobs, read out of the layout by digest, under the very reference the lock names (the daemon's
//     containerd store keeps the manifest digest, so `local/<repository>@sha256:<digest>` then resolves locally);
//   - a buildx build, whose docker-container builders never see that store, takes the layout as a named context:
//     imageContexts gives `--build-context <reference>=oci-layout://<layout>@sha256:<digest>` for every local
//     reference among its arguments, which a `FROM <reference>` then resolves.
// Both refuse under CI, as the offline pin does (checkout-in-ci).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { modeOf } from '@mica/build-tools'
import { inputs, REPO_ROOT, type Records } from './inputs.ts'

export class LocalImageError extends Error {}

const LOCAL = /^local\/([a-z0-9][a-z0-9-]*)(?::[A-Za-z0-9._-]+)?@sha256:([0-9a-f]{64})$/
const IN_ARGUMENT = /local\/[a-z0-9][a-z0-9-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}/g
const INDEX = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']

function fail(message: string): never {
  throw new LocalImageError(`local image: error: ${message}`)
}

export const isLocalImage = (reference: string): boolean => LOCAL.test(reference)

/** The OCI layout a local reference resolves in, and its digest. */
export function localLayout(reference: string, records: Records = inputs(), env: NodeJS.ProcessEnv = process.env): { layout: string, digest: string } {
  const m = LOCAL.exec(reference)
  if (m === null) fail(`'${reference}' is not local/<repository>[:<tag>]@sha256:<digest>`)
  if (modeOf(env) === 'ci') fail(`${reference} is an offline build's image; CI reads published releases only`)
  const checkouts = [...new Set(records.filter(i => i.name.split('.')[0] === m[1]).map(i => i.pin['CHECKOUT'] ?? ''))]
  if (checkouts.length !== 1 || checkouts[0] === '') fail(`locks/ names no one offline checkout of ${m[1]}, so ${reference} names nothing`)
  const layout = join(checkouts[0]!, '_out/offline/oci')
  if (!existsSync(join(layout, 'blobs/sha256', m[2]!))) fail(`${layout} holds no blob ${m[2]}, which ${reference} names`)
  return { layout, digest: m[2]! }
}

/** `--build-context` pairs for every local reference among a build's arguments, each once. */
export function imageContexts(argv: readonly string[], records?: Records, env: NodeJS.ProcessEnv = process.env): string[] {
  const refs = [...new Set(argv.flatMap(a => a.match(IN_ARGUMENT) ?? []))].sort()
  if (refs.length === 0) return []
  const checked = records ?? inputs()
  return refs.flatMap((ref) => {
    const { layout, digest } = localLayout(ref, checked, env)
    return ['--build-context', `${ref}=oci-layout://${layout}@sha256:${digest}`]
  })
}

/** The blobs an image needs out of its layout: the manifest or index named, every manifest an index holds there,
 * each manifest's config and layers. Each is read by digest and must hash to it. */
function closure(layout: string, digest: string): { digests: string[], mediaType: string, size: number } {
  const seen = new Set<string>()
  const blob = (d: string) => {
    const path = join(layout, 'blobs/sha256', d)
    if (!existsSync(path)) fail(`${layout} holds no blob ${d}`)
    const bytes = readFileSync(path)
    if (createHash('sha256').update(bytes).digest('hex') !== d) fail(`${path} does not hash to its name`)
    seen.add(d)
    return bytes
  }
  const walk = (d: string, optional: boolean): string => {
    if (optional && !existsSync(join(layout, 'blobs/sha256', d))) return ''
    const m = JSON.parse(blob(d).toString('utf8')) as { mediaType?: string, manifests?: { digest: string }[], config?: { digest: string }, layers?: { digest: string }[] }
    const mediaType = m.mediaType ?? ''
    if (INDEX.includes(mediaType)) { for (const c of m.manifests ?? []) walk(c.digest.slice('sha256:'.length), true) }
    else {
      if (m.config === undefined) fail(`blob ${d} of ${layout} is no image manifest or index`)
      for (const b of [m.config, ...(m.layers ?? [])]) blob(b.digest.slice('sha256:'.length))
    }
    return mediaType
  }
  const mediaType = walk(digest, false)
  return { digests: [...seen].sort(), mediaType, size: readFileSync(join(layout, 'blobs/sha256', digest)).length }
}

/** The image of a local reference in docker's store, loaded from its layout when it is not there yet. */
export function loadLocalImage(reference: string, records?: Records, env: NodeJS.ProcessEnv = process.env): void {
  const { layout, digest } = localLayout(reference, records ?? inputs(), env)
  const docker = env['MICA_BUILD_DOCKER'] || 'docker'
  if (Bun.spawnSync([docker, 'image', 'inspect', reference], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0) return
  const { digests, mediaType, size } = closure(layout, digest)
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/.local-image.'))
  try {
    // The name docker records the image under: the reference's repository as docker's client spells it (docker.io/
    // before a name with no registry), tagged sha256-<hex>, since a bare 64-hex tag reads as an image id.
    const name = `docker.io/${reference.split('@')[0]!.split(':')[0]}:sha256-${digest}`
    writeFileSync(join(work, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n')
    writeFileSync(join(work, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType, digest: `sha256:${digest}`, size,
      annotations: { 'io.containerd.image.name': name, 'org.opencontainers.image.ref.name': digest } }] }) + '\n')
    // The layout's own blobs, read where they are; only the index naming the one image is written here.
    const tar = Bun.spawnSync(['tar', '-cf', `${work}.tar`, '-C', work, 'oci-layout', 'index.json', '-C', layout, ...digests.map(d => `blobs/sha256/${d}`)], { stdout: 'pipe', stderr: 'pipe' })
    if (tar.exitCode !== 0) fail(`packing ${reference} failed: ${tar.stderr.toString().trim()}`)
    const loaded = Bun.spawnSync([docker, 'load', '-q', '-i', `${work}.tar`], { stdout: 'pipe', stderr: 'pipe' })
    if (loaded.exitCode !== 0) fail(`docker load of ${reference} failed: ${loaded.stderr.toString().trim()}`)
    if (Bun.spawnSync([docker, 'image', 'inspect', reference], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0)
      fail(`${reference} is not in docker's store after loading it from ${layout}`)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(`${work}.tar`, { force: true })
  }
}
