// dd: raw placement.
//
// Failure signal: the exit status. On success dd writes its summary to stderr,
// so a wrapper reading "stderr is not empty" as failure fails every correct run
// of it, and one reading "stderr is empty" as success passes every failed
// debugfs run (the opposite case, in e2fsprogs.ts). Each tool's signal is its
// own, which is why toolbox.run() interprets nothing. `status=none` silences
// the summary and both assemblers pass it; it is a parameter rather than a
// default, because a silenced dd is harder to debug.
//
// Reading bytes back out of an image is not here: the cx3576 assembly contract checks the
// loader magic with `dd ... | od -An -tx1 -N4`, the image is a file on the host
// so a caller reads it with node:fs, and `docker exec` would route binary
// through a text stream that corrupts at the first non-UTF-8 byte.

import type { Toolbox, ToolResult } from '../toolbox.ts'

export interface DdSpec {
  readonly input: string
  readonly output: string
  /** `bs=`. The assemblers use `512` (cx3576's loader) and `1M` (everything else). */
  readonly blockSize: string
  /** `seek=`, in blocks of blockSize. */
  readonly seekBlocks?: bigint
  /** `skip=`, in blocks of blockSize. */
  readonly skipBlocks?: bigint
  /** `count=`, in blocks of blockSize. */
  readonly countBlocks?: bigint
  /**
   * `conv=`. NOT defaulted, and not normalised across callers: the cx3576 assembly contract
   * uses `notrunc,sparse` and the x64 assembly contract uses `notrunc`. They agree on
   * the bytes for a target that is already zero -- the cx3576 assembler's comment says so -- but
   * which one a call passes is that call's decision, taken where the reason is.
   */
  readonly conv?: readonly string[]
  /** `status=none`. False leaves dd's summary on stderr, which is where it belongs. */
  readonly quiet?: boolean
}

export function ddArgs(spec: DdSpec): string[] {
  if (spec.blockSize === '') throw new Error('dd was given an empty bs=, which it reads as zero')
  if (spec.seekBlocks !== undefined && spec.seekBlocks < 0n) {
    throw new Error(`dd was asked to seek to block ${spec.seekBlocks} of ${spec.output}`)
  }
  if (spec.skipBlocks !== undefined && spec.skipBlocks < 0n) {
    throw new Error(`dd was asked to skip to block ${spec.skipBlocks} of ${spec.input}`)
  }
  if (spec.countBlocks !== undefined && spec.countBlocks <= 0n) {
    // `count=0` copies nothing and exits 0. A caller that computed a zero
    // length has already made its mistake; this is where it stops being silent.
    throw new Error(
      `dd was asked to copy ${spec.countBlocks} blocks from ${spec.input}. It would copy nothing and `
      + `exit 0, which is indistinguishable from having copied what was wanted.`,
    )
  }
  const argv = ['dd', `if=${spec.input}`, `of=${spec.output}`, `bs=${spec.blockSize}`]
  if (spec.skipBlocks !== undefined) argv.push(`skip=${spec.skipBlocks}`)
  if (spec.seekBlocks !== undefined) argv.push(`seek=${spec.seekBlocks}`)
  if (spec.countBlocks !== undefined) argv.push(`count=${spec.countBlocks}`)
  if (spec.conv !== undefined && spec.conv.length > 0) argv.push(`conv=${spec.conv.join(',')}`)
  if (spec.quiet === true) argv.push('status=none')
  return argv
}

/** Place a file into an image at an offset. Throws a ToolError carrying dd's words. */
export async function dd(tb: Toolbox, spec: DdSpec): Promise<ToolResult> {
  return tb.must(ddArgs(spec), { note: `dd could not write ${spec.input} into ${spec.output}` })
}

/**
 * `truncate -s <size>` -- how both assemblers create the file dd writes into.
 *
 * Here rather than in a file of its own because it is the same coreutils
 * toolset and the same one-line shape, and because a sparse file of the right
 * length is half of what "place a partition at an offset" means.
 */
export async function truncate(tb: Toolbox, path: string, size: string): Promise<ToolResult> {
  if (size === '' || size === '0') {
    throw new Error(`truncate was asked to make ${path} ${size || 'an empty'} bytes, which is not an image`)
  }
  return tb.must(['truncate', '-s', size, path], { note: `truncate could not size ${path} to ${size}` })
}
