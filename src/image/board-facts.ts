// The facts of a board the engine dispatches on, read out of its board.env
// and nothing else. Every branch that used to ask "is this cx3576?" asks the
// fact instead -- which backend, which firmware format, which addresses --
// so a board that reuses an existing backend costs data in mica-boards, not
// code here. tests/gates/board-name-lint.test.ts holds the line.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadLayout, partitionOf, RECORD_BYTES, type FileLayout } from './file-layout.ts'
import { BACKENDS } from './backends/index.ts'
import { FIRMWARE_FORMATS, formatsOf, type FirmwareFormatModule, type FirmwareTarget } from './firmware-formats.ts'
import { BOARDS_DIR, boardEnvPath } from './paths.ts'
import { parseBoardEnv, type BoardEnvFile } from './verify-package.ts'

export type Backend = 'systemd-boot' | 'uboot-fit'
export type Profile = 'dev' | 'prod'
export type Arch = 'amd64' | 'arm64'

export type FirmwareFacts
  = | { format: 'efi', loaderName: string, partition: number }
    | { format: 'rockchip-loader', binName: string, maxBytes: number, diskOffset: number, magic: string }
    | { format: 'amlogic-boot0', binName: string, minBytes: number, maxBytes: number, payloadOffset: number }

export interface FitFacts {
  dtb: string
  watchdog: string
  addresses: readonly [string, string, string]
}

export interface BoardFacts {
  board: string
  arch: Arch
  backend: Backend
  /** The EFI machine type systemd-boot and the UKI stub are built for, in the spec's spelling (BOOTX64.EFI, BOOTAA64.EFI). */
  efiArch: 'X64' | 'AA64'
  /** What Kbuild left in the kernel directory: bzImage on x86, Image on arm64. */
  kernelImage: 'bzImage' | 'Image'
  /** The authenticated kernel command line, BOARD_CMDLINE_ARGS. */
  cmdline: string
  firmware: FirmwareFacts
  /** The FIT facts of a uboot-fit board; absent on a UEFI board. */
  fit?: FitFacts
  /** The ESP's FAT volume id; absent on a FIT board. */
  espVolumeId?: string
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
export interface BoardPolicy {
  boot: 'uefi' | 'uboot-fit'
  kernel: 'uki' | 'fit'
  partitions: { boot: number, system: number, data: number }
  firmware: FirmwareTarget
  records?: { startSector: number, sectors: number, offsets: [number, number], size: number }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The facts of a board.env; the loader's place on the disk and the esp's volume id are its layout.tsv's. */
export function boardFacts(env: BoardEnvFile, layout: FileLayout): BoardFacts {
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
  if (arch !== 'amd64' && arch !== 'arm64') throw new Error(`board.env MICA_ARCH '${arch}' is neither amd64 nor arm64`)
  const backend = get('BOOT_BACKEND')
  if (backend !== 'systemd-boot' && backend !== 'uboot-fit') throw new Error(`board.env BOOT_BACKEND '${backend}' is neither systemd-boot nor uboot-fit`)
  const efiArch = arch === 'amd64' ? 'X64' : 'AA64'
  const format = get('FIRMWARE_FORMAT')
  const module = (FIRMWARE_FORMATS as Record<string, FirmwareFormatModule | undefined>)[format]
  if (module === undefined || module.backend !== backend) throw new Error(`board.env FIRMWARE_FORMAT '${format}' on a ${backend} board; it boots ${formatsOf(backend)}`)
  let fit: FitFacts | undefined
  if (backend === 'uboot-fit') {
    const addresses = get('FIT_LOAD_ADDRESSES').split(' ').filter(Boolean)
    if (addresses.length !== 3 || addresses.some(a => !/^0x[0-9a-fA-F]+$/.test(a))) throw new Error('board.env FIT_LOAD_ADDRESSES is three hexadecimal addresses')
    fit = { dtb: get('FIT_DTB'), watchdog: get('FIT_WATCHDOG'), addresses: [addresses[0]!, addresses[1]!, addresses[2]!] }
  }
  const firmware = module.facts({ get, integer, board, efiArch, layout })
  const policy = boardPolicy(BACKENDS[backend], module.target(firmware), layout)
  const releaseTarget = get('BOARD_RELEASE_TARGET')
  if (releaseTarget !== '0' && releaseTarget !== '1') throw new Error(`board.env BOARD_RELEASE_TARGET '${releaseTarget}' is neither 0 nor 1`)
  return { board, arch, backend, efiArch, kernelImage: arch === 'amd64' ? 'bzImage' : 'Image', cmdline: get('BOARD_CMDLINE_ARGS'),
    firmware, ...(fit ? { fit } : {}), ...(backend === 'systemd-boot' ? { espVolumeId: partitionOf(layout, 'esp').volumeId! } : {}), releaseTarget: releaseTarget === '1', policy }
}

/** The policy of a layout: the record regions' partition is the boot medium where the layout has them, the esp where it does not. */
function boardPolicy(backend: { policyBoot: BoardPolicy['boot'], bootFormat: BoardPolicy['kernel'] }, firmware: FirmwareTarget, layout: FileLayout): BoardPolicy {
  const [a, b] = ['records-a', 'records-b'].map(source => layout.regions.find(r => r.source === source))
  const boot = a === undefined ? partitionOf(layout, 'esp') : layout.partitions.find(p => p.name === a.partition)!
  return { boot: backend.policyBoot, kernel: backend.bootFormat,
    partitions: { boot: boot.number, system: partitionOf(layout, 'system').number, data: partitionOf(layout, 'data').number }, firmware,
    ...(a !== undefined && b !== undefined ? { records: { startSector: boot.startSector, sectors: boot.sizeSectors, offsets: [a.offset, b.offset] as [number, number], size: RECORD_BYTES } } : {}) }
}

/** The fetched kernel directory a product of `profile` packs: its backend's (src/image/backends/). */
export function kernelDirectory(facts: Pick<BoardFacts, 'board' | 'backend'>, profile: Profile, boards: string = BOARDS_DIR): string {
  if (profile !== 'dev' && profile !== 'prod') throw new Error(`Invalid image profile: ${String(profile)}`)
  return join(boards, facts.board, BACKENDS[facts.backend].kernelDir(profile))
}

/** The facts of a pinned, fetched board (`_out/boards/<board>/board.env`). */
export function loadBoardFacts(board: string): BoardFacts {
  if (!NAME.test(board)) throw new Error(`'${board}' is not a board name`)
  const facts = boardFacts(parseBoardEnv(readFileSync(boardEnvPath(board), 'utf8'), 'board.env'), loadLayout(dirname(boardEnvPath(board))))
  if (facts.board !== board) throw new Error(`${boardEnvPath(board)} declares LAYOUT_BOARD=${facts.board}`)
  return facts
}

/** The facts of a board.env at an explicit path (a fixture, a frozen checkout). */
export function boardFactsFrom(path: string): BoardFacts {
  return boardFacts(parseBoardEnv(readFileSync(path, 'utf8'), 'board.env'), loadLayout(dirname(path)))
}
