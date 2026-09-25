// pin_seeded_times, against a real seeded filesystem.
//
// THE CLAIM UNDER TEST IS NOT "it runs" -- it is that two filesystems seeded
// from trees whose inode times differ come out BYTE-IDENTICAL afterwards, and
// that they do not without it. Both halves are here, because the first alone is
// satisfied by a pass that does nothing at all: an empty command file makes
// debugfs exit 0 with a clean stderr, and a filesystem that was already
// identical stays identical.
//
// The two stage trees are made to differ DETERMINISTICALLY, by `touch -a` on one
// of them. That sets atime and, because no syscall sets ctime, bumps ctime as
// well -- which is exactly the pair os/mkimage-common.sh identifies as the
// assembler's noise rather than the producer's data. Waiting for a wall clock to
// tick between two copies would test the same thing on a machine slow enough and
// nothing on a machine that is not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBoardEnv } from './verify-package.ts'
import { makeWorkDir, REPO_ROOT } from './paths.ts'
import { loadLayout, partitionOf } from './file-layout.ts'
import { ROLES, type RoleContext } from './roles/index.ts'
import { inUseInodes, pinSeededTimes, refuseUnlessCountsAgree, timeCommands } from './pin-seeded-times.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from './testing.ts'
import { Toolbox } from './toolbox.ts'
import { FILE_IMAGE_TOOLS } from './file-image.ts'
import { debugfsApply, dumpe2fsFull, dumpe2fsHeader, mke2fs } from './tools/e2fsprogs.ts'
import { truncate } from './tools/dd.ts'

const env = parseBoardEnv(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'), 'board.env').values
const FILE_MTIME = env.get('FILE_MTIME')! // @1577836800
const PINNED_EPOCH = 1577836800

let tb: Toolbox
let dir: string

beforeAll(async () => {
  dir = makeWorkDir('pin-times')
  tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [REPO_ROOT] })
}, OPEN_TIMEOUT_MS)

afterAll(async () => {
  await tb?.close()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

/** A fabricated /var-shaped seed: a handful of files, a directory, a symlink. */
function makeSeed(name: string): string {
  const root = join(dir, name)
  mkdirSync(join(root, 'lib', 'mica'), { recursive: true })
  mkdirSync(join(root, 'cache'), { recursive: true })
  writeFileSync(join(root, 'lib', 'dpkg-status'), 'Package: micad\n')
  writeFileSync(join(root, 'lib', 'mica', 'state.json'), '{}\n')
  writeFileSync(join(root, 'cache', 'a.bin'), 'x'.repeat(4096))
  return root
}

/** One 16 MiB ext4, seeded from a tree, formatted exactly as the assembler does. */
async function seededImage(name: string, seedDir: string): Promise<string> {
  const image = join(dir, `${name}.img`)
  await truncate(tb, image, '16M')
  await mke2fs(tb, {
    image,
    label: 'ephemeral',
    uuid: partitionOf(loadLayout(join(REPO_ROOT, 'boards/cx3576')), 'data').fsUuid!,
    blockSize: BigInt(env.get('EXT4_BLOCK_SIZE')!),
    features: env.get('EXT4_FEATURES')!,
    fakeTime: env.get('E2FSPROGS_FAKE_TIME')!,
    seedDir,
  })
  return image
}

/**
 * `debugfs -R "stat <N>"` -- the times ACTUALLY WRITTEN into the inode table.
 *
 * Read as the EPOCH rather than as the human date beside it. debugfs prints
 * ` atime: 0x5e0be100:00000000 -- Wed Jan  1 00:00:00 2020`, and matching the
 * text after the `--` would be matching a rendering in whatever timezone the
 * container happens to carry: a test that passes in UTC and fails in +08.
 */
async function inodeTimes(image: string, inode: bigint): Promise<Record<string, number>> {
  const r = await tb.must(['debugfs', '-R', `stat <${inode}>`, image])
  const out: Record<string, number> = {}
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(atime|ctime|mtime|crtime): 0x([0-9a-f]+)/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = Number.parseInt(m[2], 16)
  }
  if (out.atime === undefined)
    throw new Error(`debugfs printed no readable atime for inode ${inode} of ${image}:\n${r.stdout}`)

  return out
}

describe('the free-inode-range parse', () => {
  test('single numbers, ranges, and both together', () => {
    expect(inUseInodes('  Free inodes: 12-20\n', 11n, 22n)).toEqual([11n, 21n, 22n])
    expect(inUseInodes('  Free inodes: 12, 14, 16\n', 11n, 16n)).toEqual([11n, 13n, 15n])
    expect(inUseInodes('  Free inodes: 12-14, 17\n', 11n, 18n)).toEqual([11n, 15n, 16n, 18n])
  })

  test('a group with NOTHING free prints the key and an empty value', () => {
    // A real shape, not a parse failure -- so every inode in range is in use.
    expect(inUseInodes('  Free inodes: \n', 11n, 13n)).toEqual([11n, 12n, 13n])
  })

  test('several groups accumulate', () => {
    expect(inUseInodes('  Free inodes: 12-13\n  Free inodes: 15\n', 11n, 16n)).toEqual([11n, 14n, 16n])
  })

  test('THE TWO LEADING SPACES ARE LOAD-BEARING: the superblock total is not a group', () => {
    // dumpe2fs prints an UNINDENTED `Free inodes:` in the superblock carrying
    // the whole-filesystem total. Read as a group it would mark a range free
    // that no group ever said was -- and the number there is a COUNT, not a
    // range, so `Free inodes: 21` would mark inode 21 free and nothing else,
    // which is a wrong answer that looks like a right one.
    const listing = 'Free inodes: 21\n  Free inodes: 12-20\n'
    expect(inUseInodes(listing, 11n, 22n)).toEqual([11n, 21n, 22n])
    // The control, and it has to bite INSIDE the range or it proves nothing:
    // indent that superblock line and inode 21 disappears from the answer.
    expect(inUseInodes('  Free inodes: 21\n  Free inodes: 12-20\n', 11n, 22n)).toEqual([11n, 22n])
  })

  test('a range this parser cannot read is refused, not skipped', () => {
    // Skipped, it would report those inodes as IN USE -- more work, not less,
    // and the count cross-check would catch it. Refused, the message names the
    // token. Either way it must not be silent.
    expect(() => inUseInodes('  Free inodes: 12-abc\n', 11n, 20n))
      .toThrow(/printed a free-inode range this parser does not understand/)
  })

  test('an impossible inode range is refused rather than treated as all-in-use', () => {
    expect(() => inUseInodes('', 20n, 10n)).toThrow(/cannot have inodes 20\.\.10/)
    expect(() => inUseInodes('', 0n, 10n)).toThrow(/cannot have inodes 0\.\.10/)
  })
})

describe('the command file', () => {
  test('two lines per inode, atime then ctime, in the touch -d spelling', () => {
    expect(timeCommands([12n, 13n], FILE_MTIME)).toBe(
      'sif <12> atime @1577836800\nsif <12> ctime @1577836800\n'
      + 'sif <13> atime @1577836800\nsif <13> ctime @1577836800\n',
    )
  })

  test('mtime is NOT written -- it is the producer\'s data', () => {
    expect(timeCommands([12n], FILE_MTIME)).not.toContain('mtime')
  })

  test('an empty FILE_MTIME is refused before debugfs can shrug at it', () => {
    expect(() => timeCommands([12n], '')).toThrow(/empty FILE_MTIME/)
  })
})

describe('the cross-check between the superblock and the listing', () => {
  test('agreement passes', () => {
    expect(() => refuseUnlessCountsAgree('/x.img', 5n, 5n, 11n)).not.toThrow()
  })

  test('a parse that found FEWER is refused, naming both numbers', () => {
    expect(() => refuseUnlessCountsAgree('/x.img', 5n, 0n, 11n))
      .toThrow(/says 5 inodes are in use from 11 up, but parsing dumpe2fs's free-inode ranges found 0/)
  })

  test('and one that found MORE', () => {
    // os/mkimage-common.sh's own case: "a dumpe2fs that dies mid-listing leaves
    // inodes it never printed looking allocated, which makes `got` EXCEED
    // `want`". So the check is an equality, not a floor.
    expect(() => refuseUnlessCountsAgree('/x.img', 5n, 9n, 11n)).toThrow(/found 9/)
  })

  test('the refusal says what the silent failure would have been', () => {
    try {
      refuseUnlessCountsAgree('/x.img', 5n, 0n, 11n)
      throw new Error('unreachable')
    }
    catch (e) {
      expect(String(e)).toContain('debugfs runs, does nothing with, and exits 0')
      expect(String(e)).toContain('byte-identity check that passes for the wrong reason')
    }
  })
})

describe('against a real seeded filesystem', () => {
  test('a real dumpe2fs listing and a real superblock agree, and the count is not zero', async () => {
    // The positive control for everything above: the parse understands THIS
    // dumpe2fs. A parse that returned nothing would satisfy every pure case
    // above by never being asked a real question.
    const image = await seededImage('agree', makeSeed('seed-agree'))
    const header = await dumpe2fsHeader(tb, image)
    const used = inUseInodes(await dumpe2fsFull(tb, image), header.firstInode, header.inodeCount)
    const want = header.inodeCount - header.freeInodes - (header.firstInode - 1n)
    expect(BigInt(used.length)).toBe(want)
    expect(used.length).toBeGreaterThan(5)
  }, TOOL_TIMEOUT_MS)

  test('and a TRUNCATED listing from that same filesystem is refused', async () => {
    // The numbers here are real -- a real superblock and a real listing with its
    // groups after the first dropped, which is what "a future dumpe2fs [that]
    // changes how it prints ranges" looks like from this side.
    const image = await seededImage('truncated', makeSeed('seed-truncated'))
    const header = await dumpe2fsHeader(tb, image)
    const full = await dumpe2fsFull(tb, image)
    const want = header.inodeCount - header.freeInodes - (header.firstInode - 1n)
    const truncated = full.split('  Free inodes:').slice(0, 1).join('  Free inodes:')
    const got = BigInt(inUseInodes(truncated, header.firstInode, header.inodeCount).length)
    expect(got).not.toBe(want)
    expect(() => refuseUnlessCountsAgree(image, want, got, header.firstInode))
      .toThrow(/refusing to pin timestamps against a listing this code no longer understands/)
  }, TOOL_TIMEOUT_MS)

  test('every in-use inode ends at FILE_MTIME in atime and ctime, and mtime does not move', async () => {
    const seed = makeSeed('seed-times')
    // A distinctive mtime that is NOT the pinned one, so "mtime is left alone"
    // is a claim with something to be wrong about. touch reaches atime and
    // mtime; it cannot reach ctime, which is the whole reason this pass exists.
    await tb.must(['find', seed, '-exec', 'touch', '-h', '-d', '@1000000000', '{}', '+'])
    const image = await seededImage('times', seed)
    const header = await dumpe2fsHeader(tb, image)
    const used = inUseInodes(await dumpe2fsFull(tb, image), header.firstInode, header.inodeCount)
    expect(used.length).toBeGreaterThan(5)

    // BEFORE: at least one in-use inode carries a ctime that is NOT the pinned
    // one. Measured, and it is the SEEDED inodes that do -- inode 11 is
    // lost+found, which mke2fs creates itself and E2FSPROGS_FAKE_TIME already
    // pins, so sampling the first in-use inode alone would have found the pass
    // already done and proved nothing.
    const before = await Promise.all(used.map(i => inodeTimes(image, i)))
    expect(before.some(t => t.ctime !== PINNED_EPOCH)).toBe(true)

    const result = await pinSeededTimes(tb, image, FILE_MTIME)
    expect(result.got).toBe(result.want)
    expect(result.got).toBe(BigInt(used.length))

    // AFTER: every one of them, not a sample.
    const after = await Promise.all(used.map(i => inodeTimes(image, i)))
    expect(after.map(t => `${t.atime}/${t.ctime}`))
      .toEqual(used.map(() => `${PINNED_EPOCH}/${PINNED_EPOCH}`))
    // mtime is the producer's data, carried in through the copy. The seeded
    // files keep the 2001 stamp; mke2fs's own lost+found keeps mke2fs's.
    expect(after.filter(t => t.mtime === 1000000000).length).toBeGreaterThan(3)
  }, TOOL_TIMEOUT_MS)

  test('THE CLAIM: two filesystems whose seeds differ in atime/ctime come out identical', async () => {
    const a = makeSeed('seed-a')
    const b = makeSeed('seed-b')
    // Both trees carry identical content and identical mtimes...
    for (const s of [a, b])
      await tb.must(['find', s, '-exec', 'touch', '-h', '-d', '@1000000000', '{}', '+'])

    // ...and then one of them gets a different atime, which bumps its ctime too.
    // That is precisely the pair mke2fs -d copies in and E2FSPROGS_FAKE_TIME
    // cannot reach.
    await tb.must(['find', b, '-exec', 'touch', '-a', '-d', '@1200000000', '{}', '+'])

    const imgA = await seededImage('claim-a', a)
    const imgB = await seededImage('claim-b', b)

    // WITHOUT the pass they differ. Without this half, a pass that did nothing
    // would satisfy the half below.
    const differ = await tb.run(['cmp', '-s', imgA, imgB])
    expect(differ.exitCode).not.toBe(0)

    await pinSeededTimes(tb, imgA, FILE_MTIME)
    await pinSeededTimes(tb, imgB, FILE_MTIME)

    const same = await tb.run(['cmp', imgA, imgB])
    expect(`${same.exitCode}: ${same.stdout}${same.stderr}`).toBe('0: ')
  }, TOOL_TIMEOUT_MS)

  test('a RESERVED inode is left exactly as mke2fs wrote it', async () => {
    // The pass starts at the filesystem's first non-reserved inode, so mke2fs's
    // own reserved inodes are left exactly as mke2fs wrote them. Inode 2 is the
    // root directory; E2FSPROGS_FAKE_TIME is what pins that one, and rewriting
    // it here would be this assembler overwriting the one thing that already had
    // an answer.
    const image = await seededImage('reserved', makeSeed('seed-reserved'))
    const header = await dumpe2fsHeader(tb, image)
    expect(header.firstInode).toBe(11n)
    const beforeRoot = await inodeTimes(image, 2n)
    await pinSeededTimes(tb, image, FILE_MTIME)
    expect(await inodeTimes(image, 2n)).toEqual(beforeRoot)
  }, TOOL_TIMEOUT_MS)

  test('an EMPTY command file is refused at the tool, which is the one shape neither signal carries', async () => {
    // Measured in M6a: debugfs runs an empty script, does nothing, and exits 0
    // with a clean stderr. pin_seeded_times generates that file by parsing
    // dumpe2fs, so an empty one is exactly what a parse that understood nothing
    // produces.
    const image = await seededImage('empty-cmds', makeSeed('seed-empty'))
    const cmds = join(dir, 'empty.times')
    writeFileSync(cmds, '')
    expect(debugfsApply(tb, image, cmds)).rejects.toThrow(/contains no debugfs command/)
  }, TOOL_TIMEOUT_MS)

  test('the command file is removed afterwards, on the way out and on the way through', async () => {
    const image = await seededImage('cleanup', makeSeed('seed-cleanup'))
    await pinSeededTimes(tb, image, FILE_MTIME)
    const left = await tb.run(['ls', `${image}.times`])
    expect(left.exitCode).not.toBe(0)
  }, TOOL_TIMEOUT_MS)
})

describe('the data role over a filesystem with quotas', () => {
  // DATA carries project quotas, which the data role accounts with `e2fsck -fy` before the pin. e2fsck reads its
  // clock from E2FSCK_TIME and ignores E2FSPROGS_FAKE_TIME, so without it two assemblies of the same inputs
  // differed in the superblock's write and check times (2026-09-25). The role itself, twice, a second apart.
  test('two builds at different wall-clock seconds are byte-identical', async () => {
    const seed = makeSeed('quota-seed')
    const data = { ...partitionOf(loadLayout(join(REPO_ROOT, 'boards/cx3576')), 'data'), sizeSectors: 32768 }
    const one = async (name: string) => {
      const image = join(dir, `${name}.img`)
      await ROLES.data.build({ tb, trees: { data: seed } } as unknown as RoleContext, data, image)
      return new Bun.CryptoHasher('sha256').update(readFileSync(image)).digest('hex')
    }
    const a = await one('quota-a')
    await Bun.sleep(1100)
    expect(await one('quota-b')).toBe(a)
  }, TOOL_TIMEOUT_MS)
})
