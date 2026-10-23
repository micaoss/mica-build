import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localRelease } from '../offline/local-release.ts'
import { inputs } from './inputs.ts'
import { imageContexts, loadLocalImage, localLayout } from './local-images.ts'

const work = mkdtempSync(join(tmpdir(), 'local-images-'))
const created: string[] = []
afterAll(() => {
  for (const c of created) Bun.spawnSync(['docker', 'rm', '-f', c], { stdout: 'pipe', stderr: 'pipe' })
  // The loaded images, under the names loadLocalImage gives them.
  for (const ref of [fixture.platform, fixture.index])
    Bun.spawnSync(['docker', 'rmi', `local/mica-build-env:sha256-${ref.split(':').at(-1)}`], { stdout: 'pipe', stderr: 'pipe' })
  rmSync(work, { recursive: true, force: true })
})

function must(argv: string[], cwd?: string): string {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A producer checkout whose offline build wrote section 6's layout: one image, `base`, an index over its amd64
 * manifest, of one layer holding /hello. Its reference and the HELLO it carries. */
const HELLO = `local build ${Date.now()}\n`
function producer(): { checkout: string, platform: string, index: string } {
  const checkout = join(work, 'mica-build-env'), out = join(checkout, '_out/offline'), blobs = join(out, 'oci/blobs/sha256')
  mkdirSync(blobs, { recursive: true })
  must(['git', 'init', '--quiet', checkout])
  writeFileSync(join(checkout, 'README'), 'fixture\n')
  must(['git', '-C', checkout, 'add', 'README'])
  must(['git', '-C', checkout, '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '--quiet', '-m', 'fixture'])
  const put = (bytes: Uint8Array) => {
    writeFileSync(join(blobs, hex(bytes)), bytes)
    return { digest: `sha256:${hex(bytes)}`, size: bytes.length }
  }
  const tree = join(work, 'tree')
  mkdirSync(tree, { recursive: true })
  writeFileSync(join(tree, 'hello'), HELLO)
  const tar = new Uint8Array(Bun.spawnSync(['tar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '-cf', '-', '-C', tree, 'hello'], { stdout: 'pipe' }).stdout)
  const layer = put(Bun.gzipSync(tar))
  const config = put(new TextEncoder().encode(JSON.stringify({ architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [`sha256:${hex(tar)}`] } })))
  const manifest = put(new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] })))
  const index = put(new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', ...manifest, platform: { architecture: 'amd64', os: 'linux' } }] })))
  writeFileSync(join(out, 'oci/oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n')
  const commit = must(['git', '-C', checkout, 'rev-parse', 'HEAD']).trim()
  const platform = `local/mica-build-env@${manifest.digest}`, indexRef = `local/mica-build-env:base.offline@${index.digest}`
  const lock = ['# mica-lock v1', `release\tmica-build-env\toffline\t${commit}`, `image\tmica-build-env\tbase\tamd64\t${platform}`, `image\tmica-build-env\tbase\tindex\t${indexRef}`, ''].join('\n')
  writeFileSync(join(out, 'mica-build-env.lock'), lock)
  writeFileSync(join(out, 'SHA256SUMS'), `${hex(new TextEncoder().encode(lock))}  mica-build-env.lock\n`)
  return { checkout, platform, index: indexRef }
}

const fixture = producer()
const root = join(work, 'build')
mkdirSync(join(root, 'locks'), { recursive: true })

test('a producer\'s own section 6 layout is pinned as it is, and its image resolves inside its checkout', () => {
  expect(localRelease('mica-build-env', fixture.checkout, root, {})).toContain(`from ${fixture.checkout} (local only`)
  const records = inputs(join(root, 'locks'))
  expect(localLayout(fixture.platform, records, {})).toEqual({ layout: join(fixture.checkout, '_out/offline/oci'), digest: fixture.platform.split(':').at(-1)! })
  expect(imageContexts(['--build-arg', `BASE=${fixture.platform}`, '--build-arg', `INDEX=${fixture.index}`, fixture.platform], records, {})).toEqual([
    '--build-context', `${fixture.index}=oci-layout://${fixture.checkout}/_out/offline/oci@sha256:${fixture.index.split(':').at(-1)}`,
    '--build-context', `${fixture.platform}=oci-layout://${fixture.checkout}/_out/offline/oci@sha256:${fixture.platform.split(':').at(-1)}`])
  expect(imageContexts(['--build-arg', 'BASE=ghcr.io/micaoss/mica-build-env@sha256:' + 'a'.repeat(64)], records, {})).toEqual([])
})

test('refused: under CI, a reference no offline pin names, a blob the layout lacks', () => {
  const records = inputs(join(root, 'locks'))
  expect(() => localLayout(fixture.platform, records, { CI: 'true' })).toThrow('CI reads published releases only')
  expect(() => localLayout(`local/mica-core@sha256:${'b'.repeat(64)}`, records, {})).toThrow('names no one offline checkout of mica-core')
  expect(() => localLayout(`local/mica-build-env@sha256:${'c'.repeat(64)}`, records, {})).toThrow(`holds no blob ${'c'.repeat(64)}`)
})

test('docker runs the image from its layout, and a buildx build FROMs it as a named context', () => {
  const records = inputs(join(root, 'locks'))
  for (const ref of [fixture.platform, fixture.index]) {
    loadLocalImage(ref, records, {})
    const c = must(['docker', 'create', '--label', 'ai-agent=true', '--platform', 'linux/amd64', ref, '/none']).trim()
    created.push(c)
    expect(must(['docker', 'cp', `${c}:/hello`, '-'])).toContain(HELLO)
  }
  const ctx = join(work, 'ctx'), out = join(work, 'built')
  mkdirSync(ctx, { recursive: true })
  writeFileSync(join(ctx, 'Dockerfile'), 'ARG BASE=scratch\nFROM ${BASE} AS base\nFROM scratch\nCOPY --from=base /hello /hello\n')
  const argv = ['buildx', 'build', '--builder', 'default', '--platform', 'linux/amd64', '--build-arg', `BASE=${fixture.platform}`]
  must(['docker', ...argv, ...imageContexts(argv, records, {}), '-o', `type=local,dest=${out}`, ctx])
  expect(readFileSync(join(out, 'hello'), 'utf8')).toBe(HELLO)
}, 120000)
