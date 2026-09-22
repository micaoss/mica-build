// A Debian binary archive, read without dpkg: the host carries no dpkg (mica:docs/design/build.md section 0),
// and the host-toolchain lint keeps it that way.
//
//   bun src/cli.ts deb control <archive.deb>                  the whole control file
//   bun src/cli.ts deb control <archive.deb> Field [Field...] one value per line, empty when absent
//   bun src/cli.ts deb member <archive.deb> <path> [<out>]    one payload member (as installed, e.g.
//                                                            usr/share/mica-podman/upstream.lock) to <out> or stdout
//
// A .deb is an `ar` archive whose control.tar.* member holds ./control and whose data.tar.* member holds the
// payload; gzip, xz and uncompressed are read (what dpkg-deb writes), anything else is refused by name. A path
// the payload does not carry, a directory or a symlink is a refusal by name: the callers compare what an imported
// archive holds with what this tree commits, and "nothing" must never stand in for a file.
//
// The port of tools/deb/control-fields.py and tools/deb-member.py (deleted 2026-09-22).
import { XzReadableStream } from 'xz-decompress'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

class Exit extends Error {}

function* arMembers(path: string): Generator<[string, Uint8Array]> {
  const data = new Uint8Array(readFileSync(path))
  const ascii = (a: number, b: number) => new TextDecoder('ascii').decode(data.subarray(a, b))
  if (ascii(0, 8) !== '!<arch>\n') throw new Exit(`error: ${path} is not an ar archive, so not a Debian binary package`)
  let at = 8
  while (at + 60 <= data.length) {
    const name = ascii(at, at + 16).trim().replace(/\/$/, '')
    const size = parseInt(ascii(at + 48, at + 58).trim(), 10)
    yield [name, data.subarray(at + 60, at + 60 + size)]
    at += 60 + size + (size & 1)
  }
}

async function decompress(name: string, body: Uint8Array): Promise<Uint8Array> {
  if (name.endsWith('.gz')) return Bun.gunzipSync(new Uint8Array(body))
  if (name.endsWith('.xz')) return new Uint8Array(await new Response(new XzReadableStream(new Blob([body]).stream())).arrayBuffer())
  return body
}

type TarEntry = { name: string, type: string, mode: number, body: Uint8Array }

/** The entries of an uncompressed tar stream: ustar and GNU headers, long names through the L/K entries. */
function* tarEntries(tar: Uint8Array): Generator<TarEntry> {
  const field = (at: number, len: number) => new TextDecoder('ascii').decode(tar.subarray(at, at + len)).replace(/\0.*$/s, '')
  let at = 0, longName: string | undefined
  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every(b => b === 0)) break
    const name = field(at, 100), mode = parseInt(field(at + 100, 8).trim() || '0', 8), size = parseInt(field(at + 124, 12).trim() || '0', 8)
    const type = field(at + 156, 1) || '0', prefix = field(at + 345, 155)
    const body = tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = new TextDecoder().decode(body).replace(/\0.*$/s, ''); continue }
    if (type === 'K') continue
    const full = longName ?? (prefix ? `${prefix}/${name}` : name)
    longName = undefined
    yield { name: full, type, mode, body }
  }
}

// A tar member name as Python's tarfile reports it: no leading ./, no trailing / on a directory.
function stripDots(name: string): string {
  return name.replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/^\.$/, '')
}

export async function controlText(path: string): Promise<string> {
  for (const [name, body] of arMembers(path)) {
    if (!name.startsWith('control.tar')) continue
    if (name.endsWith('.zst') || name.endsWith('.lz4') || name.endsWith('.bz2'))
      throw new Exit(`error: ${path} compresses its control archive as ${name}; only control.tar, .gz and .xz are read here`)
    for (const entry of tarEntries(await decompress(name, body)))
      if (stripDots(entry.name) === 'control' && entry.type === '0') return new TextDecoder().decode(entry.body)
    throw new Exit(`error: ${path}: ${name} carries no control file`)
  }
  throw new Exit(`error: ${path} carries no control.tar member`)
}

export function controlFields(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  let key: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (key !== undefined) result[key] += '\n' + line
    }
    else if (line) {
      const i = line.indexOf(':')
      key = (i < 0 ? line : line.slice(0, i)).trim()
      result[key] = (i < 0 ? '' : line.slice(i + 1)).trim()
    }
  }
  return result
}

export async function payloadMember(archive: string, wanted: string): Promise<{ body: Uint8Array, mode: number }> {
  for (const [name, body] of arMembers(archive)) {
    if (!name.startsWith('data.tar')) continue
    if (name.endsWith('.zst') || name.endsWith('.lz4') || name.endsWith('.bz2'))
      throw new Exit(`error: ${archive} compresses its payload as ${name}; only data.tar, .gz and .xz are read here`)
    for (const entry of tarEntries(await decompress(name, body))) {
      if (stripDots(entry.name) !== wanted) continue
      if (entry.type !== '0') throw new Exit(`error: ${archive}: ${wanted} is not a regular file in the payload (it is a ${JSON.stringify(entry.type)} entry)`)
      return { body: entry.body, mode: entry.mode }
    }
    throw new Exit(`error: ${archive} carries no ${wanted} in its payload`)
  }
  throw new Exit(`error: ${archive} carries no data.tar member`)
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'control' && argv.length >= 2) {
      const text = await controlText(argv[1]!)
      if (argv.length === 2) { await Bun.write(Bun.stdout, text); return 0 }
      const parsed = controlFields(text)
      for (const name of argv.slice(2)) console.log(parsed[name] ?? '')
      return 0
    }
    if (argv[0] === 'member' && (argv.length === 3 || argv.length === 4)) {
      const { body, mode } = await payloadMember(argv[1]!, argv[2]!.replace(/^\/+/, ''))
      if (argv.length === 4) {
        const out = argv[3]!
        mkdirSync(dirname(out) || '.', { recursive: true })
        writeFileSync(out, body)
        chmodSync(out, mode & 0o777)
      }
      // Written and awaited: process.exit after a process.stdout.write drops what is still buffered.
      else { await Bun.write(Bun.stdout, body) }
      return 0
    }
    console.error('usage: bun src/cli.ts deb control <archive.deb> [Field...] | deb member <archive.deb> <path> [<out>]')
    return 2
  }
  catch (e) {
    if (e instanceof Exit) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
