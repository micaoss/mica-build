// pin_seeded_times, ported: every in-use inode's atime and ctime rewritten to
// FILE_MTIME, in place, in a finished filesystem.
//
// Only a filesystem seeded with `mke2fs -d` needs it, and it is the difference
// between "the seeded filesystem is seeded" and "the seeded filesystem rebuilds byte-identically":
// without it two builds differ in 106 bytes of the inode table, spanning every
// inode the seed created.
// mtime is deliberately left alone -- it is the producer's data, carried in
// through the copy, not something an assembler invents. crtime is mke2fs's own
// invention and E2FSPROGS_FAKE_TIME already pins it; that is all it can pin,
// and it does not reach times copied in from a source tree. The three
// primitives this stands on are wrapped in src/tools/e2fsprogs.ts; the
// free-inode-range parse and the atime/ctime generation are here, in their only
// home, because both assemblers need them and they must not be written twice.

import { rmSync, writeFileSync } from 'node:fs'
import type { Toolbox } from './toolbox.ts'
import { debugfsApply, dumpe2fsFull, dumpe2fsHeader } from './tools/e2fsprogs.ts'

// mke2fs -d copies the source inode's atime, mtime and ctime into the image,
// and two of the three are the assembler's noise rather than the exported
// tree's content:
//
//   ctime  The assembler copies a source tree into staging before seeding, so
//          the stamp can be added without writing into _out, and the kernel
//          stamps every copied inode's ctime with the moment of that copy. NO
//          syscall sets ctime -- not touch, not utimensat -- so the only way to
//          pin it is to write the inode table, which is what this does.
//   atime  cp -a preserves the source's atime, and reading the source to make
//          the first copy is itself what bumps it under relatime, so assembly 2
//          seeds the seeded filesystem with a timestamp assembly 1 created and the two
//          images differ in a field neither build was asked about.

export interface PinnedTimes {
  /** How many inodes the superblock says are in use from the first non-reserved one up. */
  readonly want: bigint
  /** How many the free-inode-range parse actually accounted for. Equal, or this threw. */
  readonly got: bigint
  readonly firstInode: bigint
  readonly inodeCount: bigint
}

/**
 * Every inode NOT listed as free, from `first` to `count` inclusive.
 *
 * The listing is dumpe2fs's group output -- `  Free inodes: 12-2048` -- one
 * block per group, each a comma-separated list of single numbers and inclusive
 * ranges. The shell reads it with a sed anchored on two leading spaces before
 * `Free inodes:`, and those two spaces are load-bearing: the superblock prints
 * `Free inodes:` unindented, carrying the whole-filesystem total, and reading
 * that line as a group would mark a range of inodes free that no group said was.
 * The inode set comes from the bitmap rather than a walk of the source tree, so
 * a filename a parser would split cannot desynchronise it, and it starts at the
 * first non-reserved inode so mke2fs's reserved inodes stay as it wrote them. A
 * group with nothing free prints the key and an empty value: a real shape.
 */
export function inUseInodes(listing: string, firstInode: bigint, inodeCount: bigint): bigint[] {
  if (firstInode <= 0n || inodeCount < firstInode) {
    throw new Error(
      `an ext4 filesystem cannot have inodes ${firstInode}..${inodeCount}; a first inode past the `
      + `inode count means the header this came from was misread, and every inode would be "in use".`,
    )
  }
  const free = new Set<bigint>()
  for (const line of listing.split('\n')) {
    const m = /^ {2}Free inodes: *(.*)$/.exec(line)
    if (m === null || m[1] === undefined) continue
    for (const token of m[1].split(',')) {
      const t = token.replace(/[ \t]/g, '')
      if (t === '') continue
      // `split(/-+/)` in the awk: one or more dashes, so `12--20` reads as a
      // range rather than as a token this refuses. Kept identical; a listing
      // this parser reads differently from the shell is the one thing a port of
      // a parser must not introduce, and the count cross-check below catches it
      // when it does.
      const parts = t.split(/-+/).filter(s => s !== '')
      const lo = parts[0]
      const hi = parts.length > 1 ? parts[1] : parts[0]
      if (lo === undefined || hi === undefined || !/^[0-9]+$/.test(lo) || !/^[0-9]+$/.test(hi)) {
        throw new Error(
          `dumpe2fs printed a free-inode range this parser does not understand: ${JSON.stringify(token)}. `
          + `Refusing to pin timestamps against a listing that is no longer the one this was written `
          + `for -- a range read as nothing pins nothing and reports success.`,
        )
      }
      for (let i = BigInt(lo); i <= BigInt(hi); i += 1n) free.add(i)
    }
  }

  const used: bigint[] = []
  for (let i = firstInode; i <= inodeCount; i += 1n) {
    if (!free.has(i)) used.push(i)
  }
  return used
}

/** The debugfs script: two `sif` lines per in-use inode, atime then ctime. */
export function timeCommands(inodes: readonly bigint[], fileMtime: string): string {
  if (fileMtime.trim() === '') {
    throw new Error(
      'pin_seeded_times was given an empty FILE_MTIME. debugfs would set every atime and ctime to '
      + 'whatever it parses an empty string as, and the pass would still report success.',
    )
  }
  const lines: string[] = []
  for (const i of inodes) {
    lines.push(`sif <${i}> atime ${fileMtime}`)
    lines.push(`sif <${i}> ctime ${fileMtime}`)
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/**
 * The cross-check, as its own function so the refusal is reachable.
 *
 * `want` comes from the superblock and `got` from the group listing: two
 * independent readings of the same filesystem. If a future dumpe2fs changes how
 * it prints ranges, this refuses the build rather than pinning nothing and
 * handing the byte-identity check a fake pass -- an empty or partial command
 * file is the exact output of a reader that understood nothing, and debugfs
 * runs it, does nothing and exits 0 with a clean stderr. Nothing a caller can
 * pass to pinSeededTimes makes a real dumpe2fs disagree with itself, so a guard
 * left inline there could only be observed NOT firing; split out, it is driven
 * with real numbers and a listing truncated the way a changed dumpe2fs would.
 */
export function refuseUnlessCountsAgree(image: string, want: bigint, got: bigint, firstInode: bigint): void {
  if (got === want) return
  throw new Error(
    `the inode bitmap of ${image} says ${want} inodes are in use from ${firstInode} up, but parsing `
    + `dumpe2fs's free-inode ranges found ${got}; refusing to pin timestamps against a listing this `
    + `code no longer understands.\n`
    + `A parse that understood nothing produces an empty command file, which debugfs runs, does `
    + `nothing with, and exits 0 on -- so this count is the only thing standing between a silent `
    + `no-op and a byte-identity check that passes for the wrong reason.`,
  )
}

/**
 * Rewrite every in-use inode's atime and ctime, and refuse a listing this no
 * longer understands.
 *
 * @param image a path both this process and the toolbox see -- the same path,
 *   because the toolbox mounts by identity.
 */
export async function pinSeededTimes(tb: Toolbox, image: string, fileMtime: string): Promise<PinnedTimes> {
  const header = await dumpe2fsHeader(tb, image)
  // Reserved inodes 1..first-1 are mke2fs's, and are not being rewritten.
  const want = header.inodeCount - header.freeInodes - (header.firstInode - 1n)

  const listing = await dumpe2fsFull(tb, image)
  const used = inUseInodes(listing, header.firstInode, header.inodeCount)
  refuseUnlessCountsAgree(image, want, BigInt(used.length), header.firstInode)
  const got = BigInt(used.length)

  // `${img}.times`, exactly as the shell writes it. The image is on a path the
  // toolbox mounts by identity, so the same name resolves on both sides of the
  // container boundary and debugfs's -f needs no translation.
  const commandsFile = `${image}.times`
  writeFileSync(commandsFile, timeCommands(used, fileMtime))
  try {
    await debugfsApply(tb, image, commandsFile)
  } finally {
    rmSync(commandsFile, { force: true })
  }

  return { want, got, firstInode: header.firstInode, inodeCount: header.inodeCount }
}
