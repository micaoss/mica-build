// The facts of a board the engine dispatches on, read out of its board.env
// and nothing else. No branch asks "is this cx3576?"; each asks the
// fact -- which backend, which firmware format, which addresses --
// so a board that reuses an existing backend costs data in boards/<board>/, not
// code here. tests/gates/board-name-lint.test.ts holds the line.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadLayout, partitionOf, RECORD_BYTES, type FileLayout } from './file-layout.ts'
import { BACKENDS } from './backends/index.ts'
import { FIRMWARE_FORMATS, formatsOf, type FirmwareFormatModule, type FirmwareTarget } from './firmware-formats.ts'
import { loadFlashLayout, storageOf, ubiRegion, type FlashLayout, type Storage } from './flash-layout.ts'
import { BOARDS_DIR, boardEnvPath } from './paths.ts'
import { parseBoardEnv, type BoardEnvFile } from './verify-package.ts'
import { ARCH, ARCH_CHOICES, isArch, type Arch } from '../rootfs/runtime/arch.ts'

export type Backend = 'systemd-boot' | 'uboot-fit'
export type Profile = 'dev' | 'prod'
export type { Arch }

const EFI_ARCH: Partial<Record<Arch, 'X64' | 'AA64'>> = { amd64: 'X64', arm64: 'AA64' }

export type FirmwareFacts
  = | { format: 'efi', loaderName: string, partition: number }
    | { format: 'rockchip-loader', binName: string, maxBytes: number, diskOffset: number, magic: string }
    | { format: 'amlogic-boot0', binName: string, minBytes: number, maxBytes: number, payloadOffset: number }
    | { format: 'mtd-loader', binName: string, partition: string, maxBytes: number }

export interface FitFacts {
  dtb: string
  watchdog: string
  addresses: readonly [string, string, string]
  /** On a ubi board: where the loader reads k-<kernelId> whole, and the most bytes it reads (FIT_UBI_ADDRESS,
   * FIT_UBI_LIMIT); the boot image is held to that limit. */
  ubi?: { address: string, limit: number }
}

export interface BoardFacts {
  board: string
  arch: Arch
  backend: Backend
  /** board.env's BOARD_STORAGE: a GPT disk (layout.tsv), or raw flash under UBI (flash.tsv). */
  storage: Storage
  /** The EFI machine type systemd-boot and the UKI stub are built for, in the spec's spelling (BOOTX64.EFI, BOOTAA64.EFI);
   * absent on an architecture no board boots EFI on. */
  efiArch?: 'X64' | 'AA64'
  /** What Kbuild left in the kernel directory: bzImage on x86, Image on arm64, zImage on armhf. */
  kernelImage: 'bzImage' | 'Image' | 'zImage'
  /** The authenticated kernel command line, BOARD_CMDLINE_ARGS. */
  cmdline: string
  firmware: FirmwareFacts
  /** What the boot path proves, board.env's BOOT_TRUST: `fit` (the default) when the loader verifies the FIT's
   * signature against the key in its control DTB, `none` when it checks only the FIT's hashes. The FIT is signed
   * either way. */
  bootTrust: 'fit' | 'none'
  /** The FIT facts of a uboot-fit board; absent on a UEFI board. */
  fit?: FitFacts
  /** The ESP's FAT volume id; absent on a FIT board. */
  espVolumeId?: string
  /** The flash of a ubi board (flash.tsv); absent on a gpt board. */
  flash?: FlashLayout
  releaseTarget: boolean
  /** The `board` section of the signed boot policy the kernel component carries. */
  policy: BoardPolicy
}

/**
 * What the device learns about its board from boot.json, and from nothing else: the backend, the kernel format,
 * the GPT numbers of its boot medium, SYSTEM and DATA, the firmware target and, on a FIT board, the boot record
 * geometry (mica-core crates/mica-deploy/src/board.rs, BoardFacts). Every value is read from board.env and
 * layout.tsv; a new board is a new policy, not a mica-core change.
 */
export type BoardPolicy = GptBoardPolicy | UbiBoardPolicy

interface PolicyCommon {
  boot: 'uefi' | 'uboot-fit'
  kernel: 'uki' | 'fit'
  firmware: FirmwareTarget
  /** The layout's declared reserves, bytes; an undeclared one is the device's default. */
  reserves?: Partial<Record<'system' | 'esp' | 'data', number>>
  /** `false` when board.env's BOARD_DATA_QUOTAS=0: DATA without prjquota and project limits. Absent is on. */
  dataQuotas?: false
  /** `none` when board.env's BOOT_TRUST=none: the loader checks the FIT's hashes, not its signature. Absent is fit. */
  bootTrust?: 'none'
}

/** A disk board: the GPT numbers of its boot medium, SYSTEM and DATA, and on FIT the record geometry. */
export interface GptBoardPolicy extends PolicyCommon {
  partitions: { boot: number, system: number, data: number }
  records?: { startSector: number, sectors: number, offsets: [number, number], size: number }
  storage?: never
  ubi?: never
}

/** A ubi board: the MTD partition of its UBI device, no partitions or records (its copies are the records
 * volumes), DATA without quotas and both reserves declared. */
export interface UbiBoardPolicy extends PolicyCommon {
  storage: 'ubi'
  ubi: { mtd: string }
  partitions?: never
  records?: never
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The facts of a board.env; the loader's place on the disk and the esp's volume id are its layout.tsv's, and on a
 * ubi board the loader's MTD partition and the UBI partition are its flash.tsv's. */
export function boardFacts(env: BoardEnvFile, layout: FileLayout | FlashLayout): BoardFacts {
  const get = (key: string): string => {
    const value = env.values.get(key)
    if (value === undefined || value === '') throw new Error(`board.env declares no ${key}`)
    return value
  }
  const integer = (key: string): number => {
    const value = Number(get(key))
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`board.env ${key} is not a positive integer`)
    return value
  }
  const board = get('LAYOUT_BOARD')
  if (!NAME.test(board)) throw new Error(`board.env LAYOUT_BOARD '${board}' is not a board name`)
  const arch = get('MICA_ARCH')
  if (!isArch(arch)) throw new Error(`board.env MICA_ARCH '${arch}' is not one of ${ARCH_CHOICES}`)
  const backend = get('BOOT_BACKEND')
  if (backend !== 'systemd-boot' && backend !== 'uboot-fit') throw new Error(`board.env BOOT_BACKEND '${backend}' is neither systemd-boot nor uboot-fit`)
  const efiArch = EFI_ARCH[arch]
  if (backend === 'systemd-boot' && efiArch === undefined) throw new Error(`board.env BOOT_BACKEND systemd-boot on ${arch}, which no EFI target is built for; such a board boots uboot-fit`)
  const format = get('FIRMWARE_FORMAT')
  const module = (FIRMWARE_FORMATS as Record<string, FirmwareFormatModule | undefined>)[format]
  if (module === undefined || module.backend !== backend) throw new Error(`board.env FIRMWARE_FORMAT '${format}' on a ${backend} board; it boots ${formatsOf(backend)}`)
  const storage = storageOf(env.values)
  const flash = 'flash' in layout ? layout : undefined
  if ((storage === 'ubi') !== (flash !== undefined)) throw new Error(`board.env BOARD_STORAGE=${storage} read with a ${flash ? 'flash.tsv' : 'layout.tsv'}`)
  if (storage === 'ubi' && backend !== 'uboot-fit') throw new Error(`board.env BOARD_STORAGE=ubi on a ${backend} board; UBI boards boot a FIT`)
  if (module.storage !== storage) throw new Error(`board.env FIRMWARE_FORMAT '${format}' on a ${storage} board; the format is written to ${module.storage === 'ubi' ? 'raw flash' : 'a disk'}`)
  let fit: FitFacts | undefined
  if (backend === 'uboot-fit') {
    const addresses = get('FIT_LOAD_ADDRESSES').split(' ').filter(Boolean)
    if (addresses.length !== 3 || addresses.some(a => !/^0x[0-9a-fA-F]+$/.test(a))) throw new Error('board.env FIT_LOAD_ADDRESSES is three hexadecimal addresses')
    fit = { dtb: get('FIT_DTB'), watchdog: get('FIT_WATCHDOG'), addresses: [addresses[0]!, addresses[1]!, addresses[2]!] }
    if (flash) fit.ubi = ubiFit(get('FIT_UBI_ADDRESS'), integer('FIT_UBI_LIMIT'), fit.addresses)
  }
  const bootTrust = env.values.get('BOOT_TRUST') ?? 'fit'
  if (bootTrust !== 'fit' && bootTrust !== 'none') throw new Error(`board.env BOOT_TRUST '${bootTrust}' is neither fit nor none`)
  if (bootTrust === 'none' && backend !== 'uboot-fit') throw new Error(`board.env BOOT_TRUST=none on a ${backend} board; only a uboot-fit loader may boot without verifying a signature`)
  const firmware = module.facts({ get, integer, board, efiArch, ...(flash ? { flash } : { layout: layout as FileLayout }) })
  const cmdline = get('BOARD_CMDLINE_ARGS')
  if (flash) checkUbiCmdline(cmdline, flash)
  const quotas = env.values.get('BOARD_DATA_QUOTAS') ?? '1'
  if (quotas !== '0' && quotas !== '1') throw new Error(`board.env BOARD_DATA_QUOTAS '${quotas}' is neither 0 nor 1`)
  if (flash && env.values.get('BOARD_DATA_QUOTAS') === '1') throw new Error('board.env BOARD_DATA_QUOTAS=1 on a ubi board; UBIFS has no project quotas')
  const trust = bootTrust === 'none' ? { bootTrust: 'none' as const } : {}
  const policy: BoardPolicy = flash
    ? { ...ubiPolicy(module.target(firmware), flash), ...trust }
    : { ...boardPolicy(BACKENDS[backend], module.target(firmware), layout as FileLayout), ...(quotas === '0' ? { dataQuotas: false as const } : {}), ...trust }
  const releaseTarget = get('BOARD_RELEASE_TARGET')
  if (releaseTarget !== '0' && releaseTarget !== '1') throw new Error(`board.env BOARD_RELEASE_TARGET '${releaseTarget}' is neither 0 nor 1`)
  return { board, arch, backend, storage, ...(efiArch ? { efiArch } : {}), kernelImage: ARCH[arch].kernelImage, cmdline,
    firmware, bootTrust, ...(fit ? { fit } : {}), ...(backend === 'systemd-boot' ? { espVolumeId: partitionOf(layout as FileLayout, 'esp').volumeId! } : {}),
    ...(flash ? { flash } : {}), releaseTarget: releaseTarget === '1', policy }
}

/** The policy of a ubi board: its UBI partition, its loader's MTD partition, both reserves, DATA without quotas. */
function ubiPolicy(firmware: FirmwareTarget, flash: FlashLayout): UbiBoardPolicy {
  if (firmware.format !== 'mtd-loader') throw new Error(`a ubi board's firmware target is mtd-loader, not ${firmware.format}`)
  const r = flash.declaredReserves
  return { boot: 'uboot-fit', kernel: 'fit', storage: 'ubi', ubi: { mtd: ubiRegion(flash).name }, firmware,
    reserves: { system: r.system * 1048576, data: r.data * 1048576 }, dataQuotas: false }
}

/** Where a ubi board's loader reads the FIT: a buffer of `limit` bytes (1 to 128 MiB) that holds none of the
 * addresses the FIT's images are loaded to. */
function ubiFit(address: string, limit: number, loads: readonly string[]): { address: string, limit: number } {
  if (!/^0x[0-9a-fA-F]+$/.test(address)) throw new Error('board.env FIT_UBI_ADDRESS is not a hexadecimal address')
  if (limit > 134217728) throw new Error(`board.env FIT_UBI_LIMIT ${limit} is above the 128 MiB of a FIT`)
  const start = Number(address)
  const inside = loads.filter(a => Number(a) >= start && Number(a) < start + limit)
  if (inside.length > 0) throw new Error(`board.env FIT_UBI_ADDRESS ${address} and FIT_UBI_LIMIT ${limit} cover the load address ${inside.join(', ')}; the FIT is read where none of its images is loaded`)
  return { address, limit }
}

const SIZE_SUFFIX: Record<string, number> = { '': 1, 'k': 1024, 'K': 1024, 'm': 1048576, 'M': 1048576, 'g': 1073741824, 'G': 1073741824 }

/**
 * The forced command line of a ubi board names its UBI partition exactly once (`ubi.mtd=`, which the kernel attaches
 * before init and the policy's board.ubi.mtd states), and an `mtdparts=`, where the device tree does not partition
 * the flash, is the flash layout's regions: their names and sizes, in order.
 */
function checkUbiCmdline(cmdline: string, flash: FlashLayout): void {
  const words = cmdline.split(/\s+/).filter(Boolean)
  const mtd = ubiRegion(flash).name
  const attach = words.filter(w => w.startsWith('ubi.mtd='))
  if (attach.length !== 1 || attach[0] !== `ubi.mtd=${mtd}`) throw new Error(`board.env BOARD_CMDLINE_ARGS names ${attach.join(' ') || 'no ubi.mtd='}; a ubi board's command line attaches its UBI partition once, ubi.mtd=${mtd}`)
  const parts = words.filter(w => w.startsWith('mtdparts='))
  if (parts.length === 0) return
  if (parts.length > 1) throw new Error('board.env BOARD_CMDLINE_ARGS carries mtdparts= twice')
  const specs = parts[0]!.slice('mtdparts='.length).split(':').slice(1).join(':').split(',')
  const named = specs.map(s => /^([0-9]+)([kKmMgG]?)\(([^)]+)\)$/.exec(s)).map(m => (m ? { size: Number(m[1]) * SIZE_SUFFIX[m[2]!]!, name: m[3]! } : undefined))
  const want = flash.regions.map(r => ({ size: r.size, name: r.name }))
  if (named.length !== want.length || named.some((n, i) => n === undefined || n.size !== want[i]!.size || n.name !== want[i]!.name))
    throw new Error(`board.env BOARD_CMDLINE_ARGS ${parts[0]} is not the regions of flash.tsv (${want.map(w => `${w.size}(${w.name})`).join(',')})`)
}

/** The policy of a layout: the record regions' partition is the boot medium where the layout has them, the esp where it does not. */
function boardPolicy(backend: { policyBoot: BoardPolicy['boot'], bootFormat: BoardPolicy['kernel'] }, firmware: FirmwareTarget, layout: FileLayout): BoardPolicy {
  const [a, b] = ['records-a', 'records-b'].map(source => layout.regions.find(r => r.source === source))
  const boot = a === undefined ? partitionOf(layout, 'esp') : layout.partitions.find(p => p.name === a.partition)!
  return { boot: backend.policyBoot, kernel: backend.bootFormat,
    partitions: { boot: boot.number, system: partitionOf(layout, 'system').number, data: partitionOf(layout, 'data').number }, firmware,
    ...(a !== undefined && b !== undefined ? { records: { startSector: boot.startSector, sectors: boot.sizeSectors, offsets: [a.offset, b.offset] as [number, number], size: RECORD_BYTES } } : {}),
    ...(Object.keys(layout.declaredReserves).length > 0 ? { reserves: Object.fromEntries(Object.entries(layout.declaredReserves).map(([k, mib]) => [k, mib * 1048576])) } : {}) }
}

/** The fetched kernel directory a product of `profile` packs: its backend's (src/image/backends/). */
export function kernelDirectory(facts: Pick<BoardFacts, 'board' | 'backend'>, profile: Profile, boards: string = BOARDS_DIR): string {
  if (profile !== 'dev' && profile !== 'prod') throw new Error(`Invalid image profile: ${String(profile)}`)
  return join(boards, facts.board, BACKENDS[facts.backend].kernelDir(profile))
}

/** The facts of a pinned, fetched board (`_out/boards/<board>/board.env`). */
export function loadBoardFacts(board: string, storageLayout = ''): BoardFacts {
  if (!NAME.test(board)) throw new Error(`'${board}' is not a board name`)
  const facts = boardFactsFrom(boardEnvPath(board), storageLayout)
  if (facts.board !== board) throw new Error(`${boardEnvPath(board)} declares LAYOUT_BOARD=${facts.board}`)
  return facts
}

/** The facts of a board.env at an explicit path (a fixture, a frozen checkout), with the layout.tsv or, on a ubi
 * board, the flash.tsv beside it. */
export function boardFactsFrom(path: string, storageLayout = ''): BoardFacts {
  const env = parseBoardEnv(readFileSync(path, 'utf8'), 'board.env')
  if (storageOf(env.values) === 'gpt') return boardFacts(env, loadLayout(dirname(path), storageLayout))
  if (storageLayout !== '') throw new Error(`${path}: a ubi board has one flash.tsv and no storage layout '${storageLayout}'`)
  return boardFacts(env, loadFlashLayout(dirname(path), env.values.get('LAYOUT_BOARD') ?? ''))
}
