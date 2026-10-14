import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkCapacity, loadLayout, parseLayout, partitionOf, regionOf, ROLE_NAMES, type FileLayout } from './file-layout.ts'
import { REPO_ROOT } from './paths.ts'
import { ROLES } from './roles/index.ts'
import { TOOL_TIMEOUT_MS } from './testing.ts'

const BOARDS = ['uefi-x64', 'uefi-arm64', 'cx3576', 's905x5m']
const layoutOf = (board: string): FileLayout => loadLayout(join(REPO_ROOT, 'boards', board))
const textOf = (board: string): string => readFileSync(join(REPO_ROOT, 'boards', board, 'layout.tsv'), 'utf8')

// The reference geometry each board's layout.tsv must declare exactly, so a table edit that moves a byte is seen.
test.each(BOARDS)('%s declares the reference geometry', (board) => {
  const layout = layoutOf(board)
  const fit = layout.backend === 'uboot-fit'
  expect(layout.partitions.map(p => [p.name, p.role])).toEqual(fit
    ? [['firmware', 'raw'], ['system', 'system'], ['data', 'data']]
    : [['esp', 'esp'], ['system', 'system'], ['data', 'data']])
  expect(partitionOf(layout, 'system').sizeSectors * 512).toBe(1024 * 1048576)
  expect(partitionOf(layout, 'data').sizeSectors * 512).toBe(256 * 1048576)
  expect(layout.alignSectors).toBe(fit ? 1 : 2048)
  if (!fit) {
    expect(layout.partitions.map(p => p.startSector)).toEqual([2048, 513 * 2048, 1537 * 2048])
    expect(partitionOf(layout, 'esp').sizeSectors * 512).toBe(512 * 1048576)
  }
})

test('cx3576 reserves one raw firmware partition across the loader and both record copies', () => {
  const layout = layoutOf('cx3576')
  expect(layout.partitions.map(p => p.startSector)).toEqual([64, 18 * 2048, 1042 * 2048])
  expect(layout.partitions[0]!.sizeSectors).toBe(18 * 2048 - 64)
  expect(layout.sizeSectors * 512).toBe(1299 * 1048576)
  expect(regionOf(layout, 'loader')).toMatchObject({ diskOffset: 64 * 512, size: 32704 * 512 })
  expect([regionOf(layout, 'records-a')!.diskOffset, regionOf(layout, 'records-b')!.diskOffset]).toEqual([16777216, 17825792])
})

test('s905x5m protects the Amlogic reservations and the native records before system, and places no loader', () => {
  const layout = layoutOf('s905x5m')
  expect(layout.partitions.map(p => p.startSector)).toEqual([64, 128 * 2048, 1152 * 2048])
  expect(layout.partitions[0]!.sizeSectors).toBe(128 * 2048 - 64)
  expect(layout.sizeSectors * 512).toBe(1409 * 1048576)
  expect(regionOf(layout, 'loader')).toBeUndefined()
  expect([regionOf(layout, 'records-a')!.diskOffset, regionOf(layout, 'records-b')!.diskOffset]).toEqual([120 * 1048576, 124 * 1048576])
})

test('every declared role is one the engine registry carries, and it carries exactly the roles the rules know', () => {
  expect(Object.keys(ROLES).sort()).toEqual([...ROLE_NAMES].sort())
  for (const board of BOARDS) for (const p of layoutOf(board).partitions) expect(ROLE_NAMES).toContain(p.role)
})

// A fifth board of its own shape: four partitions, a vendor raw partition with a file region before the esp,
// a vfat configuration partition, and data last. Nothing of it is in the engine.
const FIFTH = `# mica layout v1
disk\t5AC35760-0555-4000-8000-000000000000\t512\t2048
part\t1\tvendor\traw\t2048\t8192\t8DA63339-0007-60C0-C436-083AC8230908\t5AC35760-0555-4000-8000-000000000001\t-
region\tvendor\tblob\t4096\t1024\tfile:vendor/blob.bin
part\t2\tesp\tesp\t10240\t1048576\tC12A7328-F81F-11D2-BA4B-00A0C93EC93B\t5AC35760-0555-4000-8000-000000000002\t0555A001
part\t3\tconfig\tvfat\t1058816\t65536\tEBD0A0A2-B9E5-4433-87C0-68B6B72699C7\t5AC35760-0555-4000-8000-000000000003\t0555A002
part\t4\tsystem\tsystem\t1124352\t4194304\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5AC35760-0555-4000-8000-000000000004\t5ac35760-0555-4000-8000-000000000104
part\t5\tdata\tdata\t5318656\t524288\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5AC35760-0555-4000-8000-000000000005\t5ac35760-0555-4000-8000-000000000105
`

test('a fifth board with five partitions, a vendor raw partition and a 2 GiB system is data only', () => {
  const layout = parseLayout(FIFTH, 'fifth', 'systemd-boot')
  expect(layout.partitions.map(p => `${p.number}:${p.name}:${p.role}`)).toEqual(['1:vendor:raw', '2:esp:esp', '3:config:vfat', '4:system:system', '5:data:data'])
  expect(partitionOf(layout, 'system').sizeSectors * 512).toBe(2048 * 1048576)
  expect(layout.regions).toEqual([{ partition: 'vendor', name: 'blob', offset: 4096, size: 1024, source: 'file:vendor/blob.bin' }])
  expect(layout.sizeSectors).toBe(5318656 + 524288 + 2048)
  // The capacity check reads the declared system size, not a fixed 1 GiB.
  expect(() => checkCapacity(layout, 900 * 1048576, 20 * 1048576)).not.toThrow()
  expect(() => checkCapacity(layout, 1000 * 1048576, 20 * 1048576)).toThrow('system cannot retain')
})

const edit = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`the fixture carries no ${JSON.stringify(from)}`)
  return text.replace(from, to)
}

test.each([
  ['overlapping partitions', FIFTH, 'part\t3\tconfig\tvfat\t1058816', 'part\t3\tconfig\tvfat\t1056768', 'starts at sector 1056768, inside partition esp'],
  ['two system roles', FIFTH, 'part\t3\tconfig\tvfat\t1058816\t65536\tEBD0A0A2-B9E5-4433-87C0-68B6B72699C7\t5AC35760-0555-4000-8000-000000000003\t0555A002', 'part\t3\tconfig\tsystem\t1058816\t65536\tEBD0A0A2-B9E5-4433-87C0-68B6B72699C7\t5AC35760-0555-4000-8000-000000000003\t5ac35760-0555-4000-8000-000000000103', '2 system partitions'],
  ['a region outside its partition', FIFTH, 'region\tvendor\tblob\t4096\t1024', 'region\tvendor\tblob\t4194000\t1024', 'is outside vendor'],
  ['a role no registry carries', FIFTH, '\tconfig\tvfat\t', '\tconfig\tbtrfs\t', 'role \'btrfs\' is none the engine implements'],
  ['data not last', FIFTH, 'part\t5\tdata\tdata', 'part\t5\tdata\text4', '0 data partitions'],
  ['a misaligned start', FIFTH, 'part\t2\tesp\tesp\t10240', 'part\t2\tesp\tesp\t10241', 'not a multiple of the alignment 2048'],
  ['a gap in the numbering', FIFTH, 'part\t3\tconfig', 'part\t7\tconfig', 'is number 7'],
  ['a duplicate identity', FIFTH, '5AC35760-0555-4000-8000-000000000003\t0555A002', '5AC35760-0555-4000-8000-000000000002\t0555A002', 'share the identity'],
  ['a region in a filesystem partition', FIFTH, 'region\tvendor\tblob', 'region\tconfig\tblob', 'only a raw partition holds regions'],
  ['a region source outside the board directory', FIFTH, 'file:vendor/blob.bin', 'file:../secret', 'is none of loader'],
  ['a loader on a systemd-boot board', FIFTH, 'file:vendor/blob.bin', 'loader', 'a systemd-boot board carries no loader'],
  ['no layout header', FIFTH, '# mica layout v1', '# layout', 'the first line is not'],
])('%s is refused by name', (_what, text, from, to, message) => {
  expect(() => parseLayout(edit(text, from, to), 'fifth', 'systemd-boot')).toThrow(message)
})

test('a uboot-fit board carries both record regions, sector aligned inside its raw partition, and no esp', () => {
  const cx = textOf('cx3576')
  expect(() => parseLayout(cx.replace(/^region\tfirmware\trecords-b.*\n/m, ''), 'cx3576', 'uboot-fit')).toThrow('carries the records-a and records-b regions')
  expect(() => parseLayout(edit(cx, 'records-a\t16744448\t65536', 'records-a\t16744704\t65536'), 'cx3576', 'uboot-fit')).toThrow('is not sector aligned')
  expect(() => parseLayout(edit(cx, '\t64\t36800\t', '\t64\t34800\t'), 'cx3576', 'uboot-fit')).toThrow('is outside firmware')
  expect(() => parseLayout(edit(cx, 'records-b\t17793024\t65536', 'records-b\t17793024\t131072'), 'cx3576', 'uboot-fit')).toThrow('a boot record copy is 65536')
  // The device reads the geometry from the signed boot policy: a FIT board it has never seen is data.
  expect(parseLayout(cx, 'fifth', 'uboot-fit').board).toBe('fifth')
  expect(() => parseLayout(FIFTH, 'fifth', 'uboot-fit')).toThrow('an esp partition on a uboot-fit board')
  expect(() => parseLayout(textOf('uefi-x64'), 'uefi-x64', 'uboot-fit')).toThrow()
})

test.each(BOARDS)('%s retains exact two-deployment raw reserve boundaries', (board) => {
  const layout = layoutOf(board)
  const boot = 60 * 1048576
  const root = 448 * 1048576 - (layout.backend === 'uboot-fit' ? boot : 0)
  expect(() => checkCapacity(layout, root, boot)).not.toThrow()
  expect(() => checkCapacity(layout, root + 1, boot)).toThrow('system')
  if (layout.backend === 'systemd-boot') {
    expect(() => checkCapacity(layout, root, 224 * 1048576)).not.toThrow()
    expect(() => checkCapacity(layout, root, 224 * 1048576 + 1)).toThrow('esp')
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
    expect(() => checkCapacity(layoutOf('cx3576'), 360 * 1048576, 60 * 1048576)).not.toThrow()
    expect(() => checkSystemFilesystemCapacity(header, 350 * 1048576)).not.toThrow()
    expect(() => checkSystemFilesystemCapacity(header, 420 * 1048576)).toThrow('filesystem')
    // A declared reserve moves the boundary and nothing else: the filesystem's own overhead still counts.
    expect(() => checkSystemFilesystemCapacity(header, 450 * 1048576, 4)).not.toThrow()
    expect(() => checkSystemFilesystemCapacity(header, 480 * 1048576, 4)).toThrow('filesystem')
  }
  finally {
    await tb.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, TOOL_TIMEOUT_MS)

// A board sized for a small part declares its reserves;
// without the rows they are the 128 MiB and 64 MiB every board had before.
test('reserve rows set the system and esp reserves the capacity check holds, exactly', () => {
  const x64 = textOf('uefi-x64')
  expect(parseLayout(x64, 'uefi-x64', 'systemd-boot').reserves).toEqual({ system: 128, esp: 64 })
  expect(parseLayout(x64, 'uefi-x64', 'systemd-boot').declaredReserves).toEqual({})
  const layout = parseLayout(`${x64}reserve\tsystem\t4\nreserve\tesp\t2\nreserve\tdata\t8\n`, 'uefi-x64', 'systemd-boot')
  expect(layout.reserves).toEqual({ system: 4, esp: 2 })
  expect(layout.declaredReserves).toEqual({ system: 4, esp: 2, data: 8 })
  const system = partitionOf(layout, 'system').sizeSectors * 512, esp = partitionOf(layout, 'esp').sizeSectors * 512
  const root = (system - 4 * 1048576) / 2, boot = (esp - 2 * 1048576) / 2
  expect(() => checkCapacity(layout, root, boot)).not.toThrow()
  expect(() => checkCapacity(layout, root + 1, boot)).toThrow('system cannot retain')
  expect(() => checkCapacity(layout, root, boot + 1)).toThrow('esp cannot retain')
})

test('a reserve row is refused for another role, twice, not a whole MiB, outside 1 MiB to 1 GiB, or for an esp a board lacks', () => {
  const x64 = textOf('uefi-x64'), cx = textOf('cx3576')
  expect(() => parseLayout(`${x64}reserve\tboot\t4\n`, 'uefi-x64', 'systemd-boot')).toThrow('reserve for \'boot\'')
  expect(() => parseLayout(`${x64}reserve\tdata\t0\n`, 'uefi-x64', 'systemd-boot')).toThrow('the data reserve')
  expect(() => parseLayout(`${x64}reserve\tdata\t1025\n`, 'uefi-x64', 'systemd-boot')).toThrow('the data reserve is 1025 MiB; a reserve is 1 to 1024 MiB')
  expect(() => parseLayout(`${x64}reserve\tsystem\t4\nreserve\tsystem\t8\n`, 'uefi-x64', 'systemd-boot')).toThrow('a second system reserve')
  expect(() => parseLayout(`${x64}reserve\tsystem\t1.5\n`, 'uefi-x64', 'systemd-boot')).toThrow('is not an integer')
  expect(() => parseLayout(`${x64}reserve\tsystem\n`, 'uefi-x64', 'systemd-boot')).toThrow('a reserve row has 3 columns')
  expect(() => parseLayout(`${cx}reserve\tesp\t2\n`, 'cx3576', 'uboot-fit')).toThrow('an esp reserve on a board with no esp')
})

const EMMC = `# mica layout v1
# eMMC user area. Vendor partitions occupy GPT slots 4..6 before Mica slots 1..3.
# Preserve every vendor partition and unpartitioned bootloader gap during installation.
disk\t5A9055A0-0004-4000-8000-000000000000\t512\t1
discard\tno
part\t4\tbootloader_a\tpreserved\t8192\t24576\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t708161C1-0000-4000-8000-000000000011\t-
part\t5\treserved\tpreserved\t73728\t131072\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t708161C1-0000-4000-8000-000000000014\t-
part\t6\tenv\tpreserved\t221184\t32768\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t708161C1-0000-4000-8000-000000000015\t-
part\t1\tfirmware\traw\t262144\t16384\t8DA63339-0007-60C0-C436-083AC8230908\t5A9055A0-0004-4000-8000-000000000001\t-
part\t2\tsystem\tsystem\t278528\t2097152\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5A9055A0-0004-4000-8000-000000000002\t5a9055a0-0004-4000-8000-000000000102
part\t3\tdata\tdata\t2375680\t524288\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5A9055A0-0004-4000-8000-000000000003\t5a9055a0-0004-4000-8000-000000000103
region\tfirmware\trecords-a\t0\t65536\trecords-a
region\tfirmware\trecords-b\t4194304\t65536\trecords-b
`

test('preserved slots remain in disk order, numbered after the Mica partitions, with discard disabled', () => {
  const layout = parseLayout(EMMC, 'fixture', 'uboot-fit')
  expect(layout.partitions.map(p => [p.number, p.role])).toEqual([[4, 'preserved'], [5, 'preserved'], [6, 'preserved'], [1, 'raw'], [2, 'system'], [3, 'data']])
  expect(layout.discard).toBe('no')
  expect(regionOf(layout, 'records-a')!.diskOffset).toBe(128 * 1048576)
  expect(regionOf(layout, 'records-b')!.diskOffset).toBe(132 * 1048576)
  expect(parseLayout(textOf('cx3576'), 'fixture', 'uboot-fit').discard).toBeUndefined()
})

test('preserved layouts refuse discard defaults, invalid numbering, filesystem ids and out-of-order rows', () => {
  expect(() => parseLayout(EMMC.replace('discard\tno\n', ''), 'fixture', 'uboot-fit')).toThrow('discard no')
  expect(() => parseLayout(EMMC.replace('discard\tno', 'discard\tyes'), 'fixture', 'uboot-fit')).toThrow('discard no')
  expect(() => parseLayout(EMMC.replace('part\t4\tbootloader_a', 'part\t7\tbootloader_a'), 'fixture', 'uboot-fit')).toThrow('is number 7')
  expect(() => parseLayout(EMMC.replace('part\t1\tfirmware', 'part\t4\tfirmware'), 'fixture', 'uboot-fit')).toThrow('is number 4')
  expect(() => parseLayout(EMMC.replace('discard\tno', 'discard\tmaybe'), 'fixture', 'uboot-fit')).toThrow('discard')
  expect(() => parseLayout(`${EMMC}discard\tno\n`, 'fixture', 'uboot-fit')).toThrow('second discard')
  expect(() => parseLayout(EMMC.replace('000000000011\t-', '000000000011\t708161c1-0000-4000-8000-000000000111'), 'fixture', 'uboot-fit')).toThrow('no filesystem id')
  expect(() => parseLayout(EMMC.replace('\t73728\t131072', '\t4096\t131072'), 'fixture', 'uboot-fit')).toThrow('inside partition')
})

test('a named layout is selected explicitly and a missing or unsafe name is refused', () => {
  mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
  const dir = mkdtempSync(join(REPO_ROOT, '.tmp/layout-selector-'))
  try {
    copyFileSync(join(REPO_ROOT, 'boards/s905x5m/board.env'), join(dir, 'board.env'))
    writeFileSync(join(dir, 'layout.tsv'), textOf('s905x5m'))
    writeFileSync(join(dir, 'layout-emmc.tsv'), EMMC)
    expect(loadLayout(dir).diskGuid).toContain('-0003-')
    expect(loadLayout(dir, 'emmc').diskGuid).toContain('-0004-')
    expect(loadLayout(dir, 'emmc').storageLayout).toBe('emmc')
    expect(loadLayout(dir).storageLayout).toBeUndefined()
    expect(() => loadLayout(dir, 'missing')).toThrow('does not exist')
    expect(() => loadLayout(dir, '../emmc')).toThrow('layout name')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
