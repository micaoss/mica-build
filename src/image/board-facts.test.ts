import { expect, test } from 'bun:test'
import { boardFacts, loadBoardFacts } from './board-facts.ts'
import { pinnedBoards } from './paths.ts'
import { parseBoardEnv } from './verify-package.ts'
import type { FileLayout } from './file-layout.ts'

// The layouts the facts read the esp's volume id and the loader's place from (layout.tsv, as parsed).
const LAYOUT: FileLayout = { board: 'demo', backend: 'systemd-boot', diskGuid: '', alignSectors: 2048, sizeSectors: 0, regions: [],
  partitions: [{ number: 1, name: 'esp', role: 'esp', startSector: 2048, sizeSectors: 2048, type: '', guid: '', volumeId: 'C3576101' }] }
const FIT_LAYOUT: FileLayout = { board: 'demo-fit', backend: 'uboot-fit', diskGuid: '', alignSectors: 1, sizeSectors: 0,
  partitions: [{ number: 1, name: 'firmware', role: 'raw', startSector: 64, sizeSectors: 36800, type: '', guid: '' }],
  regions: [{ partition: 'firmware', name: 'loader', offset: 0, size: 16744448, source: 'loader' }] }
const env = (text: string) => boardFacts(parseBoardEnv(text, 'board.env'), text.includes('uboot-fit') ? FIT_LAYOUT : LAYOUT)
const UEFI = `LAYOUT_BOARD=demo\nMICA_ARCH=amd64\nBOOT_BACKEND=systemd-boot\nFIRMWARE_FORMAT=efi\nBOARD_RELEASE_TARGET=1\nBOARD_CMDLINE_ARGS="console=ttyS0 ro rdinit=/init"\n`
const FIT = `LAYOUT_BOARD=demo-fit\nMICA_ARCH=arm64\nBOOT_BACKEND=uboot-fit\nFIRMWARE_FORMAT=rockchip-loader\nUBOOT_BIN_NAME=u-boot-rockchip.bin\nUBOOT_MAX_BYTES=16744448\nLOADER_MAGIC_HEX=524b4e53\nFIT_DTB=board.dtb\nFIT_WATCHDOG=DW_WATCHDOG\nFIT_LOAD_ADDRESSES="0x42000000 0x52000000 0x54000000"\nBOARD_RELEASE_TARGET=0\nBOARD_CMDLINE_ARGS="console=ttyFIQ0 ro rdinit=/init"\n`

test('every pinned board yields its facts, and they agree with its backend', () => {
  const boards = pinnedBoards()
  expect(boards.length).toBeGreaterThan(1)
  for (const board of boards) {
    const facts = loadBoardFacts(board)
    expect(facts.board).toBe(board)
    expect(facts.fit !== undefined).toBe(facts.backend === 'uboot-fit')
    expect(facts.espVolumeId !== undefined).toBe(facts.backend === 'systemd-boot')
    expect(facts.firmware.format === 'efi').toBe(facts.backend === 'systemd-boot')
    expect(facts.kernelImage).toBe(facts.arch === 'amd64' ? 'bzImage' : 'Image')
  }
})

test('a UEFI board: the loader follows the EFI machine type, no FIT facts', () => {
  const facts = env(UEFI)
  expect(facts.efiArch).toBe('X64')
  expect(facts.firmware).toEqual({ format: 'efi', loaderName: 'BOOTX64.EFI' })
  expect(facts.fit).toBeUndefined()
  expect(facts.espVolumeId).toBe('C3576101')
  expect(facts.releaseTarget).toBe(true)
})

test('a FIT board: the loader magic is decoded, the disk offset is its layout\'s loader region', () => {
  const facts = env(FIT)
  expect(facts.firmware).toEqual({ format: 'rockchip-loader', binName: 'u-boot-rockchip.bin', maxBytes: 16744448, diskOffset: 32768, magic: 'RKNS' })
  expect(facts.fit).toEqual({ dtb: 'board.dtb', watchdog: 'DW_WATCHDOG', addresses: ['0x42000000', '0x52000000', '0x54000000'] })
  expect(facts.espVolumeId).toBeUndefined()
})

test.each([
  ['a systemd-boot board with a loader format', UEFI.replace('FIRMWARE_FORMAT=efi', 'FIRMWARE_FORMAT=rockchip-loader'), 'it boots efi'],
  ['a FIT board with the efi format', FIT.replace('FIRMWARE_FORMAT=rockchip-loader', 'FIRMWARE_FORMAT=efi'), 'rockchip-loader or an amlogic-boot0'],
  ['two load addresses', FIT.replace('0x54000000', ''), 'three hexadecimal addresses'],
  ['no command line', UEFI.replace(/BOARD_CMDLINE_ARGS=.*\n/, ''), 'no BOARD_CMDLINE_ARGS'],
  ['a release target that is neither 0 nor 1', UEFI.replace('BOARD_RELEASE_TARGET=1', 'BOARD_RELEASE_TARGET=yes'), 'neither 0 nor 1'],
])('%s is refused by name', (_label, text, fragment) => {
  expect(() => env(text)).toThrow(fragment)
})
