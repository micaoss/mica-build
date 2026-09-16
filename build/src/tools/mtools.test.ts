// mtools and mkfs.vfat, against the real tools, driven from the failing side.
//
// THE INTERESTING ONE IS mkfs.vfat, because it is the tool in this toolset that
// FAILS BY SUCCEEDING. `-F 32` on a partition too small for 65525 clusters
// writes a FAT32 boot sector over a filesystem that is not FAT32 and exits 0.
// the uefi-x64 assembly contract records what that cost -- OVMF refused the ESP, it was
// absent from the firmware's device list, and the machine dropped to the UEFI
// shell -- and records that the first check written for it asked minfo for the
// TYPE and passed on the very image that would not boot. So the case below is
// built at the size that reproduces it, and the assertion is a cluster count.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkDir, REPO_ROOT } from '../paths.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../testing.ts'
import { Toolbox, ToolError } from '../toolbox.ts'
import { FILE_IMAGE_TOOLS } from '../file-image.ts'
import { truncate } from './dd.ts'
import { FAT32_MIN_CLUSTERS, listFat, mcopy, mcopyArgs, mkfsVfat, mkfsVfatArgs, mmd, readFatClusters } from './mtools.ts'

let tb: Toolbox
let work = ''

beforeAll(async () => {
  work = makeWorkDir('mtools')
  tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [REPO_ROOT], cwd: work })
}, OPEN_TIMEOUT_MS)
afterAll(async () => {
  await tb?.close()
  if (work !== '') rmSync(work, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

describe('the argv shapes', () => {
  test('mkfs.vfat carries --invariant, without which the volume label entry gets the wall clock', () => {
    expect(mkfsVfatArgs({ image: 'boot-a.img', label: 'BOOT-A', volumeId: 'C3576003' }))
      .toEqual(['mkfs.vfat', '--invariant', '-F', '32', '-n', 'BOOT-A', '-i', 'C3576003', 'boot-a.img'])
  })

  test('a volume id that is not eight hex digits is refused', () => {
    for (const bad of ['', 'nothex!!', 'C357600', 'C35760033']) {
      expect(() => mkfsVfatArgs({ image: 'i', label: 'L', volumeId: bad })).toThrow(/not eight hex digits/)
    }
    // The positive control: both boards' real volume ids pass.
    for (const good of ['C3576003', 'C3576004', 'C3576100', 'C3576103']) {
      expect(mkfsVfatArgs({ image: 'i', label: 'L', volumeId: good })).toContain(good)
    }
  })

  test('mcopy keeps -m, and -s only when a tree was asked for', () => {
    expect(mcopyArgs({ image: 'i', sources: ['stage/a'], destination: '::/' }))
      .toEqual(['mcopy', '-m', '-i', 'i', 'stage/a', '::/'])
    expect(mcopyArgs({ image: 'i', sources: ['stage/EFI'], destination: '::/', recursive: true }))
      .toEqual(['mcopy', '-s', '-m', '-i', 'i', 'stage/EFI', '::/'])
  })

  test('a destination without "::" is refused, because mcopy would run the copy BACKWARDS', () => {
    expect(() => mcopyArgs({ image: 'i', sources: ['a'], destination: '/boot' }))
      .toThrow(/runs OUT of i rather than into it -- successfully/)
  })

  test('copying nothing is refused', () => {
    expect(() => mcopyArgs({ image: 'i', sources: [], destination: '::/' })).toThrow(/copy nothing into/)
  })
})

describe('against the real mkfs.vfat and mtools', () => {
  test('the current 512 MiB ESP is a real FAT32 filesystem', async () => {
    const img = join(work, 'esp.img')
    await truncate(tb, img, '512M')
    await mkfsVfat(tb, { image: img, label: 'MICA-ESP', volumeId: 'C3576100' })
    expect(await readFatClusters(tb, img)).toBeGreaterThan(FAT32_MIN_CLUSTERS)
  }, TOOL_TIMEOUT_MS)

  test('mkfs.vfat -F 32 SUCCEEDS on a size that cannot be FAT32, and only the cluster count sees it', async () => {
    // 32 MiB is the size the uefi-x64 assembly contract measured: "at 32 MiB it produced an
    // image mtools read happily, mdir listed, the verifier passed -- and the
    // firmware would not mount it".
    const img = join(work, 'too-small.img')
    await truncate(tb, img, '32M')
    const r = await mkfsVfat(tb, { image: img, label: 'MICA-ESP', volumeId: 'C3576100' })
    // The premise, asserted rather than assumed: the tool is happy.
    expect(r.exitCode).toBe(0)
    // ...and mtools reads it happily too, which is why a type check was not enough.
    writeFileSync(join(work, 'probe.txt'), 'x\n')
    await mcopy(tb, { image: img, sources: [join(work, 'probe.txt')], destination: '::/probe.txt' })
    expect(await listFat(tb, img)).toEqual(['::/probe.txt'])
    // The one measurement that disagrees.
    const clusters = await readFatClusters(tb, img)
    expect(clusters).toBeLessThan(FAT32_MIN_CLUSTERS)
  }, TOOL_TIMEOUT_MS)

  test('a staged tree copies in, and lists back with every entry', async () => {
    const stage = join(work, 'stage')
    mkdirSync(join(stage, 'EFI', 'mica'), { recursive: true })
    writeFileSync(join(stage, 'Image'), 'kernel\n')
    writeFileSync(join(stage, 'EFI', 'mica', 'grub.cfg'), 'menuentry\n')

    const img = join(work, 'tree.img')
    await truncate(tb, img, '64M')
    await mkfsVfat(tb, { image: img, label: 'BOOT-A', volumeId: 'C3576003' })
    await mcopy(tb, { image: img, sources: [join(stage, 'Image'), join(stage, 'EFI')], destination: '::/', recursive: true })
    const listing = await listFat(tb, img)
    expect(listing).toContain('::/Image')
    expect(listing).toContain('::/EFI/mica/grub.cfg')
  }, TOOL_TIMEOUT_MS)

  test('mmd makes a directory, and the listing shows it', async () => {
    const img = join(work, 'mmd.img')
    await truncate(tb, img, '64M')
    await mkfsVfat(tb, { image: img, label: 'BOOT-B', volumeId: 'C3576004' })
    await mmd(tb, img, '::/EFI')
    writeFileSync(join(work, 'f.txt'), 'f\n')
    await mcopy(tb, { image: img, sources: [join(work, 'f.txt')], destination: '::/EFI/f.txt' })
    expect(await listFat(tb, img)).toContain('::/EFI/f.txt')
  }, TOOL_TIMEOUT_MS)
})

describe('every failure is reported', () => {
  test('an EMPTY filesystem is refused by listFat, because every comparison over it would pass', async () => {
    // "both slots carry the same files" and "no stray entry at the root" are
    // both satisfied by two empty slots. An empty listing is what a failed copy
    // leaves behind.
    const img = join(work, 'empty.img')
    await truncate(tb, img, '64M')
    await mkfsVfat(tb, { image: img, label: 'EMPTY', volumeId: 'DEADBEEF' })
    // The premise: mdir itself is content.
    const raw = await tb.run(['mdir', '-/', '-b', '-i', img, '::/'])
    expect(raw.exitCode).toBe(0)
    await expect(listFat(tb, img)).rejects.toThrow(/listed nothing under/)
  }, TOOL_TIMEOUT_MS)

  test('mkfs.vfat on a path that is not there is a ToolError', async () => {
    await expect(mkfsVfat(tb, { image: join(work, 'no', 'x.img'), label: 'L', volumeId: 'AAAABBBB' }))
      .rejects.toThrow(/could not format/)
  }, TOOL_TIMEOUT_MS)

  test('mcopy of a source that is not there is a ToolError carrying mcopy\'s words', async () => {
    const img = join(work, 'tree.img')
    let err: ToolError | undefined
    try {
      await mcopy(tb, { image: img, sources: [join(work, 'absent.txt')], destination: '::/absent.txt' })
    } catch (e) { err = e as ToolError }
    expect(err).toBeInstanceOf(ToolError)
    expect(err!.message).toContain('absent.txt')
  }, TOOL_TIMEOUT_MS)

  test('minfo on something that is not a filesystem is refused, not read as a small count', async () => {
    // `[ -z "${esp_clusters}" ]` is the shell's half of this. An unread count
    // must not compare as a small one.
    const notFs = join(work, 'not-a-fs.img')
    await truncate(tb, notFs, '8M')
    let msg = ''
    try { await readFatClusters(tb, notFs) } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/could not read|printed no "free clusters=" line/)
    expect(msg).toContain(notFs)
  }, TOOL_TIMEOUT_MS)
})
