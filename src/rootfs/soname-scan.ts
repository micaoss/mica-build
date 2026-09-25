// Every shared-object name a carried binary mentions, against what the root carries.
//
//   bun src/cli.ts soname-scan <product>        (make os-soname-scan PRODUCT=<name>)
//
// THE QUESTION THE COMPOSER CANNOT ANSWER. Its declaration model proves a path by package ownership and keeps a
// library by DT_NEEDED; NEITHER SEES A RUNTIME LOAD BY NAME. /usr/bin/stdbuf is carried and
// /usr/libexec/coreutils/libstdbuf.so -- the object it exists to LD_PRELOAD -- was dropped, so the tool runs, exits
// zero and silently does not buffer. This scan keys on the NAME rather than on the mechanism, so it covers dlopen,
// LD_PRELOAD and exec-with-environment alike. IT IS A NECESSARY CONDITION AND NOT A PROOF: a name assembled at run
// time (openssl's providers, read from a directory) is invisible to it.
//
// tests/fixtures/runtime-sonames.json holds the classes of names that are absent ON PURPOSE, each with the reason
// that explains every member. UNEXPLAINED IS THE FINDING. The root is unpacked with the tools that packed it; the
// scan and the report are here. The port of tests/gates/runtime-soname-scan.sh (deleted 2026-09-25) and its two
// inline Python programs, report line for report line.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'

export class SonameScanError extends Error {}

const NAME = /lib[A-Za-z0-9._+-]{1,40}\.so(?:\.[0-9]+){0,3}/g

function isElf(path: string): boolean {
  const fd = openSync(path, 'r')
  try { const b = Buffer.alloc(4); return readSync(fd, b, 0, 4, 0) === 4 && b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) }
  finally { closeSync(fd) }
}

/** name, carried|absent, up to three binaries naming it: the rows the scan of an unpacked root yields. */
export function scanRoot(root: string): string[][] {
  const carried = new Set<string>(), mentions = new Map<string, Set<string>>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name), s = lstatSync(p)
      carried.add(name)
      if (s.isDirectory()) { walk(p); continue }
      if (!s.isFile()) continue
      let elf = false
      try { elf = isElf(p) }
      catch { continue }
      if (!elf) continue
      const text = readFileSync(p).toString('latin1')
      for (const m of new Set(text.match(NAME) ?? [])) {
        if (!mentions.has(m)) mentions.set(m, new Set())
        mentions.get(m)!.add(`/${relative(root, p)}`)
      }
    }
  }
  walk(root)
  return [...mentions.keys()].sort().map(n => [n, carried.has(n) ? 'carried' : 'absent', [...mentions.get(n)!].sort().slice(0, 3).join(';')])
}

type Classes = Record<string, { reason: string, names: string[] }>

/** The report over the rows, and the count of unexplained names. */
export function report(rows: string[][], classes: Classes, product: string): { lines: string[], unexplained: number } {
  const known = new Map<string, string>()
  for (const [title, body] of Object.entries(classes)) for (const n of body.names) known.set(n, title)
  const absent = rows.filter(r => r[1] === 'absent')
  const counts = new Map<string, number>(), unexplained: string[][] = []
  for (const [name, , where] of absent) {
    const title = known.get(name!)
    if (title === undefined) unexplained.push([name!, where ?? ''])
    else counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const lines = [`soname scan: ${rows.length} name(s) mentioned by ${product}'s binaries, ${absent.length} not carried`]
  for (const title of [...counts.keys()].sort()) lines.push(`  ${String(counts.get(title)).padStart(3)} explained: ${title} -- ${classes[title]!.reason}`)
  for (const [name, where] of unexplained) lines.push(`  UNEXPLAINED: ${name}, named by ${where}`)
  lines.push(`RESULT: ${unexplained.length} unexplained name(s) of ${absent.length} absent`)
  return { lines, unexplained: unexplained.length }
}

export function main(argv: string[]): number {
  const product = argv[0]
  if (product === undefined || argv.length !== 1) { console.error('usage: bun src/cli.ts soname-scan <product>'); return 2 }
  const root = join(REPO_ROOT, '_out/products', product, 'root/rootfs.img')
  const built = join(REPO_ROOT, '_out/products', product, 'build/rootfs-report.runtime.json')
  if (!existsSync(root)) { console.error(`error: ${root} does not exist; build the product first (make product PRODUCT=${product})`); return 1 }
  // THE SIGNED ROOT IS WRITTEN BY `make product`; `make os-rootfs` REFRESHES ONLY build/. A compose followed by a
  // scan would read the PREVIOUS product's root and answer about it without saying so.
  if (existsSync(built) && statSync(built).mtimeMs > statSync(root).mtimeMs) {
    console.error(`error: ${root} is older than ${built}; this scan would answer about the PREVIOUS product build. Run: make product PRODUCT=${product}`)
    return 1
  }
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  const work = mkdtempSync(join(REPO_ROOT, '_out/soname-scan.'))
  try {
    // mica-build-side: container -- the root is unpacked with the tools that packed it.
    const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none',
      '-v', `${hostPath(join(REPO_ROOT, '_out/products', product, 'root'))}:/r:ro`, '-v', `${hostPath(work)}:/w`,
      process.env.MICA_BOOT_TOOLS_IMAGE || 'ai-agent/mica-boot-tools-amd64', 'unsquashfs', '-d', '/w/root', '/r/rootfs.img'], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new SonameScanError(`error: unsquashfs could not unpack ${root}: ${r.stderr.toString().trim()}`)
    const classes = (JSON.parse(readFileSync(join(REPO_ROOT, 'tests/fixtures/runtime-sonames.json'), 'utf8')) as { classes: Classes }).classes
    for (const l of report(scanRoot(join(work, 'root')), classes, product).lines) console.log(l)
    return 0
  }
  catch (e) {
    if (e instanceof SonameScanError) { console.error(e.message); return 1 }
    throw e
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
