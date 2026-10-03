import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson, componentId, validateCoreComponent, type Artifact, type CoreComponent, type RootComponent, type VerityImage } from './components.ts'
import { ROOT_INTERFACE_LEVEL, type Selected } from './core-components.ts'
import type { Toolbox } from './toolbox.ts'
import { type Toolset } from './toolbox.ts'
import { sign } from '../boot/verity-tool.ts'

export const COMPONENT_TOOLS: Toolset = {
  key: 'components', imageKey: 'upstream:alpine:3.24.1', manager: 'apk',
  packages: ['squashfs-tools', 'cryptsetup', 'coreutils', 'tar', 'openssl'],
  tools: ['mksquashfs', 'unsquashfs', 'veritysetup', 'tar', 'openssl'],
}
export interface ContentSigning { key: string, certificate: string }

export function artifactFile(path: string): Artifact {
  if (!lstatSync(path).isFile()) throw new Error(`Artifact is not a regular file: ${path}`)
  return { bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

/** The mksquashfs compression options of a board's root, as stages/compose/scripts/pack-squashfs.sh packs it:
 * ROOTFS_COMPRESSION and MICA_ARCH of its fetched board.env. */
export function rootCompression(board: string): string[] {
  const env = readFileSync(join(import.meta.dir, '../../_out/boards', board, 'board.env'), 'utf8')
  if (!/^ROOTFS_COMPRESSION=xz$/m.test(env)) return ['-comp', 'zstd', '-Xcompression-level', '19']
  return ['-comp', 'xz', '-b', '1M', '-Xdict-size', '100%', ...(/^MICA_ARCH=amd64$/m.test(env) ? ['-Xbcj', 'x86'] : [])]
}

/** Each invocation owns a fresh directory; failed outputs never look complete. */
export async function packComponent(tree: string, output: string, name: 'rootfs' | 'support' | 'core', signing: ContentSigning, tb: Toolbox, compression: string[] = ['-comp', 'zstd']): Promise<VerityImage> {
  if (existsSync(output)) throw new Error(`Component output exists: ${output}`)
  if (name === 'rootfs') {
    for (const leaf of ['usr/lib/modules', 'usr/lib/firmware']) {
      const path = join(tree, leaf)
      if (!existsSync(path) || !lstatSync(path).isDirectory() || readdirSync(path).length !== 0)
        throw new Error(`Rootfs must have an empty kernel support mountpoint: ${leaf}`)
    }
  }
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    const image = join(work, `${name}.img`)
    await tb.must(['mksquashfs', tree, image, '-noappend', ...compression, '-processors', '1',
      '-all-time', '1577836800', '-mkfs-time', '1577836800', '-no-progress'])
    const hashOffset = statSync(image).size
    if (hashOffset % 4096 !== 0) throw new Error('SquashFS is not aligned to verity blocks')
    // The salt is a deterministic content identity, independent of release labels.
    const salt = artifactFile(image).sha256
    const formatted = await tb.must(['veritysetup', 'format', image, image, '--no-superblock',
      '--format', '1', '--hash', 'sha256', '--data-block-size', '4096', '--hash-block-size', '4096',
      '--data-blocks', String(hashOffset / 4096), '--hash-offset', String(hashOffset), '--salt', salt])
    const rootHash = /^Root hash:\s+([0-9a-f]{64})$/m.exec(formatted.stdout)?.[1]
    if (!rootHash) throw new Error('veritysetup returned no SHA-256 root hash')
    const hash = join(work, `${name}.roothash`)
    const signature = `${hash}.p7s`
    writeFileSync(hash, rootHash)
    try { sign(hash, signing.key, signing.certificate, signature) }
    catch (e) { throw new Error(`Content signing failed: ${(e as Error).message}`) }
    const result: VerityImage = {
      image: artifactFile(image), rootHash, signature: artifactFile(signature),
      verity: { version: 1, algorithm: 'sha256', dataBlockSize: 4096, hashBlockSize: 4096,
        dataBlocks: hashOffset / 4096, hashOffset, salt },
    }
    writeFileSync(join(work, `${name}.verity.json`), canonicalJson(result))
    renameSync(work, output)
    return result
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The BSP supplies modules from the same build as kernel.release. */
export async function packSupport(modulesTar: string, release: string, firmware: string | undefined, output: string, signing: ContentSigning, tb: Toolbox): Promise<VerityImage> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(release)) throw new Error('Invalid module release')
  if (existsSync(output)) throw new Error(`Component output exists: ${output}`)
  const tree = `${output}.tree`
  mkdirSync(dirname(tree), { recursive: true })
  mkdirSync(tree)
  try {
    const listing = (await tb.must(['tar', '-tf', modulesTar])).stdout.trim().split('\n')
    if (listing.some(path => path.startsWith('/') || path.split('/').includes('..') || !/^lib\/?$|^lib\/modules(?:\/|$)/.test(path)))
      throw new Error('Module archive contains a path outside lib/modules')

    await tb.must(['tar', '--no-same-owner', '-C', tree, '-xf', modulesTar])
    const modules = join(tree, 'lib/modules')
    if (!existsSync(modules) || readdirSync(modules).join() !== release) throw new Error('Kernel and module release differ')
    for (const name of ['modules.dep', 'modules.builtin', 'modules.order'])
      if (!lstatSync(join(modules, release, name)).isFile()) throw new Error(`Missing module index ${name}`)

    renameSync(modules, join(tree, 'modules'))
    rmSync(join(tree, 'lib'), { recursive: true })
    if (firmware) cpSync(firmware, join(tree, 'firmware'), { recursive: true, verbatimSymlinks: true })
    else mkdirSync(join(tree, 'firmware'))
    writeFileSync(join(tree, 'kernel.release'), `${release}\n`)
    return await packComponent(tree, output, 'support', signing, tb)
  }
  finally {
    rmSync(tree, { recursive: true, force: true })
  }
}

export function describeRoot(arch: string, content: VerityImage): RootComponent {
  if (!['amd64', 'arm64'].includes(arch)) throw new Error('Invalid rootfs architecture')
  const root: RootComponent = { schema: 'mica/rootfs/v1', id: '', arch, content, interfaceLevel: ROOT_INTERFACE_LEVEL }
  root.id = componentId(root)
  return root
}

/** The signed core components of a cores directory, one per package directory, in package order. */
export function coreRecords(directory: string): CoreComponent[] {
  return readdirSync(directory).sort().map(name => JSON.parse(readFileSync(join(directory, name, 'core.json'), 'utf8')) as CoreComponent)
}

/**
 * A core component of the pool, signed for this product: its image checked against the record's verity
 * parameters, its root hash signed with the content key like the root's, and the record completed with the
 * signature and its identity. Writes core.img, core.roothash, core.roothash.p7s and core.json into `output`.
 */
export async function packCore(selected: Selected, output: string, signing: ContentSigning, tb: Toolbox): Promise<CoreComponent> {
  if (existsSync(output)) throw new Error(`Component output exists: ${output}`)
  const { component, record } = selected
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    const image = join(work, 'core.img')
    writeFileSync(image, component.image.bytes)
    const content = record.content
    const g = content.verity
    await tb.must(['veritysetup', 'verify', image, image, content.rootHash, '--no-superblock', '--format', String(g.version), '--hash', g.algorithm,
      '--data-block-size', String(g.dataBlockSize), '--hash-block-size', String(g.hashBlockSize), '--data-blocks', String(g.dataBlocks),
      '--hash-offset', String(g.hashOffset), '--salt', g.salt])
    const hash = join(work, 'core.roothash')
    writeFileSync(hash, content.rootHash)
    try { sign(hash, signing.key, signing.certificate, `${hash}.p7s`) }
    catch (e) { throw new Error(`Content signing failed: ${(e as Error).message}`) }
    const core = { ...record, id: '', content: { ...content, signature: artifactFile(`${hash}.p7s`) } } as CoreComponent
    core.id = componentId(core)
    validateCoreComponent(JSON.parse(canonicalJson(core)), record.arch)
    writeFileSync(join(work, 'core.json'), canonicalJson(core))
    renameSync(work, output)
    return core
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
