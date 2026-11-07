// A driver extension: out-of-tree modules (and their firmware) for one kernel, signed by the device owner's key and
// packed as a verity image a device maps after it has enrolled the owner's CA. The tool needs nothing of mica's: the
// KDK of the kernel (src/boards: kernel/kdk.tar), the owner's key and certificate (src/drivers/driver-key.ts), and
// the sources or the built modules.
//
//   bun src/cli.ts driver-ext build --kdk KDK.tar (--src DIR | --modules DIR) [--firmware DIR]
//                                   --name NAME --version VERSION --kernel-id ID
//                                   --key FILE --cert FILE [--chain FILE] --out NEW_DIRECTORY
//   -> ext.img (squashfs + verity), ext.roothash, ext.roothash.p7s, ext.json (the descriptor)
//
// THE CONTRACT is core's (mica-core docs/mica-core.md 6.2, mica_deploy::driver_ext, its shared vector
// tests/component-contracts/driver-ext.json). The image holds manifest.json (mica/driver-ext/v1: name, version,
// arch, kernel, kernelRelease, modules, load, options, firmware), the modules under
// modules/<kernelRelease>/updates/mica-ext/<name>/, each signed with the owner's key and carrying the signer's
// certificate and --chain's (src/image/module-signing.ts), and the firmware under firmware/. ext.json
// (mica/driver-ext-descriptor/v1: name, version, arch, kernel, content) locates the image and is not signed; the
// root hash signature, by the same key and chain, is what the device's kernel verifies when it maps the image.
//
// --src builds the modules with the KDK in the toolchain image the kernel was built with (the KDK's kdk.env), so
// their vermagic and symbol versions are the kernel's; --modules takes modules built elsewhere, held to the same
// vermagic.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { artifactFile, COMPONENT_TOOLS, type ContentSigning } from '../image/component-build.ts'
import { canonicalJson, type VerityImage } from '../image/components.ts'
import { modulesUnder, signDetached, signModules } from '../image/module-signing.ts'
import { Toolbox } from '../image/toolbox.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'

export class DriverExtError extends Error {}
const fail = (m: string): never => { throw new DriverExtError(`driver-ext: ${m}`) }

export const DESCRIPTOR_SCHEMA = 'mica/driver-ext-descriptor/v1'
export const MANIFEST_SCHEMA = 'mica/driver-ext/v1'
const MAX_MODULES = 64, MAX_FIRMWARE = 256

/** The files below `dir`, sorted, each a relative path of plain components at most four deep (the contract's). */
function paths(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found = (readdirSync(dir, { recursive: true }) as string[]).filter(f => statSync(join(dir, f)).isFile()).sort()
  for (const f of found) {
    const parts = f.split('/')
    if (f.length > 128 || parts.length > 4 || !parts.every(p => /^[A-Za-z0-9._+-]+$/.test(p) && p !== '.' && p !== '..'))
      fail(`${f}: a path is at most four plain components of letters, digits and ._+-`)
  }
  return found
}

/** The name kmod knows a module path by: its file name without .ko, - read as _. */
export function moduleName(path: string): string {
  return basename(path, '.ko').replace(/-/g, '_')
}

/** The vermagic of a module's .modinfo, or undefined. */
export function vermagic(module: Buffer): string | undefined {
  const at = module.indexOf('vermagic=')
  if (at < 0) return undefined
  const end = module.indexOf(0, at)
  return module.subarray(at + 'vermagic='.length, end < 0 ? undefined : end).toString()
}

/** The KDK's facts (kdk.env): the kernel's release and architecture, and how it was built -- the toolchain image,
 * the builder's platform (the KDK's host programs are that platform's) and the make environment that crosses. */
export function kdkFacts(dir: string): { release: string, arch: string, image: string, platform: string, makeEnv: string[] } {
  const env = Object.fromEntries(readFileSync(join(dir, 'kdk.env'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  for (const k of ['KERNEL_RELEASE', 'KERNEL_ARCH', 'BUILD_IMAGE', 'BUILD_PLATFORM']) if (!env[k]) fail(`the KDK's kdk.env names no ${k}`)
  return { release: env['KERNEL_RELEASE']!, arch: env['KERNEL_ARCH']!, image: env['BUILD_IMAGE']!, platform: env['BUILD_PLATFORM']!,
    makeEnv: (env['KERNEL_MAKE_ENV'] ?? '').split(' ').filter(Boolean) }
}

export interface ExtInputs {
  kdk: string
  src?: string
  modules?: string
  firmware?: string
  load?: string[]
  options?: Record<string, string>
  name: string
  version: string
  kernelId: string
  signing: ContentSigning
  chain?: string
  out: string
}

/** Build a driver extension into `out` (which must not exist); its descriptor. */
export async function build(i: ExtInputs): Promise<{ descriptor: Record<string, unknown>, manifest: Record<string, unknown> }> {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(i.name)) fail('the name is 1 to 32 lowercase letters, digits and hyphens')
  if (!/^[0-9]{1,9}(\.[0-9]{1,9}){0,3}$/.test(i.version)) fail('the version is one to four dotted numbers')
  if (!/^[0-9a-f]{64}$/.test(i.kernelId)) fail('the kernel id is the kernel component\'s 64-digit hex id')
  if ((i.src === undefined) === (i.modules === undefined)) fail('give exactly one of --src and --modules')
  if (existsSync(i.out)) fail(`${i.out} exists`)
  mkdirSync(dirname(i.out), { recursive: true })
  const work = `${i.out}.building`
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work)
  try {
    const kdk = join(work, 'kdk')
    mkdirSync(kdk)
    const tar = Bun.spawnSync(['tar', '-xf', i.kdk, '-C', kdk], { stderr: 'pipe' })
    if (tar.exitCode !== 0) fail(`the KDK ${i.kdk} did not unpack: ${tar.stderr.toString().trim()}`)
    const facts = kdkFacts(kdk)
    const built = join(work, 'built')
    if (i.src !== undefined) {
      cpSync(i.src, built, { recursive: true })
      const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--platform', facts.platform,
        '--name', `ai-agent-driver-ext-${process.pid}`, '-v', `${hostPath(realpathSync(kdk))}:/kdk:ro`, '-v', `${hostPath(realpathSync(built))}:/src`,
        '-e', 'KBUILD_BUILD_TIMESTAMP=@1577836800', '-e', 'KBUILD_BUILD_USER=mica', '-e', 'KBUILD_BUILD_HOST=mica-build',
        '--entrypoint', 'env', facts.image, ...facts.makeEnv, 'make', '-C', '/kdk/build', 'M=/src', 'modules'], { stdout: 'inherit', stderr: 'inherit' })
      if (r.exitCode !== 0) fail('the module build failed (see above)')
    }
    else { cpSync(i.modules!, built, { recursive: true }) }
    const found = modulesUnder(built)
    if (found.length === 0) fail('no module (.ko) was built or given')
    if (!['amd64', 'arm64', 'armhf'].includes(facts.arch)) fail(`a KDK of ${facts.arch}`)
    const tree = join(work, 'tree'), dest = join(tree, 'modules', facts.release, 'updates/mica-ext', i.name)
    mkdirSync(dest, { recursive: true })
    for (const m of found) {
      const bytes = readFileSync(join(built, m))
      const magic = vermagic(bytes)
      if (magic === undefined || magic.split(' ')[0] !== facts.release) fail(`${m} is built for ${magic ?? 'no kernel'}, not ${facts.release}`)
      mkdirSync(dirname(join(dest, m)), { recursive: true })
      writeFileSync(join(dest, m), bytes)
    }
    signModules(dest, i.signing, i.chain === undefined ? {} : { intermediates: i.chain })
    if (i.firmware !== undefined) cpSync(i.firmware, join(tree, 'firmware'), { recursive: true, verbatimSymlinks: false })
    const modules = paths(dest), firmware = paths(join(tree, 'firmware'))
    if (modules.length > MAX_MODULES || firmware.length > MAX_FIRMWARE) fail(`at most ${MAX_MODULES} modules and ${MAX_FIRMWARE} firmware files`)
    const names = modules.map(moduleName)
    if (new Set(names).size !== names.length) fail('two modules of one module name')
    const load = [...(i.load ?? [])], options = { ...(i.options ?? {}) }
    for (const m of [...load, ...Object.keys(options)]) if (!names.includes(m)) fail(`${m} is not a module of this extension (${names.join(', ')})`)
    if (new Set(load).size !== load.length) fail('a module is named twice to load')
    for (const line of Object.values(options)) if (!/^[ -~]{1,256}$/.test(line)) fail('an options line is 1 to 256 printable ASCII characters')
    const identity = { name: i.name, version: i.version, arch: facts.arch, kernel: i.kernelId }
    const manifest = { schema: MANIFEST_SCHEMA, ...identity, kernelRelease: facts.release, modules, load, options, firmware }
    writeFileSync(join(tree, 'manifest.json'), canonicalJson(manifest))

    const packed = join(work, 'out')
    mkdirSync(packed)
    const image = join(packed, 'ext.img')
    const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [work] })
    let content: VerityImage
    try {
      await tb.must(['mksquashfs', tree, image, '-noappend', '-comp', 'zstd', '-processors', '1', '-all-root',
        '-all-time', '1577836800', '-mkfs-time', '1577836800', '-no-progress'])
      // One data block has no hash tree (its root hash is the block's own), and mica-core's reader requires the tree
      // after the data: a one-block squashfs gets a zero block, past what its superblock says it uses.
      if (statSync(image).size === 4096) appendFileSync(image, Buffer.alloc(4096))
      const hashOffset = statSync(image).size
      if (hashOffset % 4096 !== 0) fail('the squashfs image is not aligned to verity blocks')
      const salt = artifactFile(image).sha256
      const formatted = await tb.must(['veritysetup', 'format', image, image, '--no-superblock', '--format', '1', '--hash', 'sha256',
        '--data-block-size', '4096', '--hash-block-size', '4096', '--data-blocks', String(hashOffset / 4096), '--hash-offset', String(hashOffset), '--salt', salt])
      const rootHash = /^Root hash:\s+([0-9a-f]{64})$/m.exec(formatted.stdout)?.[1] ?? fail('veritysetup returned no root hash')
      writeFileSync(join(packed, 'ext.roothash'), rootHash)
      signDetached(packed, 'ext.roothash', i.signing, i.chain === undefined ? {} : { intermediates: i.chain })
      content = { image: artifactFile(image), rootHash, signature: artifactFile(join(packed, 'ext.roothash.p7s')),
        verity: { version: 1, algorithm: 'sha256', dataBlockSize: 4096, hashBlockSize: 4096, dataBlocks: hashOffset / 4096, hashOffset, salt } }
    }
    finally { await tb.close() }
    const descriptor = { schema: DESCRIPTOR_SCHEMA, ...identity, content }
    writeFileSync(join(packed, 'ext.json'), canonicalJson(descriptor))
    renameSync(packed, i.out)
    return { descriptor, manifest }
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export async function main(argv: string[]): Promise<number> {
  const usage = 'usage: driver-ext build --kdk KDK.tar (--src DIR | --modules DIR) [--firmware DIR] [--load MODULE]... [--option MODULE=OPTIONS]... --name NAME --version VERSION --kernel-id ID --key FILE --cert FILE [--chain FILE] --out NEW_DIRECTORY'
  try {
    const string = { type: 'string' } as const
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      'kdk': string, 'src': string, 'modules': string, 'firmware': string, 'name': string, 'version': string, 'kernel-id': string,
      'key': string, 'cert': string, 'chain': string, 'out': string, 'load': { type: 'string', multiple: true }, 'option': { type: 'string', multiple: true } } })
    if (positionals.join(' ') !== 'build') fail(usage)
    const need = (n: string) => (values as Record<string, string | undefined>)[n] ?? fail(`--${n} is required\n${usage}`)
    const options: Record<string, string> = {}
    for (const o of values.option ?? []) {
      const at = o.indexOf('=')
      if (at < 1 || options[o.slice(0, at)] !== undefined) fail(`--option takes MODULE=OPTIONS, once per module: ${o}`)
      options[o.slice(0, at)] = o.slice(at + 1)
    }
    const { manifest } = await build({ kdk: need('kdk'), src: values.src, modules: values.modules, firmware: values.firmware, load: values.load, options,
      name: need('name'), version: need('version'), kernelId: need('kernel-id'), signing: { key: need('key'), certificate: need('cert') }, chain: values.chain, out: need('out') })
    console.log(`driver-ext: ${manifest['name']} ${manifest['version']} for kernel ${manifest['kernel']} (${manifest['kernelRelease']}): ${(manifest['modules'] as unknown[]).length} module(s), ${relative(process.cwd(), need('out'))}/ext.img`)
    return 0
  }
  catch (e) {
    if (e instanceof DriverExtError || (e instanceof TypeError && 'code' in e)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
