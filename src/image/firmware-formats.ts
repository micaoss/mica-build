// The firmware formats the engine implements: the one dispatch point on board.env's FIRMWARE_FORMAT. Each says
// which boot backend it belongs to, how its facts are read, the signed target a firmware receipt carries for it,
// that target's bounds, the loader file, whether the firmware is built and signed here or is the board's loader,
// where an assembled image carries it and how it is maintained. A board that uses an existing format is data; a
// new format is one entry here.
import type { Backend, FirmwareFacts } from './board-facts.ts'
import { partitionOf, regionOf, type FileLayout } from './file-layout.ts'

export type FirmwareFormat = FirmwareFacts['format']

/** The destination a signed firmware receipt names, exactly as the receipt carries it and the board's signed
 * boot policy names it (mica-core crates/mica-deploy/src/firmware.rs, Target). */
export type FirmwareTarget
  = | { format: 'efi', partition: number, path: string }
    | { format: 'disk-range', diskOffset: number, maxBytes: number }
    | { format: 'emmc-boot', area: 'boot0', payloadOffset: number, maxBytes: number }

export interface FactsReader {
  get(key: string): string
  integer(key: string): number
  board: string
  efiArch: 'X64' | 'AA64'
  layout: FileLayout
}

export interface FirmwareFormatModule {
  readonly backend: Backend
  facts(r: FactsReader): FirmwareFacts
  target(fw: FirmwareFacts): FirmwareTarget
  /** The `format` of that target: the receipt's spelling, which is not the engine's name for the format. */
  readonly targetFormat: FirmwareTarget['format']
  /** The target's fields, and its bounds over a parsed receipt: the byte limit of its artifact, or a refusal. */
  readonly targetFields: readonly string[]
  checkTarget(target: Record<string, unknown>, arch: string, artifactBytes: number): { limit: number } | { refusal: string }
  /** The loader's file name, in the firmware component and beside an image. */
  loaderFile(fw: FirmwareFacts): string
  /** Built and signed here (the EFI loader), or the board's own loader taken from its bundle. */
  readonly builtHere: boolean
  /** The bounds a board loader is held to before it is packed. */
  checkLoader(fw: FirmwareFacts, loader: Buffer): string | undefined
  /** The board's U-Boot build outputs its uboot component carries: <_out/<board>/ directory, component directory>. */
  readonly ubootOutputs: readonly (readonly [string, string])[]
  /** Where an assembled image carries the loader: on its esp, at its disk offset, or beside the image. */
  readonly inImage: 'esp' | 'disk' | 'beside'
  /** How installed firmware is replaced offline: on a mounted esp, over RockUSB, or not by this tool. */
  readonly maintenance: 'esp' | 'rockusb' | 'recovery-package'
}

const bounded = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 64 * 1048576

const efi: FirmwareFormatModule = {
  backend: 'systemd-boot',
  facts: r => ({ format: 'efi', loaderName: `BOOT${r.efiArch}.EFI`, partition: partitionOf(r.layout, 'esp').number }),
  target: (fw) => {
    const f = fw as Extract<FirmwareFacts, { format: 'efi' }>
    return { format: 'efi', partition: f.partition, path: `EFI/BOOT/${f.loaderName}` }
  },
  targetFormat: 'efi',
  targetFields: ['format', 'partition', 'path'],
  checkTarget: (t, arch, bytes) => (t.format === 'efi' && Number.isSafeInteger(t.partition) && (t.partition as number) >= 1 && (t.partition as number) <= 128 && /^EFI\/BOOT\/BOOT(X64|AA64)\.EFI$/.test(String(t.path))
    && (arch === 'amd64') === (t.path === 'EFI/BOOT/BOOTX64.EFI') && bytes <= 4 * 1048576
    ? { limit: 4 * 1048576 }
    : { refusal: 'invalid EFI destination' }),
  loaderFile: fw => (fw as Extract<FirmwareFacts, { format: 'efi' }>).loaderName,
  builtHere: true,
  checkLoader: () => undefined,
  ubootOutputs: [],
  inImage: 'esp',
  maintenance: 'esp',
}

const rockchipLoader: FirmwareFormatModule = {
  backend: 'uboot-fit',
  facts(r) {
    const loader = regionOf(r.layout, 'loader')
    if (loader === undefined) throw new Error(`${r.board}'s layout.tsv has no loader region; a rockchip-loader is written to the disk`)
    return { format: 'rockchip-loader', binName: r.get('UBOOT_BIN_NAME'), maxBytes: r.integer('UBOOT_MAX_BYTES'), diskOffset: loader.diskOffset,
      magic: Buffer.from(r.get('LOADER_MAGIC_HEX'), 'hex').toString('ascii') }
  },
  target: (fw) => {
    const f = fw as Extract<FirmwareFacts, { format: 'rockchip-loader' }>
    return { format: 'disk-range', diskOffset: f.diskOffset, maxBytes: f.maxBytes }
  },
  targetFormat: 'disk-range',
  targetFields: ['format', 'diskOffset', 'maxBytes'],
  checkTarget: (t, _arch, bytes) => (bounded(t.diskOffset) && bounded(t.maxBytes) && bytes <= (t.maxBytes as number)
    ? { limit: t.maxBytes as number }
    : { refusal: 'invalid loader write range' }),
  loaderFile: fw => (fw as Extract<FirmwareFacts, { format: 'rockchip-loader' }>).binName,
  builtHere: false,
  checkLoader: (fw, loader) => {
    const f = fw as Extract<FirmwareFacts, { format: 'rockchip-loader' }>
    return loader.length > f.maxBytes || loader.subarray(0, f.magic.length).toString('ascii') !== f.magic ? 'Invalid bounded Rockchip loader' : undefined
  },
  ubootOutputs: [['uboot-mica', 'uboot']],
  inImage: 'disk',
  maintenance: 'rockusb',
}

const amlogicBoot0: FirmwareFormatModule = {
  backend: 'uboot-fit',
  facts: r => ({ format: 'amlogic-boot0', binName: r.get('UBOOT_BIN_NAME'), minBytes: r.integer('UBOOT_MIN_BYTES'), maxBytes: r.integer('UBOOT_MAX_BYTES'),
    payloadOffset: r.integer('UBOOT_PAYLOAD_OFFSET_BYTES') }),
  target: (fw) => {
    const f = fw as Extract<FirmwareFacts, { format: 'amlogic-boot0' }>
    return { format: 'emmc-boot', area: 'boot0', payloadOffset: f.payloadOffset, maxBytes: f.maxBytes }
  },
  targetFormat: 'emmc-boot',
  targetFields: ['format', 'area', 'payloadOffset', 'maxBytes'],
  checkTarget: (t, _arch, bytes) => ((t.area === 'boot0' || t.area === 'boot1') && bounded(t.payloadOffset) && bounded(t.maxBytes) && bytes <= (t.maxBytes as number)
    ? { limit: t.maxBytes as number }
    : { refusal: 'invalid Amlogic boot0 payload' }),
  loaderFile: fw => (fw as Extract<FirmwareFacts, { format: 'amlogic-boot0' }>).binName,
  builtHere: false,
  checkLoader: (fw, loader) => {
    const f = fw as Extract<FirmwareFacts, { format: 'amlogic-boot0' }>
    return loader.length < f.minBytes || loader.length > f.maxBytes ? 'Invalid bounded Amlogic boot0 payload' : undefined
  },
  ubootOutputs: [['uboot', 'uboot'], ['uboot-package', 'uboot-package']],
  inImage: 'beside',
  maintenance: 'recovery-package',
}

/** The format module a receipt's target `format` belongs to. */
export function formatOfTarget(format: unknown): FirmwareFormatModule | undefined {
  return Object.values(FIRMWARE_FORMATS).find(m => m.targetFormat === format)
}

export const FIRMWARE_FORMATS: Readonly<Record<FirmwareFormat, FirmwareFormatModule>> = { 'efi': efi, 'rockchip-loader': rockchipLoader, 'amlogic-boot0': amlogicBoot0 }

/** The formats a backend boots, in the words a refusal names them. */
export function formatsOf(backend: Backend): string {
  return (Object.keys(FIRMWARE_FORMATS) as FirmwareFormat[]).filter(f => FIRMWARE_FORMATS[f].backend === backend)
    .map(f => (f === 'efi' ? f : `a${/^[aeiou]/.test(f) ? 'n' : ''} ${f}`)).join(' or ')
}
