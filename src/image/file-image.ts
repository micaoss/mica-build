import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { artifactFile } from './component-build.ts'
import { componentId, verifyDeployment, type BootIdentity, type Deployment } from './components.ts'
import { loadBoardFacts } from './board-facts.ts'
import { checkCapacity, type FileLayout } from './file-layout.ts'
import { authenticateFirmware } from './firmware.ts'
import { BOARDS_DIR } from './paths.ts'
import { checkLoaderPlacement, loaderBesideImage } from './regions.ts'
import { ROLES } from './roles/index.ts'
import { PROVISIONING_DOCUMENT } from './roles/context.ts'
import type { Toolbox } from './toolbox.ts'
import { type Toolset } from './toolbox.ts'
import { verifyGpt, writeGpt } from './tools/sgdisk.ts'

export { PROVISIONING_DOCUMENT }

export const FILE_IMAGE_TOOLS: Toolset = {
  key: 'file-image', imageKey: 'upstream:alpine:3.24.1', manager: 'apk',
  packages: ['sgdisk', 'dosfstools', 'mtools', 'e2fsprogs', 'e2fsprogs-extra', 'coreutils'],
  tools: ['sgdisk', 'mkfs.vfat', 'mcopy', 'mmd', 'mke2fs', 'e2fsck', 'dumpe2fs', 'debugfs', 'dd', 'truncate', 'touch', 'find'],
}

export interface FactoryDeployment { envelope: string, kernelDirectory: string, rootDirectory: string }

export function entryText(deployment: Deployment): string {
  return `title MICA ${deployment.version}\nversion ${deployment.generation}\nsort-key mica\nefi /EFI/mica/kernels/${deployment.kernel.id}.efi\n`
}

/** What a product may add to the factory image beside the deployments. */
export interface FactoryImageOptions {
  /**
   * A factory seed: the boot-time provisioning document, placed at the
   * root of the boot medium as `mica-provisioning.toml`, exactly where
   * mica-provisioning-import reads it on first boot. UEFI boards only --
   * the ESP is the medium the device reads; a FIT board's raw firmware
   * partition holds no filesystem, so its seed travels on removable media.
   */
  provisioning?: string
}

export async function assembleFileImage(layout: FileLayout, deployments: FactoryDeployment[], keys: string[], firmwareDirectory: string, output: string, tb: Toolbox, options: FactoryImageOptions = {}): Promise<string> {
  const fit = layout.backend === 'uboot-fit'
  const hasEsp = layout.partitions.some(p => p.role === 'esp')
  if (options.provisioning !== undefined && !hasEsp) throw new Error(`Board ${layout.board} boots through a FIT and has no ESP to carry ${PROVISIONING_DOCUMENT}; a factory seed for it travels on removable media`)
  if (deployments.length !== 2) throw new Error('Factory image requires two deployments')
  const facts = loadBoardFacts(layout.board)
  if (facts.backend !== layout.backend) throw new Error('Factory boot backend mismatch')
  checkLoaderPlacement(layout, facts)
  const firmwareEnvelope = readFileSync(join(firmwareDirectory, 'firmware.json'), 'utf8')
  const manifest = authenticateFirmware(firmwareEnvelope, keys, facts)
  if (manifest.board !== layout.board) throw new Error('Factory firmware board mismatch')
  const firmware = join(firmwareDirectory, facts.firmware.format === 'efi' ? facts.firmware.loaderName : facts.firmware.binName)
  const artifact = artifactFile(firmware)
  if (artifact.bytes !== manifest.artifact.bytes || artifact.sha256 !== manifest.artifact.sha256) throw new Error('Factory firmware integrity mismatch')
  if (existsSync(output)) throw new Error(`Image output exists: ${output}`)
  const records = deployments.map((input) => {
    const identity = JSON.parse(readFileSync(join(input.kernelDirectory, 'boot.json'), 'utf8')).identity as BootIdentity
    const descriptor = verifyDeployment(input.envelope, keys, identity)
    if (descriptor.board !== layout.board) throw new Error('Factory deployment board mismatch')
    return { ...input, descriptor, id: componentId(descriptor) }
  })
  if (new Set(records.map(r => r.id)).size !== 2 || new Set(records.map(r => r.descriptor.generation)).size !== 2) throw new Error('Factory deployment IDs and generations must differ')
  const systemBytes = Math.max(...records.map(r => r.descriptor.rootfs.content.image.bytes + r.descriptor.kernel.support.image.bytes
    + r.descriptor.rootfs.content.signature.bytes + r.descriptor.kernel.support.signature.bytes + 128 + Buffer.byteLength(r.envelope)))
  const bootBytes = Math.max(...records.map(r => r.descriptor.kernel.boot.artifact.bytes))
  checkCapacity(layout, systemBytes, bootBytes + (fit ? 0 : artifactFile(firmware).bytes))
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    if (loaderBesideImage(layout)) {
      // A loader the layout places nowhere executes from outside this disk (an Amlogic boot0 from eMMC): it travels beside the image.
      copyFileSync(firmware, join(work, 'firmware.bin'))
      writeFileSync(join(work, 'firmware.json'), firmwareEnvelope)
    }
    const system = join(work, 'system-tree')
    const esp = join(work, 'esp-tree')
    const data = join(work, 'data-tree')
    for (const path of [join(system, 'deployments'), data]) mkdirSync(path, { recursive: true })
    if (!fit) {
      for (const path of [join(esp, 'EFI/BOOT'), join(esp, 'EFI/mica/kernels'), join(esp, 'loader/entries')]) mkdirSync(path, { recursive: true })
      copyFileSync(firmware, join(esp, 'EFI/BOOT', facts.firmware.format === 'efi' ? facts.firmware.loaderName : ''))
      writeFileSync(join(esp, 'loader/loader.conf'), 'timeout 0\nconsole-mode keep\neditor no\nauto-entries no\nauto-firmware no\n')
      if (options.provisioning !== undefined) {
        if (!lstatSync(options.provisioning).isFile()) throw new Error(`Factory seed is not a regular file: ${options.provisioning}`)
        copyFileSync(options.provisioning, join(esp, PROVISIONING_DOCUMENT))
      }
    }
    const copyObject = (source: string, target: string, expected: { bytes: number, sha256: string }) => {
      const actual = artifactFile(source)
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Factory object integrity mismatch: ${source}`)
      if (existsSync(target)) return
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    for (const record of records) {
      const d = record.descriptor
      for (const [directory, target, name, metadata] of [
        [record.kernelDirectory, join(system, 'kernels', d.kernel.id), 'support', d.kernel.support],
        [record.rootDirectory, join(system, 'roots', d.rootfs.id), 'rootfs', d.rootfs.content],
      ] as const) {
        copyObject(join(directory, `${name}.img`), join(target, `${name}.img`), metadata.image)
        copyObject(join(directory, `${name}.roothash.p7s`), join(target, `${name}.roothash.p7s`), metadata.signature)
        writeFileSync(join(target, `${name}.roothash`), metadata.rootHash)
      }
      copyObject(join(record.kernelDirectory, fit ? 'boot.itb' : 'boot.efi'), fit ? join(system, 'kernels', d.kernel.id, 'boot.itb') : join(esp, 'EFI/mica/kernels', `${d.kernel.id}.efi`), d.kernel.boot.artifact)
      writeFileSync(join(system, 'deployments', `${record.id}.json`), record.envelope)
      if (!fit) writeFileSync(join(esp, 'loader/entries', `mica-${record.id}+3.conf`), entryText(d))
    }
    for (const directory of ['state', 'meta', 'cache', 'tmp', 'var', 'mica', 'srv']) mkdirSync(join(data, directory), { mode: directory === 'state' || directory === 'meta' ? 0o700 : 0o755 })
    writeFileSync(join(data, 'meta/firmware.json'), firmwareEnvelope)
    await tb.must(['find', system, ...(!fit ? [esp] : []), data, '-exec', 'touch', '-h', '-d', '@1577836800', '{}', '+'])
    const ctx = { tb, layout, facts, trees: { system, esp, data }, firmware,
      records: records.toSorted((a, b) => b.descriptor.generation - a.descriptor.generation)
        .map(r => ({ id: r.id, kernelId: r.descriptor.kernel.id, generation: r.descriptor.generation, tries: 3 })),
      bundle: join(BOARDS_DIR, layout.board), systemBytes, bootBytes, ...(options.provisioning !== undefined ? { provisioning: options.provisioning } : {}) }
    for (const partition of layout.partitions) await ROLES[partition.role].build(ctx, partition, join(work, `${partition.name}.img`))
    const disk = join(work, 'disk.img')
    await tb.must(['truncate', '-s', String(layout.sizeSectors * 512), disk])
    await writeGpt(tb, disk, { diskGuid: layout.diskGuid, clear: true, alignSectors: BigInt(layout.alignSectors),
      partitions: layout.partitions.map(p => ({ partnum: BigInt(p.number), startSector: BigInt(p.startSector),
        sizeSectors: BigInt(p.sizeSectors), label: p.name, guid: p.guid, typecode: p.type })) })
    for (const partition of layout.partitions) await tb.must(['dd', `if=${join(work, `${partition.name}.img`)}`, `of=${disk}`, 'bs=1M', 'oflag=seek_bytes', `seek=${partition.startSector * 512}`, 'conv=notrunc,sparse', 'status=none'])
    await verifyGpt(tb, disk)
    renameSync(work, output)
    return join(output, 'disk.img')
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
