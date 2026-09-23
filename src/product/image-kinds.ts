// The flashing formats of a product: the board declares them, mica-build executes their packers.
//
//   bun src/cli.ts image-kinds kinds <board dir> [<kind>...]
//       the image kinds a product packs, one row each: <kind> TAB <packer> TAB <runtime image> TAB <suffix>. The
//       board's images.tsv is checked; the named kinds (default: every declared kind) must be declared, and disk
//       is always one
//   bun src/cli.ts image-kinds updates <board dir> [<kind>...]
//       the update kinds a product publishes, rows as above, with full always one; nothing when the board
//       declares no update row
//   bun src/cli.ts image-kinds pack <product out> <board dir> <product> <version> <profile> [--release] [<kind>...]
//       packs and verifies every kind into <product out>/kinds/mica-<product>-<version>.<suffix> and writes
//       <product out>/kinds.tsv: <kind> TAB <file relative to the product out> TAB <sha256>
//
// THE BOARD DECLARES (user decisions 2026-09-15). <board dir>/images.tsv, carried in the board component:
// `# mica-boards images v1`, then rows `image <kind> <packer> <runtime image> <suffix>` (flashing formats) and
// `update <kind> builtin - <suffix>` (update packages). An image <packer> is `builtin` (this tree's own raw disk
// image, for `disk` only) or a path inside the board's packer component; <runtime image> is an image selector of
// locks/ (src/cli.ts from), or `-` for a builtin row; <suffix> is the output file's suffix. `disk` is mandatory:
// every other image kind derives from it. The update kinds are full (root, kernel and signed descriptor), root
// and kernel, all built and signed here; once a board declares update rows, full is one.
//
// THE INTERFACE. A packer is run as `<packer> pack <input> <output>` and then `<packer> verify <input> <output>`
// in its runtime image, with --network none, the input read-only and no key material mounted. The input
// directory holds disk.img (the signed canonical image), <partition>.img for every GPT partition (its bytes out
// of disk.img), layout.json (layout version, sector size and count, disk and partition GUIDs, ranges), board/
// (the assembled board tree) and product.json (product, release, profile). verify must unpack the output and
// prove every byte it writes to storage equals disk.img.
//
// --release packs every non-builtin kind twice and refuses differing bytes, and refuses an output over 2 GiB
// (a GitHub release asset limit); any failure fails the product. The port of tools/image-kinds.sh (deleted
// 2026-09-23), refusal for refusal; the GPT the shell read with Python is read here.
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as fromResolve } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'
import { hostPath } from '../shared/host-path.ts'
import { dockerBin } from '../shared/docker.ts'

export class ImageKindsError extends Error {}

export type Row = { kind: string, packer: string, runtime: string, suffix: string }
type Class = 'image' | 'update'

const KIND = /^[a-z0-9][a-z0-9-]*$/
const SUFFIX = /^[a-z0-9][a-z0-9.]*$/
const PACKER = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*(\/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*$/
const MAX_ASSET = 2 * 1024 * 1024 * 1024

function die(message: string): never {
  throw new ImageKindsError(`image-kinds: error: ${message}`)
}

/** The declared rows of one class, checked, in the product's selection (every declared kind when none is named). */
export function kinds(cls: Class, boardDir: string, wanted: string[] = []): Row[] {
  const path = join(boardDir, 'images.tsv')
  if (!existsSync(path)) die(`${path} does not exist; the board component declares its flashing and update formats there (mica-boards images v1)`)
  const lines = readFileSync(path, 'utf8').split('\n')
  if (lines[0] !== '# mica-boards images v1') die(`${path} is not mica-boards images v1`)
  const rows: Record<Class, Map<string, Row>> = { image: new Map(), update: new Map() }
  lines.slice(1).forEach((line, i) => {
    const n = i + 2
    if (line === '' || line.startsWith('#')) return
    const f = line.split('\t')
    if (f.length !== 5 || (f[0] !== 'image' && f[0] !== 'update')) die(`${path}:${n} is not image|update <kind> <packer> <runtime image> <suffix>`)
    const [row, kind, packer, runtime, suffix] = f as [Class, string, string, string, string]
    if (!KIND.test(kind) || !SUFFIX.test(suffix)) die(`${path}:${n} names a kind or suffix out of form`)
    if (row === 'image') {
      if ((packer === 'builtin') !== (kind === 'disk')) die(`${path}:${n}: the builtin image packer is the raw disk image and packs disk only`)
      if (packer !== 'builtin' && !PACKER.test(packer)) die(`${path}:${n}: the packer ${packer} is not a relative path in the packer component`)
      if (packer !== 'builtin' && runtime === '-') die(`${path}:${n}: the ${kind} packer names no runtime image`)
    }
    else {
      if (!['full', 'root', 'kernel'].includes(kind)) die(`${path}:${n}: the update kind ${kind} is not full, root or kernel`)
      if (packer !== 'builtin' || runtime !== '-') die(`${path}:${n}: an update row is update <kind> builtin - <suffix>; update packages are built and signed by mica-build`)
    }
    if (rows[row].has(kind)) die(`${path} declares the ${row} kind ${kind} twice`)
    if ([...rows.image.values(), ...rows.update.values()].some(r => r.suffix === suffix)) die(`${path} gives two kinds the suffix ${suffix}`)
    rows[row].set(kind, { kind, packer, runtime, suffix })
  })
  if (!rows.image.has('disk')) die(`${path} declares no disk image kind; every other image kind derives from the canonical disk image`)
  if (rows.update.size > 0 && !rows.update.has('full')) die(`${path} declares update kinds without full; root and kernel packages are variants of the full package`)
  const declared = rows[cls], base = cls === 'image' ? 'disk' : 'full'
  for (const kind of wanted) if (!declared.has(kind)) die(`the ${cls} kind ${kind} is not declared by ${path} (declared: ${[...declared.keys()].sort().join(' ') || 'none'})`)
  const chosen = wanted.length > 0 ? [...new Set([...wanted, base])].sort() : [...declared.keys()].sort()
  return chosen.map(k => declared.get(k)!)
}

/** The image kinds, every runtime image an image row of locks/. */
export function imageKinds(boardDir: string, wanted: string[] = []): Row[] {
  const rows = kinds('image', boardDir, wanted)
  const records = inputs()
  for (const r of rows) {
    if (r.runtime === '-') continue
    try { fromResolve(r.runtime, records) }
    catch (e) { die(`the ${r.kind} packer runs in ${r.runtime}, which no image row of locks/ names (${(e as Error).message})`) }
  }
  return rows
}

export function updateKinds(boardDir: string, wanted: string[] = []): Row[] {
  return kinds('update', boardDir, wanted)
}

const render = (rows: Row[]) => rows.map(r => `${r.kind}\t${r.packer}\t${r.runtime}\t${r.suffix}\n`).join('')

function guid(bytes: Uint8Array): string {
  const b = Buffer.from(bytes)
  const hex = (x: Buffer) => x.toString('hex')
  return `${hex(b.subarray(0, 4).reverse())}-${hex(b.subarray(4, 6).reverse())}-${hex(b.subarray(6, 8).reverse())}-${hex(b.subarray(8, 10))}-${hex(b.subarray(10, 16))}`
}

/** Python's json.dump(indent=2, sort_keys=True) over a plain document. */
function pyJson(value: unknown): string {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v)
  return JSON.stringify(sorted(value), null, 2)
}

/** The partition images, layout.json and product.json of the packer input, out of the disk's GPT. */
export function splitDisk(input: string, layoutVersion: string, product: string, version: string, profile: string): void {
  const disk = join(input, 'disk.img')
  const sector = 512
  const fd = openSync(disk, 'r')
  try {
    const read = (offset: number, length: number): Buffer => {
      const buf = Buffer.alloc(length)
      let done = 0
      while (done < length) {
        const n = readSync(fd, buf, done, length - done, offset + done)
        if (n === 0) break
        done += n
      }
      return buf.subarray(0, done)
    }
    const header = read(sector, 92)
    if (header.subarray(0, 8).toString('latin1') !== 'EFI PART') die(`${disk} carries no GPT at LBA 1`)
    const first = header.readBigUInt64LE(40), last = header.readBigUInt64LE(48)
    const diskGuid = header.subarray(56, 72)
    const entriesLba = header.readBigUInt64LE(72), count = header.readUInt32LE(80), size = header.readUInt32LE(84)
    const table = read(Number(entriesLba) * sector, count * size)
    const partitions: { number: number, name: string, image: string, type_guid: string, guid: string, first_lba: number, last_lba: number }[] = []
    for (let i = 0; i < count; i++) {
      const e = table.subarray(i * size, (i + 1) * size)
      const typeGuid = e.subarray(0, 16)
      if (typeGuid.every(b => b === 0)) continue
      const start = Number(e.readBigUInt64LE(32)), end = Number(e.readBigUInt64LE(40))
      const name = e.subarray(56, 128).toString('utf16le').replace(/\0+$/, '')
      const image = `${name}.img`
      if (name === '' || name.includes('/') || ['disk.img', 'layout.json', 'product.json'].includes(image) || partitions.some(p => p.image === image))
        die(`partition ${i + 1} of ${disk} is named ${JSON.stringify(name).replace(/^"|"$/g, '\'')}, which names no partition image`)
      const out = openSync(join(input, image), 'w')
      try {
        let remaining = (end - start + 1) * sector, at = start * sector
        while (remaining > 0) {
          const block = read(at, Math.min(remaining, 1 << 24))
          writeSync(out, block)
          remaining -= block.length; at += block.length
          if (block.length === 0) break
        }
      }
      finally { closeSync(out) }
      partitions.push({ number: i + 1, name, image, type_guid: guid(typeGuid), guid: guid(e.subarray(16, 32)), first_lba: start, last_lba: end })
    }
    writeFileSync(join(input, 'layout.json'), pyJson({ schema: 'mica/layout/v1', layout_version: layoutVersion, sector_size: sector, sectors: Math.floor(statSync(disk).size / sector), disk_guid: guid(diskGuid), first_usable_lba: Number(first), last_usable_lba: Number(last), partitions }))
    writeFileSync(join(input, 'product.json'), pyJson({ product, release: version, profile }))
  }
  finally { closeSync(fd) }
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Make a tree read-only (chmod -R a-w) or writable again for its owner (chmod -R u+w). */
function chmodTree(dir: string, writable: boolean): void {
  const walk = (p: string) => {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) return
    chmodSync(p, writable ? st.mode | 0o200 : st.mode & ~0o222)
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e))
  }
  walk(dir)
}

export type PackOptions = { out: string, boardDir: string, product: string, version: string, profile: string, release?: boolean, kinds?: string[], say?: (line: string) => void }

/** Pack and verify every kind of the product; kinds.tsv's rows. */
export function pack(o: PackOptions): string[] {
  const say = o.say ?? ((l: string) => console.log(l))
  const out = realpathSync(o.out), board = realpathSync(o.boardDir)
  const rows = imageKinds(board, o.kinds ?? [])
  const sums = join(out, 'image/SHA256SUMS')
  if (!existsSync(sums) || statSync(sums).size === 0) die(`${sums} does not exist; the image component was not built`)
  const [diskSha = '', diskName = ''] = readFileSync(sums, 'utf8').split('\n')[0]!.split(/\s+/)
  if (diskName === '' || sha256(join(out, 'image', diskName)) !== diskSha) die(`${out}/image/${diskName || '?'} is not the image ${sums} names`)

  // The input directory: the signed canonical image, its partitions and layout, the board tree and the product.
  const input = join(out, 'pack-input')
  const cleanup = () => {
    if (existsSync(input)) { chmodTree(input, true); rmSync(input, { recursive: true, force: true }) }
    rmSync(join(out, 'kinds.tsv.part'), { force: true })
    rmSync(join(out, 'kinds/.twice'), { recursive: true, force: true })
  }
  cleanup()
  rmSync(join(out, 'kinds'), { recursive: true, force: true })
  rmSync(join(out, 'kinds.tsv'), { force: true })
  mkdirSync(input, { recursive: true }); mkdirSync(join(out, 'kinds'), { recursive: true })
  try {
    try { linkSync(join(out, 'image', diskName), join(input, 'disk.img')) }
    catch { cpSync(join(out, 'image', diskName), join(input, 'disk.img')) }
    cpSync(board, join(input, 'board'), { recursive: true, preserveTimestamps: true })
    const layoutVersion = readFileSync(join(board, 'board.env'), 'utf8').split('\n').filter(l => l.startsWith('LAYOUT_VERSION=')).map(l => l.slice('LAYOUT_VERSION='.length)).join('\n')
    splitDisk(input, layoutVersion, o.product, o.version, o.profile)
    chmodTree(input, false)

    const run = (image: string, packer: string, verb: string, outputDir: string, file: string): boolean =>
      Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--user', `${process.getuid!()}:${process.getgid!()}`,
        '-v', `${hostPath(input)}:/input:ro`, '-v', `${hostPath(outputDir)}:/output`, image, `/input/board/${packer}`, verb, '/input', `/output/${file}`], { stdout: 'inherit', stderr: 'inherit' }).exitCode === 0
    const records = inputs()
    const table: string[] = []
    for (const r of rows) {
      const file = `mica-${o.product}-${o.version}.${r.suffix}`
      const path = join(out, 'kinds', file)
      if (r.packer === 'builtin') {
        try { linkSync(join(input, 'disk.img'), path) }
        catch { cpSync(join(input, 'disk.img'), path) }
      }
      else {
        const packerPath = join(board, r.packer)
        if (!existsSync(packerPath) || !statSync(packerPath).isFile() || (statSync(packerPath).mode & 0o111) === 0) die(`the ${r.kind} packer ${r.packer} is no executable file of the board's packer component`)
        const image = fromResolve(r.runtime, records)
        if (!run(image, r.packer, 'pack', join(out, 'kinds'), file)) die(`the ${r.kind} packer failed to pack ${file} (see above)`)
        if (!existsSync(path)) die(`the ${r.kind} packer wrote no ${file}`)
        if (!run(image, r.packer, 'verify', join(out, 'kinds'), file)) die(`the ${r.kind} packer's verify refused ${file}: its bytes on storage are not disk.img (see above)`)
        if (o.release) {
          mkdirSync(join(out, 'kinds/.twice'), { recursive: true })
          if (!run(image, r.packer, 'pack', join(out, 'kinds/.twice'), file)) die(`the second ${r.kind} pack of ${file} failed (see above)`)
          if (Buffer.compare(readFileSync(path), readFileSync(join(out, 'kinds/.twice', file))) !== 0) die(`the ${r.kind} packer is not deterministic: two packs of ${file} differ`)
          rmSync(join(out, 'kinds/.twice'), { recursive: true, force: true })
        }
      }
      if (o.release && statSync(path).size > MAX_ASSET) die(`${file} is ${statSync(path).size} bytes, over the 2 GiB a release asset may be`)
      table.push(`${r.kind}\tkinds/${file}\t${sha256(path)}`)
      say(`image-kinds: ${r.kind} -> kinds/${file}`)
    }
    writeFileSync(join(out, 'kinds.tsv.part'), table.map(l => `${l}\n`).join(''))
    renameSync(join(out, 'kinds.tsv.part'), join(out, 'kinds.tsv'))
    return table
  }
  finally { cleanup() }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv
    if (cmd === 'updates' || cmd === 'kinds') {
      if (rest.length < 1 || !existsSync(rest[0]!) || !statSync(rest[0]!).isDirectory()) die(`usage: image-kinds ${cmd} <board dir> [<kind>...]`)
      await Bun.write(Bun.stdout, render(cmd === 'kinds' ? imageKinds(rest[0]!, rest.slice(1)) : updateKinds(rest[0]!, rest.slice(1))))
      return 0
    }
    if (cmd === 'pack') {
      if (rest.length < 5) die('usage: image-kinds pack <product out> <board dir> <product> <version> <profile> [--release] [<kind>...]')
      const [out, boardDir, product, version, profile] = rest as [string, string, string, string, string]
      let more = rest.slice(5), release = false
      if (more[0] === '--release') { release = true; more = more.slice(1) }
      pack({ out, boardDir, product, version, profile, release, kinds: more })
      return 0
    }
    die('usage: image-kinds kinds|updates <board dir> [<kind>...] | pack <product out> <board dir> <product> <version> <profile> [--release] [<kind>...]')
  }
  catch (e) {
    if (e instanceof ImageKindsError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused', 'ProductError'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
