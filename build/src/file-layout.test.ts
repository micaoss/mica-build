import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFileLayout, checkCapacity } from './file-layout.ts'
import { REPO_ROOT } from './paths.ts'
import { TOOL_TIMEOUT_MS } from './testing.ts'

test('s905x5m protects Amlogic reservations and native records before SYSTEM', () => {
  const source = readFileSync(join(REPO_ROOT, '_out/boards/s905x5m/board.env'), 'utf8')
  const layout = parseFileLayout(source)
  expect(layout.backend).toBe('uboot-fit')
  expect(layout.partitions.map(p => p.startSector)).toEqual([64, 128 * 2048, 1152 * 2048])
  expect(layout.partitions[0]!.sizeSectors).toBe(128 * 2048 - 64)
  expect(layout.firmware?.envOffsets).toEqual([120 * 1048576, 124 * 1048576])
  expect(layout.sizeSectors * 512).toBe(1409 * 1048576)
  for (const [before, after] of [
    ['UENV_A_OFFSET_BYTES=125829120', 'UENV_A_OFFSET_BYTES=113246208'],
    ['UENV_B_OFFSET_BYTES=130023424', 'UENV_B_OFFSET_BYTES=125829120'],
    ['SYSTEM_START_MIB=128', 'SYSTEM_START_MIB=124'],
    ['FIRMWARE_SIZE_SECTORS=262080', 'FIRMWARE_SIZE_SECTORS=36800'],
  ]) {
    expect(source).toContain(before!)
    expect(() => parseFileLayout(source.replace(before!, after!))).toThrow()
  }
})

test('x64 has exactly ESP, SYSTEM and last-growing DATA with independent capacity checks', () => {
  const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/x64/board.env'), 'utf8'))
  expect(layout.partitions.map(p => p.name)).toEqual(['ESP', 'SYSTEM', 'DATA'])
  expect(layout.partitions.map(p => p.startSector)).toEqual([2048, 513 * 2048, 1537 * 2048])
  expect(() => checkCapacity(layout, 100 * 1048576, 20 * 1048576)).not.toThrow()
  expect(() => checkCapacity(layout, 1000 * 1048576, 20 * 1048576)).toThrow('SYSTEM')
  expect(() => checkCapacity(layout, 100 * 1048576, 230 * 1048576)).toThrow('ESP')
})

test('refuse changed partition order, overlap, zero length and duplicate GUIDs', () => {
  const source = readFileSync(join(REPO_ROOT, '_out/boards/x64/board.env'), 'utf8')
  for (const [before, after] of [
    ['ESP SYSTEM DATA', 'ESP DATA SYSTEM'],
    ['SYSTEM_START_MIB=513', 'SYSTEM_START_MIB=512'],
    ['DATA_SIZE_MIB=256', 'DATA_SIZE_MIB=0'],
    ['SYSTEM_GUID=5AC35760-0064-4000-8000-000000000002', 'SYSTEM_GUID=5AC35760-0064-4000-8000-000000000001'],
  ]) {
    expect(source).toContain(before!)
    expect(() => parseFileLayout(source.replace(before!, after!))).toThrow()
  }
})

test('cx3576 reserves one raw firmware partition across loader and both environments', () => {
  const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'))
  expect(layout.partitions.map(p => p.name)).toEqual(['FIRMWARE', 'SYSTEM', 'DATA'])
  expect(layout.partitions.map(p => p.startSector)).toEqual([64, 18 * 2048, 1042 * 2048])
  expect(layout.partitions[0]!.sizeSectors).toBe(18 * 2048 - 64)
  expect(layout.partitions[1]!.sizeSectors * 512).toBe(1024 * 1048576)
  expect(layout.sizeSectors * 512).toBe(1299 * 1048576)
  expect(layout.firmware).toEqual({ loaderStartSector: 64, loaderSizeSectors: 32704, envOffsets: [16777216, 17825792], envSize: 65536 })
  expect(() => checkCapacity(layout, 100 * 1048576, 60 * 1048576)).not.toThrow()
  expect(() => checkCapacity(layout, 369 * 1048576, 78 * 1048576)).not.toThrow()
  expect(() => checkCapacity(layout, 371 * 1048576, 78 * 1048576)).toThrow('SYSTEM')
})

test('cx3576 refuses relocated, overlapping or unprotected firmware ranges', () => {
  const source = readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8')
  for (const [before, after] of [
    ['FIRMWARE_START_SECTOR=64', 'FIRMWARE_START_SECTOR=2048'],
    ['FIRMWARE_SIZE_SECTORS=36800', 'FIRMWARE_SIZE_SECTORS=36799'],
    ['UBOOT_MAX_BYTES=16744448', 'UBOOT_MAX_BYTES=17825792'],
    ['UENV_A_OFFSET_BYTES=16777216', 'UENV_A_OFFSET_BYTES=16777728'],
    ['UENV_B_OFFSET_BYTES=17825792', 'UENV_B_OFFSET_BYTES=16777216'],
    ['UENV_SIZE_BYTES=65536', 'UENV_SIZE_BYTES=131072'],
    ['GPT_ALIGN_SECTORS=1', 'GPT_ALIGN_SECTORS=2048'],
    ['FIRMWARE_TYPECODE=8DA63339-0007-60C0-C436-083AC8230908', 'FIRMWARE_TYPECODE=0FC63DAF-8483-4772-8E79-3D69D8477DE4'],
  ]) {
    expect(source).toContain(before!)
    expect(() => parseFileLayout(source.replace(before!, after!))).toThrow()
  }
})

test('formatted SYSTEM rejects payload pairs that fit raw bytes but consume filesystem reserves', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { Toolbox } = await import('./toolbox.ts')
  const { FILE_IMAGE_TOOLS } = await import('./file-image.ts')
  const { mke2fs, dumpe2fsHeader } = await import('./tools/e2fsprogs.ts')
  const { checkSystemFilesystemCapacity } = await import('./file-layout.ts')
  const directory = mkdtempSync(join(REPO_ROOT, '.tmp/system-capacity-'))
  const tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [directory] })
  try {
    const image = join(directory, 'system.img')
    await tb.must(['truncate', '-s', '1G', image])
    await mke2fs(tb, { image, label: 'system', uuid: '5ac35760-3576-4000-8000-000000000002', blockSize: 4096n, features: '^orphan_file,^metadata_csum_seed', fakeTime: '1577836800' })
    const header = await dumpe2fsHeader(tb, image)
    const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'))
    expect(() => checkCapacity(layout, 360 * 1048576, 60 * 1048576)).not.toThrow()
    expect(() => checkSystemFilesystemCapacity(header, 350 * 1048576)).not.toThrow()
    expect(() => checkSystemFilesystemCapacity(header, 420 * 1048576)).toThrow('filesystem')
  } finally {
    await tb.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, TOOL_TIMEOUT_MS)


test.each(['x64', 'virt-arm64', 'cx3576', 's905x5m'])('%s current signed layout keeps SYSTEM exactly 1 GiB', board => {
  const source = readFileSync(join(REPO_ROOT, '_out', 'boards', board, 'board.env'), 'utf8')
  const layout = parseFileLayout(source)
  expect(layout.partitions[1]!.sizeSectors * 512).toBe(1024 * 1048576)
  if (board === 'x64' || board === 'virt-arm64') {
    expect(layout.partitions.map(p => p.startSector)).toEqual([2048, 513 * 2048, 1537 * 2048])
    expect(layout.partitions[0]!.sizeSectors * 512).toBe(512 * 1048576)
    expect(layout.partitions[2]!.sizeSectors * 512).toBe(256 * 1048576)
  }
})

test.each(['x64', 'virt-arm64', 'cx3576', 's905x5m'])('%s refuses smaller or larger SYSTEM even with contiguous DATA', board => {
  const source = readFileSync(join(REPO_ROOT, '_out', 'boards', board, 'board.env'), 'utf8')
  const start = Number(/^SYSTEM_START_MIB=(\d+)$/m.exec(source)![1])
  for (const size of [512, 1023, 1025, 2048]) {
    const changed = source.replace(/^SYSTEM_SIZE_MIB=\d+$/m, `SYSTEM_SIZE_MIB=${size}`)
      .replace(/^DATA_START_MIB=\d+$/m, `DATA_START_MIB=${start + size}`)
    expect(() => parseFileLayout(changed)).toThrow('SYSTEM must be exactly 1 GiB')
  }
})

test.each(['x64', 'virt-arm64', 'cx3576', 's905x5m'])('%s retains exact two-deployment raw reserve boundaries', board => {
  const layout = parseFileLayout(readFileSync(join(REPO_ROOT, '_out', 'boards', board, 'board.env'), 'utf8'))
  const boot = 60 * 1048576
  const root = 448 * 1048576 - (layout.backend === 'uboot-fit' ? boot : 0)
  expect(() => checkCapacity(layout, root, boot)).not.toThrow()
  expect(() => checkCapacity(layout, root + 1, boot)).toThrow('SYSTEM')
  if (layout.backend === 'systemd-boot') {
    expect(() => checkCapacity(layout, root, 224 * 1048576)).not.toThrow()
    expect(() => checkCapacity(layout, root, 224 * 1048576 + 1)).toThrow('ESP')
  }
})
