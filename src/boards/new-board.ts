// A new board, from one that exists: the directory copied, every name rewritten, fresh identities minted,
// nothing else decided.
//
//   bun src/cli.ts new-board <new> --from <existing>
//
// What it does: copies <existing>/ to <new>/ (not its outputs, evidence or the signing symlink), renames the
// files and directories that carry the board's name (the board package and kernel control files, the kernel
// configuration), rewrites the name as a word inside every file, mints a fresh identity code for the GPT and
// filesystem identities (board.env: the 4-hex segment of every 5AC35760-XXXX-... GUID and UUID), a fresh ESP
// volume id where there is one, and sets BOARD_RELEASE_TARGET=0 -- a new board is not a release target until it
// is qualified. What it does not do: decide the hardware. BOARD_FEATURES, the command line, the firmware files,
// the hwinit facts and the kernel configuration are the port's work (mica:docs/boards/porting.md), and
// tests/gates/board-contract-test.sh holds the result to the contract.
//
// A FIT board clones the same way; its kernel and U-Boot builds and bsp.env come along (its source pins are the
// <board>-* rows of locks/upstream.lock, added by hand), and bsp.env names the files to change (the defconfig,
// the device tree, the loader). The port of tools/new-board.sh (deleted 2026-09-25), message for message; the
// copy, the renames and the rewrites are byte-preserving, as cpio and sed were.
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'

export class NewBoardError extends Error {}

function die(message: string): never {
  throw new NewBoardError(`error: ${message}`)
}

const hex = (n: number) => crypto.randomUUID().replace(/-/g, '').slice(0, n).toUpperCase()

/** Every path under `dir`, deepest first, so a directory is renamed after its contents. */
function depthFirst(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (lstatSync(p).isDirectory()) out.push(...depthFirst(p))
    out.push(p)
  }
  return out
}

export function newBoard(next: string, from: string, root = REPO_ROOT, code = hex(4), volume = hex(8)): string {
  const boards = join(root, 'boards')
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(next)) die(`'${next}' is not a board name (lowercase letters, digits and hyphens)`)
  if (!existsSync(join(boards, from, 'board.env'))) {
    const known = readdirSync(boards).filter(d => existsSync(join(boards, d, 'board.env'))).sort()
    die(`${from} is not a board here; the boards are: ${known.map(b => `${b} `).join('')}`)
  }
  const target = join(boards, next)
  if (existsSync(target)) die(`boards/${next}/ exists`)

  // 1. The copy, without what is not source.
  const src = join(boards, from)
  cpSync(src, target, {
    recursive: true, verbatimSymlinks: true, preserveTimestamps: true,
    filter: (p) => {
      const rel = relative(src, p)
      return !['_out', 'meta', 'tmp'].includes(rel) && basename(p) !== 'evidence.json'
    },
  })
  // 2. Paths carrying the name, deepest first.
  for (const p of depthFirst(target)) if (basename(p).includes(from)) renameSync(p, join(dirname(p), basename(p).replaceAll(from, next)))
  // 3. The name inside every file, as a word.
  const word = new RegExp(`\\b${from}\\b`, 'g')
  for (const p of depthFirst(target)) {
    if (!lstatSync(p).isFile()) continue
    const text = readFileSync(p).toString('latin1')
    if (word.test(text)) writeFileSync(p, Buffer.from(text.replace(word, next), 'latin1'))
    word.lastIndex = 0
  }
  // 4. Fresh identities. Every board's GUIDs and filesystem UUIDs share the prefix 5AC35760 and a per-board
  //    4-hex code; the code is what changes.
  const env = join(target, 'board.env')
  let text = readFileSync(env, 'latin1')
  const old = /^DISK_GUID=[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4})-/m.exec(text)?.[1]
  if (old === undefined) die(`${next}/board.env has no DISK_GUID of the form XXXXXXXX-CCCC-...; the identity code could not be replaced`)
  text = text.split('\n').map(l => l
    .replace(new RegExp(`^([A-Z_]+_GUID=[0-9A-F]{8})-${old}-`), `$1-${code}-`)
    .replace(new RegExp(`^([A-Z_]+_FS_UUID=[0-9a-f]{8})-${old.toLowerCase()}-`), `$1-${code.toLowerCase()}-`)
    .replace(/^ESP_FAT_VOLUME_ID=.*/, `ESP_FAT_VOLUME_ID=${volume}`)
    .replace(/^BOARD_RELEASE_TARGET=.*/, 'BOARD_RELEASE_TARGET=0')).join('\n')
  if (!text.includes(code)) die(`no identity was rewritten in ${next}/board.env`)
  writeFileSync(env, text, 'latin1')
  // 5. Nothing to route: the Makefile discovers a board by its board.env.
  return `new-board: ${next}/ created from ${from}/ with identity code ${code} (was ${old}); BOARD_RELEASE_TARGET=0.
  next: edit boards/${next}/board.env (BOARD_FEATURES, the command line, the firmware, hwinit) and boards/${next}/README.md;
        make check                  the contract over every board, ${next} included
        make ${next}-kernel        the kernel, through the board's own kernel/Dockerfile
        make board-pool && make board-package-gate && make board-publish
  then, in the assembly:  make board-add BOARD=${next}  and  make product PRODUCT=${next}-minimal`
}

export function main(argv: string[]): number {
  const [next = '', flag, from = ''] = argv
  if (next === '' || flag !== '--from' || from === '') { console.error('usage: bun src/cli.ts new-board <new> --from <existing>'); return 1 }
  try { console.log(newBoard(next, from)); return 0 }
  catch (e) {
    if (e instanceof NewBoardError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
