import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalJson, componentId, type Artifact, type RootComponent, type VerityImage } from './components.ts'
import { REPO_ROOT } from './paths.ts'
import { type Toolset, Toolbox } from './toolbox.ts'

export const COMPONENT_TOOLS: Toolset = {
  key: 'components', imageKey: 'IMAGE_ALPINE_3_21', manager: 'apk',
  packages: ['squashfs-tools', 'cryptsetup', 'coreutils', 'tar', 'openssl'],
  tools: ['mksquashfs', 'unsquashfs', 'veritysetup', 'tar', 'openssl'],
}
export interface ContentSigning { key: string, certificate: string }

export function artifactFile(path: string): Artifact {
  if (!lstatSync(path).isFile()) throw new Error(`Artifact is not a regular file: ${path}`)
  return { bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

/** Each invocation owns a fresh directory; failed outputs never look complete. */
export async function packComponent(tree: string, output: string, name: 'rootfs' | 'support', signing: ContentSigning, tb: Toolbox): Promise<VerityImage> {
  if (existsSync(output)) throw new Error(`Component output exists: ${output}`)
  if (name === 'rootfs') {
    for (const leaf of ['usr/lib/modules', 'usr/lib/firmware']) {
      const path = join(tree, leaf)
      if (!existsSync(path) || !lstatSync(path).isDirectory() || readdirSync(path).length !== 0) {
        throw new Error(`Rootfs must have an empty kernel support mountpoint: ${leaf}`)
      }
    }
  }
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    const image = join(work, `${name}.img`)
    await tb.must(['mksquashfs', tree, image, '-noappend', '-comp', 'zstd', '-processors', '1',
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
    const signed = spawnSync('bash', [join(REPO_ROOT, 'boot/verity-tool.sh'), 'sign', hash, signing.key, signing.certificate, signature], { encoding: 'utf8', timeout: 120000 })
    if (signed.status !== 0) throw new Error(`Content signing failed (${signed.error?.message ?? `status ${signed.status}, signal ${signed.signal}`}): ${signed.stderr}`)
    const result: VerityImage = {
      image: artifactFile(image), rootHash, signature: artifactFile(signature),
      verity: { version: 1, algorithm: 'sha256', dataBlockSize: 4096, hashBlockSize: 4096,
        dataBlocks: hashOffset / 4096, hashOffset, salt },
    }
    writeFileSync(join(work, `${name}.verity.json`), canonicalJson(result))
    renameSync(work, output)
    return result
  } finally {
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
    if (listing.some(path => path.startsWith('/') || path.split('/').includes('..') || !/^lib\/?$|^lib\/modules(?:\/|$)/.test(path))) {
      throw new Error('Module archive contains a path outside lib/modules')
    }
    await tb.must(['tar', '--no-same-owner', '-C', tree, '-xf', modulesTar])
    const modules = join(tree, 'lib/modules')
    if (!existsSync(modules) || readdirSync(modules).join() !== release) throw new Error('Kernel and module release differ')
    for (const name of ['modules.dep', 'modules.builtin', 'modules.order']) {
      if (!lstatSync(join(modules, release, name)).isFile()) throw new Error(`Missing module index ${name}`)
    }
    renameSync(modules, join(tree, 'modules'))
    rmSync(join(tree, 'lib'), { recursive: true })
    if (firmware) cpSync(firmware, join(tree, 'firmware'), { recursive: true, verbatimSymlinks: true })
    else mkdirSync(join(tree, 'firmware'))
    writeFileSync(join(tree, 'kernel.release'), `${release}\n`)
    return await packComponent(tree, output, 'support', signing, tb)
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
}

export function describeRoot(arch: string, version: string, content: VerityImage): RootComponent {
  if (!['amd64', 'arm64'].includes(arch) || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(version)) throw new Error('Invalid rootfs architecture or version')
  const root: RootComponent = { schema: 'mos/rootfs/v1', id: '', arch, version, content }
  root.id = componentId(root)
  return root
}
