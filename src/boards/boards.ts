// The supported boards (boards/boards.tsv, one row per board) and what a release of each outputs
// (boards/<board>/outputs.tsv, which travels in its board component).
//
//   bun src/cli.ts boards list                                   the boards, one per line
//   bun src/cli.ts boards arch|boot <board>                      its architecture, its boot backend
//   bun src/cli.ts boards packages <board>                       the archives of its pool
//   bun src/cli.ts boards components <board>                     the components its outputs.tsv names files of
//   bun src/cli.ts boards files <board> <component>              that component's files
//   bun src/cli.ts boards producers <board>                      the rows of src/cli.ts producers that build its packages
//   bun src/cli.ts boards check                                  both files' form, and that they are the tree's
//   bun src/cli.ts boards component-is <board> <component> <dir> <dir> holds exactly that component's files
//   bun src/cli.ts boards bundle-is <board> <dir>               <dir> holds exactly the board's WHOLE bundle: every
//                                                              file row of outputs.tsv, whatever its component.
//                                                              This is the shape a consumer FETCHES -- the board
//                                                              component's files at the root, kernel/, uboot/ and
//                                                              firmware/ beside them -- and the shape `make offline`
//                                                              must assemble, so that a consumer building from source
//                                                              and one building from a release read the same thing.
//   bun src/cli.ts boards pool-has <board> <pool dir>            <pool dir> holds exactly one archive of each of its
//                                                              packages (a pool built for every board holds others' too)
//
// boards.tsv: `# mica-boards boards v1`, then <board> TAB <arch> TAB <boot backend>, sorted by board.
// outputs.tsv: `# mica-boards board outputs v1`, then `package TAB <package>` and `file TAB <component> TAB
// <path>` rows, sorted by kind, then value; a component is board, kernel, uboot or firmware. The port of
// tools/boards.sh (deleted 2026-09-23), message for message.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { discover, row as producerRow, type Producer, REPO_ROOT } from '../pool/producers.ts'
import { list as componentList } from './component.ts'

export class BoardsError extends Error {}

export const BOARDS_LIST: string = process.env.MICA_BOARDS_LIST || join(REPO_ROOT, 'boards/boards.tsv')

export type Board = { name: string, arch: string, boot: string }

function die(message: string): never {
  throw new BoardsError(`boards: error: ${message}`)
}

/** The rows of boards.tsv, comment lines dropped. */
export function boards(list = BOARDS_LIST): Board[] {
  if (!existsSync(list)) die(`${list} does not exist`)
  return readFileSync(list, 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map((l) => {
    const [name = '', arch = '', boot = ''] = l.split('\t')
    return { name, arch, boot }
  })
}

/** One board, or a refusal naming the list. */
export function board(name: string, list = BOARDS_LIST): Board {
  const b = boards(list).find(x => x.name === name)
  if (b === undefined) die(`${list} lists no board ${name}`)
  return b
}

/** The rows of a board's outputs.tsv, comment lines dropped. */
export function outputs(name: string, list = BOARDS_LIST): string[][] {
  const f = join(dirname(list), name, 'outputs.tsv')
  if (!existsSync(f)) die(`${f} does not exist; a listed board states what its release outputs`)
  return readFileSync(f, 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t'))
}

export function packages(name: string, list = BOARDS_LIST): string[] {
  return outputs(name, list).filter(r => r[0] === 'package').map(r => r[1]!)
}

export function files(name: string, component: string, list = BOARDS_LIST): string[] {
  return outputs(name, list).filter(r => r[0] === 'file' && r[1] === component).map(r => r[2]!)
}

/** The components the outputs.tsv names files of, each once, in order (uniq). */
export function components(name: string, list = BOARDS_LIST): string[] {
  const out: string[] = []
  for (const r of outputs(name, list)) if (r[0] === 'file' && out.at(-1) !== r[1]) out.push(r[1]!)
  return out
}

/** The producers building the board's packages, in discovery order. */
export function producersOf(name: string, all = discover(), list = BOARDS_LIST): Producer[] {
  const wanted = packages(name, list)
  return all.filter(p => p.packages.some(pkg => wanted.includes(pkg)))
}

/** LF text with a final LF, a first line, no empty line. */
function textFile(path: string, header: string): void {
  const text = readFileSync(path, 'utf8')
  if (text.split('\n')[0] !== header) die(`${path}: line 1 is not '${header}'`)
  if (!text.endsWith('\n') || text.includes('\r')) die(`${path} is not LF text with a final LF`)
  if (text.slice(0, -1).split('\n').some(l => l === '')) die(`${path} has an empty line`)
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e), st = lstatSync(p)
    if (st.isDirectory()) out.push(...walk(p, `${rel}${e}/`))
    else if (st.isFile() || st.isSymbolicLink()) out.push(`${rel}${e}`)
  }
  return out
}

function diffLines(expected: string[], got: string[]): string {
  const e = new Set(expected), g = new Set(got)
  return [...expected.filter(x => !g.has(x)).map(x => `missing ${x}`), ...got.filter(x => !e.has(x)).map(x => `unexpected ${x}`)].join(';') + ';'
}

/** Both files' form, and that they are the tree's. */
export function check(list = BOARDS_LIST): string {
  const boardsDir = dirname(list)
  textFile(list, '# mica-boards boards v1')
  const rows = boards(list)
  const bad = rows.filter(b => !/^[a-z0-9][a-z0-9-]*$/.test(b.name) || !/^(amd64|arm64)$/.test(b.arch) || b.boot === '')
  const raw = readFileSync(list, 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#'))
  if (bad.length > 0 || raw.some(l => l.split('\t').length !== 3)) die(`${list} has rows that are not <board> TAB <amd64|arm64> TAB <boot backend>: ${raw.filter(l => l.split('\t').length !== 3 || bad.some(b => l.startsWith(b.name + '\t'))).join(';')};`)
  const names = rows.map(b => b.name)
  if ([...names].sort().join('\n') !== names.join('\n') || new Set(names).size !== names.length) die(`${list} is not sorted by board, or names a board twice`)
  for (const e of readdirSync(join(REPO_ROOT, 'boards'))) {
    if (!existsSync(join(REPO_ROOT, 'boards', e, 'board.env'))) continue
    if (!names.includes(e)) die(`boards/${e}/ is not in ${list}; a board directory is supported only when listed`)
  }
  const all = discover()
  for (const b of rows) {
    const env = join(REPO_ROOT, 'boards', b.name, 'board.env')
    if (!existsSync(env)) die(`${list} lists ${b.name}, and boards/${b.name}/board.env does not exist`)
    const text = readFileSync(env, 'utf8')
    const value = (key: string) => text.split('\n').filter(l => l.startsWith(`${key}=`)).map(l => l.slice(key.length + 1)).join('\n')
    if (value('MICA_ARCH') !== b.arch) die(`${list} lists ${b.name} as ${b.arch}; boards/${b.name}/board.env says MICA_ARCH=${value('MICA_ARCH')}`)
    if (value('BOOT_BACKEND') !== b.boot) die(`${list} lists ${b.name} as ${b.boot}; boards/${b.name}/board.env says BOOT_BACKEND=${value('BOOT_BACKEND')}`)
    const f = join(boardsDir, b.name, 'outputs.tsv')
    if (!existsSync(f)) die(`${f} does not exist; a listed board states what its release outputs`)
    textFile(f, '# mica-boards board outputs v1')
    const out = outputs(b.name, list)
    const wrong = out.filter(r => !((r[0] === 'package' && r.length === 2 && r[1] !== '') || (r[0] === 'file' && r.length === 3 && /^(board|kernel|uboot|firmware)$/.test(r[1]!) && r[2] !== '')))
    if (wrong.length > 0) die(`${f} has rows that are not package TAB <package> or file TAB <board|kernel|uboot|firmware> TAB <path>: ${wrong.map(r => r.join('\t')).join(';')};`)
    const keys = out.map(r => `${r[0] === 'package' ? 0 : 1}\t${r[1]}\t${r[2] ?? ''}`)
    const sorted = [...keys].sort((x, y) => { const [a1, a2, a3] = x.split('\t'), [b1, b2, b3] = y.split('\t'); return Number(a1) - Number(b1) || (a2! < b2! ? -1 : a2! > b2! ? 1 : 0) || (a3! < b3! ? -1 : a3! > b3! ? 1 : 0) })
    if (sorted.join('\n') !== keys.join('\n') || new Set(keys).size !== keys.length) die(`${f} is not sorted by kind, then value, or repeats a row`)
    const paths = out.filter(r => r[0] === 'file').map(r => r[2]!)
    if (new Set(paths).size !== paths.length) die(`${f} names a path in two components`)
    const pkgs = packages(b.name, list)
    if (!pkgs.includes(`mica-board-${b.name}`)) die(`${f} lists no package mica-board-${b.name}`)
    for (const p of pkgs)
      if (!all.some(pr => pr.packages.includes(p) && (pr.arches.includes(b.arch) || pr.arches.includes('all')))) die(`${f} lists ${p}, and no producer builds ${p} for ${b.arch}`)

    const have = [...components(b.name, list)].sort(), want = [...componentList(b.name)].sort()
    if (have.join(' ') !== want.join(' ')) die(`${f} names files of the components ${have.join(' ')} but ${b.name} has ${want.join(' ')} (src/boards/component.ts)`)
    const c = files(b.name, 'board', list)
    for (const p of ['board.env', 'images.tsv', 'manifests/board.pkgs', 'outputs.tsv', 'trust/verity-signer.cert.pem']) if (!c.includes(p)) die(`${f} lists no board file ${p}`)
    if (c.some(p => /^(kernel|uboot|uboot-package|firmware)\//.test(p) || p === 'component-copyright')) die(`${f} lists a kernel, uboot or firmware file in the board component`)
    const k = files(b.name, 'kernel', list)
    if (k.some(p => !p.startsWith('kernel/'))) die(`${f} lists a kernel component file outside kernel/`)
    if (b.boot === 'uboot-fit') {
      for (const p of ['kernel/dev/kernel.release', 'kernel/prod/kernel.release']) if (!k.includes(p)) die(`${f}: a FIT board lists no ${p}`)
      if (k.some(p => /^kernel\/[^/]*$/.test(p))) die(`${f}: a FIT board lists kernel files outside kernel/dev/ and kernel/prod/`)
    }
    else if (!k.includes('kernel/kernel.release')) { die(`${f} lists no kernel/kernel.release`) }
    if (files(b.name, 'uboot', list).some(p => !/^uboot(-package)?\//.test(p))) die(`${f} lists a uboot component file outside uboot/ and uboot-package/`)
    if (files(b.name, 'firmware', list).some(p => !/^firmware\//.test(p) && p !== 'component-copyright')) die(`${f} lists a firmware component file outside firmware/ and component-copyright`)
  }
  return `boards: ${list} lists ${rows.length} board(s), and they and their outputs.tsv are the tree's`
}

/** <dir> holds exactly the component's files its outputs.tsv lists. */
export function componentIs(name: string, component: string, dir: string, list = BOARDS_LIST): void {
  board(name, list)
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) die(`${dir} is not a directory`)
  const expected = [...files(name, component, list)].sort(), got = walk(dir).filter(p => !lstatSync(join(dir, p)).isSymbolicLink()).sort()
  if (expected.join('\n') !== got.join('\n')) die(`${dir} is not the ${name} ${component} component its outputs.tsv lists: ${diffLines(expected, got)}`)
}

/** <dir> holds exactly the board's whole bundle: every file row of outputs.tsv. */
export function bundleIs(name: string, dir: string, list = BOARDS_LIST): void {
  board(name, list)
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) die(`${dir} is not a directory`)
  const expected = [...outputs(name, list).filter(r => r[0] === 'file').map(r => r[2]!)].sort(), got = walk(dir).sort()
  if (expected.join('\n') !== got.join('\n')) die(`${dir} is not the ${name} bundle its outputs.tsv lists: ${diffLines(expected, got)}`)
}

/** <pool dir> holds exactly one archive of each of the board's packages. */
export function poolHas(name: string, pool: string, list = BOARDS_LIST): void {
  board(name, list)
  if (!existsSync(pool) || !lstatSync(pool).isDirectory()) die(`${pool} is not a directory`)
  for (const p of packages(name, list))
    if (readdirSync(pool).filter(f => f.startsWith(`${p}_`) && f.endsWith('.deb')).length !== 1) die(`${pool} does not hold exactly one ${p} archive; the ${name} pool its outputs.tsv lists needs it`)
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, a, b, c] = argv
    const key = `${cmd ?? ''}:${argv.length}`
    let out = ''
    if (key === 'list:1') { out = boards().map(x => x.name + '\n').join('') }
    else if (key === 'arch:2') { out = board(a!).arch + '\n' }
    else if (key === 'boot:2') { out = board(a!).boot + '\n' }
    else if (key === 'packages:2') { board(a!); out = packages(a!).map(x => x + '\n').join('') }
    else if (key === 'components:2') { board(a!); out = components(a!).map(x => x + '\n').join('') }
    else if (key === 'files:3') { board(a!); out = files(a!, b!).map(x => x + '\n').join('') }
    else if (key === 'check:1') { out = check() + '\n' }
    else if (key === 'component-is:4') { componentIs(a!, b!, c!) }
    else if (key === 'bundle-is:3') { bundleIs(a!, b!) }
    else if (key === 'pool-has:3') { poolHas(a!, b!) }
    else if (key === 'producers:2') { board(a!); out = producersOf(a!).map(p => producerRow(p) + '\n').join('') }
    else { die('usage: boards list | arch|boot|packages|components|producers <board> | files <board> <component> | check | component-is <board> <component> <dir> | bundle-is <board> <dir> | pool-has <board> <pool dir>') }
    await Bun.write(Bun.stdout, out)
    return 0
  }
  catch (e) {
    if (e instanceof BoardsError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['ProducersError', 'ComponentError'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
