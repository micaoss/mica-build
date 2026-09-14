// sgdisk: the GPT.
//
// Failure signal: the exit status, plus one exception the shell already carries
// -- `sgdisk --verify` prints problems and still exits 0, so verifyGpt requires
// exit 0 AND the sentence ("Both failure shapes -- nonzero exit AND problem
// text with exit 0 -- must reach the same friendly error" in the cx3576 assembly contract.
//
// sgdisk also relocates silently: a requested start that is not a multiple of
// the alignment is moved, with a success exit. Measured 2026-08-25,
// `--new=1:64:+32704S` with no `-a 1` lands the partition at sector 2048 and
// exits 0 -- on cx3576 that is the bootloader outside its own partition, which
// is why GPT_ALIGN_SECTORS=1 is in that board's definition. Asking sgdisk for a
// layout proves nothing about the layout: readPartition reads back what is
// actually there, and the caller compares.

import type { Toolbox, ToolResult } from '../toolbox.ts'
import { ToolError } from '../toolbox.ts'

export interface GptPartitionSpec {
  readonly partnum: bigint
  readonly startSector: bigint
  readonly sizeSectors: bigint
  readonly label?: string
  readonly typecode?: string
  readonly guid?: string
}

/**
 * One argv shape for both assemblers, because the difference was measured.
 *
 * the cx3576 assembly contract passes `--clear`, `-a 1` and `+NS` sizes in the order
 * new/change-name/typecode/partition-guid; the x64 assembly contract passes no
 * --clear, no -a, `+NM` sizes, in the order
 * new/typecode/partition-guid/change-name. Measured 2026-08-25 with sgdisk
 * 1.0.10 over the same two partitions: flag order, `+131072S` against `+64M`
 * at 512-byte sectors, `--clear` on a freshly truncated all-zero file, and
 * `-a 1` where every start is already MiB-aligned are all byte-identical.
 * `-a 1` where a start is sector 64 is NOT: 64 against 2048. alignSectors is
 * the one knob that survives, and the suite re-runs those comparisons so a
 * different sgdisk disagrees here rather than in the byte-identity gate.
 */
export interface GptSpec {
  readonly diskGuid: string
  /**
   * `-a N`. Omitted leaves sgdisk's own default (2048), which is what
   * the x64 assembly contract does; cx3576 must pass 1 or its loader is relocated.
   * Never defaulted here -- an alignment nobody asked for is how the loader
   * moved in the first place.
   */
  readonly alignSectors?: bigint
  /** `--clear`. A no-op on an all-zero file, measured; kept because a rewrite is not. */
  readonly clear?: boolean
  readonly partitions: readonly GptPartitionSpec[]
}

/**
 * The argv for one sgdisk call that writes a whole GPT.
 *
 * Pure, so the shape can be asserted without a disk. Every refusal here is one
 * whose absence would produce a well-formed and wrong partition table -- the
 * kind sgdisk writes happily and a device fails to boot from.
 */
export function writeGptArgs(spec: GptSpec, image: string): string[] {
  if (spec.partitions.length === 0) {
    // A GPT with no partitions is a valid GPT, so sgdisk would write one and
    // exit 0. That is a flashable image with nothing on it.
    throw new Error(
      `sgdisk was asked to write a GPT with no partitions in it onto ${image}. That is a valid `
      + `partition table and sgdisk would write it and succeed, which makes it exactly the kind of `
      + `empty success this tree refuses elsewhere.`,
    )
  }

  const seen = new Map<bigint, string>()
  for (const p of spec.partitions) {
    const label = p.label ?? `#${p.partnum}`
    const first = seen.get(p.partnum)
    if (first !== undefined) {
      // sgdisk applies both, and the second wins. The result is a table with
      // one fewer partition than the layout listed and no complaint.
      throw new Error(
        `partition number ${p.partnum} is given twice (${first} and ${label}) for ${image}. sgdisk `
        + `would apply both --new flags to the same slot, the second overwriting the first, and exit 0 `
        + `with one fewer partition than was asked for.`,
      )
    }
    seen.set(p.partnum, label)
    if (p.partnum <= 0n) throw new Error(`${label} has partition number ${p.partnum}; GPT numbers start at 1`)
    if (p.sizeSectors <= 0n) {
      // `--new=N:start:+0S` is sgdisk's spelling for "to the end of the disk",
      // so a zero size does not fail: it produces a partition that swallows
      // every partition after it.
      throw new Error(
        `${label} is ${p.sizeSectors} sectors long. sgdisk reads a zero-or-absent length as "to the `
        + `end of the disk", so this would not fail -- it would produce a partition covering every `
        + `one after it.`,
      )
    }
    if (p.startSector < 0n) throw new Error(`${label} starts at sector ${p.startSector}`)
  }

  const argv: string[] = ['sgdisk']
  if (spec.clear === true) argv.push('--clear')
  if (spec.alignSectors !== undefined) argv.push('-a', String(spec.alignSectors))
  argv.push(`--disk-guid=${spec.diskGuid}`)
  for (const p of spec.partitions) {
    argv.push(`--new=${p.partnum}:${p.startSector}:+${p.sizeSectors}S`)
    if (p.label !== undefined) argv.push(`--change-name=${p.partnum}:${p.label}`)
    if (p.typecode !== undefined) argv.push(`--typecode=${p.partnum}:${p.typecode}`)
    if (p.guid !== undefined) argv.push(`--partition-guid=${p.partnum}:${p.guid}`)
  }
  argv.push(image)
  return argv
}

/** Write the GPT. Throws a ToolError carrying sgdisk's own words on any failure. */
export async function writeGpt(tb: Toolbox, image: string, spec: GptSpec): Promise<ToolResult> {
  return tb.must(writeGptArgs(spec, image), { note: `sgdisk could not write the GPT of ${image}` })
}

/**
 * `sgdisk --verify`, with BOTH of its failure shapes reaching the same refusal.
 *
 * A nonzero exit, and problem text with exit 0. The cx3576 assembly contract's guard is the
 * source of that pairing; without the second half a table with overlapping
 * partitions passes.
 */
export async function verifyGpt(tb: Toolbox, image: string): Promise<string> {
  const r = await tb.run(['sgdisk', '--verify', image])
  const output = `${r.stdout}${r.stderr}`
  if (!r.ok || !output.includes('No problems found')) {
    throw new ToolError(
      r,
      `sgdisk --verify reported problems with ${image} (exit ${r.exitCode})`,
    )
  }
  return output
}

export interface GptPartitionInfo {
  readonly partnum: bigint
  readonly firstSector: bigint
  readonly lastSector: bigint
  readonly sizeSectors: bigint
  readonly typecode: string
  readonly guid: string
  readonly name: string
}

/**
 * Read one partition back OUT of the table that was written.
 *
 * The point is stated in the cx3576 assembly contract: "sgdisk is free to move a requested
 * start sector, so asserting what we asked for proves nothing; this asserts
 * what is actually there."
 *
 * Every field is required. A parser that returned undefined for a line it could
 * not find would hand its caller a comparison against nothing, and `undefined
 * !== 64` is a failure that names the wrong thing -- so an unreadable field is
 * a refusal carrying sgdisk's whole output instead.
 */
export async function readPartition(tb: Toolbox, image: string, partnum: bigint): Promise<GptPartitionInfo> {
  const r = await tb.must(['sgdisk', '-i', String(partnum), image], {
    note: `sgdisk could not read partition ${partnum} of ${image}`,
  })
  const text = r.stdout

  const field = (label: string): string => {
    const m = new RegExp(`^${label}: (.*)$`, 'm').exec(text)
    if (m === null || m[1] === undefined || m[1].trim() === '') {
      throw new ToolError(
        r,
        `sgdisk -i ${partnum} ${image} printed no readable "${label}" line, so there is nothing to `
        + `compare the assembled layout against. Either the partition is not there or this sgdisk `
        + `prints a shape this parser does not know`,
      )
    }
    return m[1].trim()
  }

  const firstWord = (label: string): bigint => {
    const raw = field(label).split(/\s+/)[0] ?? ''
    if (!/^[0-9]+$/.test(raw)) {
      throw new ToolError(r, `sgdisk's "${label}" for partition ${partnum} of ${image} reads "${raw}", not a sector number`)
    }
    return BigInt(raw)
  }

  const firstSector = firstWord('First sector')
  const lastSector = firstWord('Last sector')
  const sizeSectors = firstWord('Partition size')
  if (lastSector - firstSector + 1n !== sizeSectors) {
    throw new ToolError(
      r,
      `sgdisk says partition ${partnum} of ${image} runs ${firstSector}..${lastSector} and is `
      + `${sizeSectors} sectors, and those disagree by ${lastSector - firstSector + 1n - sizeSectors}`,
    )
  }

  return {
    partnum,
    firstSector,
    lastSector,
    sizeSectors,
    // "C12A7328-... (EFI system partition)" -- the code is the first word.
    typecode: field('Partition GUID code').split(/\s+/)[0] ?? '',
    guid: field('Partition unique GUID'),
    // "Partition name: 'esp'"
    name: field('Partition name').replace(/^'(.*)'$/, '$1'),
  }
}
