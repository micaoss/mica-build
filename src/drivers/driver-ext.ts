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
// THE IMAGE: updates/mica-ext/<name>/ holds the modules, each signed with the owner's key and carrying the
// signer's certificate and --chain's (src/image/module-signing.ts); firmware/ holds --firmware's files; ext.json
// is the manifest. The descriptor beside the image is that manifest and the image's verity facts, unsigned: the
// roothash signature, by the same key and chain, is what the device's kernel verifies (mica/driver-ext/v1).
//
// --src builds the modules with the KDK in the toolchain image the kernel was built with (the KDK's kdk.env), so
// their vermagic and symbol versions are the kernel's; --modules takes modules built elsewhere, held to the same
// vermagic.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { artifactFile, COMPONENT_TOOLS, type ContentSigning } from '../image/component-build.ts'
import { canonicalJson, type VerityImage } from '../image/components.ts'
import { modulesUnder, signDetached, signModules } from '../image/module-signing.ts'
import { Toolbox } from '../image/toolbox.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'

export class DriverExtError extends Error {}
const fail = (m: string): never => { throw new DriverExtError(`driver-ext: ${m}`) }

export const DRIVER_EXT_SCHEMA = 'mica/driver-ext/v1'

/** The file entries of a tree, sorted: its path and sha256. */
function entries(root: string, under: string): { path: string, sha256: string }[] {
  if (!existsSync(join(root, under))) return []
  return (readdirSync(join(root, under), { recursive: true }) as string[]).map(f => join(under, f)).filter(f => statSync(join(root, f)).isFile()).sort()
    .map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(root, path))).digest('hex') }))
}

/** The vermagic of a module's .modinfo, or undefined. */
export function vermagic(module: Buffer): string | undefined {
  const at = module.indexOf('vermagic=')
  if (at < 0) return undefined
  const end = module.indexOf(0, at)
  return module.subarray(at + 'vermagic='.length, end < 0 ? undefined : end).toString()
}

/** The KDK's facts (kdk.env): the kernel release, and how the kernel was built -- the toolchain image, the
 * builder's platform (the KDK's host programs are that platform's) and the make environment that crosses. */
export function kdkFacts(dir: string): { release: string, image: string, platform: string, makeEnv: string[] } {
  const env = Object.fromEntries(readFileSync(join(dir, 'kdk.env'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  for (const k of ['KERNEL_RELEASE', 'BUILD_IMAGE', 'BUILD_PLATFORM']) if (!env[k]) fail(`the KDK's kdk.env names no ${k}`)
  return { release: env['KERNEL_RELEASE']!, image: env['BUILD_IMAGE']!, platform: env['BUILD_PLATFORM']!, makeEnv: (env['KERNEL_MAKE_ENV'] ?? '').split(' ').filter(Boolean) }
}

export interface ExtInputs {
  kdk: string
  src?: string
  modules?: string
  firmware?: string
  name: string
  version: string
  kernelId: string
  signing: ContentSigning
  chain?: string
  out: string
}

/** Build a driver extension into `out` (which must not exist); its descriptor. */
export async function build(i: ExtInputs): Promise<Record<string, unknown>> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(i.name)) fail('the name is lowercase letters, digits and ._- (at most 64)')
  if (!/^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/.test(i.version)) fail('the version is letters, digits and ._+~-')
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
    const tree = join(work, 'tree'), dest = join(tree, 'updates/mica-ext', i.name)
    mkdirSync(dest, { recursive: true })
    for (const m of found) {
      const bytes = readFileSync(join(built, m))
      const magic = vermagic(bytes)
      if (magic === undefined || magic.split(' ')[0] !== facts.release) fail(`${m} is built for ${magic ?? 'no kernel'}, not ${facts.release}`)
      mkdirSync(dirname(join(dest, m)), { recursive: true })
      writeFileSync(join(dest, m), bytes)
    }
    signModules(join(tree, 'updates'), i.signing, i.chain === undefined ? {} : { intermediates: i.chain })
    if (i.firmware !== undefined) cpSync(i.firmware, join(tree, 'firmware'), { recursive: true, verbatimSymlinks: false })
    const manifest = { schema: DRIVER_EXT_SCHEMA, name: i.name, version: i.version, kernel: { id: i.kernelId, release: facts.release },
      modules: entries(tree, 'updates'), firmware: entries(tree, 'firmware') }
    writeFileSync(join(tree, 'ext.json'), canonicalJson(manifest))

    const packed = join(work, 'out')
    mkdirSync(packed)
    const image = join(packed, 'ext.img')
    const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [work] })
    let content: VerityImage
    try {
      await tb.must(['mksquashfs', tree, image, '-noappend', '-comp', 'zstd', '-processors', '1', '-all-root',
        '-all-time', '1577836800', '-mkfs-time', '1577836800', '-no-progress'])
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
    const descriptor = { ...manifest, content }
    writeFileSync(join(packed, 'ext.json'), canonicalJson(descriptor))
    renameSync(packed, i.out)
    return descriptor
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export async function main(argv: string[]): Promise<number> {
  const usage = 'usage: driver-ext build --kdk KDK.tar (--src DIR | --modules DIR) [--firmware DIR] --name NAME --version VERSION --kernel-id ID --key FILE --cert FILE [--chain FILE] --out NEW_DIRECTORY'
  try {
    const names = ['kdk', 'src', 'modules', 'firmware', 'name', 'version', 'kernel-id', 'key', 'cert', 'chain', 'out']
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: Object.fromEntries(names.map(n => [n, { type: 'string' as const }])) })
    if (positionals.join(' ') !== 'build') fail(usage)
    const need = (n: string) => values[n] ?? fail(`--${n} is required\n${usage}`)
    const d = await build({ kdk: need('kdk'), src: values.src, modules: values.modules, firmware: values.firmware, name: need('name'), version: need('version'),
      kernelId: need('kernel-id'), signing: { key: need('key'), certificate: need('cert') }, chain: values.chain, out: need('out') })
    console.log(`driver-ext: ${d['name']} ${d['version']} for kernel ${(d['kernel'] as { id: string }).id}: ${(d['modules'] as unknown[]).length} module(s), ${relative(process.cwd(), need('out'))}/ext.img`)
    return 0
  }
  catch (e) {
    if (e instanceof DriverExtError || (e instanceof TypeError && 'code' in e)) { console.error(e.message); return 1 }
    throw e
  }
}
