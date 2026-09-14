import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { artifactFile } from './component-build.ts'
import { componentId, verifyDeployment, type BootIdentity, type Deployment } from './components.ts'
import { loadBoardFacts } from './board-facts.ts'
import { checkCapacity, checkSystemFilesystemCapacity, type FileLayout } from './file-layout.ts'
import { writeFirmwareRegion } from './fit-environment.ts'
import { authenticateFirmware } from './firmware.ts'
import { pinSeededTimes } from './pin-seeded-times.ts'
import { type Toolset, Toolbox } from './toolbox.ts'
import { mke2fs, dumpe2fsHeader } from './tools/e2fsprogs.ts'
import { verifyGpt, writeGpt } from './tools/sgdisk.ts'

export const FILE_IMAGE_TOOLS: Toolset = {
  key: 'file-image', imageKey: 'IMAGE_ALPINE_3_21', manager: 'apk',
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

export const PROVISIONING_DOCUMENT = 'mica-provisioning.toml'

export async function assembleFileImage(layout: FileLayout, deployments: FactoryDeployment[], keys: string[], firmwareDirectory: string, output: string, tb: Toolbox, options: FactoryImageOptions = {}): Promise<string> {
  const fit = layout.backend === 'uboot-fit'
  if (options.provisioning !== undefined && fit) throw new Error(`Board ${layout.board} boots through a FIT and has no ESP to carry ${PROVISIONING_DOCUMENT}; a factory seed for it travels on removable media`)
  if (deployments.length !== 2) throw new Error('Factory image requires two deployments')
  const facts = loadBoardFacts(layout.board)
  if (facts.backend !== layout.backend) throw new Error('Factory boot backend mismatch')
  const firmwareEnvelope = readFileSync(join(firmwareDirectory, 'firmware.json'), 'utf8')
  const manifest = authenticateFirmware(firmwareEnvelope, keys, facts)
  if (manifest.board !== layout.board) throw new Error('Factory firmware board mismatch')
  const firmware = join(firmwareDirectory, facts.firmware.format === 'efi' ? facts.firmware.loaderName : facts.firmware.binName)
  const artifact = artifactFile(firmware)
  if (artifact.bytes !== manifest.artifact.bytes || artifact.sha256 !== manifest.artifact.sha256) throw new Error('Factory firmware integrity mismatch')
  if (existsSync(output)) throw new Error(`Image output exists: ${output}`)
  const records = deployments.map(input => {
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
    if (facts.firmware.format === 'amlogic-boot0') {
      // The boot0 payload executes from eMMC, outside the image: it travels beside it.
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
    for (const partition of layout.partitions) {
      const path = join(work, `${partition.name.toLowerCase()}.img`)
      if (partition.name === 'FIRMWARE') {
        writeFirmwareRegion(layout, firmware, records.toSorted((a, b) => b.descriptor.generation - a.descriptor.generation)
          .map(r => ({ id: r.id, kernelId: r.descriptor.kernel.id, generation: r.descriptor.generation, tries: 3 })), path)
        continue
      }
      await tb.must(['truncate', '-s', String(partition.sizeSectors * 512), path])
      if (partition.name === 'ESP') {
        await tb.must(['mkfs.vfat', '--invariant', '-F', '32', '-i', facts.espVolumeId!, '-n', 'MICAESP', path])
        for (const name of ['EFI', 'loader', ...(options.provisioning !== undefined ? [PROVISIONING_DOCUMENT] : [])]) await tb.must(['mcopy', '-s', '-m', '-i', path, join(esp, name), '::/'])
      } else {
        await mke2fs(tb, { image: path, label: partition.name.toLowerCase(), uuid: partition.fsUuid!, blockSize: 4096n,
          bytesPerInode: partition.name === 'DATA' ? 16384 : undefined,
          features: `${partition.name === 'DATA' ? 'project,quota,' : ''}^orphan_file,^metadata_csum_seed`,
          fakeTime: '1577836800', seedDir: partition.name === 'DATA' ? data : system })
        // mke2fs initializes quota accounting before importing the seed tree.
        // Account for those files before publishing the complete factory image.
        if (partition.name === 'DATA') {
          const checked = await tb.run(['env', 'E2FSPROGS_FAKE_TIME=1577836800', 'e2fsck', '-fy', path])
          if (![0, 1].includes(checked.exitCode)) throw new Error(`Factory quota initialization failed: ${checked.stderr}`)
        }
        if (partition.name === 'SYSTEM') {
          checkSystemFilesystemCapacity(await dumpe2fsHeader(tb, path), systemBytes + (fit ? bootBytes : 0))
        }
        await pinSeededTimes(tb, path, '@1577836800')
        await tb.must(['e2fsck', '-fn', path])
      }
    }
    const disk = join(work, 'disk.img')
    await tb.must(['truncate', '-s', String(layout.sizeSectors * 512), disk])
    await writeGpt(tb, disk, { diskGuid: layout.diskGuid, clear: true, alignSectors: BigInt(layout.alignSectors),
      partitions: layout.partitions.map(p => ({ partnum: BigInt(p.number), startSector: BigInt(p.startSector),
        sizeSectors: BigInt(p.sizeSectors), label: p.name.toLowerCase(), guid: p.guid, typecode: p.type })) })
    for (const partition of layout.partitions) await tb.must(['dd', `if=${join(work, `${partition.name.toLowerCase()}.img`)}`, `of=${disk}`, 'bs=1M', 'oflag=seek_bytes', `seek=${partition.startSector * 512}`, 'conv=notrunc,sparse', 'status=none'])
    await verifyGpt(tb, disk)
    renameSync(work, output)
    return join(output, 'disk.img')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
