// A board's disk, read out of its layout.tsv and held to the rules. The table is the board's: its partitions,
// what role each one plays and where the raw regions lie, sizes, offsets, identities and type codes included
// (mica:docs/plan/20260921-1142-merge-boards-into-build.md, P3). Nothing here knows a board's partition set;
// the one place a board is known by name is src/image/device-fit-geometry.ts, the device's compiled record
// geometry, which goes when mica-core carries it in the signed board policy (P4).
//
//   # mica layout v1
//   disk    <disk guid>  <sector size>  <alignment, sectors>
//   part    <number>  <GPT name>  <role>  <start sector>  <size, sectors>  <type guid>  <partition guid>  <filesystem id or ->
//   region  <partition name>  <region name>  <offset in the partition, bytes>  <size, bytes>  <source>
//   reserve <system | esp>  <MiB>      optional: what the capacity check keeps free beside two deployments
//
// The rules: exactly one `system` and one `data` partition, `data` last (first-boot repart grows the last
// partition); on systemd-boot exactly one `esp`, on uboot-fit none and one `raw` partition carrying both boot
// record regions; partitions numbered 1..n in disk order, aligned, non-overlapping and inside the disk; regions
// only in `raw` partitions, inside them and non-overlapping; distinct names and identities; the capacity of
// two deployments with their reserve over the declared `system` (and `esp`) size. The reserves are 128 MiB
// (system) and 64 MiB (esp) unless a `reserve` row declares another, which a board sized for a small part does
// (mica:docs/plan/20260926-0930-mini-images-on-128-mb.md).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Backend } from './board-facts.ts'
import { DEVICE_FIT_GEOMETRY } from './device-fit-geometry.ts'
import type { Ext4Header } from './tools/e2fsprogs.ts'
import { parseBoardEnv } from './verify-package.ts'

export const ROLE_NAMES = ['esp', 'system', 'data', 'raw', 'vfat', 'ext4'] as const
export type Role = typeof ROLE_NAMES[number]
export const REGION_SOURCES = ['loader', 'records-a', 'records-b'] as const

/** The boot record copy the engine encodes and mica-deploy reads (src/image/fit-environment.ts). */
export const RECORD_BYTES = 65536

export interface FilePartition {
  number: number, name: string, role: Role, startSector: number, sizeSectors: number, type: string, guid: string
  /** The ext4 UUID of a system, data or ext4 partition. */
  fsUuid?: string
  /** The FAT volume id of an esp or vfat partition. */
  volumeId?: string
}
export interface FileRegion { partition: string, name: string, offset: number, size: number, source: string }
export interface FileLayout {
  board: string, backend: Backend, diskGuid: string, alignSectors: number
  partitions: FilePartition[], regions: FileRegion[], sizeSectors: number
  /** What the capacity check keeps free beside two deployments, MiB. */
  reserves: { system: number, esp: number }
}

export class LayoutError extends Error {}

const GUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const NAME = /^[a-z0-9][a-z0-9-]{0,35}$/

/** The table's rows, checked against its rules; `board` and `backend` are the board's (board.env). */
export function parseLayout(text: string, board: string, backend: Backend, file = 'layout.tsv'): FileLayout {
  const fail: (message: string) => never = (message) => { throw new LayoutError(`${file}: ${message}`) }
  const lines = text.split('\n')
  if (lines[0] !== '# mica layout v1') fail('the first line is not "# mica layout v1"')
  const integer = (value: string, what: string, min = 0) => {
    const n = Number(value)
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < min) fail(`${what} '${value}' is not an integer of at least ${min}`)
    return n
  }
  const guid = (value: string, what: string) => {
    const v = value.toLowerCase()
    if (!GUID.test(v)) fail(`${what} '${value}' is not a GUID`)
    return v
  }
  let disk: { guid: string, align: number } | undefined
  const partitions: FilePartition[] = [], regions: FileRegion[] = []
  const declared: Partial<Record<'system' | 'esp', number>> = {}
  for (const [i, line] of lines.entries()) {
    if (line === '' || line.startsWith('#')) continue
    const at = `line ${i + 1}`
    const c = line.split('\t')
    if (c[0] === 'disk') {
      if (c.length !== 4) fail(`${at}: a disk row has 4 columns, not ${c.length}`)
      if (disk !== undefined) fail(`${at}: a second disk row`)
      if (c[2] !== '512') fail(`${at}: sector size ${c[2]}; the engine writes 512-byte sectors`)
      disk = { guid: guid(c[1]!, 'the disk guid'), align: integer(c[3]!, 'the alignment', 1) }
    }
    else if (c[0] === 'part') {
      if (c.length !== 9) fail(`${at}: a part row has 9 columns, not ${c.length}`)
      const [, number, name, role, start, size, type, id, fs] = c as [string, string, string, string, string, string, string, string, string]
      if (!NAME.test(name)) fail(`${at}: '${name}' is not a partition name (lowercase letters, digits and hyphens, at most 36)`)
      if (!(ROLE_NAMES as readonly string[]).includes(role)) fail(`${at}: role '${role}' is none the engine implements (${ROLE_NAMES.join(', ')})`)
      const p: FilePartition = { number: integer(number, 'the partition number', 1), name, role: role as Role,
        startSector: integer(start, 'the start sector', 34), sizeSectors: integer(size, 'the size', 1), type: guid(type, 'the type guid'), guid: guid(id, 'the partition guid') }
      if (role === 'raw') { if (fs !== '-') fail(`${at}: a raw partition carries no filesystem id, not '${fs}'`) }
      else if (role === 'esp' || role === 'vfat') {
        if (!/^[0-9A-Fa-f]{8}$/.test(fs)) fail(`${at}: the FAT volume id '${fs}' of ${name} is not 8 hexadecimal digits`)
        p.volumeId = fs.toUpperCase()
      }
      else { p.fsUuid = guid(fs, `the filesystem uuid of ${name}`) }
      partitions.push(p)
    }
    else if (c[0] === 'region') {
      if (c.length !== 6) fail(`${at}: a region row has 6 columns, not ${c.length}`)
      const [, partition, name, offset, size, source] = c as [string, string, string, string, string, string]
      if (!NAME.test(name)) fail(`${at}: '${name}' is not a region name`)
      if ((!(REGION_SOURCES as readonly string[]).includes(source) && !/^file:[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(source)) || source.includes('..'))
        fail(`${at}: source '${source}' is none of ${REGION_SOURCES.join(', ')} or file:<path in the board directory>`)
      regions.push({ partition, name, offset: integer(offset, 'the region offset'), size: integer(size, 'the region size', 1), source })
    }
    else if (c[0] === 'reserve') {
      if (c.length !== 3) fail(`${at}: a reserve row has 3 columns, not ${c.length}`)
      const role = c[1]!
      if (role !== 'system' && role !== 'esp') fail(`${at}: a reserve for '${role}'; only the system and esp reserves are declared`)
      if (declared[role] !== undefined) fail(`${at}: a second ${role} reserve`)
      declared[role] = integer(c[2]!, `the ${role} reserve`)
    }
    else { fail(`${at}: '${c[0]}' is no row kind (disk, part, region, reserve)`) }
  }
  if (disk === undefined) fail('no disk row')
  if (partitions.length === 0) fail('no part row')

  // Partitions: numbered in disk order, aligned, apart, inside the disk; distinct names and identities.
  let end = 34
  for (const [i, p] of partitions.entries()) {
    if (p.number !== i + 1) fail(`partition ${p.name} is number ${p.number}; partitions are numbered 1..${partitions.length} in row order`)
    if (p.startSector % disk.align !== 0) fail(`partition ${p.name} starts at sector ${p.startSector}, not a multiple of the alignment ${disk.align}`)
    if (p.startSector < end) fail(`partition ${p.name} starts at sector ${p.startSector}, inside ${i === 0 ? 'the primary GPT' : `partition ${partitions[i - 1]!.name}`}`)
    end = p.startSector + p.sizeSectors
  }
  const sizeSectors = end + 2048
  if (!Number.isSafeInteger(sizeSectors * 512)) fail('the disk is larger than this engine can address')
  const dup = (what: string, values: string[]) => { const d = values.find((v, i) => values.indexOf(v) !== i); if (d !== undefined) fail(`two partitions share the ${what} ${d}`) }
  dup('name', partitions.map(p => p.name))
  dup('identity', [disk.guid, ...partitions.map(p => p.guid), ...partitions.flatMap(p => (p.fsUuid ? [p.fsUuid] : []))])
  dup('volume id', partitions.flatMap(p => (p.volumeId ? [p.volumeId] : [])))

  // Roles: one system, one data and data last; the boot medium the backend reads.
  const count = (role: Role) => partitions.filter(p => p.role === role).length
  if (count('system') !== 1) fail(`${count('system')} system partitions; a board has exactly one`)
  if (count('data') !== 1) fail(`${count('data')} data partitions; a board has exactly one`)
  if (partitions.at(-1)!.role !== 'data') fail('the data partition is not the last; first-boot growth extends the last partition')
  if (backend === 'systemd-boot' && count('esp') !== 1) fail(`${count('esp')} esp partitions on a systemd-boot board; it boots from exactly one`)
  if (backend === 'uboot-fit' && count('esp') !== 0) fail('an esp partition on a uboot-fit board; its boot medium is a raw partition with the record regions')
  if (declared.esp !== undefined && count('esp') === 0) fail('an esp reserve on a board with no esp partition')

  // Regions: in a raw partition, inside it, apart; names unique per partition.
  for (const r of regions) {
    const p = partitions.find(x => x.name === r.partition)
    if (p === undefined) fail(`region ${r.name} names no partition ${r.partition}`)
    if (p.role !== 'raw') fail(`region ${r.name} is in ${p.name}, a ${p.role} partition; only a raw partition holds regions`)
    if (r.offset + r.size > p.sizeSectors * 512) fail(`region ${r.name} (${r.offset}+${r.size} bytes) is outside ${p.name} (${p.sizeSectors * 512} bytes)`)
    for (const o of regions) {
      if (o === r || o.partition !== r.partition) continue
      if (o.name === r.name) fail(`two regions of ${p.name} are named ${r.name}`)
      if (r.offset < o.offset + o.size && o.offset < r.offset + r.size) fail(`regions ${r.name} and ${o.name} of ${p.name} overlap`)
    }
    if (r.source.startsWith('records-') && r.size !== RECORD_BYTES) fail(`region ${r.name} is ${r.size} bytes; a boot record copy is ${RECORD_BYTES}`)
  }
  for (const source of REGION_SOURCES) if (regions.filter(r => r.source === source).length > 1) fail(`two regions carry the ${source}`)
  const records = ['records-a', 'records-b'].map(s => regions.find(r => r.source === s))
  if (backend === 'uboot-fit') {
    if (records.some(r => r === undefined)) fail('a uboot-fit board carries the records-a and records-b regions')
    if (records[0]!.partition !== records[1]!.partition) fail('the two record regions are in different partitions')
    const device = DEVICE_FIT_GEOMETRY[board]
    const p = partitions.find(x => x.name === records[0]!.partition)!
    if (device === undefined) fail(`mica-deploy compiles no FIT record geometry for ${board}; until it reads the geometry from the signed board policy (mica:docs/plan/20260921-1142-merge-boards-into-build.md, P4) a new FIT board needs a mica-core change`)
    if (p.startSector !== device.startSector || p.sizeSectors !== device.sizeSectors || records[0]!.offset !== device.records[0] || records[1]!.offset !== device.records[1])
      fail(`the record geometry of ${board} (${p.name} at sector ${p.startSector}, ${p.sizeSectors} sectors, records at ${records[0]!.offset} and ${records[1]!.offset}) is not the one mica-deploy compiles in (sector ${device.startSector}, ${device.sizeSectors} sectors, records at ${device.records.join(' and ')}); the device would write elsewhere (P4)`)
  }
  else {
    if (records.some(r => r !== undefined) || regions.some(r => r.source === 'loader')) fail('a systemd-boot board carries no loader or record region; its loader is on the esp')
  }
  const reserves = { system: declared.system ?? 128, esp: declared.esp ?? 64 }
  return { board, backend, diskGuid: disk.guid, alignSectors: disk.align, partitions, regions, sizeSectors, reserves }
}

/** The layout of a board directory or fetched bundle: its layout.tsv, with the board and backend of its board.env. */
export function loadLayout(dir: string): FileLayout {
  const envFile = join(dir, 'board.env'), file = join(dir, 'layout.tsv')
  if (!existsSync(file)) throw new LayoutError(`${file} does not exist; every board declares its disk in layout.tsv`)
  const env = parseBoardEnv(readFileSync(envFile, 'utf8'), envFile)
  const board = env.values.get('LAYOUT_BOARD') ?? '', backend = env.values.get('BOOT_BACKEND') ?? ''
  if (backend !== 'systemd-boot' && backend !== 'uboot-fit') throw new LayoutError(`${envFile}: BOOT_BACKEND '${backend}' is neither systemd-boot nor uboot-fit`)
  return parseLayout(readFileSync(file, 'utf8'), board, backend, file)
}

/** The one partition of a role a layout has exactly once (system, data, and esp on systemd-boot). */
export function partitionOf(layout: FileLayout, role: Role): FilePartition {
  const found = layout.partitions.filter(p => p.role === role)
  if (found.length !== 1) throw new LayoutError(`${layout.board} has ${found.length} ${role} partitions, not one`)
  return found[0]!
}

/** A region by its source, and its absolute offset on the disk. */
export function regionOf(layout: FileLayout, source: string): (FileRegion & { diskOffset: number }) | undefined {
  const r = layout.regions.find(x => x.source === source)
  if (r === undefined) return undefined
  return { ...r, diskOffset: layout.partitions.find(p => p.name === r.partition)!.startSector * 512 + r.offset }
}

/** Preflight two full deployments; installation also checks filesystem availability. The boot objects live on
 * the esp where the layout has one, beside the roots on system where it does not. */
export function checkCapacity(layout: FileLayout, systemBytes: number, bootBytes: number): void {
  const esp = layout.partitions.find(p => p.role === 'esp')
  const requirements = esp === undefined
    ? [[partitionOf(layout, 'system'), systemBytes + bootBytes, layout.reserves.system] as const]
    : [[partitionOf(layout, 'system'), systemBytes, layout.reserves.system] as const, [esp, bootBytes, layout.reserves.esp] as const]
  for (const [partition, bytes, reserve] of requirements) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || 2 * bytes + reserve * 1048576 > partition.sizeSectors * 512)
      throw new Error(`${partition.name} cannot retain the running deployment and its replacement with reserve`)
  }
}

/** Account for ext4 metadata and both reserves before publishing a factory disk. */
/** Two full deployments and the reserve (MiB; the layout's, 128 unless declared) inside the SYSTEM filesystem's usable blocks. */
export function checkSystemFilesystemCapacity(header: Ext4Header, deploymentBytes: number, reserveMib = 128): void {
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
  if (2n * BigInt(deploymentBytes) + BigInt(reserveMib) * 1048576n > usable)
    throw new Error('SYSTEM filesystem cannot retain two full deployments with installation reserve')
}
