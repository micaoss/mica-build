// A UBI board's flash, read out of its flash.tsv and held to the rules: the chip's geometry, the MTD regions
// its first-stage loader fixes, the one UBI partition and the sizes of the fixed volumes in it. Nothing here
// knows a board; the device learns only the UBI partition's name (the signed board policy, board.ubi.mtd), and
// every other region is the image producer's (mica-core docs/mica-core.md 6.6).
//
//   # mica flash layout v1
//   flash   <nor | nand>  <erase block, bytes>  <min I/O, bytes>  <sub-page, bytes>  <VID header offset, bytes>  <size, bytes>
//   mtd     <name>  <role>  <offset, bytes>  <size, bytes>  <source>
//   volume  <system | data>  <LEBs>
//   reserve <system | data>  <MiB>  1 to 1024, both: the free space kept beside what is written (the device's
//                                   defaults are sized for disks)
//
// Roles: loader (the board's U-Boot; source `loader`), fixed (a region the first-stage loader fixes; source
// file:<path in this directory> or `-` for erased), ubi (exactly one; source `-`). The regions lie in flash
// order, erase-block aligned, inside the flash, without gaps or overlap. The fixed volumes are system (UBIFS,
// SYSTEM's small files) and data (UBIFS, DATA), 24 LEBs at least each and never resized; records-a and records-b
// are one LEB each and every object a static volume of its own (ubiCapacity).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECORD_BYTES } from './file-layout.ts'

export class FlashLayoutError extends Error {}

/** The storage models, in common/kernel/features.tsv's spelling (its storage: triggers). */
export type Storage = 'gpt' | 'ubi'

/** A board's storage model, board.env's BOARD_STORAGE: gpt (a layout.tsv) unless it says ubi (a flash.tsv). */
export function storageOf(values: ReadonlyMap<string, string>, file = 'board.env'): Storage {
  const storage = values.get('BOARD_STORAGE') ?? 'gpt'
  if (storage !== 'gpt' && storage !== 'ubi') throw new FlashLayoutError(`${file}: BOARD_STORAGE '${storage}' is neither gpt nor ubi`)
  return storage
}

export const MTD_ROLES = ['loader', 'fixed', 'ubi'] as const
export type MtdRole = typeof MTD_ROLES[number]

export interface FlashGeometry { kind: 'nor' | 'nand', eraseBlock: number, minIo: number, subPage: number, vidOffset: number, size: number }
export interface MtdRegion { name: string, role: MtdRole, offset: number, size: number, source: string }
export interface FlashLayout {
  board: string
  flash: FlashGeometry
  regions: MtdRegion[]
  /** The fixed UBIFS volumes, in LEBs. */
  volumes: { system: number, data: number }
  /** What installation keeps free in the UBI device, and a download on DATA, MiB. */
  declaredReserves: Record<'system' | 'data', number>
}

/** The MTD and UBI volume name rule of the boot policy (board.ubi.mtd) and of UBI itself. */
export const MTD_NAME = /^[A-Za-z0-9._-]{1,63}$/
/** UBI_VOL_NAME_MAX. */
export const UBI_VOLUME_NAME_MAX = 127
/** The UBI headers' own size, UBI_EC_HDR_SIZE and UBI_VID_HDR_SIZE. */
const UBI_HEADER = 64
/** The PEBs UBI keeps for itself: the layout volume (2), wear-leveling (1) and the atomic LEB change (1). */
const UBI_RESERVED_PEBS = 4
/** The fewest LEBs of a fixed volume: UBIFS has 17 (UBIFS_MIN_LEB_CNT), and mkfs.ubifs sizes its log by default so
 * that it formats 22 at the NOR and 2 KiB-page NAND LEB sizes measured and refuses 20; the floor keeps a margin. */
export const UBIFS_MIN_LEBS = 24
/** NAND's default bad-block reserve, per 1024 PEBs of the device (CONFIG_MTD_UBI_BEB_LIMIT). */
const BEB_LIMIT = 20

const align = (n: number, to: number) => Math.ceil(n / to) * to

/** The table's rows, checked against the rules. */
export function parseFlashLayout(text: string, board: string, file = 'flash.tsv'): FlashLayout {
  const fail = (m: string): never => { throw new FlashLayoutError(`${file}: ${m}`) }
  const lines = text.split('\n')
  if (lines[0] !== '# mica flash layout v1') fail('the first line is not "# mica flash layout v1"')
  const integer = (value: string, what: string, min = 0) => {
    const n = Number(value)
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < min) fail(`${what} '${value}' is not an integer of at least ${min}`)
    return n
  }
  let flash: FlashGeometry | undefined
  const regions: MtdRegion[] = [], volumes: Partial<FlashLayout['volumes']> = {}, declared: Partial<FlashLayout['declaredReserves']> = {}
  for (const [i, line] of lines.entries()) {
    if (line === '' || line.startsWith('#')) continue
    const c = line.split('\t'), at = `line ${i + 1}`
    if (c[0] === 'flash') {
      if (c.length !== 7) fail(`${at}: flash <nor|nand> <erase block> <min I/O> <sub-page> <VID header offset> <size>`)
      if (flash) fail(`${at}: a second flash row`)
      if (c[1] !== 'nor' && c[1] !== 'nand') fail(`${at}: the flash kind '${c[1]}' is neither nor nor nand`)
      flash = { kind: c[1] as 'nor' | 'nand', eraseBlock: integer(c[2]!, 'the erase block', 1), minIo: integer(c[3]!, 'the min I/O', 1),
        subPage: integer(c[4]!, 'the sub-page', 1), vidOffset: integer(c[5]!, 'the VID header offset', 1), size: integer(c[6]!, 'the flash size', 1) }
    }
    else if (c[0] === 'mtd') {
      if (c.length !== 6) fail(`${at}: mtd <name> <role> <offset> <size> <source>`)
      const [, name, role, offset, size, source] = c as [string, string, string, string, string, string]
      if (!MTD_NAME.test(name)) fail(`${at}: '${name}' is not an MTD name (1 to 63 of A-Z a-z 0-9 . _ -)`)
      if (!(MTD_ROLES as readonly string[]).includes(role)) fail(`${at}: the role '${role}' is none of ${MTD_ROLES.join(', ')}`)
      regions.push({ name, role: role as MtdRole, offset: integer(offset, 'an offset'), size: integer(size, 'a size', 1), source })
    }
    else if (c[0] === 'volume') {
      if (c.length !== 3 || (c[1] !== 'system' && c[1] !== 'data')) fail(`${at}: volume <system|data> <LEBs>`)
      if (volumes[c[1] as 'system' | 'data'] !== undefined) fail(`${at}: a second ${c[1]} volume row`)
      volumes[c[1] as 'system' | 'data'] = integer(c[2]!, `the ${c[1]} volume's LEBs, a UBIFS's`, UBIFS_MIN_LEBS)
    }
    else if (c[0] === 'reserve') {
      if (c.length !== 3 || (c[1] !== 'system' && c[1] !== 'data')) fail(`${at}: reserve <system|data> <MiB>`)
      if (declared[c[1] as 'system' | 'data'] !== undefined) fail(`${at}: a second ${c[1]} reserve`)
      const mib = integer(c[2]!, 'a reserve', 1)
      if (mib > 1024) fail(`${at}: a reserve of ${mib} MiB is above 1024`)
      declared[c[1] as 'system' | 'data'] = mib
    }
    else { fail(`${at}: '${c[0]}' is not a row of a flash layout (flash, mtd, volume, reserve)`) }
  }
  if (!flash) return fail('no flash row')
  const f = flash
  if (f.minIo > f.eraseBlock || f.eraseBlock % f.minIo !== 0) fail(`the erase block ${f.eraseBlock} is not a multiple of the min I/O ${f.minIo}`)
  if (f.subPage > f.minIo || f.minIo % f.subPage !== 0) fail(`the sub-page ${f.subPage} does not divide the min I/O ${f.minIo}`)
  if (f.vidOffset % f.subPage !== 0 || f.vidOffset < align(UBI_HEADER, f.subPage) || f.vidOffset + UBI_HEADER > f.eraseBlock)
    fail(`the VID header offset ${f.vidOffset} is not a sub-page multiple after the erase counter header`)
  if (f.size % f.eraseBlock !== 0) fail(`the flash size ${f.size} is not a multiple of the erase block ${f.eraseBlock}`)
  let end = 0
  for (const r of regions) {
    if (r.offset !== end) fail(`the region ${r.name} starts at ${r.offset}, and the regions before it end at ${end}: the regions cover the flash in order, without gaps or overlap`)
    if (r.offset % f.eraseBlock !== 0 || r.size % f.eraseBlock !== 0) fail(`the region ${r.name} is not erase-block aligned`)
    end = r.offset + r.size
    if (regions.filter(x => x.name === r.name).length !== 1) fail(`the region name ${r.name} is used twice`)
    if (r.role === 'loader' && r.source !== 'loader') fail(`the loader region ${r.name} has the source '${r.source}'; a loader region's source is loader`)
    if (r.role === 'ubi' && r.source !== '-') fail(`the UBI region ${r.name} has the source '${r.source}'; UBI holds what the assembly writes`)
    if (r.role === 'fixed' && r.source !== '-' && !/^file:[A-Za-z0-9._/-]+$/.test(r.source)) fail(`the fixed region ${r.name} has the source '${r.source}'; it is file:<path> or -`)
  }
  if (end !== f.size) fail(`the regions end at ${end}, and the flash is ${f.size} bytes`)
  if (regions.filter(r => r.role === 'ubi').length !== 1) fail('there is not exactly one ubi region')
  if (regions.filter(r => r.role === 'loader').length > 1) fail('there is more than one loader region')
  if (volumes.system === undefined || volumes.data === undefined) fail('the system and data volume rows are both required')
  if (declared.system === undefined || declared.data === undefined) fail('the system and data reserve rows are both required')
  const layout: FlashLayout = { board, flash: f, regions, volumes: volumes as FlashLayout['volumes'], declaredReserves: declared as FlashLayout['declaredReserves'] }
  const { leb, available } = ubiGeometry(layout)
  if (leb < RECORD_BYTES) fail(`a LEB is ${leb} bytes, below the ${RECORD_BYTES} of one boot record copy`)
  const fixed = layout.volumes.system + layout.volumes.data + 2
  if (fixed > available) fail(`the fixed volumes take ${fixed} LEBs, and the UBI partition has ${available}`)
  return layout
}

export function loadFlashLayout(boardDir: string, board: string): FlashLayout {
  const file = join(boardDir, 'flash.tsv')
  if (!existsSync(file)) throw new FlashLayoutError(`${file} does not exist; a UBI board describes its flash there`)
  return parseFlashLayout(readFileSync(file, 'utf8'), board, file)
}

export function ubiRegion(layout: FlashLayout): MtdRegion {
  return layout.regions.find(r => r.role === 'ubi')!
}

/** A LEB's size and the LEBs the UBI partition offers its volumes, after UBI's own and the bad-block reserve. */
export function ubiGeometry(layout: FlashLayout): { leb: number, pebs: number, available: number } {
  const f = layout.flash
  const leb = f.eraseBlock - align(f.vidOffset + UBI_HEADER, f.minIo)
  const pebs = ubiRegion(layout).size / f.eraseBlock
  // UBI sizes the bad-block reserve by the whole chip, not by its partition.
  const bad = f.kind === 'nand' ? Math.ceil((f.size / f.eraseBlock) * BEB_LIMIT / 1024) : 0
  return { leb, pebs, available: Math.max(0, pebs - UBI_RESERVED_PEBS - bad) }
}

/** The LEBs `bytes` occupy as a static volume: its size rounded up to whole LEBs. */
export function lebs(layout: FlashLayout, bytes: number): number {
  return Math.ceil(bytes / ubiGeometry(layout).leb)
}

/**
 * The capacity rule over whole LEBs: two deployments' objects (the kernel's boot.itb and support.img and the
 * root's rootfs.img each), the core set's components, the `p.<name>` of the largest object while it is written
 * and the system reserve, beside the fixed volumes and the two records. A refusal, or undefined.
 */
export function ubiCapacity(layout: FlashLayout, deployment: readonly number[], coreSet: readonly number[]): string | undefined {
  const { leb, available } = ubiGeometry(layout)
  const one = deployment.reduce((n, b) => n + lebs(layout, b), 0), cores = coreSet.reduce((n, b) => n + lebs(layout, b), 0)
  const largest = Math.max(0, ...deployment.map(b => lebs(layout, b)), ...coreSet.map(b => lebs(layout, b)))
  const reserve = Math.ceil(layout.declaredReserves.system * 1048576 / leb)
  const need = layout.volumes.system + layout.volumes.data + 2 + 2 * one + cores + largest + reserve
  return need > available
    ? `two deployments of ${one} LEBs, the core set's ${cores}, a ${largest}-LEB object being written, the ${reserve}-LEB system reserve and the fixed volumes need ${need} LEBs of ${leb} bytes, and the UBI partition offers ${available}`
    : undefined
}

/** The static volume an object lives in (mica-core docs/mica-core.md 6.6), held to UBI's name limit with its `p.` prefix. */
export function objectVolume(kind: 'k' | 's' | 'r' | 'c', id: string): string {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new FlashLayoutError(`'${id}' is not a component id`)
  const name = `${kind}-${id}`
  if (`p.${name}`.length > UBI_VOLUME_NAME_MAX) throw new FlashLayoutError(`p.${name} is longer than a UBI volume name`)
  return name
}
