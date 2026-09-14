// The image helpers, driven from the failing side of every tool they use.
//
// A stub runtime and not a real image: `make os-verify-test` runs on a host with
// no image built, and in CI inside the pinned bun container with no docker under
// it, and a suite that needed a 1.4 GiB image would be a suite that skipped. So
// the tools' output is the fixture -- every transcript below was captured
// 2026-08-25 from the real tools in the pinned alpine:3.21, against the real
// cx3576 image and against deliberately malformed inputs, and pasted verbatim.
// The stub shares tools.ts's own runChecked, so a non-zero exit throws here
// exactly as it throws in production.
//
// Four of the five tools answer a question they could not answer with something
// shaped like an answer -- sgdisk invents a partition table, debugfs exits 0
// having opened nothing, unsquashfs exits 0 having extracted nothing,
// veritysetup uses one exit status for an answer and for a failure -- and every
// one is driven below and must be refused.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  debugfsRun,
  e2fsckClean,
  ext4List,
  ext4Stat,
  ext4Super,
  extractRange,
  fatCopyOut,
  fatList,
  fatTryReadFile,
  fatVolumeLabel,
  fdtGet,
  fdtGetCells,
  fdtGetResult,
  readBytes,
  readGpt,
  readUImage,
  sgdiskVerify,
  squashfsExtract,
  squashfsList,
  squashfsSuper,
  uImageMagic,
  uImageText,
  verityVerify,
  type UImageHeader,
} from './image.ts'
import { runChecked, ToolError, ToolOutputError, type ToolResult, type ToolRuntime } from './tools.ts'
import { REPO_ROOT } from './paths.ts'

// A scratch directory under _out/, never /tmp: a bind mount of /tmp on this
// host succeeds and delivers an empty directory, and these files are read back.
//
// _out/ is created, not assumed: it is gitignored build output (.gitignore)
// and `mkdtempSync` does not create its parent, so on a fresh worktree, a clean
// clone and CI this threw ENOENT at module scope, aborting the file before a
// single test in it was declared. Measured 2026-08-26 by moving _out/ aside,
// `make os-verify-test` went from `PASS (373/373)` to `FAIL (332 passed of 333
// run)` -- a ratio cannot see the tests that were never declared, so 373/373 and
// 333/333 are equally green and only one of them ran this file.
//
// Created and removed by the same condition. Made at module scope and removed in
// `afterAll` those are not the same condition: under a `-t` filter bun loads
// every file, so every file made its scratch, but only a file with a matching
// test runs its `afterAll`. Measured 2026-08-26, `run.sh -t 'the partition
// count'` left verify-bootchain-*, verify-cmdline-* and verify-test-* behind
// while an unfiltered run was clean, which is why it survived every floor this
// campaign ran.
//
// `process.on('exit')` does NOT close it -- driven on bun 1.4.0, the handler
// never fires under the test runner, filtered or not. A top-level `beforeAll`
// does: it is skipped by exactly the condition that skips `afterAll`.
let SCRATCH = ''
beforeAll(() => {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  SCRATCH = mkdtempSync(join(REPO_ROOT, '_out', 'verify-test-'))
})

// ...and removed afterwards. It used to survive every run, so a tree that had
// run the suite a few times carried a drift of _out/verify-test-* directories
// that nothing owned. `force` so a run that never reached a test still exits.
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

/**
 * The scratch directory, refusing to be read before `beforeAll` made it.
 *
 * `join('', 'src.bin')` is `'src.bin'` -- a RELATIVE path, so a read that outran
 * the hook would write fixtures into the process cwd and the tests would pass.
 */
function scratch(): string {
  if (SCRATCH === '') {
    throw new Error('the scratch directory was read before beforeAll created it')
  }
  return SCRATCH
}

interface Reply {
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
  /** What the tool DID to the filesystem, for the helpers that check after it. */
  readonly effect?: () => void
}

/** A runtime that replays recorded transcripts, keyed by a substring of the argv. */
function stub(replies: ReadonlyArray<readonly [string, Reply]>): ToolRuntime {
  const exec = async (argv: readonly string[]): Promise<ToolResult> => {
    const line = argv.join(' ')
    const hit = replies.find(([needle]) => line.includes(needle))
    if (hit === undefined) throw new Error(`the stub has no transcript for: ${line}`)
    const [, reply] = hit
    reply.effect?.()
    return { argv, code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return {
    route: 'host',
    announce: 'stub',
    run: (argv, options) => runChecked(exec, argv, options),
    dispose: async () => {},
  }
}

// real transcripts

/** `sgdisk -p` on the real cx3576 image, trimmed to five partitions. */
const SGDISK_P = `Disk /x.img: 2693120 sectors, 1.3 GiB
Sector size (logical): 512 bytes
Disk identifier (GUID): 5AC35760-0002-4000-8000-000000000000
Partition table holds up to 128 entries
Main partition table begins at sector 2 and ends at sector 33
First usable sector is 34, last usable sector is 2693086
Partitions will be aligned on 64-sector boundaries
Total free space is 5885 sectors (2.9 MiB)

Number  Start (sector)    End (sector)  Size       Code  Name
   1              64           32767   16.0 MiB    8301  loader
   2           32768           32895   64.0 KiB    8300  uenv-a
`

/** `sgdisk -i N` on the real image. */
const SGDISK_I1 = `Partition GUID code: 8DA63339-0007-60C0-C436-083AC8230908 (Linux reserved)
Partition unique GUID: 5AC35760-0002-4000-8000-000000000011
First sector: 64 (at 32.0 KiB)
Last sector: 32767 (at 16.0 MiB)
Partition size: 32704 sectors (16.0 MiB)
Attribute flags: 0000000000000000
Partition name: 'loader'
`
const SGDISK_I2 = SGDISK_I1
  .replace('8DA63339-0007-60C0-C436-083AC8230908 (Linux reserved)', '0FC63DAF-8483-4772-8E79-3D69D8477DE4 (Linux filesystem)')
  .replace('000000000011', '000000000001')
  .replace('First sector: 64 (at 32.0 KiB)', 'First sector: 32768 (at 16.0 MiB)')
  .replace('Last sector: 32767 (at 16.0 MiB)', 'Last sector: 32895 (at 16.1 MiB)')
  .replace('Partition size: 32704 sectors (16.0 MiB)', 'Partition size: 128 sectors (64.0 KiB)')
  .replace(`'loader'`, `'uenv-a'`)

/**
 * `sgdisk -p` on 64 MiB of zeros. Exit 0. A complete, well-formed fiction.
 *
 * The disk GUID here is one sgdisk made up: run twice on the same file it
 * printed 82861E6A-8EE5-47F2-A091-D96EFFDF5396 and then
 * 21E337DD-C4F2-4C27-AC27-ED70C064792A. Nothing downstream of this can be an
 * observation of anything.
 */
const SGDISK_P_INVENTED = `Creating new GPT entries in memory.
Disk /blank.img: 131072 sectors, 64.0 MiB
Sector size (logical): 512 bytes
Disk identifier (GUID): 21E337DD-C4F2-4C27-AC27-ED70C064792A
Partition table holds up to 128 entries
Main partition table begins at sector 2 and ends at sector 33
First usable sector is 34, last usable sector is 131038
Partitions will be aligned on 2048-sector boundaries
Total free space is 131005 sectors (64.0 MiB)

Number  Start (sector)    End (sector)  Size       Code  Name
`

const SGDISK_VERIFY_OK = `
No problems found. 5885 free sectors (2.9 MiB) available in 4
segments, the largest of which is 2015 (1007.5 KiB) in size.
`

/** The same clean bill of health, about a file with no partition table at all. */
const SGDISK_VERIFY_INVENTED = `Creating new GPT entries in memory.

No problems found. 131005 free sectors (64.0 MiB) available in 1
segments, the largest of which is 131005 (64.0 MiB) in size.
`

const TUNE2FS = `tune2fs 1.47.1 (20-May-2024)
Filesystem volume name:   meta
Last mounted on:          <not available>
Filesystem UUID:          5ac35760-0002-4000-8000-000000000107
Filesystem magic number:  0xEF53
Filesystem revision #:    1 (dynamic)
Filesystem features:      has_journal ext_attr resize_inode dir_index filetype extent 64bit flex_bg sparse_super large_file huge_file dir_nlink extra_isize metadata_csum
Filesystem state:         clean
Block count:              4096
Block size:               4096
`

const E2FS_BANNER_ONLY = 'debugfs 1.47.1 (20-May-2024)\n'
const DEBUGFS_LS = ` /2/040755/0/0/.//
 /2/040755/0/0/..//
 /11/040700/0/0/lost+found//
`.replace(/^ /gm, '')

/** debugfs on a file that is not ext4. EXIT 0, empty stdout, the truth on stderr. */
const DEBUGFS_NOT_OPEN = `debugfs 1.47.1 (20-May-2024)
debugfs: Attempt to read block from filesystem resulted in short read while trying to open /x
ls: Filesystem not open
`

const UNSQUASHFS_S = `Found a valid SQUASHFS 4:0 superblock on /x.img.
Creation or last append time Wed Jan  1 00:00:00 2020
Filesystem size 97312301 bytes (95031.54 Kbytes / 92.80 Mbytes)
Compression zstd
	compression-level 19
Block size 131072
`

// sgdisk

describe('readGpt reads a real table, and refuses an invented one', () => {
  const good = stub([
    ['sgdisk -p', { stdout: SGDISK_P }],
    ['sgdisk -i 1', { stdout: SGDISK_I1 }],
    ['sgdisk -i 2', { stdout: SGDISK_I2 }],
  ])

  test('every field a GPT check reads comes out typed', async () => {
    const gpt = await readGpt(good, '/x.img')
    expect(gpt.sectorSize).toBe(512)
    expect(gpt.totalSectors).toBe(2693120)
    expect(gpt.diskGuid).toBe('5AC35760-0002-4000-8000-000000000000')
    expect(gpt.partitions).toHaveLength(2)
    expect(gpt.partition(1)).toMatchObject({
      name: 'loader',
      firstSector: 64,
      lastSector: 32767,
      sizeSectors: 32704,
      typeGuid: '8DA63339-0007-60C0-C436-083AC8230908',
      uniqueGuid: '5AC35760-0002-4000-8000-000000000011',
      attributeFlags: '0000000000000000',
    })
    expect(gpt.partition(2)?.name).toBe('uenv-a')
  })

  test('a file with NO partition table is refused, though sgdisk exited 0', async () => {
    const blank = stub([['sgdisk -p', { stdout: SGDISK_P_INVENTED }]])
    await expect(readGpt(blank, '/blank.img')).rejects.toThrow(/Creating new GPT entries/)
    await expect(readGpt(blank, '/blank.img')).rejects.toThrow(ToolOutputError)
  })

  test('a real but EMPTY table is refused too, and for a different reason', async () => {
    const empty = stub([['sgdisk -p', { stdout: SGDISK_P.replace(/^ {3}\d.*\n/gm, '') }]])
    await expect(readGpt(empty, '/x.img')).rejects.toThrow(/listed no partitions/)
  })

  test('a table and a per-partition read that disagree are refused', async () => {
    const torn = stub([
      ['sgdisk -p', { stdout: SGDISK_P }],
      ['sgdisk -i 1', { stdout: SGDISK_I1 }],
      ['sgdisk -i 2', { stdout: 'Partition #2 does not exist.\n' }],
    ])
    await expect(readGpt(torn, '/x.img')).rejects.toThrow(/two readings of one table disagree/)
  })

  test('an output shape the parser does not know names the field and quotes it', async () => {
    const odd = stub([
      ['sgdisk -p', { stdout: SGDISK_P }],
      ['sgdisk -i 1', { stdout: SGDISK_I1.replace('Attribute flags: 0000000000000000\n', '') }],
    ])
    await expect(readGpt(odd, '/x.img')).rejects.toThrow(/partition 1 Attribute flags/)
  })

  test('sgdisk exiting non-zero throws a ToolError naming the argv', async () => {
    const broken = stub([['sgdisk -p', { code: 2, stderr: 'Disk is too small' }]])
    await expect(readGpt(broken, '/x.img')).rejects.toThrow(ToolError)
    await expect(readGpt(broken, '/x.img')).rejects.toThrow(/sgdisk -p \/x\.img` exited 2/)
  })
})

describe('sgdiskVerify does not take "No problems found" as the verdict', () => {
  test('a real clean table', async () => {
    const v = await sgdiskVerify(stub([['--verify', { stdout: SGDISK_VERIFY_OK }]]), '/x.img')
    expect(v.clean).toBe(true)
    expect(v.complaints).toEqual([])
  })

  test('the SAME clean sentence about a file with no GPT is refused', async () => {
    const blank = stub([['--verify', { stdout: SGDISK_VERIFY_INVENTED }]])
    await expect(sgdiskVerify(blank, '/blank.img')).rejects.toThrow(/There is no partition table/)
  })

  test('a Caution is a complaint; the two benign alignment notes are not', async () => {
    const noisy = stub([['--verify', {
      stdout: `${SGDISK_VERIFY_OK}\nCaution: partition 3 doesn't begin on a 2048-sector boundary\nWarning: partition 4 is damaged`,
    }]])
    const v = await sgdiskVerify(noisy, '/x.img')
    expect(v.clean).toBe(false)
    expect(v.complaints).toEqual(['Warning: partition 4 is damaged'])
  })
})

// mtools

describe('mtools reads the FAT in place, at an offset', () => {
  const slot = { image: '/x.img', offsetBytes: 18874368 }
  const fat = stub([
    ['mlabel', { stdout: ' Volume label is BOOT-A     \n' }],
    ['mdir', { stdout: '::/Image\n::/boot.scr\n::/mica-verity-a.env\n' }],
    ['mcopy -n -i /x.img@@18874368 ::/there', { stdout: 'contents\n' }],
    ['mcopy', { code: 1, stderr: 'mcopy: File "::/nope" not found\n' }],
  ])

  test('the volume label loses its FAT padding', async () => {
    expect(await fatVolumeLabel(fat, slot)).toBe('BOOT-A')
  })

  test('the offset goes into the mtools target, not into a temp file', async () => {
    let seen = ''
    const spy = stub([['mdir', { stdout: '::/Image\n' }]])
    const wrapped: ToolRuntime = { ...spy, run: async (argv, o) => { seen = argv.join(' '); return spy.run(argv, o) } }
    await fatList(wrapped, slot)
    expect(seen).toContain('/x.img@@18874368')
  })

  test('a listing is the paths mdir printed, in its own ::/ form', async () => {
    expect(await fatList(fat, slot)).toEqual(['::/Image', '::/boot.scr', '::/mica-verity-a.env'])
  })

  test('"has no label" is the empty string, not a parse failure', async () => {
    const bare = stub([['mlabel', { stdout: ' Volume has no label\n' }]])
    expect(await fatVolumeLabel(bare, slot)).toBe('')
  })

  test('mlabel printing something else entirely is refused', async () => {
    const odd = stub([['mlabel', { stdout: 'who knows\n' }]])
    await expect(fatVolumeLabel(odd, slot)).rejects.toThrow(/neither a volume label nor/)
  })

  test('a file that is not there is an ANSWER for fatTryReadFile', async () => {
    expect(await fatTryReadFile(fat, slot, 'nope')).toBeUndefined()
    expect(await fatTryReadFile(fat, slot, 'there')).toBe('contents\n')
  })

  test('exit 1 for a reason that is NOT absence must not be read as absence', async () => {
    const badOffset = stub([['mcopy', { code: 1, stderr: 'init :: non DOS media\n' }]])
    await expect(fatTryReadFile(badOffset, slot, 'x')).rejects.toThrow(/not because it is absent/)
  })

  test('a NaN offset is refused before it becomes an mtools target', async () => {
    await expect(fatList(fat, { image: '/x.img', offsetBytes: Number.NaN }))
      .rejects.toThrow(/non-negative whole number of bytes/)
  })
})

// ext4

describe('tune2fs and debugfs, where the exit status is not the answer', () => {
  const ext4 = stub([
    ['tune2fs -l', { stdout: TUNE2FS }],
    ['debugfs -R ls -p /', { stdout: DEBUGFS_LS, stderr: E2FS_BANNER_ONLY }],
  ])

  test('the superblock comes out typed', async () => {
    const sb = await ext4Super(ext4, '/p8.img')
    expect(sb.volumeName).toBe('meta')
    expect(sb.uuid).toBe('5ac35760-0002-4000-8000-000000000107')
    expect(sb.blockSize).toBe(4096)
    expect(sb.blockCount).toBe(4096)
    expect(sb.state).toBe('clean')
    expect(sb.features).toContain('metadata_csum')
    expect(sb.get('Filesystem revision #')).toBe('1 (dynamic)')
  })

  test('a magic number that is not 0xEF53 is refused, whatever the exit status', async () => {
    const wrong = stub([['tune2fs -l', { stdout: TUNE2FS.replace('0xEF53', '0x0000') }]])
    await expect(ext4Super(wrong, '/x.img')).rejects.toThrow(/not.*0xEF53/)
  })

  test('debugfs opening nothing at EXIT 0 is refused by its stderr', async () => {
    const notOpen = stub([['debugfs', { code: 0, stdout: '', stderr: DEBUGFS_NOT_OPEN }]])
    await expect(debugfsRun(notOpen, '/x', 'ls -p /')).rejects.toThrow(/EXITED 0 and complained/)
    await expect(debugfsRun(notOpen, '/x', 'ls -p /')).rejects.toThrow(/Filesystem not open/)
  })

  test('the version banner alone is not a complaint', async () => {
    expect(await debugfsRun(ext4, '/p8.img', 'ls -p /')).toBe(DEBUGFS_LS)
  })

  test('a directory listing is parsed to inode, mode, uid, gid, name', async () => {
    const entries = await ext4List(ext4, '/p8.img', '/')
    expect(entries.map(e => e.name)).toEqual(['.', '..', 'lost+found'])
    expect(entries[2]).toMatchObject({ inode: 11, mode: '040700', uid: 0, gid: 0 })
  })

  test('a listing with not even "." and ".." is refused', async () => {
    const empty = stub([['debugfs', { stdout: '\n', stderr: E2FS_BANNER_ONLY }]])
    await expect(ext4List(empty, '/x', '/')).rejects.toThrow(/listing of nothing/)
  })

  test('"File not found by ext2_lookup" is undefined -- an answer, not a failure', async () => {
    const missing = stub([['debugfs', {
      stdout: '', stderr: `${E2FS_BANNER_ONLY}/nope: File not found by ext2_lookup\n`,
    }]])
    expect(await ext4Stat(missing, '/p8.img', '/nope')).toBeUndefined()
  })

  test('any OTHER debugfs complaint on a stat is a failure, not an absence', async () => {
    const broken = stub([['debugfs', { stdout: '', stderr: DEBUGFS_NOT_OPEN }]])
    await expect(ext4Stat(broken, '/x', '/etc')).rejects.toThrow(/other than the path/)
  })

  test('a stat that worked comes back as fields', async () => {
    const ok = stub([['debugfs', {
      stdout: 'Inode: 11   Type: directory    Mode:  0700   Flags: 0x80000\nLinks: 2   Blockcount: 32\n',
      stderr: E2FS_BANNER_ONLY,
    }]])
    const fields = await ext4Stat(ok, '/p8.img', '/lost+found')
    expect(fields?.get('Inode')).toBe('11')
    expect(fields?.get('Type')).toBe('directory')
  })
})

// squashfs

describe('unsquashfs, which exits 0 having extracted nothing', () => {
  const sq = stub([
    ['unsquashfs -s', { stdout: UNSQUASHFS_S }],
    ['unsquashfs -l', { stdout: 'squashfs-root\nsquashfs-root/etc\nsquashfs-root/etc/fstab\n' }],
    ['unsquashfs -n', { stdout: '' }],
  ])

  test('the superblock comes out typed', async () => {
    const sb = await squashfsSuper(sq, '/r.img')
    expect(sb.version).toBe('4:0')
    expect(sb.sizeBytes).toBe(97312301)
    expect(sb.compression).toBe('zstd')
    expect(sb.blockSize).toBe(131072)
  })

  test('unsquashfs -s on a non-squashfs exits 1 and throws', async () => {
    const bad = stub([['unsquashfs -s', {
      code: 1, stderr: 'FATAL ERROR: Can\'t find a valid SQUASHFS superblock on /x\n',
    }]])
    await expect(squashfsSuper(bad, '/x')).rejects.toThrow(ToolError)
  })

  test('a listing strips the squashfs-root prefix and refuses an empty one', async () => {
    expect(await squashfsList(sq, '/r.img')).toEqual(['/etc', '/etc/fstab'])
    const empty = stub([['unsquashfs -l', { stdout: '\n' }]])
    await expect(squashfsList(empty, '/r.img')).rejects.toThrow(/listed nothing under squashfs-root/)
  })

  test('a requested path that did not land is refused, though the tool exited 0', async () => {
    const dest = join(scratch(), 'extract-nothing')
    await expect(squashfsExtract(sq, '/r.img', dest, ['no/such/path']))
      .rejects.toThrow(/did not extract no\/such\/path/)
  })

  test('an extracted path that is a DANGLING SYMLINK counts as extracted', async () => {
    // Measured against the real cx3576 root on 2026-08-25: etc/os-release is a
    // symlink to ../usr/lib/os-release, and asking for that path alone extracts
    // the LINK without its target. existsSync follows the link, finds nothing,
    // and reports the path as unextracted -- a refusal about a file that is
    // right there, which is the mirror of the swallow this guard exists to
    // stop and just as wrong. The probe found it against the real image; this
    // is what keeps it found.
    const dest = join(scratch(), 'extract-symlink')
    const runtime = stub([['unsquashfs -n', {
      effect: () => {
        mkdirSync(join(dest, 'etc'), { recursive: true })
        symlinkSync('../usr/lib/os-release', join(dest, 'etc/os-release'))
      },
    }]])
    expect(await squashfsExtract(runtime, '/r.img', dest, ['etc/os-release'])).toBe(dest)
    // ...and the same guard still refuses a path the tool left nothing at.
    const empty = join(scratch(), 'extract-symlink-empty')
    const nothing = stub([['unsquashfs -n', { effect: () => mkdirSync(empty, { recursive: true }) }]])
    await expect(squashfsExtract(nothing, '/r.img', empty, ['etc/os-release']))
      .rejects.toThrow(/did not extract etc\/os-release/)
  })

  test('extracting into a directory that already exists is refused', async () => {
    const dest = join(scratch(), 'twice')
    mkdirSync(dest, { recursive: true })
    await expect(squashfsExtract(sq, '/r.img', dest)).rejects.toThrow(/already exists/)
  })
})

// dm-verity

describe('veritysetup, where exit 1 means two different things', () => {
  const HASH = '776ffaf3c23c995829e39e443ef46e0b2ea5dd40d8a0ba9aa8849dfb9335f49f'
  const SALT = '0000000000000000000000000000000000000000000000000000000000000001'
  const req = {
    dataFile: '/r.img',
    hashFile: '/r.img',
    rootHash: HASH,
    hashOffset: 97312768,
    hashAlgo: 'sha256',
    dataBlockSize: 4096,
    hashBlockSize: 4096,
    dataBlocks: 23758,
    salt: SALT,
  }

  test('exit 0 is verified', async () => {
    expect(await verityVerify(stub([['veritysetup', { code: 0 }]]), req)).toBe('verified')
  })

  test('the walk is the KERNEL\'s: --no-superblock and every parameter spelled out', async () => {
    // The pair this whole family got wrong. Left to its own convention
    // veritysetup reads a superblock at --hash-offset and starts the tree one
    // hash block later, which is not where `dm-mod.create=` tells the kernel it
    // is -- so a payload could verify here and be refused at boot.
    let seen = ''
    const spy = stub([['veritysetup', { code: 0 }]])
    const wrapped: ToolRuntime = { ...spy, run: async (argv, o) => { seen = argv.join(' '); return spy.run(argv, o) } }
    await verityVerify(wrapped, req)
    expect(seen).toContain('--no-superblock')
    expect(seen).toContain('--hash-offset=97312768')
    expect(seen).toContain('--hash=sha256')
    expect(seen).toContain('--data-block-size=4096')
    expect(seen).toContain('--hash-block-size=4096')
    expect(seen).toContain('--data-blocks=23758')
    expect(seen).toContain(`--salt=${SALT}`)
  })

  test('"Verification of root hash failed." is the failing DIRECTION, and an answer', async () => {
    const mismatch = stub([['veritysetup', { code: 1, stderr: 'Verification of root hash failed.\n' }]])
    expect(await verityVerify(mismatch, req)).toBe('mismatch')
  })

  test('exit 2, "Verification of data area failed.", is the same direction one level lower', async () => {
    // What a tree at the WRONG OFFSET produces -- measured against cryptsetup
    // 2.7.5 by verifying a superblock-formatted image with --no-superblock,
    // which is exactly the pre-fix Mica OS image. Left unmapped it throws, and a
    // throw is not a verdict about the image, so the one artifact this check
    // exists to reject would come out as a harness error instead of a FAIL.
    const areaFailed = stub([['veritysetup', {
      code: 2, stderr: 'Verification failed at position 0.\nVerification of data area failed.\n',
    }]])
    expect(await verityVerify(areaFailed, req)).toBe('mismatch')
  })

  test('"not a valid VERITY device" is the SAME exit status and is NOT an answer', async () => {
    const broken = stub([['veritysetup', {
      code: 1, stderr: 'Device /r.img is not a valid VERITY device.\n',
    }]])
    await expect(verityVerify(broken, req)).rejects.toThrow(/NOT a hash mismatch/)
    await expect(verityVerify(broken, req)).rejects.toThrow(/--hash-offset=97312768/)
  })

  test('a root hash that is not one is refused before veritysetup sees it', async () => {
    const any = stub([['veritysetup', { code: 1, stderr: 'Verification of root hash failed.\n' }]])
    await expect(verityVerify(any, { ...req, rootHash: 'not-a-hash' })).rejects.toThrow(/is not a root hash/)
  })

  test('a NaN hash offset is refused, rather than becoming --hash-offset=NaN', async () => {
    const any = stub([['veritysetup', { code: 0 }]])
    await expect(verityVerify(any, { ...req, hashOffset: Number.NaN })).rejects.toThrow(/whole number of bytes/)
  })

  test('a NaN block size is refused too -- it is what a missing env key becomes', async () => {
    const any = stub([['veritysetup', { code: 0 }]])
    await expect(verityVerify(any, { ...req, dataBlockSize: Number.NaN }))
      .rejects.toThrow(/whole number of bytes/)
  })

  test('an empty salt or hash algorithm is refused: there is no superblock to fall back to', async () => {
    const any = stub([['veritysetup', { code: 0 }]])
    await expect(verityVerify(any, { ...req, salt: '' })).rejects.toThrow(/empty salt/)
    await expect(verityVerify(any, { ...req, hashAlgo: '' })).rejects.toThrow(/empty hash algorithm/)
  })
})

// byte ranges

describe('extractRange and readBytes need no tool, and refuse a short read', () => {
  // In a hook, not at describe scope: a describe BODY runs while bun is merely
  // REGISTERING tests, which happens in every loaded file even under a filter
  // that matches none of them -- so this write would outrun the scratch it
  // writes into. A describe-level beforeAll runs only if a test here runs.
  let src = ''
  beforeAll(() => {
    src = join(scratch(), 'src.bin')
    writeFileSync(src, Buffer.from(Array.from({ length: 4096 }, (_, i) => i & 0xff)))
  })

  test('a range comes out byte for byte', () => {
    const dest = join(scratch(), 'range.bin')
    extractRange(src, 1024, 512, dest)
    const got = readBytes(dest, 0, 512)
    expect(got[0]).toBe(0)
    expect(got[1]).toBe(1)
    expect(got.length).toBe(512)
  })

  test('a range past the end is refused, naming both sizes', () => {
    expect(() => extractRange(src, 4000, 512, join(scratch(), 'over.bin')))
      .toThrow(/which is 4096 bytes long/)
  })

  test('a NaN offset is refused rather than read from 0', () => {
    expect(() => readBytes(src, Number.NaN, 4)).toThrow(/non-negative whole number/)
    expect(() => extractRange(src, 0, Number.NaN, join(scratch(), 'nan.bin'))).toThrow(/whole number/)
  })

  test('reading past the end is a refusal, not a short buffer', () => {
    expect(() => readBytes(src, 4090, 16)).toThrow(/wanted 16 bytes/)
  })
})

// fdtget

/**
 * Every transcript below was captured on 2026-08-26 in the pinned alpine:3.21
 * with the package set the shell verifier installs -- fdtget out of `dtc`, and
 * the device tree compiled from a four-line .dts carrying the two status LEDs.
 */
describe('fdtget refuses honestly, except in the one place it does not', () => {
  const dtb = '/w/boot-a-rk3576-src.dtb'

  test('a property that is there comes back without its newline', async () => {
    const rt = stub([['fdtget', { stdout: 'status-red\n' }]])
    expect(await fdtGet(rt, dtb, '/leds/status-red', 'label')).toBe('status-red')
  })

  test('64 MiB of ZEROS is FDT_ERR_BADMAGIC, not an invented tree', async () => {
    // The contrast with sgdisk above is the whole reason this is asserted:
    // given the same input sgdisk prints a disk GUID it made up and exits 0.
    const rt = stub([['fdtget', {
      code: 1,
      stderr: `Error at '/leds/status-red': FDT_ERR_BADMAGIC\n`,
    }]])
    const read = await fdtGetResult(rt, dtb, '/leds/status-red', 'label')
    expect(read.value).toBeUndefined()
    expect(read.refusal).toMatch(/FDT_ERR_BADMAGIC/)
  })

  test('a node that is not in the tree is FDT_ERR_NOTFOUND and an ANSWER', async () => {
    const rt = stub([['fdtget', {
      code: 1,
      stderr: `Error at '/leds/status-green': FDT_ERR_NOTFOUND\n`,
    }]])
    expect(await fdtGet(rt, dtb, '/leds/status-green', 'label')).toBeUndefined()
  })

  test('a dtb that was never extracted is "Couldn\'t open blob", also an answer', async () => {
    const rt = stub([['fdtget', {
      code: 1,
      stderr: `Couldn't open blob from '${dtb}': No such file or directory\n`,
    }]])
    expect(await fdtGet(rt, dtb, '/leds/status-red', 'label')).toBeUndefined()
  })

  test('exit 1 saying something libfdt never says is NOT an absence', async () => {
    // The failure this separates: `fdtget: not found` from a container without
    // dtc. Read as "the property is absent" it would report a defect in the
    // device tree, on an image whose device tree nothing ever opened.
    const rt = stub([['fdtget', { code: 1, stderr: 'sh: fdtget: not found\n' }]])
    await expect(fdtGet(rt, dtb, '/leds/status-red', 'label'))
      .rejects.toThrow(/for a reason libfdt did not name/)
  })

  test('an EMPTY property value is the empty string, not an absence', async () => {
    const rt = stub([['fdtget', { stdout: '\n' }]])
    expect(await fdtGet(rt, dtb, '/leds/status-red', 'label')).toBe('')
  })

  test('-t x splits into cells the way `read -r -a` splits them', async () => {
    const rt = stub([['fdtget -t x', { stdout: '6b 1d 1\n' }]])
    expect(await fdtGetCells(rt, dtb, '/leds/status-red', 'gpios')).toEqual(['6b', '1d', '1'])
  })

  test('a refusal makes the cell array EMPTY, so [2] is missing rather than wrong', async () => {
    const rt = stub([['fdtget -t x', { code: 1, stderr: `Error at 'gpios': FDT_ERR_NOTFOUND\n` }]])
    const cells = await fdtGetCells(rt, dtb, '/leds/status-red', 'gpios')
    expect(cells).toEqual([])
    expect(cells[2]).toBeUndefined()
  })

  test('-t x on a STRING property answers anyway, and that is REPRODUCED', async () => {
    // Measured: `fdtget -t x T.dtb /leds/status-red label` exits 0 and prints
    // the string's bytes. So a `gpios` that had become a string hands
    // `fdtGetCells` the third BYTE of it -- `61` here -- as the
    // GPIO flags cell. Refusing would be the better tool and the wrong port:
    // the oracle FAILS that check, and a throw is a different parity row.
    const rt = stub([['fdtget -t x', { stdout: '73 74 61 74 75 73 2d 72 65 64 0\n' }]])
    const cells = await fdtGetCells(rt, dtb, '/leds/status-red', 'gpios')
    expect(cells[2]).toBe('61')
  })
})

// e2fsck

const E2FSCK_CLEAN = `e2fsck 1.47.1 (20-May-2024)
Pass 1: Checking inodes, blocks, and sizes
Pass 2: Checking directory structure
Pass 3: Checking directory connectivity
Pass 4: Checking reference counts
Pass 5: Checking group summary information
data: 12/16384 files (8.3% non-contiguous), 1650/16384 blocks
`

/** e2fsck 1.47.1 on an 8192-block filesystem in a 4096-block file. EXIT 0. */
const E2FSCK_TRUNCATED = `e2fsck 1.47.1 (20-May-2024)
The filesystem size (according to the superblock) is 8192 blocks
The physical size of the device is 4096 blocks
Either the superblock or the partition table is likely to be corrupt!
Abort? no

Pass 1: Checking inodes, blocks, and sizes
Pass 5: Checking group summary information
data: 12/2048 files (8.3% non-contiguous), 1650/8192 blocks
`

const E2FSCK_NOT_EXT4 = `e2fsck 1.47.1 (20-May-2024)
ext2fs_open2: Bad magic number in super-block
e2fsck: Superblock invalid, trying backup blocks...
e2fsck: Bad magic number in super-block while trying to open /w/meta.img
`

describe('e2fsck -fn, whose exit status is the oracle\'s whole test', () => {
  test('a clean filesystem is clean, and the report is kept rather than dropped', async () => {
    const rt = stub([['e2fsck -fn', { stdout: E2FSCK_CLEAN }]])
    const v = await e2fsckClean(rt, '/w/data.img')
    expect(v.clean).toBe(true)
    expect(v.code).toBe(0)
    expect(v.report.some(l => l.startsWith('Pass 5'))).toBe(true)
    // The version banner is not part of what e2fsck said about the filesystem.
    expect(v.report.some(l => /^e2fsck 1\.47/.test(l))).toBe(false)
  })

  test('a file that is not ext4 at all is exit 8, and that is NOT clean', async () => {
    const rt = stub([['e2fsck -fn', { code: 8, stdout: E2FSCK_NOT_EXT4 }]])
    const v = await e2fsckClean(rt, '/w/meta.img')
    expect(v.clean).toBe(false)
    expect(v.code).toBe(8)
    expect(v.report.join(' ')).toMatch(/Bad magic number in super-block/)
  })

  test('errors left UNCORRECTED is exit 4 and is not clean', async () => {
    const rt = stub([['e2fsck -fn', { code: 4, stdout: 'Inode 12 is in use, but has dtime set.  Fix? no\n' }]])
    expect((await e2fsckClean(rt, '/w/state.img')).clean).toBe(false)
  })

  test('A TRUNCATED FILESYSTEM EXITS 0, and this reproduces that', async () => {
    // The vacuous PASS in the code under test, asserted as its own case rather
    // than repaired. e2fsck says the superblock or the partition table is
    // likely to be corrupt and then exits 0; `e2fsckClean` sends
    // both streams to /dev/null and reads the status, so it concludes
    // `e2fsck -fn on data is clean`. A port that read the REPORT instead would
    // answer FAIL where the oracle answers PASS -- a divergence, and the
    // divergence would be the port's.
    const rt = stub([['e2fsck -fn', { code: 0, stdout: E2FSCK_TRUNCATED }]])
    const v = await e2fsckClean(rt, '/w/data.img')
    expect(v.clean).toBe(true)
    // ...and the sentence the oracle threw away is here, for whoever decides
    // whether it should be red.
    expect(v.report.join(' ')).toMatch(/likely to be corrupt/)
  })

  test('a usage error is NOT a statement about the filesystem', async () => {
    const rt = stub([['e2fsck -fn', { code: 16, stderr: 'Usage: e2fsck [-panyrcdfktvDFV]\n' }]])
    await expect(e2fsckClean(rt, '/w/data.img')).rejects.toThrow(/exited 16/)
  })
})

// the legacy uImage header

describe('the uImage header reader, which has no tool to lie for it', () => {
  /** The first 64 bytes of the real cx3576 boot.scr, captured 2026-08-26. */
  const HEADER = Buffer.from(
    '27051956e6c334365e0be1000000' + '1a04'
    + '00000000' + '00000000' + '1780edc9' + '05070600'
    + Buffer.from('mica boot').toString('hex') + '00'.repeat(24),
    'hex',
  )
  // EVERY path derived from `dir` is derived INSIDE the hook, not just `dir`
  // itself. Deriving one at describe scope from a `dir` the hook has not set
  // yet produces `join('', 'boot.scr')` -- the RELATIVE path `boot.scr` -- and
  // the write lands in whatever directory run.sh cd'd into. Measured: it left
  // a real uImage at verify/boot.scr and every test still passed, because a
  // file written to the wrong place reads back perfectly well from there.
  let dir = ''
  let scr = ''
  beforeAll(() => {
    dir = join(scratch(), 'uimage')
    mkdirSync(dir, { recursive: true })
    scr = join(dir, 'boot.scr')
    writeFileSync(scr, Buffer.concat([HEADER, Buffer.from('\0\0\x19\xfc\0\0\0\0setenv bootslot A\n', 'latin1')]))
  })

  test('the magic is the four bytes od prints, lowercase and unspaced', () => {
    expect(uImageMagic(scr)).toBe('27051956')
  })

  test('a file that is not there is the EMPTY string, as `od 2>/dev/null` is', () => {
    // Not a throw. The verification contract compares '' against 27051956 and
    // FAILS the check; a throw here would be a run that died instead.
    expect(uImageMagic(join(dir, 'never-written'))).toBe('')
  })

  test('a file shorter than four bytes is the empty string too', () => {
    const short = join(dir, 'short.scr')
    writeFileSync(short, Buffer.from([0x27, 0x05]))
    expect(uImageMagic(short)).toBe('')
  })

  test('the header comes out typed, including the type the oracle never reads', () => {
    const h = readUImage(scr)
    expect(h).toBeDefined()
    expect((h as UImageHeader).magic).toBe('27051956')
    expect((h as UImageHeader).name).toBe('mica boot')
    // 6 is IH_TYPE_SCRIPT. Read and reported; deliberately not asserted by any
    // check, because the oracle checks the magic and nothing else, and a uImage
    // of any other type carries the same four bytes.
    expect((h as UImageHeader).imageType).toBe(6)
    expect((h as UImageHeader).dataOffset).toBe(64)
  })

  test('a file too short to hold a header is undefined, not a struct of zeros', () => {
    const short = join(dir, 'stub.scr')
    writeFileSync(short, Buffer.from('27051956', 'hex'))
    expect(readUImage(short)).toBeUndefined()
    expect(readUImage(join(dir, 'never-written'))).toBeUndefined()
  })

  test('the text is the WHOLE file with NULs removed, header included', () => {
    // `tr -d '\0' < scr-A`, which is what the oracle awks over. A reader that
    // started at offset 64 would be a better reader and a different one.
    const text = uImageText(scr)
    expect(text).toContain('mica boot')
    expect(text).toContain('setenv bootslot A')
    expect(text).not.toContain('\0')
    expect(uImageText(join(dir, 'never-written'))).toBe('')
  })
})

describe('mcopy writing a file rather than a stdout string', () => {
  let dir = ''
  beforeAll(() => {
    dir = join(scratch(), 'mcopy-out')
    mkdirSync(dir, { recursive: true })
  })
  const slot = { image: '/w/x.img', offsetBytes: 18874368 }

  test('a file that landed is true, and the caller may read the BYTES', async () => {
    const dest = join(dir, 'rk3576-src.dtb')
    // Why this helper exists: the runtime reads stdout as TEXT, so `mcopy ... -`
    // turns every byte of a 290 KiB device tree that is not valid UTF-8 into
    // U+FFFD. mcopy writes the file itself instead.
    const rt = stub([['mcopy', { effect: () => writeFileSync(dest, Buffer.from([0xd0, 0x0d, 0xfe, 0xed])) }]])
    expect(await fatCopyOut(rt, slot, 'rk3576-src.dtb', dest)).toBe(true)
    expect([...readBytes(dest, 0, 4)]).toEqual([0xd0, 0x0d, 0xfe, 0xed])
  })

  test('a file that is not in the slot is FALSE, an answer', async () => {
    const rt = stub([['mcopy', { code: 1, stderr: 'File "::/nope" not found\n' }]])
    expect(await fatCopyOut(rt, slot, 'nope', join(dir, 'nope'))).toBe(false)
  })

  test('exit 1 that is NOT an absence must not be read as one', async () => {
    const rt = stub([['mcopy', { code: 1, stderr: 'init ::: non DOS media\n' }]])
    await expect(fatCopyOut(rt, slot, 'boot.scr', join(dir, 'x.scr')))
      .rejects.toThrow(/not because it is absent/)
  })

  test('mcopy exiting 0 having written NOTHING is refused', async () => {
    // unsquashfs's defect one directory along: the status says it worked and
    // the next read finds nothing, and the reason it finds nothing is
    // indistinguishable from the file being empty in the image.
    const rt = stub([['mcopy', { code: 0 }]])
    await expect(fatCopyOut(rt, slot, 'boot.scr', join(dir, 'never.scr')))
      .rejects.toThrow(/exited 0 .* and .* is not there/s)
  })
})
