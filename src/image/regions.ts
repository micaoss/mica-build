// The bytes of a raw partition: its region rows of layout.tsv, one writer per source, over zeros. `loader` is
// the signed U-Boot binary, bounded by the region and by the board's loader facts; `records-a` and
// `records-b` are the two boot record copies the engine encodes (src/image/fit-environment.ts, the contract
// with mica-deploy and common/uboot/mica-records.h); `file:<path>` is a file of the board directory (the
// fetched bundle), placed as it is.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardFacts } from './board-facts.ts'
import { encodeFitEnvironment, type FitBootRecord } from './fit-environment.ts'
import { regionOf, type FileLayout, type FilePartition, type FileRegion } from './file-layout.ts'

export interface RegionContext {
  facts: BoardFacts
  /** The loader file, for the `loader` source. */
  loader: string
  /** The boot records, newest first, for the `records-*` sources. */
  records: FitBootRecord[]
  /** The board directory a `file:` source is read from. */
  bundle: string
}

const WRITERS: Record<string, (region: FileRegion, ctx: RegionContext) => Buffer> = {
  'loader': (region, ctx) => {
    const bytes = readFileSync(ctx.loader)
    const fw = ctx.facts.firmware
    const magic = 'magic' in fw ? fw.magic : ''
    if (bytes.length <= magic.length || bytes.length > region.size) throw new Error('Invalid firmware size')
    if (bytes.subarray(0, magic.length).toString('ascii') !== magic) throw new Error('Invalid loader header')
    return bytes
  },
  'records-a': (_region, ctx) => encodeFitEnvironment(ctx.records, 0),
  'records-b': (_region, ctx) => encodeFitEnvironment(ctx.records, 1),
}

/** The bytes one region source writes. */
export function regionBytes(region: FileRegion, ctx: RegionContext): Buffer {
  if (region.source.startsWith('file:')) {
    const path = join(ctx.bundle, region.source.slice('file:'.length))
    if (!existsSync(path)) throw new Error(`region ${region.name}: ${path} does not exist`)
    const bytes = readFileSync(path)
    if (bytes.length > region.size) throw new Error(`region ${region.name}: ${path} is ${bytes.length} bytes, more than the region's ${region.size}`)
    return bytes
  }
  const writer = WRITERS[region.source]
  if (writer === undefined) throw new Error(`region ${region.name}: no writer for the source ${region.source}`)
  return writer(region, ctx)
}

/** A raw partition image: zeros, then each of its regions at its offset. */
export function writeRawPartition(layout: FileLayout, partition: FilePartition, ctx: RegionContext, output: string): void {
  if (existsSync(output)) throw new Error('Firmware output exists')
  writeFileSync(output, '', { flag: 'wx' })
  truncateSync(output, partition.sizeSectors * 512)
  const fd = openSync(output, 'r+')
  try {
    for (const region of layout.regions.filter(r => r.partition === partition.name)) {
      const bytes = regionBytes(region, ctx)
      if (writeSync(fd, bytes, 0, bytes.length, region.offset) !== bytes.length) throw new Error(`Short region write: ${region.name}`)
    }
    fsyncSync(fd)
  }
  finally { closeSync(fd) }
}

/**
 * Where the loader lives is the layout's and the firmware receipt's at once, and they must agree: a `loader`
 * region exactly where the board's firmware facts place the loader on the disk, of the size they bound it to,
 * or neither (a UEFI loader on its esp, a loader that executes from outside this disk and travels beside it).
 */
export function checkLoaderPlacement(layout: FileLayout, facts: BoardFacts): void {
  const region = regionOf(layout, 'loader'), fw = facts.firmware
  const onDisk = 'diskOffset' in fw ? fw : undefined
  if (region === undefined && onDisk !== undefined) throw new Error(`${layout.board}'s firmware facts place the loader at disk byte ${onDisk.diskOffset} and its layout.tsv has no loader region`)
  if (region !== undefined && onDisk === undefined) throw new Error(`${layout.board}'s layout.tsv has a loader region and its firmware facts place no loader on the disk`)
  if (region !== undefined && onDisk !== undefined && (region.diskOffset !== onDisk.diskOffset || region.size !== onDisk.maxBytes))
    throw new Error(`${layout.board}'s loader region (disk byte ${region.diskOffset}, ${region.size} bytes) is not where its firmware facts place the loader (disk byte ${onDisk.diskOffset}, at most ${onDisk.maxBytes} bytes)`)
}

/** The loader leaves the disk image: it executes from elsewhere and is delivered beside the image. */
export function loaderBesideImage(layout: FileLayout): boolean {
  return layout.backend === 'uboot-fit' && regionOf(layout, 'loader') === undefined
}
