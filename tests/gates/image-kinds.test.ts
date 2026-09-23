// src/product/image-kinds.ts over a fake board packer: the builtin disk kind, the packer interface (input
// directory, pack, verify), the product subset, the release double pack and size limit, and every refusal.
// The port of tests/gates/image-kinds-test.sh (deleted 2026-09-23), case for case; the fixture GPT image the
// shell built with Python is built here.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/image-kinds.test.ts      (make os-image-kinds-test; docker, no network)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ImageKindsError, imageKinds, pack, updateKinds } from '../../src/product/image-kinds.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'image-kinds-test.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))
const OUT = join(SCRATCH, 'product')
const BOARD = join(SCRATCH, 'board')
const IMAGE = 'mica-fixture-20260915-000000.img'
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A GUID's 16 bytes in the GPT's mixed-endian layout, from the uuid.UUID(int=n) the shell's Python used. */
function guidBytes(n: bigint): Buffer {
  const big = Buffer.alloc(16)
  big.writeBigUInt64BE(n >> 64n, 0); big.writeBigUInt64BE(n & ((1n << 64n) - 1n), 8)
  return Buffer.concat([big.subarray(0, 4).reverse(), big.subarray(4, 6).reverse(), big.subarray(6, 8).reverse(), big.subarray(8, 16)])
}

/** CRC-32 as zlib.crc32 computes it. */
function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

/** A signed canonical image stand-in: 8 MiB with a GPT of two partitions whose bytes differ. */
function fixtureDisk(path: string): void {
  const sector = 512, sectors = 16384
  const disk = Buffer.alloc(sector * sectors)
  const parts: [string, number, number, number][] = [['esp', 2048, 4095, 0x11], ['system', 4096, 16000, 0x22]]
  const entries = Buffer.alloc(128 * 128)
  parts.forEach(([name, first, last, fill], i) => {
    disk.fill(fill, first * sector, (last + 1) * sector)
    const e = entries.subarray(i * 128, (i + 1) * 128)
    guidBytes(0x0fc63daf848347728e793d69d8477de4n).copy(e, 0)
    guidBytes(BigInt(i + 1)).copy(e, 16)
    e.writeBigUInt64LE(BigInt(first), 32); e.writeBigUInt64LE(BigInt(last), 40); e.writeBigUInt64LE(0n, 48)
    Buffer.from(name, 'utf16le').copy(e, 56)
  })
  const header = Buffer.alloc(92)
  header.write('EFI PART', 0, 'latin1'); header.writeUInt32LE(0x10000, 8); header.writeUInt32LE(92, 12)
  header.writeBigUInt64LE(1n, 24); header.writeBigUInt64LE(BigInt(sectors - 1), 32); header.writeBigUInt64LE(34n, 40); header.writeBigUInt64LE(BigInt(sectors - 34), 48)
  guidBytes(0xd15cn).copy(header, 56)
  header.writeBigUInt64LE(2n, 72); header.writeUInt32LE(128, 80); header.writeUInt32LE(128, 84); header.writeUInt32LE(crc32(entries), 88)
  header.copy(disk, sector); entries.copy(disk, 2 * sector)
  writeFileSync(path, disk)
}

const FAKE_PACKER = `#!/bin/sh
set -eu
mode="$(cat /input/board/packer/mode)"
case "$1" in
pack)
    [ "\${mode}" != fail-pack ] || exit 3
    if [ "\${mode}" = huge ]; then truncate -s 2147483649 "$3"; exit 0; fi
    python3 - "$2" "$3" "\${mode}" <<'PY'
import hashlib, json, os, sys, time
input, output, mode = sys.argv[1:4]
layout = json.load(open(f'{input}/layout.json'))
head = {'layout': layout, 'parts': {p['image']: hashlib.sha256(open(f'{input}/{p["image"]}', 'rb').read()).hexdigest() for p in layout['partitions']},
        'product': json.load(open(f'{input}/product.json')), 'board': sorted(os.listdir(f'{input}/board'))}
if mode == 'nondeterministic':
    head['time'] = time.time_ns()
with open(output, 'wb') as out:
    out.write((json.dumps(head, sort_keys=True) + '\\n').encode())
    out.write(open(f'{input}/disk.img', 'rb').read())
PY
    ;;
verify)
    [ "\${mode}" != broken-verify ] || { echo "fake verify: byte 0 differs" >&2; exit 1; }
    [ "\${mode}" != huge ] || exit 0
    python3 - "$2" "$3" <<'PY'
import hashlib, json, sys
input, output = sys.argv[1:3]
data = open(output, 'rb').read()
head, body = data.split(b'\\n', 1)
disk = open(f'{input}/disk.img', 'rb').read()
assert body == disk, 'storage bytes differ from disk.img'
for p in json.loads(head)['layout']['partitions']:
    assert hashlib.sha256(disk[p['first_lba'] * 512:(p['last_lba'] + 1) * 512]).hexdigest() == json.loads(head)['parts'][p['image']], p['image']
PY
    ;;
*) exit 2 ;;
esac
`

const DISK = 'image\tdisk\tbuiltin\tmica-build-env:base\timg'
const FAKE = 'image\tfake-flash\tpacker/fake.sh\tmica-build-env:base\tfake.bin'
const FULL = 'update\tfull\tbuiltin\t-\tmicaupd', ROOT = 'update\troot\tbuiltin\t-\troot.micaupd', KERNEL = 'update\tkernel\tbuiltin\t-\tkernel.micaupd'
const images = (...rows: string[]) => writeFileSync(join(BOARD, 'images.tsv'), `# mica-boards images v1\n${rows.map(r => `${r}\n`).join('')}`)
const mode = (m: string) => writeFileSync(join(BOARD, 'packer/mode'), `${m}\n`)
const doPack = (release: boolean, ...kinds: string[]) => pack({ out: OUT, boardDir: BOARD, product: 'fixture', version: '20260915-0000', profile: 'dev', release, kinds, say: () => {} })
const refuses = (label: string, fragment: string, run: () => unknown) => {
  test(`${label}: refused naming '${fragment}'`, () => {
    expect(run).toThrow(ImageKindsError)
    expect(run).toThrow(fragment)
  }, 120000)
}

beforeAll(() => {
  mkdirSync(join(OUT, 'image'), { recursive: true })
  fixtureDisk(join(OUT, 'image', IMAGE))
  writeFileSync(join(OUT, 'image/SHA256SUMS'), `${sha256(readFileSync(join(OUT, 'image', IMAGE)))}  ${IMAGE}\n`)
  mkdirSync(join(BOARD, 'packer'), { recursive: true })
  writeFileSync(join(BOARD, 'board.env'), 'LAYOUT_VERSION=3\n')
  writeFileSync(join(BOARD, 'packer/fake.sh'), FAKE_PACKER)
  chmodSync(join(BOARD, 'packer/fake.sh'), 0o755)
})

describe('kinds: the declaration and the product subset', () => {
  const kindsOf = (...wanted: string[]) => imageKinds(BOARD, wanted).map(r => r.kind)
  test('every declared kind by default; a subset keeps disk', () => {
    images(DISK, FAKE)
    expect(kindsOf()).toEqual(['disk', 'fake-flash'])
    expect(kindsOf('disk')).toEqual(['disk'])
    expect(kindsOf('fake-flash')).toEqual(['disk', 'fake-flash'])
  })
  refuses('a kind the board does not declare', 'the image kind floppy is not declared', () => { images(DISK, FAKE); return kindsOf('floppy') })
  refuses('a board without disk', 'declares no disk image kind', () => { images(FAKE); return kindsOf() })
  refuses('builtin for another kind than disk', 'packs disk only', () => { images(DISK, 'image\tfake-flash\tbuiltin\tmica-build-env:base\tfake.bin'); return kindsOf() })
  refuses('a kind declared twice', 'declares the image kind fake-flash twice', () => { images(DISK, FAKE, FAKE); return kindsOf() })
  refuses('a runtime image no lock names', 'runs in upstream:no-such-image:1', () => { images(DISK, 'image\tfake-flash\tpacker/fake.sh\tupstream:no-such-image:1\tfake.bin'); return kindsOf() })
  refuses('a packer outside the packer component', 'is not a relative path', () => { images(DISK, 'image\tfake-flash\t../fake.sh\tmica-build-env:base\tfake.bin'); return kindsOf() })
  refuses('a packer row with no runtime image', 'names no runtime image', () => { images(DISK, 'image\tfake-flash\tpacker/fake.sh\t-\tfake.bin'); return kindsOf() })
  refuses('a board with no images.tsv', 'images.tsv does not exist', () => { rmSync(join(BOARD, 'images.tsv'), { force: true }); return kindsOf() })
})

describe('updates: the update rows, full mandatory once declared', () => {
  const updatesOf = (...wanted: string[]) => updateKinds(BOARD, wanted)
  test('- is the runtime image of the builtin disk row; every declared update kind by default; a subset keeps full', () => {
    images('image\tdisk\tbuiltin\t-\timg', FAKE, FULL, ROOT, KERNEL)
    expect(imageKinds(BOARD).map(r => `${r.kind}\t${r.runtime}`)).toEqual(['disk\t-', 'fake-flash\tmica-build-env:base'])
    expect(updatesOf().map(r => `${r.kind}\t${r.suffix}`)).toEqual(['full\tmicaupd', 'kernel\tkernel.micaupd', 'root\troot.micaupd'])
    expect(updatesOf('root').map(r => r.kind)).toEqual(['full', 'root'])
    images(DISK)
    expect(updatesOf()).toEqual([])
  })
  refuses('an update kind of a board without update rows', 'the update kind root is not declared', () => { images(DISK); return updatesOf('root') })
  refuses('update kinds without full', 'without full', () => { images(DISK, ROOT); return updatesOf() })
  refuses('an update kind other than full, root or kernel', 'is not full, root or kernel', () => { images(DISK, FULL, 'update\tfirmware\tbuiltin\t-\tfirmware.bin'); return updatesOf() })
  refuses('an update row with a packer', 'update <kind> builtin - <suffix>', () => { images(DISK, 'update\tfull\tpacker/fake.sh\tmica-build-env:base\tmicaupd'); return updatesOf() })
  refuses('an update suffix an image kind already has', 'two kinds the suffix img', () => { images(DISK, 'update\tfull\tbuiltin\t-\timg'); return updatesOf() })
})

describe('pack: the builtin disk and the fake packer through the interface', () => {
  test('pack --release: disk is the canonical image, the packer got disk.img, partitions, layout, board and product, verified and packed twice', () => {
    images(DISK, FAKE); mode('ok')
    const table = doPack(true)
    const packed = readFileSync(join(OUT, 'kinds/mica-fixture-20260915-0000.fake.bin'))
    const nl = packed.indexOf(0x0a)
    const head = JSON.parse(packed.subarray(0, nl).toString()) as { layout: { partitions: { image: string }[], layout_version: string, sector_size: number, sectors: number }, product: unknown, board: string[] }
    expect(readFileSync(join(OUT, 'kinds/mica-fixture-20260915-0000.img'))).toEqual(readFileSync(join(OUT, 'image', IMAGE)))
    expect(sha256(packed.subarray(nl + 1))).toBe(readFileSync(join(OUT, 'image/SHA256SUMS'), 'utf8').split(' ')[0]!)
    expect(head.layout.partitions.map(p => p.image)).toEqual(['esp.img', 'system.img'])
    expect([head.layout.layout_version, head.layout.sector_size, head.layout.sectors]).toEqual(['3', 512, 16384])
    expect(head.product).toEqual({ product: 'fixture', release: '20260915-0000', profile: 'dev' })
    expect(head.board).toContain('images.tsv')
    expect(table.map(l => l.split('\t').slice(0, 2).join('\t'))).toEqual(['disk\tkinds/mica-fixture-20260915-0000.img', 'fake-flash\tkinds/mica-fixture-20260915-0000.fake.bin'])
    expect(readFileSync(join(OUT, 'kinds.tsv'), 'utf8')).toBe(table.map(l => `${l}\n`).join(''))
    expect(existsSync(join(OUT, 'pack-input'))).toBe(false)
  }, 300000)
  test('a product subset packs only its kinds', () => {
    images(DISK, FAKE); mode('ok')
    expect(doPack(false, 'disk').map(l => l.split('\t')[0])).toEqual(['disk'])
    expect(existsSync(join(OUT, 'kinds/mica-fixture-20260915-0000.fake.bin'))).toBe(false)
  }, 120000)
  refuses('a failing pack', 'failed to pack', () => { images(DISK, FAKE); mode('fail-pack'); return doPack(false) })
  test('a failed pack leaves no kinds.tsv', () => { expect(existsSync(join(OUT, 'kinds.tsv'))).toBe(false) })
  refuses('a verify that finds other bytes', 'verify refused', () => { images(DISK, FAKE); mode('broken-verify'); return doPack(false) })
  test('a nondeterministic packer passes outside a release', () => { images(DISK, FAKE); mode('nondeterministic'); expect(doPack(false)).toHaveLength(2) }, 120000)
  refuses('a nondeterministic packer in a release', 'is not deterministic', () => { images(DISK, FAKE); mode('nondeterministic'); return doPack(true) })
  refuses('an output over 2 GiB in a release', 'over the 2 GiB', () => { images(DISK, FAKE); mode('huge'); return doPack(true) })
  refuses('a packer that is not executable', 'is no executable file', () => { images(DISK, FAKE); mode('ok'); chmodSync(join(BOARD, 'packer/fake.sh'), 0o644); return doPack(false) })
})
