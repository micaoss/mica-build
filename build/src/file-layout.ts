import { parseBoardEnv } from './verify-package.ts'
import type { Ext4Header } from './tools/e2fsprogs.ts'

export interface FilePartition {
  name: string, number: number, startSector: number, sizeSectors: number, guid: string, type: string, fsUuid?: string
}
export interface FileLayout {
  board: string, backend: 'systemd-boot' | 'uboot-fit', diskGuid: string,
  alignSectors: number, partitions: FilePartition[], sizeSectors: number,
  firmware?: { loaderStartSector?: number, loaderSizeSectors?: number, envOffsets: [number, number], envSize: number }
}

export function parseFileLayout(source: string): FileLayout {
  const env = parseBoardEnv(source, 'board.env')
  if (env.duplicates.length) throw new Error('Duplicate layout assignment')
  const get = (name: string) => {
    const value = env.values.get(name)
    if (!value) throw new Error(`Missing layout field ${name}`)
    return value
  }
  const number = (name: string) => {
    const value = Number(get(name))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid layout integer ${name}`)
    return value
  }
  const guid = (name: string) => {
    const value = get(name).toLowerCase()
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) throw new Error(`Invalid GUID ${name}`)
    return value
  }
  const backend = get('BOOT_BACKEND')
  if (get('LAYOUT_VERSION') !== '3' || !['systemd-boot', 'uboot-fit'].includes(backend) || number('SECTOR_SIZE') !== 512) throw new Error('Expected a signed file deployment layout')
  const fit = backend === 'uboot-fit'
  const names = [fit ? 'FIRMWARE' : 'ESP', 'SYSTEM', 'DATA']
  if (get('LAYOUT_PARTITIONS') !== names.join(' ')) throw new Error('Invalid file deployment partition set')
  const partitions = names.map((name, i) => ({
    name, number: number(`${name}_PARTNUM`),
    startSector: fit && i === 0 ? number('FIRMWARE_START_SECTOR') : number(`${name}_START_MIB`) * 2048,
    sizeSectors: fit && i === 0 ? number('FIRMWARE_SIZE_SECTORS') : number(`${name}_SIZE_MIB`) * 2048,
    guid: guid(`${name}_GUID`), type: guid(`${name}_TYPECODE`), ...(i ? { fsUuid: guid(`${name}_FS_UUID`) } : {}),
  }))
  if (partitions[1]!.sizeSectors !== 1024 * 2048) throw new Error('SYSTEM must be exactly 1 GiB')
  let end = fit ? 64 : 2048
  for (const [i, partition] of partitions.entries()) {
    if (partition.number !== i + 1 || partition.startSector !== end || !Number.isSafeInteger(partition.sizeSectors)) throw new Error('Partition order, gap or overlap is invalid')
    end += partition.sizeSectors
  }
  if (!Number.isSafeInteger(end + 2048) || new Set(partitions.map(p => p.guid)).size !== 3) throw new Error('Invalid partition sizes or duplicate GUID')
  const alignSectors = number('GPT_ALIGN_SECTORS')
  if (alignSectors !== (fit ? 1 : 2048)) throw new Error('Invalid GPT alignment')
  let firmware: FileLayout['firmware']
  if (fit) {
    firmware = { envOffsets: [number('UENV_A_OFFSET_BYTES'), number('UENV_B_OFFSET_BYTES')], envSize: number('UENV_SIZE_BYTES') }
    // The firmware format says whether the loader lives on the system disk
    // (rockchip-loader, in the protected range) or outside it (amlogic-boot0).
    const format = get('FIRMWARE_FORMAT')
    if (format !== 'rockchip-loader' && format !== 'amlogic-boot0') throw new Error('Unsupported FIT firmware format')
    const amlogic = format === 'amlogic-boot0'
    if (!amlogic) {
      const loaderBytes = number('UBOOT_MAX_BYTES')
      firmware.loaderStartSector = number('UBOOT_SEEK_SECTOR')
      firmware.loaderSizeSectors = loaderBytes / 512
      if (firmware.loaderStartSector !== 64
        || !Number.isSafeInteger(firmware.loaderSizeSectors) || 64 * 512 + loaderBytes !== firmware.envOffsets[0]) throw new Error('Invalid protected loader range')
    } else if (env.values.has('UBOOT_SEEK_SECTOR')) {
      // UBOOT_MAX_BYTES bounds the boot0 payload; a seek sector would put it on the disk.
      throw new Error('Amlogic hardware bootloader cannot occupy the system disk')
    }
    if (firmware.envOffsets[0] !== (amlogic ? 120 : 16) * 1048576
      || firmware.envOffsets[1] !== (amlogic ? 124 : 17) * 1048576
      || firmware.envSize !== 65536 || partitions[1]!.startSector !== (amlogic ? 128 : 18) * 2048
      || partitions[0]!.type !== '8da63339-0007-60c0-c436-083ac8230908') throw new Error('Invalid protected firmware ranges')
  }
  return { board: get('LAYOUT_BOARD'), backend: backend as FileLayout['backend'], diskGuid: guid('DISK_GUID'), alignSectors, partitions, sizeSectors: end + 2048, ...(firmware ? { firmware } : {}) }

}

/** Preflight two full deployments; installation also checks filesystem availability. */
export function checkCapacity(layout: FileLayout, systemBytes: number, bootBytes: number): void {
  const fit = layout.backend === 'uboot-fit'
  const requirements = fit ? [['SYSTEM', systemBytes + bootBytes, 128] as const]
    : [['SYSTEM', systemBytes, 128] as const, ['ESP', bootBytes, 64] as const]
  for (const [name, bytes, reserve] of requirements) {
    const partition = layout.partitions.find(p => p.name === name)
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !partition || 2 * bytes + reserve * 1048576 > partition.sizeSectors * 512) {
      throw new Error(`${name} cannot retain the running deployment and its replacement with reserve`)
    }
  }
}

/** Account for ext4 metadata and both reserves before publishing a factory disk. */
export function checkSystemFilesystemCapacity(header: Ext4Header, deploymentBytes: number): void {
  const count = (name: string) => {
    const value = header.fields.get(name)
    if (value === undefined || !/^[0-9]+$/.test(value)) throw new Error(`Invalid SYSTEM filesystem field ${name}`)
    return BigInt(value)
  }
  if (header.blockSize !== 4096n || header.fields.get('Filesystem features')?.split(/\s+/).includes('bigalloc')
    || !Number.isSafeInteger(deploymentBytes) || deploymentBytes <= 0) throw new Error('Invalid SYSTEM filesystem capacity inputs')
  // ext4 reserves min(2%, 4096) clusters in addition to the superblock reserve.
  // https://www.kernel.org/doc/html/latest/admin-guide/ext4.html#sysfs-entries
  const internalReserve = header.blockCount / 50n < 4096n ? header.blockCount / 50n : 4096n
  const usable = (header.blockCount - count('Overhead clusters') - count('Reserved block count') - internalReserve) * header.blockSize
  if (2n * BigInt(deploymentBytes) + 128n * 1048576n > usable) {
    throw new Error('SYSTEM filesystem cannot retain two full deployments with installation reserve')
  }
}
