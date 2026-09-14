// Read a Mica OS disk image without touching the host. The toolset is fixed:
// sgdisk for the GPT, mtools at an offset for the FAT boot
// slots, a byte range read with debugfs/tune2fs for the ext4 partitions,
// unsquashfs for the packed root, and `veritysetup verify`, which walks the hash
// tree in USERSPACE and never creates a device-mapper target, never calls
// losetup and never mounts anything. No host mutation, nothing that needs root.
//
// Four of the five tools answer a question they could not answer with something
// that reads exactly like an answer, measured 2026-08-25 in the pinned
// alpine:3.21 with the shell verifier's package set; each quirk is recorded at
// its helper -- `SGDISK_INVENTED`, `debugfsRun`, `squashfsExtract`,
// `verityVerify`. No helper decides by exit status alone: one blind to its
// tool's did-the-work output refuses loudly and names it, the rule tools.ts
// states for ToolError.

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ToolOutputError, type RunOptions, type ToolRuntime } from './tools.ts'

/** mtools refuses a file whose size is not a whole number of sectors unless told. */
const MTOOLS_ENV = ['env', 'MTOOLS_SKIP_CHECK=1'] as const

// Byte ranges.

/**
 * Copy `length` bytes at `offset` out of `image` into `dest`.
 *
 * Not `dd`, though the scope says dd-extract, and the same bytes either way:
 * measured on 2026-08-25 against ROOTFS-A of the real cx3576 image, this
 * function and `dd bs=1M skip=146 count=256 conv=sparse` produced files with the
 * same sha256. What it is not is a container round trip and a second copy of the
 * offset arithmetic -- dd's skip/count are in BLOCKS, so every call site divides
 * by a block size and a partition whose start is not a whole number of MiB
 * silently extracts from the wrong place. Here the unit is bytes, because the
 * GPT's unit is sectors and the layout's is MiB and one conversion in one place
 * is the point. Nothing is mutated: `image` is opened read-only.
 */
export function extractRange(image: string, offset: number, length: number, dest: string): string {
  requireWholeNumbers({ offset, length })
  const size = statSync(image).size
  if (offset + length > size) {
    throw new ToolOutputError(
      `extractRange wants bytes ${offset}..${offset + length} of ${image}, which is ${size} bytes long. `
      + `A short read here would hand the next tool a TRUNCATED partition, and every tool below `
      + `answers a truncated partition with a content complaint rather than a size one.`,
    )
  }
  mkdirSync(dirname(dest), { recursive: true })
  const src = openSync(image, 'r')
  const out = openSync(dest, 'w')
  try {
    const chunk = new Uint8Array(4 * 1024 * 1024)
    let done = 0
    while (done < length) {
      const want = Math.min(chunk.length, length - done)
      const got = readSync(src, chunk, 0, want, offset + done)
      if (got === 0) {
        throw new ToolOutputError(
          `${image} ended after ${done} of ${length} bytes from offset ${offset}, though it reports `
          + `${size} bytes. The extract would be short and the tool reading it would blame its content.`,
        )
      }
      writeSync(out, chunk, 0, got)
      done += got
    }
  }
  finally {
    closeSync(src)
    closeSync(out)
  }
  return dest
}

/** Read `length` bytes at `offset`. For magic numbers and superblock fields. */
export function readBytes(image: string, offset: number, length: number): Uint8Array {
  requireWholeNumbers({ offset, length })
  const buf = new Uint8Array(length)
  const fd = openSync(image, 'r')
  try {
    const got = readSync(fd, buf, 0, length, offset)
    if (got !== length) {
      throw new ToolOutputError(
        `wanted ${length} bytes at offset ${offset} of ${image} and got ${got}. A short read here `
        + `becomes a magic number that does not match, which reads as a wrong image rather than a `
        + `wrong offset.`,
      )
    }
  }
  finally {
    closeSync(fd)
  }
  return buf
}

function requireWholeNumbers(values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ToolOutputError(
        `${name} is ${value}; it must be a non-negative whole number of bytes. NaN is what an `
        + `unparsed layout value becomes, and NaN offsets read from position 0 without complaining.`,
      )
    }
  }
}

// 1. The GPT, with sgdisk.

export interface GptPartition {
  readonly number: number
  readonly firstSector: number
  readonly lastSector: number
  readonly sizeSectors: number
  /** Uppercase, as sgdisk prints it. Compare case-folded; udev prints lowercase. */
  readonly typeGuid: string
  readonly uniqueGuid: string
  readonly name: string
  /** Sixteen hex digits, as `Attribute flags:` prints them. */
  readonly attributeFlags: string
}

export interface GptTable {
  readonly image: string
  readonly sectorSize: number
  readonly diskGuid: string
  readonly totalSectors: number
  readonly partitions: readonly GptPartition[]
  partition: (n: number) => GptPartition | undefined
}

/**
 * sgdisk's admission that the file it was handed has no partition table.
 *
 * It prints this and then behaves as though it had been asked to CREATE one --
 * exit 0, an invented disk GUID, an empty table. Everything downstream of that
 * is fiction, and the fiction is well formed.
 */
const SGDISK_INVENTED = 'Creating new GPT entries'

async function sgdisk(rt: ToolRuntime, args: readonly string[], context: string): Promise<string> {
  const r = await rt.run(['sgdisk', ...args], { context })
  const both = `${r.stdout}\n${r.stderr}`
  if (both.includes(SGDISK_INVENTED)) {
    throw new ToolOutputError(
      `${context}: sgdisk said "${SGDISK_INVENTED} in memory." and then exited ${r.code}.\n`
      + `  That is sgdisk reporting there is NO partition table on this file and offering to invent\n`
      + `  one. Driven on 64 MiB of zeros it goes on to print a random disk GUID, an empty partition\n`
      + `  list and "No problems found." -- a complete, green, entirely fictional table. Nothing\n`
      + `  below may be read as an observation of the image.`,
    )
  }
  return r.stdout
}

/** Parse `sgdisk -p` and `sgdisk -i N` into the fields every GPT check reads. */
export async function readGpt(rt: ToolRuntime, image: string): Promise<GptTable> {
  const table = await sgdisk(rt, ['-p', image], `reading the GPT of ${image}`)

  const sectorSize = intAfter(table, /^Sector size \(logical\): (\d+) bytes$/m, 'Sector size (logical)', image)
  const totalSectors = intAfter(table, /^Disk .*: (\d+) sectors,/m, 'the disk sector count', image)
  const diskGuid = strAfter(table, /^Disk identifier \(GUID\): (\S+)$/m, 'Disk identifier (GUID)', image)

  // The numbered rows of `sgdisk -p`'s table, which is the ONLY statement of
  // how many partitions there are. The verification contract counts the same
  // rows with the same shape.
  const numbers = [...table.matchAll(/^\s+(\d+)\s+\d+\s+\d+\s/gm)].map(m => Number(m[1]))
  if (numbers.length === 0) {
    throw new ToolOutputError(
      `sgdisk -p ${image} listed no partitions. It did not say "${SGDISK_INVENTED}", so this is a `
      + `real but EMPTY partition table -- which no mica image has ever been. Read as data it would `
      + `make every per-partition check below vacuous rather than failed.`,
    )
  }

  const partitions: GptPartition[] = []
  for (const n of numbers) {
    const info = await sgdisk(rt, ['-i', String(n), image], `reading partition ${n} of ${image}`)
    // "Partition #7 does not exist." is what sgdisk says for a number the table
    // does not carry -- at exit 0, with no other output. It cannot happen for a
    // number that came out of the table above, which is exactly why it is
    // checked: if it ever does, the two readings disagree with each other.
    if (/does not exist/.test(info)) {
      throw new ToolOutputError(
        `sgdisk -p ${image} listed partition ${n} and sgdisk -i ${n} says it does not exist. `
        + `The two readings of one table disagree; neither can be used.`,
      )
    }
    const firstSector = intAfter(info, /^First sector: (\d+)/m, `partition ${n} First sector`, image)
    const lastSector = intAfter(info, /^Last sector: (\d+)/m, `partition ${n} Last sector`, image)
    partitions.push({
      number: n,
      firstSector,
      lastSector,
      sizeSectors: intAfter(info, /^Partition size: (\d+) sectors/m, `partition ${n} Partition size`, image),
      typeGuid: strAfter(info, /^Partition GUID code: (\S+)/m, `partition ${n} GUID code`, image),
      uniqueGuid: strAfter(info, /^Partition unique GUID: (\S+)/m, `partition ${n} unique GUID`, image),
      // A partition name may be empty, so this one tolerates an empty capture --
      // and only this one. `Partition name: ''` is a fact about the image.
      name: (/^Partition name: '(.*)'$/m.exec(info)?.[1]) ?? refuse(`partition ${n} Partition name`, image, info),
      attributeFlags: strAfter(info, /^Attribute flags: (\S+)/m, `partition ${n} Attribute flags`, image),
    })
  }

  return {
    image,
    sectorSize,
    diskGuid,
    totalSectors,
    partitions,
    partition: (n: number) => partitions.find(p => p.number === n),
  }
}

export interface SgdiskVerdict {
  readonly clean: boolean
  readonly output: string
  /** The Caution/Warning lines that are not the two benign alignment notes. */
  readonly complaints: readonly string[]
}

/**
 * `sgdisk --verify`, with the same reading the verification contract gives it.
 *
 * "No problems found." alone is not the verdict: sgdisk says that about a file
 * with no GPT at all. The invented-table sentence is refused by `sgdisk()`
 * above, so reaching here means there WAS a table to verify.
 */
export async function sgdiskVerify(rt: ToolRuntime, image: string): Promise<SgdiskVerdict> {
  const r = await rt.run(['sgdisk', '--verify', image], {
    context: `sgdisk --verify ${image}`,
    allow: [1, 2, 3, 4, 5, 6, 7, 8],
  })
  const output = `${r.stdout}${r.stderr}`
  if (output.includes(SGDISK_INVENTED)) {
    throw new ToolOutputError(
      `sgdisk --verify ${image} said "${SGDISK_INVENTED} in memory." and then "No problems found." `
      + `There is no partition table on this file; the clean bill of health is about one sgdisk `
      + `made up.`,
    )
  }
  const complaints = output.split('\n')
    .filter(l => /Caution|Warning/.test(l))
    .filter(l => !/doesn't (begin|end) on a|degraded performance/.test(l))
  const clean = output.includes('No problems found')
    && !/problems!|Problem:|invalid GPT|damaged GPT/.test(output)
    && complaints.length === 0
  return { clean, output, complaints }
}

// 2. The FAT boot slots, with mtools at an offset.

/** A FAT filesystem living at a byte offset inside a larger image. */
export interface FatSlot {
  readonly image: string
  readonly offsetBytes: number
}

function mtoolsTarget(slot: FatSlot): string {
  requireWholeNumbers({ 'the FAT slot offset': slot.offsetBytes })
  // mtools' own syntax for "the filesystem starts here": image@@offset. No
  // extraction, no temp file, and no second copy of the offset arithmetic.
  return `${slot.image}@@${slot.offsetBytes}`
}

async function mtool(
  rt: ToolRuntime,
  argv: readonly string[],
  slot: FatSlot,
  what: string,
  options?: RunOptions,
): Promise<string> {
  const r = await rt.run([...MTOOLS_ENV, ...argv], {
    context: `${what} in the FAT at offset ${slot.offsetBytes} of ${slot.image}`,
    ...options,
  })
  // mtools is honest about a bad offset -- "init :: non DOS media", exit 1 --
  // so the status carries it. What it is not honest about is WHICH offset, so
  // the context above supplies it: the same message appears for a slot that is
  // simply empty, and those are different edits.
  return r.stdout
}

/** The volume label, as `mlabel -s` reports it, trailing padding removed. */
export async function fatVolumeLabel(rt: ToolRuntime, slot: FatSlot): Promise<string> {
  const out = await mtool(rt, ['mlabel', '-s', '-i', mtoolsTarget(slot), '::'], slot, 'reading the volume label')
  const line = /^ *Volume label is (.*?) *$/m.exec(out)
  if (line === null) {
    // "Volume has no label" is a real answer and is returned as the empty
    // string; anything else means mlabel printed something this does not know.
    if (/has no label/.test(out)) return ''
    throw new ToolOutputError(
      `mlabel -s on the FAT at offset ${slot.offsetBytes} of ${slot.image} exited 0 and printed `
      + `neither a volume label nor "has no label":\n${out.trim() || '(nothing)'}`,
    )
  }
  return line[1] ?? ''
}

/**
 * The FAT volume SERIAL, as `minfo` reports it.
 *
 * Not the label. `mlabel` reads the label, which an operator chose; the serial
 * is the four bytes mkfs.vfat wrote, and the two answer different questions.
 * The volume-label and volume-serial checks ask both separately, and a factory
 * image must satisfy both.
 *
 * A slot with no serial is refused rather than returned as the empty string:
 * minfo prints `serial number: <hex>` for every FAT it can read at all, so a
 * missing line means it read something that is not one, and an empty answer
 * would make "the volume id is wrong" indistinguishable from "there is no
 * filesystem here".
 */
export async function fatVolumeSerial(rt: ToolRuntime, slot: FatSlot): Promise<string> {
  const out = await mtool(rt, ['minfo', '-i', mtoolsTarget(slot)], slot, 'reading the volume serial')
  const line = /^serial number: *(.*?) *$/m.exec(out)
  if (line === null || (line[1] ?? '').trim() === '') {
    throw new ToolOutputError(
      `minfo on the FAT at offset ${slot.offsetBytes} of ${slot.image} exited 0 and printed no `
      + `"serial number:" line:\n${out.trim() || '(nothing)'}`,
    )
  }
  // Spaces come out, and nothing else does. The verification contract pipes
  // through `tr -d ' '` and no more, so a minfo that printed `C357-6003` would
  // make the oracle FAIL against a layout that declares `C3576003` -- and a
  // port that also stripped the dash would pass where the oracle fails, which
  // is a divergence hidden by the port rather than found by it.
  return (line[1] as string).replace(/ /g, '')
}

/**
 * Every path in the slot, recursively, as `::/name` -- `mdir -/ -b`'s own form.
 *
 * An empty listing is returned as an empty array rather than refused: a boot
 * slot with nothing in it is a thing a check must be able to observe and fail.
 */
export async function fatList(rt: ToolRuntime, slot: FatSlot): Promise<string[]> {
  const out = await mtool(rt, ['mdir', '-/', '-b', '-i', mtoolsTarget(slot), '::/'], slot, 'listing')
  return out.split('\n').map(l => l.trimEnd()).filter(l => l.startsWith('::'))
}

/**
 * Copy one file out of the slot and hand back its bytes.
 *
 * mcopy exits 1 and says `File "::/x" not found` for a path that is not there,
 * which is the one tool in this file that reports an absence honestly -- so an
 * absence throws, and `fatTryRead` is the way to ask a question that tolerates
 * one.
 */
export async function fatReadFile(rt: ToolRuntime, slot: FatSlot, path: string): Promise<string> {
  const target = path.startsWith('::') ? path : `::/${path.replace(/^\/+/, '')}`
  const out = await mtool(rt, ['mcopy', '-n', '-i', mtoolsTarget(slot), target, '-'], slot, `reading ${path}`)
  return out
}

/**
 * Copy one file out of the slot into a local path, and say whether it landed.
 *
 * NOT `fatReadFile` plus a write. mcopy's `-` target sends the file to stdout and
 * this runtime reads stdout as TEXT -- fine for a `set MICA_*=` fragment, destructive
 * for a 290 KiB device tree, where every byte that is not valid UTF-8 comes back as
 * U+FFFD. The device tree and compiled boot script are read as BYTES below, so
 * this helper has mcopy write them directly. `false` means the file is not in
 * the slot -- mcopy exits 1 saying
 * `File "::/x" not found`, the one honest absence in the mtools set -- and any other
 * non-zero exit throws, because "unreadable slot" and "file not in it" are different
 * edits. The destination is checked after the copy as well as before: mcopy exiting 0
 * having written nothing is `unsquashfs -d`'s defect one directory along.
 */
export async function fatCopyOut(
  rt: ToolRuntime,
  slot: FatSlot,
  path: string,
  dest: string,
): Promise<boolean> {
  const target = path.startsWith('::') ? path : `::/${path.replace(/^\/+/, '')}`
  mkdirSync(dirname(dest), { recursive: true })
  const r = await rt.run([...MTOOLS_ENV, 'mcopy', '-n', '-i', mtoolsTarget(slot), target, dest], {
    context: `copying ${path} out of the FAT at offset ${slot.offsetBytes} of ${slot.image}`,
    allow: [1],
  })
  if (r.code !== 0) {
    if (/not found/.test(r.stderr)) return false
    throw new ToolOutputError(
      `mcopy could not copy ${path} out of the FAT at offset ${slot.offsetBytes} of ${slot.image}, `
      + `and not because it is absent:\n  ${r.stderr.trim() || '(no stderr)'}\n`
      + `  Returning "absent" here would turn a broken read into a fact about the image.`,
    )
  }
  if (!existsSync(dest)) {
    throw new ToolOutputError(
      `mcopy exited 0 copying ${path} out of the FAT at offset ${slot.offsetBytes} of ${slot.image} `
      + `and ${dest} is not there. A caller reading that path next would find nothing and blame the `
      + `image for a file the tool never wrote.`,
    )
  }
  return true
}

/** The same read, with "it is not there" as an answer rather than a throw. */
export async function fatTryReadFile(
  rt: ToolRuntime,
  slot: FatSlot,
  path: string,
): Promise<string | undefined> {
  const target = path.startsWith('::') ? path : `::/${path.replace(/^\/+/, '')}`
  const r = await rt.run([...MTOOLS_ENV, 'mcopy', '-n', '-i', mtoolsTarget(slot), target, '-'], {
    context: `reading ${path} from the FAT at offset ${slot.offsetBytes} of ${slot.image}`,
    allow: [1],
  })
  if (r.code === 0) return r.stdout
  if (/not found/.test(r.stderr)) return undefined
  // Exit 1 for a reason that is NOT absence -- a bad offset, an unreadable
  // image -- must not be reported as absence. Same shape as veritysetup below.
  throw new ToolOutputError(
    `mcopy could not read ${path} from the FAT at offset ${slot.offsetBytes} of ${slot.image}, and `
    + `not because it is absent:\n  ${r.stderr.trim() || '(no stderr)'}\n`
    + `  Returning "absent" here would turn a broken read into a fact about the image.`,
  )
}

// 3. The ext4 partitions, with tune2fs and debugfs over an extracted range.

/** e2fsprogs put their version banner on stderr and nothing else, when well. */
const E2FS_BANNER = /^(debugfs|tune2fs|dumpe2fs|e2fsck) \d+\.\d+/

export interface Ext4Super {
  readonly file: string
  /** Every `Key: value` line, keys exactly as e2fsprogs spells them. */
  readonly fields: ReadonlyMap<string, string>
  readonly volumeName: string
  readonly uuid: string
  readonly blockSize: number
  readonly blockCount: number
  readonly features: readonly string[]
  readonly state: string
  get: (key: string) => string | undefined
}

/** `tune2fs -l`, refused unless it actually opened a filesystem. */
export async function ext4Super(rt: ToolRuntime, file: string): Promise<Ext4Super> {
  const r = await rt.run(['tune2fs', '-l', file], { context: `reading the ext4 superblock of ${file}` })
  const fields = new Map<string, string>()
  for (const line of r.stdout.split('\n')) {
    const m = /^([A-Za-z][^:]*):\s{2,}(.*?)\s*$/.exec(line)
    if (m !== null && m[1] !== undefined) fields.set(m[1], m[2] ?? '')
  }
  const magic = fields.get('Filesystem magic number')
  if (magic !== '0xEF53') {
    throw new ToolOutputError(
      `tune2fs -l ${file} exited 0 but its "Filesystem magic number" is ${magic ?? 'absent'}, not `
      + `0xEF53. Whatever it read, it was not an ext4 superblock.`,
    )
  }
  const get = (key: string): string | undefined => fields.get(key)
  return {
    file,
    fields,
    volumeName: get('Filesystem volume name') ?? '',
    uuid: get('Filesystem UUID') ?? '',
    blockSize: Number(get('Block size') ?? Number.NaN),
    blockCount: Number(get('Block count') ?? Number.NaN),
    features: (get('Filesystem features') ?? '').split(/\s+/).filter(f => f !== ''),
    state: get('Filesystem state') ?? '',
    get,
  }
}

/**
 * Run one debugfs command and hand back its stdout.
 *
 * The stderr rule is the whole check. debugfs exits 0 whether or not it opened
 * the filesystem -- measured: `debugfs -R "ls -p /"` on a file that is not ext4
 * exits 0 with empty stdout. What differs is stderr: on a filesystem it opened,
 * stderr is EXACTLY the one-line version banner; on one it did not, the banner
 * is followed by "...while trying to open FILE" and "ls: Filesystem not open".
 * So the rule is one line of stderr and it is the banner; any second line is a
 * refusal, quoted.
 */
export async function debugfsRun(rt: ToolRuntime, file: string, command: string): Promise<string> {
  const r = await rt.run(['debugfs', '-R', command, file], {
    context: `debugfs -R "${command}" on ${file}`,
  })
  const noise = r.stderr.split('\n').map(l => l.trim()).filter(l => l !== '' && !E2FS_BANNER.test(l))
  if (noise.length > 0) {
    throw new ToolOutputError(
      `debugfs -R "${command}" ${file} EXITED 0 and complained:\n`
      + noise.map(l => `    ${l}`).join('\n')
      + `\n  debugfs exits 0 whether or not it opened the filesystem, so the status says nothing. `
      + `Its stderr is the whole answer, and this one is not the version banner alone.`,
    )
  }
  return r.stdout
}

export interface Ext4Entry {
  readonly inode: number
  /** Octal, as `ls -p` prints it: `040755`. */
  readonly mode: string
  readonly uid: number
  readonly gid: number
  readonly name: string
}

/** `ls -p DIR`, parsed. Always contains `.` and `..` on a real ext4. */
export async function ext4List(rt: ToolRuntime, file: string, dir: string): Promise<Ext4Entry[]> {
  const out = await debugfsRun(rt, file, `ls -p ${dir}`)
  const entries: Ext4Entry[] = []
  for (const line of out.split('\n')) {
    // /inode/mode/uid/gid/name/size/
    const parts = line.split('/')
    if (parts.length < 6 || parts[1] === undefined || !/^\d+$/.test(parts[1])) continue
    entries.push({
      inode: Number(parts[1]),
      mode: parts[2] ?? '',
      uid: Number(parts[3] ?? Number.NaN),
      gid: Number(parts[4] ?? Number.NaN),
      name: parts[5] ?? '',
    })
  }
  if (entries.length === 0) {
    throw new ToolOutputError(
      `debugfs listed ${dir} in ${file} and produced no entries at all, not even "." and "..". `
      + `Every directory on a mounted-able ext4 has those two; a listing without them is a listing `
      + `of nothing, and read as data it makes an "is X absent?" check pass.`,
    )
  }
  return entries
}

/** `stat PATH`, as a field map. `undefined` when the path is not in the tree. */
export async function ext4Stat(
  rt: ToolRuntime,
  file: string,
  path: string,
): Promise<Map<string, string> | undefined> {
  const r = await rt.run(['debugfs', '-R', `stat ${path}`, file], {
    context: `debugfs -R "stat ${path}" on ${file}`,
  })
  const noise = r.stderr.split('\n').map(l => l.trim()).filter(l => l !== '' && !E2FS_BANNER.test(l))
  // "File not found by ext2_lookup" is the answer "it is not there"; anything
  // else on stderr is the tool failing, and the two must not be one value.
  if (noise.length > 0) {
    if (noise.every(l => /File not found by ext2_lookup|stat: File not found/.test(l))) return undefined
    throw new ToolOutputError(
      `debugfs -R "stat ${path}" ${file} complained about something other than the path:\n`
      + noise.map(l => `    ${l}`).join('\n'),
    )
  }
  const fields = new Map<string, string>()
  for (const m of r.stdout.matchAll(/(\w[\w ]*?):\s+(\S+)/g)) {
    if (m[1] !== undefined && !fields.has(m[1])) fields.set(m[1], m[2] ?? '')
  }
  if (fields.size === 0) return undefined
  return fields
}

// 4. The packed root, with unsquashfs.

export interface SquashfsSuper {
  readonly file: string
  readonly version: string
  readonly sizeBytes: number
  readonly compression: string
  readonly blockSize: number
}

/** `unsquashfs -s`. Exits 1 and says so on anything that is not a squashfs. */
export async function squashfsSuper(rt: ToolRuntime, file: string): Promise<SquashfsSuper> {
  const r = await rt.run(['unsquashfs', '-s', file], { context: `reading the squashfs superblock of ${file}` })
  const version = /Found a valid SQUASHFS (\S+) superblock/.exec(r.stdout)?.[1]
  if (version === undefined) {
    throw new ToolOutputError(
      `unsquashfs -s ${file} exited 0 without reporting a valid superblock:\n${r.stdout.trim() || '(nothing)'}`,
    )
  }
  return {
    file,
    version,
    sizeBytes: intAfter(r.stdout, /^Filesystem size (\d+) bytes/m, 'Filesystem size', file),
    compression: strAfter(r.stdout, /^Compression (\S+)/m, 'Compression', file),
    blockSize: intAfter(r.stdout, /^Block size (\d+)/m, 'Block size', file),
  }
}

/**
 * Unpack `paths` (or the whole archive) into `dest`, and PROVE each one landed.
 *
 * Measured: `unsquashfs -d DEST ARCHIVE nope/nothing` exits 0 and leaves DEST
 * empty. So a caller asking for three files and getting none would read three
 * absences out of one silent failure -- and "absent from the image" is exactly
 * what several checks in the oracle assert. Each requested path is therefore
 * asserted present under DEST afterwards, by name.
 */
export async function squashfsExtract(
  rt: ToolRuntime,
  file: string,
  dest: string,
  paths?: readonly string[],
): Promise<string> {
  if (existsSync(dest)) {
    throw new ToolOutputError(
      `${dest} already exists. unsquashfs merges into an existing directory, so a second extract `
      + `into the same place would hand back a tree that is partly the previous one -- and every `
      + `"is this file in the image?" check below would then be about the wrong image.`,
    )
  }
  const wanted = (paths ?? []).map(p => p.replace(/^\/+/, ''))
  await rt.run(['unsquashfs', '-n', '-xattrs', '-q', '-d', dest, file, ...wanted], {
    context: `unpacking ${file}${wanted.length > 0 ? ` (${wanted.join(' ')})` : ''}`,
  })
  // lstat, NOT existsSync. Driven against the real cx3576 image on 2026-08-25:
  // `etc/os-release` in the packed root is a symlink to `../usr/lib/os-release`,
  // and asking for it alone extracts the LINK without its target. existsSync
  // follows the link, finds nothing at the other end and reports the path as
  // unextracted -- a refusal about a file that is right there, which is the
  // mirror image of the swallow this guard exists to prevent and just as wrong.
  // What the guard is asking is "did unsquashfs put something at this path",
  // and lstat is the call that answers that question.
  const lost = wanted.filter(p => !extracted(join(dest, p)))
  if (lost.length > 0) {
    throw new ToolOutputError(
      `unsquashfs exited 0 and did not extract ${lost.join(', ')} from ${file}.\n`
      + `  It exits 0 for a path that is not in the archive, so the status said nothing. Whether `
      + `those paths are absent from the IMAGE is a question for a check; it is not something this `
      + `helper may answer by handing back an empty directory.`,
    )
  }
  if (wanted.length === 0 && !existsSync(dest)) {
    throw new ToolOutputError(`unsquashfs exited 0 and created no ${dest} at all from ${file}.`)
  }
  return dest
}

/** Every path in the archive, as `unsquashfs -l` prints them, `squashfs-root` stripped. */
export async function squashfsList(rt: ToolRuntime, file: string): Promise<string[]> {
  const r = await rt.run(['unsquashfs', '-l', file], { context: `listing ${file}` })
  const paths = r.stdout.split('\n')
    .filter(l => l.startsWith('squashfs-root'))
    .map(l => l.slice('squashfs-root'.length))
    .filter(l => l !== '')
  if (paths.length === 0) {
    throw new ToolOutputError(
      `unsquashfs -l ${file} exited 0 and listed nothing under squashfs-root. An empty listing `
      + `makes every "is X in the image?" check answer no.`,
    )
  }
  return paths
}

// 5. dm-verity, in userspace.

export type VerityVerdict = 'verified' | 'mismatch'

export interface VerityRequest {
  readonly dataFile: string
  readonly hashFile: string
  readonly rootHash: string
  readonly hashOffset: number
  /** The five values the superblock used to carry, which the CALLER must now supply. */
  readonly hashAlgo: string
  readonly dataBlockSize: number
  readonly hashBlockSize: number
  readonly dataBlocks: number
  readonly salt: string
}

/**
 * `veritysetup verify`, which walks the hash tree in USERSPACE.
 *
 * It never creates a device-mapper target, never calls losetup and never mounts
 * anything -- which is what makes it safe against a host, and it is the reason
 * the oracle chose it.
 *
 * `--no-superblock`, and every parameter spelled out, because this has to be the
 * KERNEL's read. dm-init assembles the device from the `dm-mod.create=` table,
 * whose verity v1 target has no superblock concept at all: it takes the algo,
 * the block sizes, the data-block count and the salt from the table and reads
 * hash_start_block as the tree's top level. Left to its own convention
 * veritysetup finds a superblock, takes those five values back out of it, and
 * starts the tree one hash block later -- so it can verify a payload the kernel
 * then refuses, which is exactly the pair of agreeing-but-wrong statements that
 * made every Mica OS image fail to boot while this check passed.
 *
 * Three exit statuses and only two of them are answers. Measured against
 * cryptsetup 2.7.5: "Verification of root hash failed." is exit 1 and the
 * failing direction; "Verification of data area failed." is exit 2 and the same
 * direction reached one level lower -- it is what a tree at the wrong offset
 * produces, so an image built the old way must reach a FAIL and not a throw;
 * "Device X is not a valid VERITY device." is exit 1 and the tool getting
 * nowhere. Mapping status alone to `mismatch` would report a corrupt payload for
 * a wrong offset or an unreadable file.
 */
export async function verityVerify(rt: ToolRuntime, req: VerityRequest): Promise<VerityVerdict> {
  requireWholeNumbers({
    'the verity hash offset': req.hashOffset,
    'the verity data block size': req.dataBlockSize,
    'the verity hash block size': req.hashBlockSize,
    'the verity data block count': req.dataBlocks,
  })
  if (!/^[0-9a-fA-F]{32,128}$/.test(req.rootHash)) {
    throw new ToolOutputError(
      `'${req.rootHash}' is not a root hash. veritysetup would refuse it, at exit 1, in the same `
      + `breath it uses to say a payload does not verify.`,
    )
  }
  // Refused here rather than passed through: with --no-superblock these are the
  // only source of the values, so an empty one is silently a DIFFERENT tree and
  // the mismatch would read as a statement about the payload.
  for (const [name, value] of [['hash algorithm', req.hashAlgo], ['salt', req.salt]] as const) {
    if (value.trim() === '') {
      throw new ToolOutputError(
        `verityVerify was given an empty ${name}. With --no-superblock there is nothing to fall `
        + `back to, so the walk would hash a different tree and report the difference as a payload `
        + `that does not verify.`,
      )
    }
  }
  const argv = [
    'veritysetup', 'verify', req.dataFile, req.hashFile, req.rootHash,
    `--hash-offset=${req.hashOffset}`,
    '--no-superblock',
    `--hash=${req.hashAlgo}`,
    `--data-block-size=${req.dataBlockSize}`,
    `--hash-block-size=${req.hashBlockSize}`,
    `--data-blocks=${req.dataBlocks}`,
    `--salt=${req.salt}`,
  ]
  const r = await rt.run(
    argv,
    { context: `verifying ${req.dataFile} against ${req.rootHash}`, allow: [1, 2] },
  )
  if (r.code === 0) return 'verified'
  const said = `${r.stdout}${r.stderr}`
  if (/Verification of root hash failed/.test(said)) return 'mismatch'
  if (r.code === 2 && /Verification of data area failed/.test(said)) return 'mismatch'
  throw new ToolOutputError(
    `veritysetup verify exited ${r.code} for a reason that is NOT a hash mismatch:\n`
    + `    ${said.trim().split('\n').join('\n    ') || '(no output)'}\n`
    + `  data=${req.dataFile} hash=${req.hashFile} --hash-offset=${req.hashOffset}\n`
    + `  Reporting this as "mismatch" would blame the image for a wrong offset or an unreadable file.`,
  )
}


// 6. The device tree, with fdtget.
//
// Driven from the failing side, 2026-08-26, in the pinned alpine:3.21 with the
// package set the shell verifier installs. fdtget is the first tool in this file
// that refuses honestly on nearly every input it cannot read; the two shapes
// that answer anyway are recorded at `fdtGetCells`.

/**
 * libfdt's own refusals, exactly as fdtget spells them on stderr.
 *
 * Measured: 64 MiB of zeros and an empty file both give exit 1, empty stdout and
 * `Error at '<node>': FDT_ERR_BADMAGIC`; a missing file gives `Couldn't open
 * blob from 'nosuch.dtb': No such file or directory`; a missing node and a
 * missing property both give `FDT_ERR_NOTFOUND`. Where sgdisk INVENTS a GPT on
 * the same zeros, libfdt names the magic it did not find.
 */
const FDT_REFUSAL = /FDT_ERR_[A-Z]+|Couldn't open blob from/

/** `-t` as fdtget spells it: string, hex, signed and unsigned integer. */
export type FdtType = 's' | 'x' | 'i' | 'u'

/**
 * One property out of a flattened device tree, or `undefined` when libfdt
 * refused to produce one.
 *
 * The refusal is quoted into nothing -- the caller gets `undefined` and the
 * reason is lost, deliberately, because that is the oracle's semantics. A
 * caller that needs the reason calls `fdtGetResult`.
 */
export async function fdtGet(
  rt: ToolRuntime,
  dtb: string,
  node: string,
  property: string,
  options: { type?: FdtType } = {},
): Promise<string | undefined> {
  return (await fdtGetResult(rt, dtb, node, property, options)).value
}

export interface FdtRead {
  /** The property's value as fdtget printed it, or undefined when it refused. */
  readonly value: string | undefined
  /** libfdt's own sentence, when it refused. */
  readonly refusal: string | undefined
}

/**
 * `fdtGet`, with libfdt's refusal kept rather than dropped.
 *
 * An absence is an answer here and not a throw: the verification contract
 * writes `$(fdtget ... 2>/dev/null || true)` and compares the empty string
 * against the wanted value, so on this tool every refusal is a failed check
 * rather than a broken run, and that is what the port reproduces. What it does
 * NOT reproduce is the collapse -- `undefined` means libfdt said so, in its own
 * words, and a non-zero exit saying anything else still throws, so "the dtb is
 * not there" and "fdtget is not installed" cannot arrive at a check as the same
 * value.
 */
export async function fdtGetResult(
  rt: ToolRuntime,
  dtb: string,
  node: string,
  property: string,
  options: { type?: FdtType } = {},
): Promise<FdtRead> {
  const argv = options.type === undefined
    ? ['fdtget', dtb, node, property]
    : ['fdtget', '-t', options.type, dtb, node, property]
  const r = await rt.run(argv, {
    context: `reading ${node} ${property} out of ${dtb}`,
    allow: [1],
  })
  if (r.code === 0) {
    // A trailing newline and nothing else. An EMPTY value is a real answer --
    // an empty string property -- and comes back as '' rather than undefined,
    // so a check comparing it against a wanted value fails describing the
    // value, which is what the oracle does.
    return { value: r.stdout.replace(/\n$/, ''), refusal: undefined }
  }
  const said = `${r.stderr}${r.stdout}`.trim()
  if (FDT_REFUSAL.test(said)) return { value: undefined, refusal: said.split('\n')[0] }
  throw new ToolOutputError(
    `fdtget exited ${r.code} on ${dtb} for a reason libfdt did not name:\n`
    + `    ${said.split('\n').join('\n    ') || '(no output)'}\n`
    + `  Every refusal this tool has been observed making carries FDT_ERR_* or "Couldn't open `
    + `blob"; anything else is the tool failing to run, and reporting that as "the property is `
    + `absent" would make a missing fdtget read as a defect in the device tree.`,
  )
}

/**
 * `fdtget -t x`, split into cells the way the oracle's `read -r -a` splits it.
 *
 * Returns `[]` when libfdt refused -- what `gpio_cells` becomes in the shell, an
 * empty array whose `[2]` is unset and prints as `missing`. The default radix is
 * decimal (`107 29 1`) and `-t x` is hexadecimal (`6b 1d 1`); the oracle passes
 * `-t x` and compares against 0 and 1, which read the same in both, so the flag
 * is what keeps a flags cell of 10 from being compared as sixteen. `-t x` on a
 * STRING property does not refuse: it exits 0 and prints the string's bytes as
 * cells, so a `gpios` that had become a string would hand `gpio_cells[2]` the
 * third byte of it rather than a refusal. Reproduced and not refused, because
 * the verification contract reads exactly those cells and a helper that threw
 * would fail where the oracle fails the check.
 */
export async function fdtGetCells(
  rt: ToolRuntime,
  dtb: string,
  node: string,
  property: string,
): Promise<string[]> {
  const value = await fdtGet(rt, dtb, node, property, { type: 'x' })
  if (value === undefined) return []
  return value.trim().split(/\s+/).filter(c => c !== '')
}

/**
 * `fdtget -l` -- the names of a node's children, or `[]` when libfdt refused.
 *
 * ENUMERATION AND NOT A PATH, which is the whole reason this exists beside
 * `fdtGet`. The reserved-memory assertion has to hold over regions this
 * repository did not write: the vendor `.dtsi` chain contributes most of
 * them, their unit addresses are part of what is under test, and a check that
 * asked for `/reserved-memory/ramoops@40400000` by name would be comparing the
 * device tree against a second copy of the address rather than reading what is
 * in it. So the subject set is read out of the blob and the assertion is a
 * property over it.
 *
 * `[]` for a refusal, as `fdtGetCells` does: a device tree with no
 * `/reserved-memory` at all is a real answer and the caller decides what it
 * means. It is not confusable with a node that HAS no children, because
 * `/reserved-memory` with no children is a node no producer emits -- and the
 * caller fails an empty subject set rather than passing it, so the two lead to
 * the same verdict either way.
 */
export async function fdtSubnodes(
  rt: ToolRuntime,
  dtb: string,
  node: string,
): Promise<string[]> {
  const r = await rt.run(['fdtget', '-l', dtb, node], {
    context: `listing the subnodes of ${node} in ${dtb}`,
    allow: [1],
  })
  if (r.code === 0) {
    return r.stdout.split('\n').map(l => l.trim()).filter(l => l !== '')
  }
  const said = `${r.stderr}${r.stdout}`.trim()
  if (FDT_REFUSAL.test(said)) return []
  throw new ToolOutputError(
    `fdtget -l exited ${r.code} on ${dtb} for a reason libfdt did not name:\n`
    + `    ${said.split('\n').join('\n    ') || '(no output)'}\n`
    + `  Reporting this as "the node has no children" would make a missing fdtget read as a `
    + `device tree with no reserved regions in it, which is the answer that passes.`,
  )
}

// 7. e2fsck -fn, whose exit status is the whole answer and is not the truth.
//
// Driven from the failing side, 2026-08-26, e2fsck 1.47.1 in the pinned alpine:
// a clean image exits 0 after five passes with a summary; zeros, an empty file,
// a squashfs, a directory and a missing file all exit 8 ("Bad magic number in
// super-block", "No such file or directory").

/**
 * The statuses e2fsck uses to describe a FILESYSTEM, as opposed to itself.
 *
 * The exit codes are a bitmask (e2fsck(8)): 1 errors corrected, 2 corrected and
 * reboot, 4 errors left UNCORRECTED, 8 operational error, 16 usage error, 32
 * cancelled, 128 shared-library error. Under `-n` nothing is ever corrected, so
 * 1 and 2 cannot arise; they are allowed anyway because a status this helper
 * refused would be a run that died where the oracle printed a FAIL. 16 and 32
 * are NOT allowed: a usage error is this port's argv being wrong and a cancel is
 * a signal, and neither is a statement about the filesystem.
 */
export const E2FSCK_VERDICT_CODES = [0, 1, 2, 4, 8] as const

export interface E2fsckVerdict {
  /** `e2fsck -fn` exited 0 -- which is the whole of the oracle's test. */
  readonly clean: boolean
  readonly code: number
  /** What it printed, banner removed. Empty on a filesystem it had nothing to say about. */
  readonly report: readonly string[]
}

/**
 * `e2fsck -fn FILE`, read the way the verification contract reads it.
 *
 * A truncated image exits 0 and says otherwise: an 8192-block filesystem in a
 * 4096-block file makes e2fsck print "The filesystem size (according to the
 * superblock) is 8192 blocks", "The physical size of the device is 4096 blocks",
 * "Either the superblock or the partition table is likely to be corrupt!" and
 * "Abort? no", then run all five passes and exit 0. The oracle's line is
 * `if e2fsck -fn "${img}" >/dev/null 2>&1`, so both streams go to /dev/null and the
 * status alone decides -- and the branch is reachable, because `check_ext4` extracts
 * `count=${size_mib}` MiB at the layout's offset and a short-tailed image produces
 * exactly this file. Reproduced and not repaired: the verdict is the STATUS the
 * oracle reads, and `E2fsckVerdict.report` keeps the sentence rather than dropping it.
 */
export async function e2fsckClean(rt: ToolRuntime, file: string): Promise<E2fsckVerdict> {
  const r = await rt.run(['e2fsck', '-fn', file], {
    context: `e2fsck -fn on ${file}`,
    allow: [...E2FSCK_VERDICT_CODES],
  })
  const report = `${r.stdout}\n${r.stderr}`.split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !E2FS_BANNER.test(l))
  return { clean: r.code === 0, code: r.code, report }
}

// 8. The legacy uImage header, which needs no tool at all.
//
// `mkimage -T script` wraps a text script in a 64-byte big-endian header whose
// first four bytes are 0x27051956. The verification contract reads exactly
// those four with `od -An -tx1 -N4 ... | tr -d ' \n'` and compares the string.

export const UIMAGE_MAGIC = '27051956'
/** Where the payload starts: the header is exactly 64 bytes (image.h). */
export const UIMAGE_HEADER_BYTES = 64

export interface UImageHeader {
  /** The first four bytes as lowercase hex, `od -An -tx1 -N4 | tr -d ' \n'`'s form. */
  readonly magic: string
  readonly headerCrc: number
  readonly timestamp: number
  readonly dataSize: number
  readonly loadAddress: number
  readonly entryPoint: number
  readonly dataCrc: number
  readonly os: number
  readonly arch: number
  /** 6 is IH_TYPE_SCRIPT. Read, reported, and deliberately not asserted. */
  readonly imageType: number
  readonly compression: number
  readonly name: string
  readonly dataOffset: number
}

/**
 * The first four bytes as lowercase hex, or '' when there are not four to read.
 *
 * '' is the value the oracle compares, and it is an ANSWER: a boot script that
 * was never written into the slot fails the magic check rather than killing the
 * run. Every other reader in this file refuses a short read; this one does not,
 * because its caller's shell counterpart does not either -- `od` prints nothing
 * for a file that is not there or is shorter than four bytes, and `|| true`
 * swallows the status.
 */
export function uImageMagic(file: string): string {
  let fd: number
  try {
    fd = openSync(file, 'r')
  }
  catch {
    return ''
  }
  try {
    const buf = new Uint8Array(4)
    const got = readSync(fd, buf, 0, 4, 0)
    if (got !== 4) return ''
    return [...buf].map(b => b.toString(16).padStart(2, '0')).join('')
  }
  finally {
    closeSync(fd)
  }
}

/**
 * The whole 64-byte header, or undefined when the file is not long enough.
 *
 * A file shorter than 64 bytes has no header to read, and returning a struct of
 * zeros would make `imageType` read as 0 ("invalid") rather than as absent. The
 * header also carries the image TYPE, and `type=6` is what makes a uImage a
 * SCRIPT; the oracle checks the magic and nothing else, so a uImage of any other
 * type -- a kernel, a ramdisk -- carries the same four bytes and passes. That is
 * recorded here and exposed through `--probe`, and deliberately not turned into
 * a check: a port that hardened its oracle would diverge from it, and the
 * divergence would be the port's.
 */
export function readUImage(file: string): UImageHeader | undefined {
  let size: number
  try {
    size = statSync(file).size
  }
  catch {
    return undefined
  }
  if (size < UIMAGE_HEADER_BYTES) return undefined
  const head = Buffer.from(readBytes(file, 0, UIMAGE_HEADER_BYTES))
  return {
    magic: head.subarray(0, 4).toString('hex'),
    headerCrc: head.readUInt32BE(4),
    timestamp: head.readUInt32BE(8),
    dataSize: head.readUInt32BE(12),
    loadAddress: head.readUInt32BE(16),
    entryPoint: head.readUInt32BE(20),
    dataCrc: head.readUInt32BE(24),
    os: head[28] as number,
    arch: head[29] as number,
    imageType: head[30] as number,
    compression: head[31] as number,
    // NUL-padded, 32 bytes. `Mica OS boot` on the shipped cx3576 script.
    name: head.subarray(32, 64).toString('latin1').replace(/\0.*$/, ''),
    dataOffset: UIMAGE_HEADER_BYTES,
  }
}

/**
 * The whole file with its NUL bytes removed -- `tr -d '\0' < FILE`.
 *
 * NOT the payload from offset 64. The verification contract strips NULs from
 * the ENTIRE file, header included, and then awks over the result; the header's
 * remaining bytes never look like `setenv`, so the parse works. A reader that
 * started at 64 would be a better reader and a different one, and the four
 * partition-number conclusions it produces are compared against the oracle's.
 */
export function uImageText(file: string): string {
  let bytes: Buffer
  try {
    bytes = Buffer.from(readFileSync(file))
  }
  catch {
    return ''
  }
  return bytes.toString('latin1').replace(/\0/g, '')
}

/** True when SOMETHING is at `path`, dangling symlink included. */
function extracted(path: string): boolean {
  try {
    lstatSync(path)
    return true
  }
  catch {
    return false
  }
}

function refuse(what: string, image: string, output: string): never {
  throw new ToolOutputError(
    `could not read ${what} out of the tool's output for ${image}. It exited 0, so this is a `
    + `format this parser does not know rather than a failure it swallowed:\n`
    + output.trim().split('\n').slice(0, 12).map(l => `    ${l}`).join('\n'),
  )
}

function strAfter(output: string, pattern: RegExp, what: string, image: string): string {
  const value = pattern.exec(output)?.[1]
  if (value === undefined || value === '') refuse(what, image, output)
  return value
}

function intAfter(output: string, pattern: RegExp, what: string, image: string): number {
  const value = Number(strAfter(output, pattern, what, image))
  if (!Number.isSafeInteger(value)) refuse(what, image, output)
  return value
}
