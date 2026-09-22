// The facts of a board the engine dispatches on, read out of its board.env
// and nothing else. Every branch that used to ask "is this cx3576?" asks the
// fact instead -- which backend, which firmware format, which addresses --
// so a board that reuses an existing backend costs data in mica-boards, not
// code here. tests/gates/board-name-lint.sh holds the line.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOARDS_DIR, boardEnvPath } from './paths.ts'
import { parseBoardEnv, type BoardEnvFile } from './verify-package.ts'

export type Backend = 'systemd-boot' | 'uboot-fit'
export type Profile = 'dev' | 'prod'
export type Arch = 'amd64' | 'arm64'

export type FirmwareFacts
  = | { format: 'efi', loaderName: string }
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
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

export function boardFacts(env: BoardEnvFile): BoardFacts {
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
  let firmware: FirmwareFacts
  let fit: FitFacts | undefined
  if (backend === 'systemd-boot') {
    if (format !== 'efi') throw new Error(`board.env FIRMWARE_FORMAT '${format}' on a systemd-boot board; it boots efi`)
    firmware = { format: 'efi', loaderName: `BOOT${efiArch}.EFI` }
  }
  else {
    const addresses = get('FIT_LOAD_ADDRESSES').split(' ').filter(Boolean)
    if (addresses.length !== 3 || addresses.some(a => !/^0x[0-9a-fA-F]+$/.test(a))) throw new Error('board.env FIT_LOAD_ADDRESSES is three hexadecimal addresses')
    fit = { dtb: get('FIT_DTB'), watchdog: get('FIT_WATCHDOG'), addresses: [addresses[0]!, addresses[1]!, addresses[2]!] }
    if (format === 'rockchip-loader') {
      firmware = { format, binName: get('UBOOT_BIN_NAME'), maxBytes: integer('UBOOT_MAX_BYTES'), diskOffset: integer('UBOOT_SEEK_SECTOR') * 512,
        magic: Buffer.from(get('LOADER_MAGIC_HEX'), 'hex').toString('ascii') }
    }
    else if (format === 'amlogic-boot0') {
      firmware = { format, binName: get('UBOOT_BIN_NAME'), minBytes: integer('UBOOT_MIN_BYTES'), maxBytes: integer('UBOOT_MAX_BYTES'), payloadOffset: integer('UBOOT_PAYLOAD_OFFSET_BYTES') }
    }
    else {
      throw new Error(`board.env FIRMWARE_FORMAT '${format}' on a uboot-fit board; it boots a rockchip-loader or an amlogic-boot0`)
    }
  }
  const releaseTarget = get('BOARD_RELEASE_TARGET')
  if (releaseTarget !== '0' && releaseTarget !== '1') throw new Error(`board.env BOARD_RELEASE_TARGET '${releaseTarget}' is neither 0 nor 1`)
  return { board, arch, backend, efiArch, kernelImage: arch === 'amd64' ? 'bzImage' : 'Image', cmdline: get('BOARD_CMDLINE_ARGS'),
    firmware, ...(fit ? { fit } : {}), ...(backend === 'systemd-boot' ? { espVolumeId: get('ESP_FAT_VOLUME_ID') } : {}), releaseTarget: releaseTarget === '1' }
}

/**
 * The fetched kernel directory a product of `profile` packs: a FIT board forces
 * its built-in command line, which carries the profile, so its bundle has
 * kernel/dev and kernel/prod; a UEFI board has one kernel/, its profile on the
 * signed UKI command line.
 */
export function kernelDirectory(facts: Pick<BoardFacts, 'board' | 'backend'>, profile: Profile, boards: string = BOARDS_DIR): string {
  if (profile !== 'dev' && profile !== 'prod') throw new Error(`Invalid image profile: ${String(profile)}`)
  return facts.backend === 'uboot-fit' ? join(boards, facts.board, 'kernel', profile) : join(boards, facts.board, 'kernel')
}

/** The facts of a pinned, fetched board (`_out/boards/<board>/board.env`). */
export function loadBoardFacts(board: string): BoardFacts {
  if (!NAME.test(board)) throw new Error(`'${board}' is not a board name`)
  const facts = boardFacts(parseBoardEnv(readFileSync(boardEnvPath(board), 'utf8'), 'board.env'))
  if (facts.board !== board) throw new Error(`${boardEnvPath(board)} declares LAYOUT_BOARD=${facts.board}`)
  return facts
}

/** The facts of a board.env at an explicit path (a fixture, a frozen checkout). */
export function boardFactsFrom(path: string): BoardFacts {
  return boardFacts(parseBoardEnv(readFileSync(path, 'utf8'), 'board.env'))
}
