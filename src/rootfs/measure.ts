// PLAN-086 S1: measure the root a board actually ships, from the artifact it ships.
//
//   bun src/cli.ts measure-rootfs --product NAME [--keep]
//
// Every later slice of PLAN-086 states its result as a DELTA -- S2 strips debug sections, S3 selects an explicit
// runtime, S4 drops the static hardware database -- and a delta needs a baseline that was measured rather than
// remembered. This is that measurement, and it is a command rather than a paragraph so that the next slice
// re-runs it instead of re-deriving it.
//
// WHAT IT READS: `_out/products/<name>/build/factory-root.oci`, the packed root exported as an OCI image by
// stages/compose/90-pack.Dockerfile. That archive is the tree that went into mksquashfs -- after the tree
// surgery, after the shadow relocation -- so it is the root that ships and not one adjacent to it. The squashfs
// itself would need unsquashfs; the OCI layer is a plain tar.
//
// WHY NOT `du -sxm /` IN THE BUILD, which 90-pack already does for TOTAL_MB: that number is a filesystem's idea
// of occupancy -- block-rounded, and hard links counted differently by different du versions. This counts
// payload bytes with every inode once, and prints the naive sum beside the deduplicated one so the size of the
// hard-link effect is visible rather than assumed.
//
// NOTHING HERE WRITES TO THE IMAGE OR TO THE POOL. It extracts into `_out/products/<name>/build/measure-root/`,
// which it owns and clears on entry, and prints a report to stdout. The ELF sections and the dynamic entries are
// read by src/verify/elf.ts and src/rootfs/runtime/elf.ts, not by readelf. The port of tools/measure-rootfs.sh
// (deleted 2026-09-25), report line for report line; one difference: an empty candidate list counts 0 and prints
// no candidate line, where the shell's `printf | grep -c` counted the empty line as one.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { product, products } from '../product/product.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { version } from '../release/version.ts'
import { elfInfo } from './runtime/elf.ts'
import { isElf, isRemovableDebugSection, readElf } from '../verify/elf.ts'

export class MeasureError extends Error {}

function die(message: string): never {
  throw new MeasureError(`error: ${message}`)
}

type File = { rel: string, key: string, size: number }

/** Every regular file under `root` (not crossing devices), with its inode identity and apparent size. */
function files(root: string, under = ''): File[] {
  const base = join(root, under)
  if (!existsSync(base)) return []
  const dev = statSync(root).dev
  const out: File[] = []
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), r = rel === '' ? name : `${rel}/${name}`, s = lstatSync(p)
      if (s.isDirectory()) { if (s.dev === dev) walk(p, r) }
      else if (s.isFile()) { out.push({ rel: r, key: `${s.dev}:${s.ino}`, size: s.size }) }
    }
  }
  const s = lstatSync(base)
  if (s.isFile()) return [{ rel: under.replace(/^\//, ''), key: `${s.dev}:${s.ino}`, size: s.size }]
  if (s.isDirectory()) walk(base, under.replace(/^\//, ''))
  return out
}

/** One file per inode: the one with the smallest path, as `sort -u -k1,1` kept it. */
function dedup(list: File[]): File[] {
  const byKey = new Map<string, File>()
  for (const f of [...list].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) if (!byKey.has(f.key)) byKey.set(f.key, f)
  return [...byKey.values()]
}

const sum = (list: File[]) => list.reduce((a, f) => a + f.size, 0)
const mib = (b: number) => (b / 1048576).toFixed(2)

function count(root: string, kind: 'l' | 'd'): number {
  const dev = statSync(root).dev
  let n = kind === 'd' ? 1 : 0
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), s = lstatSync(p)
      if (s.isSymbolicLink()) { if (kind === 'l') n++ }
      else if (s.isDirectory() && s.dev === dev) { if (kind === 'd') n++; walk(p) }
    }
  }
  walk(root)
  return n
}

function tarMember(archive: string, member: string): Buffer {
  const r = Bun.spawnSync(['tar', '-xOf', archive, member], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) die(`${archive} carries no ${member}: ${r.stderr.toString().trim()}`)
  return Buffer.from(r.stdout)
}

/** The one layer of the factory root, extracted into `work`; the number of paths it holds. */
function extract(oci: string, work: string): number {
  const blob = (digest: string) => tarMember(oci, `blobs/${digest.replace(':', '/')}`)
  const index = JSON.parse(tarMember(oci, 'index.json').toString()) as { manifests: { digest: string }[] }
  const manifest = JSON.parse(blob(index.manifests[0]!.digest).toString()) as { layers: { digest: string, mediaType: string }[] }
  if (manifest.layers.length !== 1)
    die(`${oci} carries ${manifest.layers.length} layers; factory-root is a single-COPY scratch stage and must have exactly one. Measuring layer 1 alone would report a fraction of the root as the whole of it.`)
  const { digest, mediaType } = manifest.layers[0]!
  const body = blob(digest)
  const layer = mediaType.endsWith('+gzip') ? Bun.gunzipSync(new Uint8Array(body)) : mediaType.endsWith('+zstd') ? Bun.zstdDecompressSync(new Uint8Array(body)) : mediaType.endsWith('tar') ? body : die(`${oci}'s layer is '${mediaType}', which this command cannot open.`)
  const tarFile = `${work}.tar`
  writeFileSync(tarFile, layer)
  try {
    const r = Bun.spawnSync(['tar', '-x', '-C', work, '--numeric-owner', '-f', tarFile], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) die(`the layer of ${oci} did not extract: ${r.stderr.toString().trim()}`)
  }
  finally { rmSync(tarFile, { force: true }) }
  let n = 0
  const walk = (d: string) => { for (const f of readdirSync(d)) { n++; const p = join(d, f); if (lstatSync(p).isDirectory()) walk(p) } }
  walk(work)
  return n
}

const field = (text: string, key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]

export function measure(name: string, keep: boolean): string[] {
  const out = join(REPO_ROOT, '_out/products', name, 'build')
  if (!existsSync(join(out, 'factory-root.oci'))) die(`${join(out, 'factory-root.oci')} does not exist, so there is no packed root to measure. Build it with 'make os-rootfs PRODUCT=${name}'.`)
  return measureBuild(out, product(name).board, join(REPO_ROOT, '_out/boards'), keep)
}

/** The report over one product build directory (its factory-root.oci and the files beside it); `boards` holds
 * the fetched board bundles, whose board.env names the architecture. */
export function measureBuild(out: string, boardName: string, boards: string, keep: boolean): string[] {
  const oci = join(out, 'factory-root.oci')
  const work = join(out, 'measure-root')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const entries = extract(oci, work)
  if (entries <= 1000)
    die(`the extracted root holds ${entries} path(s). Every size below would be a fraction of the real one and every 'is X absent' reading would be true of an empty directory.`)

  const L: string[] = []
  const row = (...cols: (string | number)[]) => L.push(cols.join('\t'))
  const read = (rel: string) => (existsSync(join(work, rel)) ? readFileSync(join(work, rel), 'utf8') : '')

  // ---- identity: the tree's stamp and the root's OWN identity, named apart because they are not one number.
  L.push('== identity ==')
  row('board', boardName)
  row('tree-stamp', version())
  row('root-image-version', (field(read('usr/lib/os-release'), 'IMAGE_VERSION') ?? '').replace(/"/g, ''))
  row('root-image-id', field(read('usr/lib/os-release'), 'IMAGE_ID') ?? '')
  const boardEnv = join(boards, boardName, 'board.env')
  const arch = (field(existsSync(boardEnv) ? readFileSync(boardEnv, 'utf8') : '', 'MICA_ARCH') ?? '').replace(/"/g, '')
  if (arch === '') die(`_out/boards/${boardName}/board.env declares no MICA_ARCH, so the pool this root was composed from cannot be named.`)
  row('arch', arch)
  const poolManifest = join(REPO_ROOT, '_out/debs', arch, 'manifest.txt')
  if (existsSync(poolManifest)) {
    const stamps = [...new Set(readFileSync(poolManifest, 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => (l.split('\t')[1] ?? '').replace(/^.*\+/, '')))].sort()
    row('pool-stamp', stamps.map(s => `${s} `).join(''))
  }
  const verityEnv = join(out, 'rootfs-verity.env')
  if (existsSync(verityEnv)) for (const key of ['SQUASHFS_BYTES', 'IMAGE_BYTES', 'VERITY_ROOT_HASH', 'VERITY_DATA_BLOCKS']) row(key, field(readFileSync(verityEnv, 'utf8'), key) ?? '')
  row('factory-root-sha256', new Bun.CryptoHasher('sha256').update(readFileSync(oci)).digest('hex'))
  row('factory-root-bytes', statSync(oci).size)
  const report = join(out, 'rootfs-report.txt')
  if (existsSync(report)) row('report-TOTAL_MB', /^TOTAL_MB (\S+)/m.exec(readFileSync(report, 'utf8'))?.[1] ?? '')
  const shipped = read('usr/share/mica/manifest.tsv')
  if (existsSync(join(work, 'usr/share/mica/manifest.tsv'))) {
    const lines = shipped.split('\n').slice(0, shipped.endsWith('\n') ? -1 : undefined)
    row('packages-shipped', lines.filter(l => !l.startsWith('#')).length)
    row('packages-local', lines.filter(l => l.startsWith('mica')).length)
  }

  // ---- payload: the inode identity counts a hard-linked file once; the naive sum beside it is the same set
  // without that step, so the difference IS the hard-link effect.
  const all = files(work), inodes = dedup(all)
  L.push('', '== payload (regular files) ==')
  row('regular-file-bytes-dedup', sum(inodes))
  row('regular-file-bytes-naive', sum(all))
  row('regular-file-MiB-dedup', mib(sum(inodes)))
  row('hardlink-saving-bytes', sum(all) - sum(inodes))
  row('regular-files', all.length)
  row('distinct-inodes', inodes.length)
  row('symlinks', count(work, 'l'))
  row('directories', count(work, 'd'))

  L.push('', '== payload by top-level directory (bytes, hard links counted once) ==')
  const top = new Map<string, number>()
  for (const f of inodes) top.set(f.rel.split('/')[0]!, (top.get(f.rel.split('/')[0]!) ?? 0) + f.size)
  for (const [d, b] of [...top].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) row(d, b)

  // ---- named sets, each over the same inode-deduplicated set as the total, so they are subsets of it.
  const setBytes = (...paths: string[]) => paths.reduce((a, path) => a + sum(dedup(files(work, path))), 0)
  const inDirs = (dirs: string[], match: (f: string) => boolean) => dirs.flatMap(d => files(work, d).filter(f => match(f.rel)))

  L.push('', '== static hardware database ==')
  for (const path of ['/usr/lib/udev/hwdb.bin', '/etc/udev/hwdb.bin', '/usr/lib/udev/hwdb.d', '/etc/udev/hwdb.d', '/usr/bin/systemd-hwdb'])
    row(existsSync(join(work, path)) ? 'present' : 'absent', path, existsSync(join(work, path)) ? setBytes(path) : 0)
  row('hwdb-bytes', setBytes('/usr/lib/udev/hwdb.bin', '/etc/udev/hwdb.bin', '/usr/lib/udev/hwdb.d', '/etc/udev/hwdb.d'))
  row('hwdb-source-files', inDirs(['/usr/lib/udev/hwdb.d', '/etc/udev/hwdb.d'], f => f.endsWith('.hwdb')).length)
  const rules = inDirs(['/usr/lib/udev/rules.d', '/etc/udev/rules.d'], () => true)
  row('udev-rules-files', rules.filter(f => f.rel.endsWith('.rules')).length)
  const texts = rules.map(f => readFileSync(join(work, f.rel), 'latin1'))
  row('udev-rules-querying-hwdb', texts.filter(t => t.includes('IMPORT{builtin}="hwdb')).length)
  row('udev-hwdb-query-clauses', texts.reduce((a, t) => a + (t.match(/IMPORT\{builtin\}="hwdb[^"]*"/g)?.length ?? 0), 0))
  row('kernel-module-index-bytes', sum(files(work, '/usr/lib/modules').filter(f => f.rel.split('/').at(-1)!.startsWith('modules.'))))

  L.push('', '== boot inputs retained inside the root ==')
  for (const path of ['/boot', '/usr/lib/mica/board']) row(path, setBytes(path))
  row('boot-bytes', setBytes('/boot', '/usr/lib/mica/board'))

  // ---- ELF sections: `.symtab`/`.strtab` and `.debug*`. Kernel modules are counted SEPARATELY and never folded
  // into the user-space number: stripping a module's symbols breaks loading, so those bytes are not an S2 target.
  L.push('', '== ELF debug and static symbol sections ==')
  let userDebug = 0, modDebug = 0, userElf = 0, modElf = 0
  const needed: string[] = [], sonames: string[] = []
  for (const f of inodes) {
    const path = join(work, f.rel)
    if (!isElf(path)) continue
    let bytes = 0
    try { bytes = readElf(path).sections.filter(s => isRemovableDebugSection(s.name)).reduce((a, s) => a + s.size, 0) }
    catch { bytes = 0 }
    const module = f.rel.startsWith('usr/lib/modules/')
    if (module) { modDebug += bytes; modElf++; continue }
    userDebug += bytes; userElf++
    try {
      const data = new Uint8Array(readFileSync(path))
      const info = elfInfo(data, new DataView(data.buffer).getUint16(18, true), f.rel)
      needed.push(...info.needed)
      if (/\.so(\.|$)/.test(f.rel.split('/').at(-1)!) && info.soname !== null) sonames.push(info.soname)
    }
    catch { /* not a dynamic object this reader takes, as readelf printed nothing for it */ }
  }
  row('user-space-elf-files', userElf)
  row('user-space-debug-bytes', userDebug)
  row('user-space-debug-MiB', mib(userDebug))
  row('kernel-module-elf-files', modElf)
  row('kernel-module-debug-bytes', modDebug)

  // ---- a library with no DT_NEEDED referrer is a CANDIDATE, not proof of dead content.
  L.push('', '== ELF dependency surface ==')
  const neededSet = new Set(needed), shippedSet = [...new Set(sonames)].sort()
  row('distinct-NEEDED-names', neededSet.size)
  row('shipped-SONAMEs', shippedSet.length)
  const unreferenced = shippedSet.filter(s => !neededSet.has(s))
  row('SONAMEs-with-no-DT_NEEDED-referrer', unreferenced.length)
  for (const s of unreferenced) L.push(`  candidate\t${s}`)

  L.push('', '== non-ELF consumer surfaces (file counts) ==')
  for (const path of ['/usr/lib/systemd/system', '/usr/lib/systemd/system-generators', '/etc/systemd/system', '/usr/share/dbus-1', '/etc/dbus-1',
    '/usr/lib/tmpfiles.d', '/usr/lib/sysusers.d', '/etc/pam.d', '/usr/lib/udev/rules.d', '/usr/lib/firmware', '/usr/share/ca-certificates',
    '/usr/share/zoneinfo', '/usr/lib/mica', '/usr/share/doc'])
    row(path, files(work, path).length, setBytes(path))

  L.push('', `measured: ${work} (${entries} paths)`)
  if (!keep) rmSync(work, { recursive: true, force: true })
  return L
}

export function main(argv: string[]): number {
  let name = '', keep = false
  for (let i = 0; i < argv.length;) {
    if (argv[i] === '--product') { name = argv[i + 1] ?? ''; i += 2 }
    else if (argv[i] === '--keep') { keep = true; i++ }
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log('usage: bun src/cli.ts measure-rootfs --product NAME [--keep]\n  the shipped root of a built product, measured from its factory-root.oci: payload, hardware database, boot inputs, ELF sections and dependency surface'); return 0 }
    else { console.error(`error: unknown argument '${argv[i]}'`); return 2 }
  }
  if (name === '') { console.error(`error: --product is required. Products: ${products().join(' ')}`); return 2 }
  try {
    for (const l of measure(name, keep)) console.log(l)
    return 0
  }
  catch (e) {
    if (e instanceof MeasureError) { console.error(e.message); return 1 }
    if (e instanceof Error && e.constructor.name === 'ProductError') { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
