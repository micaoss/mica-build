// mke2fs, dumpe2fs and debugfs -- three tools, three different answers to "did
// it work", in one toolset.
//
// THE ONE THAT MATTERS IS debugfs. It EXITS 0 even when an individual command
// inside it failed, so its exit status is not its verdict; its stderr is.
// os/mkimage-common.sh states the consequence of getting that wrong: "Silencing
// the stream instead would let a rename of `sif` turn this into a no-op that
// still reports success" -- and a no-op there means the seeded filesystem stops rebuilding
// byte-identically, which nothing else would notice.
//
// This is also the toolset that proves the container-side case is the ordinary
// one: these layouts ask for `-O ^orphan_file`, this host's mke2fs is 1.46.5,
// and no amount of it being on PATH changes that.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBoardEnv } from '../verify-package.ts'
import { makeWorkDir, REPO_ROOT } from '../paths.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../testing.ts'
import { Toolbox } from '../toolbox.ts'
import { FILE_IMAGE_TOOLS } from '../file-image.ts'
import { truncate } from './dd.ts'
import { debugfsApply, dumpe2fsFull, dumpe2fsHeader, mke2fs, mke2fsArgs } from './e2fsprogs.ts'

let tb: Toolbox
let work = ''

/** DATA filesystem settings from the current board definition. */
function dataSpec(image: string, seedDir?: string) {
  const env = parseBoardEnv(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'), 'board.env').values
  return { image, label: env.get('DATA_FS_LABEL')!, uuid: env.get('DATA_FS_UUID')!,
    blockSize: BigInt(env.get('EXT4_BLOCK_SIZE')!), features: env.get('EXT4_FEATURES')!, fakeTime: env.get('E2FSPROGS_FAKE_TIME')!, seedDir }
}

beforeAll(async () => {
  work = makeWorkDir('e2fsprogs')
  tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [REPO_ROOT], cwd: work })
}, OPEN_TIMEOUT_MS)
afterAll(async () => {
  await tb?.close()
  if (work !== '') rmSync(work, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

describe('the argv shape', () => {
  test('the hash seed is pinned to the filesystem\'s own uuid, and root_owner to 0:0', () => {
    const argv = mke2fsArgs(dataSpec('meta.img'))
    expect(argv).toEqual([
      'mke2fs', '-q', '-t', 'ext4', '-b', '4096', '-L', 'data',
      '-U', '5ac35760-0002-4000-8000-000000000103',
      '-O', '^orphan_file,^metadata_csum_seed',
      '-E', 'root_owner=0:0,hash_seed=5ac35760-0002-4000-8000-000000000103',
      'meta.img',
    ])
  })

  test('-d only when a seed was asked for', () => {
    expect(mke2fsArgs(dataSpec('m.img'))).not.toContain('-d')
    expect(mke2fsArgs(dataSpec('m.img', '/stage/var'))).toContain('-d')
  })

  test('an empty feature list is refused: `-O \'\'` is a different filesystem, not a default one', () => {
    expect(() => mke2fsArgs({ ...dataSpec('m.img'), features: '  ' })).toThrow(/empty feature list is a different filesystem/)
  })

  test('a non-positive block size is refused', () => {
    expect(() => mke2fsArgs({ ...dataSpec('m.img'), blockSize: 0n })).toThrow(/-b 0/)
  })

  test('E2FSPROGS_FAKE_TIME is not on the command line -- mke2fs reads it from the ENVIRONMENT', () => {
    expect(mke2fsArgs(dataSpec('m.img')).join(' ')).not.toContain('1577836800')
  })
})

describe('against the real e2fsprogs', () => {
  test('the toolset reached a mke2fs that can write these layouts, which this host cannot', async () => {
    const v = await tb.must(['mke2fs', '-V'])
    const version = `${v.stdout}${v.stderr}`.split('\n')[0] ?? ''
    expect(version).toMatch(/^mke2fs 1\.(4[7-9]|[5-9][0-9])/)
  }, TOOL_TIMEOUT_MS)

  test('DATA with the board filesystem policy formats, and the header reads back the pinned uuid', async () => {
    const img = join(work, 'meta.img')
    await truncate(tb, img, '256M')
    await mke2fs(tb, dataSpec(img))

    const h = await dumpe2fsHeader(tb, img)
    expect(h.uuid.toLowerCase()).toBe('5ac35760-0002-4000-8000-000000000103')
    expect(h.label).toBe('data')
    expect(h.blockSize).toBe(4096n)
    expect(h.inodeCount).toBeGreaterThan(0n)
    expect(h.firstInode).toBe(11n)
    // The arithmetic pin_seeded_times is built on, checked here as arithmetic.
    expect(h.freeInodes).toBeLessThanOrEqual(h.inodeCount)
  }, TOOL_TIMEOUT_MS)

  test('the same settings twice produce the same bytes, which is the whole contract', async () => {
    const a = join(work, 'rep-a.img')
    const b = join(work, 'rep-b.img')
    for (const img of [a, b]) {
      await truncate(tb, img, '16M')
      await mke2fs(tb, dataSpec(img))
    }
    const ha = (await tb.must(['sha256sum', a])).stdout.split(/\s+/)[0]
    const hb = (await tb.must(['sha256sum', b])).stdout.split(/\s+/)[0]
    expect(ha).toMatch(/^[0-9a-f]{64}$/)
    expect(ha).toBe(hb!)
  }, TOOL_TIMEOUT_MS)

  test('...and a different E2FSPROGS_FAKE_TIME produces different bytes, so that comparison means something', async () => {
    const c = join(work, 'rep-c.img')
    await truncate(tb, c, '16M')
    await mke2fs(tb, { ...dataSpec(c), fakeTime: '1600000000' })
    const ha = (await tb.must(['sha256sum', join(work, 'rep-a.img')])).stdout.split(/\s+/)[0]
    const hc = (await tb.must(['sha256sum', c])).stdout.split(/\s+/)[0]
    expect(hc).not.toBe(ha!)
  }, TOOL_TIMEOUT_MS)

  test('a seeded filesystem carries the tree, and dumpe2fs shows the inodes it used', async () => {
    const seed = join(work, 'seed')
    mkdirSync(join(seed, 'lib', 'mica'), { recursive: true })
    writeFileSync(join(seed, 'lib', 'mica', 'a.txt'), 'a\n')
    writeFileSync(join(seed, 'lib', 'mica', 'b.txt'), 'b\n')

    const img = join(work, 'seeded.img')
    await truncate(tb, img, '16M')
    await mke2fs(tb, dataSpec(img, seed))

    const h = await dumpe2fsHeader(tb, img)
    const unseeded = await dumpe2fsHeader(tb, join(work, 'rep-a.img'))
    // The seed used inodes the empty one did not.
    expect(h.freeInodes).toBeLessThan(unseeded.freeInodes)
    // ...and the full listing carries the free-inode ranges pin_seeded_times
    // reads. Parsing them is that function's argument and ports with it (M6b).
    expect(await dumpe2fsFull(tb, img)).toContain('Free inodes:')
  }, TOOL_TIMEOUT_MS)
})

describe('debugfs: exit 0 is not a verdict', () => {
  test('a command file that works applies cleanly', async () => {
    const img = join(work, 'debugfs-ok.img')
    await truncate(tb, img, '16M')
    await mke2fs(tb, dataSpec(img))
    const cmds = join(work, 'ok.cmds')
    // `sif` is what pin_seeded_times uses: set inode field.
    writeFileSync(cmds, 'sif <11> atime 1577836800\nsif <11> ctime 1577836800\n')
    const r = await debugfsApply(tb, img, cmds)
    expect(r.exitCode).toBe(0)
  }, TOOL_TIMEOUT_MS)

  test('a bad ARGUMENT to a real command EXITS 0 -- and the wrapper still fails', async () => {
    // The whole point of reading stderr, driven. `sif <999999>` is a real
    // command against an inode that is not there: debugfs reports it and exits
    // 0, so an exit-status check passes a run that pinned nothing.
    const img = join(work, 'debugfs-bad.img')
    await truncate(tb, img, '16M')
    await mke2fs(tb, dataSpec(img))
    const cmds = join(work, 'badarg.cmds')
    writeFileSync(cmds, 'sif <999999> atime 1577836800\n')

    // The premise, asserted rather than assumed.
    const raw = await tb.run(['debugfs', '-w', '-f', cmds, img])
    expect(raw.exitCode).toBe(0)
    expect(raw.stderr).toContain('ext2_lookup')

    // The wrapper's verdict.
    await expect(debugfsApply(tb, img, cmds)).rejects.toThrow(/exited 0 and reported errors on stderr/)
    await expect(debugfsApply(tb, img, cmds)).rejects.toThrow(/999999/)
  }, TOOL_TIMEOUT_MS)

  test('an UNKNOWN command exits 1 here, which is not what mkimage-common.sh\'s comment expects', async () => {
    // os/mkimage-common.sh gives the reason for reading stderr as "a rename of
    // `sif` [would] turn this into a no-op that still reports success".
    // Measured against debugfs 1.47.1, that example is wrong: an unrecognised
    // command exits 1. The argument for reading stderr stands on the case
    // above, which really is silent; this is the record that the illustration
    // is not, so a later reader does not trust it and drop the other half.
    const img = join(work, 'debugfs-bad.img')
    const cmds = join(work, 'renamed.cmds')
    writeFileSync(cmds, 'sif_renamed <11> atime 1577836800\n')
    const raw = await tb.run(['debugfs', '-w', '-f', cmds, img])
    expect(raw.exitCode).toBe(1)
    expect(raw.stderr).toContain('Command not found')
    // Caught either way, by the other half of the wrapper.
    await expect(debugfsApply(tb, img, cmds)).rejects.toThrow(/exited 1 applying/)
  }, TOOL_TIMEOUT_MS)

  test('an EMPTY command file is refused: debugfs would do nothing and report success', async () => {
    // The one failure NEITHER signal carries -- rc 0 and a clean stderr.
    // pin_seeded_times generates this file out of dumpe2fs's free-inode ranges,
    // so an empty one is what a parse that understood nothing produces.
    const img = join(work, 'debugfs-bad.img')
    const cmds = join(work, 'empty.cmds')
    writeFileSync(cmds, '\n   \n')
    const raw = await tb.run(['debugfs', '-w', '-f', cmds, img])
    expect(raw.exitCode).toBe(0)
    expect(raw.stderr).toMatch(/^debugfs 1\.[0-9.]+ \([^)]*\)\s*$/)
    await expect(debugfsApply(tb, img, cmds)).rejects.toThrow(/contains no debugfs command/)
  }, TOOL_TIMEOUT_MS)

  test('the version banner alone is NOT an error -- otherwise every run would fail', async () => {
    // The other half of reading stderr: debugfs writes "debugfs 1.47.1 ..." to
    // it on every invocation. A filter that did not exclude the banner would
    // turn every correct run red, which is the mirror image of the defect above
    // and would be found on the first use rather than never.
    const img = join(work, 'debugfs-ok.img')
    const cmds = join(work, 'ok.cmds')
    const raw = await tb.run(['debugfs', '-w', '-f', cmds, img])
    expect(raw.stderr).toMatch(/^debugfs 1\./)
    await expect(debugfsApply(tb, img, cmds)).resolves.toBeDefined()
  }, TOOL_TIMEOUT_MS)

  test('an image debugfs cannot OPEN also exits 0, and is caught by stderr rather than status', async () => {
    // Measured, and it corrects what this wrapper first assumed: a bad magic
    // number is not an exit code, it is two lines on stderr and a success.
    const notFs = join(work, 'not-a-fs.img')
    await truncate(tb, notFs, '4M')
    const cmds = join(work, 'ok.cmds')
    const raw = await tb.run(['debugfs', '-w', '-f', cmds, notFs])
    expect(raw.exitCode).toBe(0)
    expect(raw.stderr).toContain('Bad magic number')
    await expect(debugfsApply(tb, notFs, cmds)).rejects.toThrow(/exited 0 and reported errors on stderr/)
    await expect(debugfsApply(tb, notFs, cmds)).rejects.toThrow(/Bad magic number/)
  }, TOOL_TIMEOUT_MS)

  test('a command file that is not there exits 1, which the status half catches', async () => {
    const img = join(work, 'debugfs-ok.img')
    await expect(debugfsApply(tb, img, join(work, 'absent.cmds'))).rejects.toThrow(/exited 1 applying/)
  }, TOOL_TIMEOUT_MS)
})

describe('dumpe2fs refuses a header it cannot read', () => {
  test('something that is not a filesystem is refused, not defaulted to zero', async () => {
    const notFs = join(work, 'not-a-fs.img')
    await expect(dumpe2fsHeader(tb, notFs)).rejects.toThrow(/could not read the superblock/)
  }, TOOL_TIMEOUT_MS)

  test('a fakeTime that is not an epoch is refused before mke2fs runs', async () => {
    for (const bad of ['', '@1577836800', 'now']) {
      await expect(mke2fs(tb, { ...dataSpec(join(work, 'x.img')), fakeTime: bad }))
        .rejects.toThrow(/which is not an epoch/)
    }
  })
})
