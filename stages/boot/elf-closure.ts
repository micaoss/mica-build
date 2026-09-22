// Copy a target ELF closure without executing target-architecture programs.
//
//   bun /tools/elf-closure.ts <runtime> <destination> <x64|aa64> <source> <target>
//
// The ELF file at <source> lands at <destination>/<target>, and with it every shared library it needs and the
// interpreter it names, each found under the target root <runtime> in the loader's directories. The dependencies
// are read with the image's readelf, never by running the binary. The port of elf-closure.py (deleted 2026-09-22),
// rule for rule and message for message.
import { chmodSync, copyFileSync, lstatSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const [runtime, destination, architecture, source, target] = Bun.argv.slice(2) as [string, string, string, string, string]
const ARCHITECTURES: Record<string, [number, string]> = { x64: [62, 'x86_64-linux-gnu'], aa64: [183, 'aarch64-linux-gnu'] }
const arch = ARCHITECTURES[architecture]
if (arch === undefined) throw new Error(`KeyError: '${architecture}'`)
const [machine, triplet] = arch
const pending: [string, string][] = [[source, target]]
const copied = new Set<string>()

function isFile(path: string): boolean {
  try { return lstatSync(path).isFile() }
  catch { return false }
}

function findLibrary(name: string): [string, string] {
  for (const directory of [`usr/lib/${triplet}`, `lib/${triplet}`, `usr/lib/${triplet}/systemd`, 'usr/lib', 'lib']) {
    const candidate = join(runtime, directory, name)
    if (isFile(candidate)) return [candidate, `/${directory}/${name}`]
  }
  throw new Error(`Missing target library: ${name}`)
}

function readelf(flag: string, path: string): string {
  const r = Bun.spawnSync(['readelf', flag, path], { stdout: 'pipe', stderr: 'inherit', timeout: 10000 })
  if (r.exitCode !== 0) throw new Error(`Command '['readelf', '${flag}', '${path}']' returned non-zero exit status ${r.exitCode}.`)
  return r.stdout.toString()
}

while (pending.length > 0) {
  const [from, to] = pending.pop()!
  if (copied.has(to)) continue
  const header = Buffer.alloc(20)
  const fd = openSync(from, 'r')
  const n = readSync(fd, header, 0, 20, 0)
  closeSync(fd)
  if (n < 20 || !header.subarray(0, 6).equals(Buffer.from('\x7fELF\x02\x01', 'latin1')) || header.readUInt16LE(18) !== machine)
    throw new Error(`Wrong ELF architecture: ${from}`)

  const output = join(destination, to.replace(/^\/+/, ''))
  mkdirSync(dirname(output), { recursive: true })
  copyFileSync(from, output)
  chmodSync(output, 0o755)
  copied.add(to)
  for (const m of readelf('-d', from).matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)) pending.push(findLibrary(m[1]!))
  for (const m of readelf('-l', from).matchAll(/\[Requesting program interpreter: ([^\]]+)\]/g)) {
    const [library] = findLibrary(basename(m[1]!))
    pending.push([library, m[1]!])
  }
}
