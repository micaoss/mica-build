// A producer's local build pinned in locks/ in place of its release, for a local product build only.
//
//   bun src/cli.ts local-release <repository> <checkout>
//
//   reads   <checkout>/_out/offline/<repository>.lock         the producer's own section 6 layout, when it writes one
//                                                           (its images too: src/locks/local-images.ts); else
//           <checkout>/_out/debs/<amd64|arm64|armhf>/pool   the producer's `make offline` pools, of its clean HEAD
//   writes  _out/local-releases/<repository>/               a shared clone at that commit (objects read through
//                                                           alternates, no working tree) holding _out/offline/:
//                                                           <repository>.lock, oci/ and SHA256SUMS (release-lock.md
//                                                           section 6), each pool as `release pool` lays it out
//           locks/<repository>.lock, locks/pins/<repository>.pin   by mica-tools local-lock (section 7): the offline pin
//
// A producer whose offline build writes section 6's layout is pinned from its checkout as it is (local-lock). One
// whose `make offline` builds only its pools gets that layout written from them here, so
// the pin is the offline pin the tools already define: the lock's release row is `offline` and the commit, its
// package and item rows name the versions built, and every `local/<repository>` reference resolves inside the
// CHECKOUT the pin names. Refused under CI (here and by the tools' rule checkout-in-ci), and for pools that miss an
// architecture the release pins or hold a package at two versions (pools left from different builds); the locks it
// writes are committed on a local branch that is never pushed.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { digestOf, EMPTY_CONFIG, inputsHash, ITEM_LAYER, localLock, modeOf, OCI_MANIFEST, poolArchives, poolItems, poolManifest, producerOf } from '@mica/build-tools'
import { REPO_ROOT } from '../pool/producers.ts'
import { ARCHES } from '../rootfs/runtime/arch.ts'

export class LocalReleaseError extends Error {}

function die(message: string): never {
  throw new LocalReleaseError(`local-release: error: ${message}`)
}

function git(args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) die(`git ${args.join(' ')}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().trim()
}

/** Section 6's layout of the checkout's pools under out/_out/offline; the lock's text. */
export function offlineLayout(repository: string, checkout: string, commit: string, out: string): string {
  const oci = join(out, '_out/offline/oci'), blobs = join(oci, 'blobs/sha256')
  mkdirSync(blobs, { recursive: true })
  const put = (bytes: Uint8Array) => writeFileSync(join(blobs, digestOf(bytes).slice('sha256:'.length)), bytes)
  put(EMPTY_CONFIG)
  const pools: string[][] = [], packages: string[][] = [], items: string[][] = [], manifests: object[] = []
  for (const arch of ARCHES) {
    const dir = join(checkout, '_out/debs', arch, 'pool')
    if (!existsSync(dir)) continue
    const archives = poolArchives(checkout, repository, arch), held = poolItems(dir, arch)
    if (archives.length === 0 && held.length === 0) die(`${dir} holds no archive and no item`)
    const layers = []
    for (const a of archives) {
      put(a.bytes)
      layers.push({ title: a.file, digest: `sha256:${a.sha256}`, size: a.bytes.length, inputs: a.inputs })
      packages.push(['package', a.name, arch, a.version, a.sha256])
    }
    for (const i of held) {
      put(i.bytes)
      layers.push({ title: i.file, digest: `sha256:${i.sha256}`, size: i.bytes.length, inputs: inputsHash(checkout, producerOf(checkout, i.name), arch), mediaType: ITEM_LAYER + i.type })
      items.push(['item', i.type, i.name, arch, i.version, i.sha256])
    }
    const bytes = poolManifest(repository, arch, layers), digest = digestOf(bytes)
    put(bytes)
    manifests.push({ mediaType: OCI_MANIFEST, digest, size: bytes.length, annotations: { 'org.opencontainers.image.ref.name': `pool.${arch}.offline` } })
    pools.push(['pool', arch, `local/${repository}:pool.${arch}.offline@${digest}`])
  }
  if (pools.length === 0) die(`${checkout}/_out/debs holds no pool; run make offline there`)
  // One `make offline` builds every pool at one version; two versions of a package are pools of different builds.
  for (const name of [...new Set(packages.map(r => r[1]!))].sort()) {
    const versions = new Map<string, string[]>()
    for (const r of packages.filter(r => r[1] === name)) versions.set(r[3]!, [...(versions.get(r[3]!) ?? []), r[2]!])
    if (versions.size > 1)
      die(`${name} is built at ${[...versions].sort().map(([v, a]) => `${v} (${a.join(' ')})`).join(' and ')} across ${checkout}/_out/debs; a pool there is left from another build, so run make offline afresh`)
  }
  writeFileSync(join(oci, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n')
  writeFileSync(join(oci, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests }, null, 2) + '\n')
  // The rows in `release pool`'s order: a row's key is every column before its version.
  const key = (r: string[]) => Buffer.from(r.slice(1, -2).join('\t'))
  const byKey = (a: string[], b: string[]) => Buffer.compare(key(a), key(b))
  const text = ['# mica-lock v1', `release\t${repository}\toffline\t${commit}`, ...pools.map(r => r.join('\t')),
    ...[packages, items].flatMap(rows => rows.sort(byKey).map(r => r.join('\t')))].join('\n') + '\n'
  writeFileSync(join(out, '_out/offline', `${repository}.lock`), text)
  writeFileSync(join(out, '_out/offline/SHA256SUMS'), `${digestOf(new TextEncoder().encode(text)).slice('sha256:'.length)}  ${repository}.lock\n`)
  return text
}

export function localRelease(repository: string, checkoutArg: string, root = REPO_ROOT, env: NodeJS.ProcessEnv = process.env): string {
  if (modeOf(env) === 'ci') die('a local release is never pinned in CI: its pools are no release input')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(repository)) die(`'${repository}' is not a repository name`)
  const checkout = resolve(checkoutArg)
  const commit = git(['-C', checkout, 'rev-parse', '--verify', 'HEAD'])
  if (git(['-C', checkout, 'status', '--porcelain', '--untracked-files=no']) !== '') die(`${checkout} has uncommitted changes; its pools are of no commit`)
  if (existsSync(join(checkout, '_out/offline', `${repository}.lock`))) return localLock(join(root, 'locks'), repository, checkout, env)
  // Every architecture the release pins a pool for, built: a product of an architecture left out would find none.
  const released = join(root, 'locks', `${repository}.lock`)
  for (const arch of existsSync(released) ? readFileSync(released, 'utf8').split('\n').filter(l => l.startsWith('pool\t')).map(l => l.split('\t')[1]!) : [])
    if (!existsSync(join(checkout, '_out/debs', arch, 'pool'))) die(`${checkout}/_out/debs holds no ${arch} pool, which locks/${repository}.lock pins; run make offline there`)
  const out = join(root, '_out/local-releases', repository)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, '..'), { recursive: true })
  git(['clone', '--quiet', '--shared', '--no-checkout', checkout, out])
  git(['-C', out, 'update-ref', '--no-deref', 'HEAD', commit])
  offlineLayout(repository, checkout, commit, out)
  return localLock(join(root, 'locks'), repository, out, env)
}

export function main(argv: string[]): number {
  if (argv.length !== 2) {
    console.error('usage: bun src/cli.ts local-release <repository> <checkout>')
    return 1
  }
  try { console.log(localRelease(argv[0]!, argv[1]!)) }
  catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  }
  return 0
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
