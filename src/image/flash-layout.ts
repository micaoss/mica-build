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
//   reserve store            <MiB>  1 to 4096, optional: what DATA's first-boot growth leaves the store (the signed
//                                   board.ubi.storeReserve, mica-core's runkit: DATA grows to the free LEBs beside
//                                   the factory content minus this); without it DATA keeps its volume row's size
//   raw     <blocks>         NAND, at most one: the first <blocks> erase blocks are programmed in place, without
//                            bad-block skipping, and read back; they end at or before the UBI region
//
// Roles: loader (the board's U-Boot; source `loader`), fixed (a region the first-stage loader fixes; source
// file:<path in this directory>, input:<VARIABLE>:<sha256> -- a local build input outside git, the file the
// environment variable MICA_<...> names, exactly the region's size and of that sha256 -- or `-` for erased), ubi (exactly
// one; source `-`). The regions lie in flash
// order, erase-block aligned, inside the flash, without gaps or overlap. The fixed volumes are system (UBIFS,
// SYSTEM's small files) and data (UBIFS, DATA), 24 LEBs at least each; system is never resized, and data only by
// the first boot's growth where a store reserve is declared (its row is then the minimum the image carries);
// records-a and records-b are one LEB each and every object a static volume of its own (ubiCapacity).

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
  /** What installation keeps free in the UBI device, and a download on DATA, MiB; store, where declared, what
   * DATA's first-boot growth leaves the store. */
  declaredReserves: Record<'system' | 'data', number> & { store?: number }
  /** The leading erase blocks a flasher programs in place, without bad-block skipping, and reads back; 0 for none. */
  rawBlocks: number
}

/** A fixed region whose content is a local build input: the file `variable` names, of `sha256`. */
export interface FlashInput { region: string, variable: string, sha256: string }

// MICA_*: the variables bin/bun.sh hands into its container.
const INPUT_SOURCE = /^input:(MICA_[A-Z0-9_]+):([0-9a-f]{64})$/

/** The fixed regions of the layout whose source is input:<VARIABLE>:<sha256>, in flash order. */
export function flashInputs(layout: FlashLayout): FlashInput[] {
  return layout.regions.flatMap((r) => {
    const m = r.role === 'fixed' ? INPUT_SOURCE.exec(r.source) : null
    return m === null ? [] : [{ region: r.name, variable: m[1]!, sha256: m[2]! }]
  })
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
  let flash: FlashGeometry | undefined, rawBlocks: number | undefined
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
      if (c.length !== 3 || (c[1] !== 'system' && c[1] !== 'data' && c[1] !== 'store')) fail(`${at}: reserve <system|data|store> <MiB>`)
      const kind = c[1] as 'system' | 'data' | 'store'
      if (declared[kind] !== undefined) fail(`${at}: a second ${kind} reserve`)
      const mib = integer(c[2]!, 'a reserve', 1)
      const most = kind === 'store' ? 4096 : 1024
      if (mib > most) fail(`${at}: a ${kind} reserve of ${mib} MiB is above ${most}`)
      declared[kind] = mib
    }
    else if (c[0] === 'raw') {
      if (c.length !== 2) fail(`${at}: raw <blocks>`)
      if (rawBlocks !== undefined) fail(`${at}: a second raw row`)
      rawBlocks = integer(c[1]!, 'the raw blocks', 1)
    }
    else { fail(`${at}: '${c[0]}' is not a row of a flash layout (flash, mtd, volume, reserve, raw)`) }
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
    if (r.role === 'fixed' && r.source !== '-' && !/^file:[A-Za-z0-9._/-]+$/.test(r.source) && !INPUT_SOURCE.test(r.source))
      fail(`the fixed region ${r.name} has the source '${r.source}'; it is file:<path>, input:<VARIABLE>:<sha256> or -`)
  }
  if (end !== f.size) fail(`the regions end at ${end}, and the flash is ${f.size} bytes`)
  if (regions.filter(r => r.role === 'ubi').length !== 1) fail('there is not exactly one ubi region')
  if (regions.filter(r => r.role === 'loader').length > 1) fail('there is more than one loader region')
  if (volumes.system === undefined || volumes.data === undefined) fail('the system and data volume rows are both required')
  if (declared.system === undefined || declared.data === undefined) fail('the system and data reserve rows are both required')
  if (rawBlocks !== undefined) {
    if (f.kind !== 'nand') fail('a raw row on NOR flash, which has no bad blocks to skip')
    const ubi = regions.find(r => r.role === 'ubi')!
    if (rawBlocks * f.eraseBlock > ubi.offset) fail(`the ${rawBlocks} raw blocks end at ${rawBlocks * f.eraseBlock}, inside the UBI region ${ubi.name} at ${ubi.offset}`)
  }
  const layout: FlashLayout = { board, flash: f, regions, volumes: volumes as FlashLayout['volumes'], declaredReserves: declared as FlashLayout['declaredReserves'], rawBlocks: rawBlocks ?? 0 }
  const { leb, available } = ubiGeometry(layout)
  if (leb < RECORD_BYTES) fail(`a LEB is ${leb} bytes, below the ${RECORD_BYTES} of one boot record copy`)
  const fixed = layout.volumes.system + layout.volumes.data + 2
  if (fixed > available) fail(`the fixed volumes take ${fixed} LEBs, and the UBI partition has ${available}`)
  // mica-core refuses a store reserve below the system reserve and one LEB.
  if (declared.store !== undefined && declared.store * 1048576 < declared.system! * 1048576 + leb)
    fail(`the store reserve of ${declared.store} MiB is below the ${declared.system} MiB system reserve and one LEB`)
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

/** The share of a UBIFS volume's raw bytes taken as room for files: what its own areas (superblock, master, log,
 * LPT, orphans, the index and the GC reserve) leave, rounded down. An estimate; the bench's df is the measure. */
export const UBIFS_USABLE = 0.8

/** What a grown DATA holds against what an update stages on it, on a board with a store reserve: the store reserve
 * in LEBs, DATA's LEBs after its first-boot growth beside this factory content, and the bytes a full update of
 * this size stages on DATA (mica-deploy fetches every object it lacks there first, beside the DATA reserve). */
export function dataGrowth(layout: FlashLayout, deployment: readonly number[], coreSet: readonly number[]): { store: number, data: number, usable: number, staging: number } | undefined {
  const store = layout.declaredReserves.store
  if (store === undefined) return undefined
  const { leb, available } = ubiGeometry(layout)
  const factory = [...deployment, ...coreSet].reduce((n, b) => n + lebs(layout, b), 0)
  const storeLebs = Math.ceil(store * 1048576 / leb)
  const data = Math.max(layout.volumes.data, available - layout.volumes.system - 2 - factory - storeLebs)
  const staging = [...deployment, ...coreSet].reduce((n, b) => n + b, 0) + layout.declaredReserves.data * 1048576
  return { store: storeLebs, data, usable: Math.floor(data * leb * UBIFS_USABLE), staging }
}

/**
 * The capacity rule over whole LEBs. Without a store reserve: two deployments' objects (the kernel's boot.itb and
 * support.img and the root's rootfs.img each), the core set's components, the `p.<name>` of the largest object
 * while it is written and the system reserve, beside the fixed volumes and the two records. With one, the factory
 * content (one deployment, one core set) is written before DATA grows into the rest, so the store reserve must hold
 * what an update adds beside it -- one more deployment, one more core set, the largest object being written and the
 * system reserve (mica-deploy collects the fallback before it writes) -- the factory content, the minimum DATA and
 * the reserve must fit, and the grown DATA must hold what a full update stages on it. A refusal, or undefined.
 */
export function ubiCapacity(layout: FlashLayout, deployment: readonly number[], coreSet: readonly number[]): string | undefined {
  const { leb, available } = ubiGeometry(layout)
  const one = deployment.reduce((n, b) => n + lebs(layout, b), 0), cores = coreSet.reduce((n, b) => n + lebs(layout, b), 0)
  const largest = Math.max(0, ...deployment.map(b => lebs(layout, b)), ...coreSet.map(b => lebs(layout, b)))
  const reserve = Math.ceil(layout.declaredReserves.system * 1048576 / leb)
  const growth = dataGrowth(layout, deployment, coreSet)
  if (growth !== undefined) {
    const update = one + cores + largest + reserve
    if (update > growth.store)
      return `an update beside this content needs ${update} LEBs of ${leb} bytes (a deployment of ${one}, a core set of ${cores}, a ${largest}-LEB object being written, the ${reserve}-LEB system reserve), and the store reserve keeps ${growth.store}`
    const factory = layout.volumes.system + layout.volumes.data + 2 + one + cores + growth.store
    if (factory > available)
      return `the fixed volumes, the factory content (${one + cores} LEBs) and the ${growth.store}-LEB store reserve need ${factory} LEBs of ${leb} bytes, and the UBI partition offers ${available}`
    if (growth.staging > growth.usable)
      return `an update stages ${growth.staging} bytes on DATA (its objects and the DATA reserve), and DATA grown to ${growth.data} LEBs holds about ${growth.usable}`
    return undefined
  }
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
