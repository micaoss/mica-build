// A board's components: the trees a release publishes as the OCI artifacts <component>.<board>.<YYYYMMDD-HHMM>,
// out of the board's build (_out/<board>/) and its directory.
//
//   bun src/cli.ts component list <board>                      board, kernel, and uboot and firmware where it has them
//   bun src/cli.ts component stage <board> <component> <dir>   <dir>: exactly the component's files of its outputs.tsv
//
//   board     board.env, evidence.json, images.tsv, manifests/, outputs.tsv, trust/verity-signer.cert.pem
//   kernel    kernel/ from _out/<board>/kernel (a FIT board's kernel/dev/ and kernel/prod/)
//   uboot     uboot/ (and uboot-package/) from the board's loader build, by its FIRMWARE_FORMAT
//   firmware  firmware/<BOARD_FIRMWARE_FILES> and component-copyright
//
// VERITY_TRUST_CERT names the verity certificate the kernel was built against (default
// meta/verity/signer.cert.pem). A staged tree that is not exactly what outputs.tsv lists for the component is
// refused. The port of tools/component.sh (deleted 2026-09-23), message for message.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'
import { board, componentIs } from './boards.ts'

export class ComponentError extends Error {}

function die(message: string): never {
  throw new ComponentError(`component: error: ${message}`)
}

/** The first `KEY=` line of the board's board.env, its value unquoted. */
export function value(name: string, key: string): string {
  const line = readFileSync(join(REPO_ROOT, 'boards', name, 'board.env'), 'utf8').split('\n').find(l => l.startsWith(`${key}=`))
  if (line === undefined) return ''
  const v = line.slice(key.length + 1)
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v.replace(/^"/, '').replace(/"$/, '')
}

/** board, kernel, and uboot and firmware where the board has them. */
export function list(name: string): string[] {
  const out = ['board', 'kernel']
  if (board(name).boot === 'uboot-fit') out.push('uboot')
  if (value(name, 'BOARD_FIRMWARE_FILES') !== '') out.push('firmware')
  return out
}

function install(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  chmodSync(to, 0o644)
}

/** cp -a <from>/. <to>/: the tree with its modes and times, the top directory's mode included. */
function tree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  // The directories' modes and times too, after their contents, which writing them would have touched.
  const times = (src: string, dst: string) => {
    for (const e of readdirSync(src, { withFileTypes: true })) if (e.isDirectory()) times(join(src, e.name), join(dst, e.name))
    const st = statSync(src)
    chmodSync(dst, st.mode & 0o7777)
    utimesSync(dst, st.atime, st.mtime)
  }
  times(from, to)
}

function need(path: string, why: string): void {
  if (!existsSync(path)) die(`${path} does not exist; ${why}`)
}

/** <dir>: exactly the component's files of the board's outputs.tsv; <cert> the verity certificate the board
 * component carries (VERITY_TRUST_CERT, else meta/verity/signer.cert.pem). */
export function stage(name: string, component: string, dir: string, cert = process.env.VERITY_TRUST_CERT || join(REPO_ROOT, 'meta/verity/signer.cert.pem')): void {
  board(name)
  const out = join(REPO_ROOT, '_out', name), src = join(REPO_ROOT, 'boards', name)
  if (!list(name).includes(component)) die(`${name} has no ${component} component`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  if (component === 'board') {
    for (const f of ['board.env', 'outputs.tsv', 'images.tsv']) install(join(src, f), join(dir, f))
    if (existsSync(join(src, 'evidence.json'))) install(join(src, 'evidence.json'), join(dir, 'evidence.json'))
    tree(join(src, 'manifests'), join(dir, 'manifests'))
    need(cert, 'the verity trust certificate the kernel was built against; set VERITY_TRUST_CERT')
    install(cert, join(dir, 'trust/verity-signer.cert.pem'))
  }
  else if (component === 'kernel') {
    need(join(out, 'kernel'), `run 'make ${name}-kernel'`)
    tree(join(out, 'kernel'), join(dir, 'kernel'))
  }
  else if (component === 'uboot') {
    const format = value(name, 'FIRMWARE_FORMAT')
    if (format === 'rockchip-loader') { need(join(out, 'uboot-mica'), `run 'make ${name}-firmware'`); tree(join(out, 'uboot-mica'), join(dir, 'uboot')) }
    else if (format === 'amlogic-boot0') { for (const f of ['uboot', 'uboot-package']) { need(join(out, f), `run 'make ${name}-firmware'`); tree(join(out, f), join(dir, f)) } }
    else { die(`${name} declares FIRMWARE_FORMAT=${format}, which has no uboot component here`) }
  }
  else if (component === 'firmware') {
    mkdirSync(join(dir, 'firmware'), { recursive: true })
    for (const f of value(name, 'BOARD_FIRMWARE_FILES').split(/\s+/).filter(x => x !== '')) {
      const rel = f.replace(/^\/usr\/lib\/firmware\//, '')
      install(join(src, 'firmware', rel), join(dir, 'firmware', rel))
    }
    need(join(src, 'firmware/component-copyright'), 'the copyright of the board\'s firmware files')
    install(join(src, 'firmware/component-copyright'), join(dir, 'component-copyright'))
  }
  componentIs(name, component, dir)
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'list' && argv.length === 2) { board(argv[1]!); await Bun.write(Bun.stdout, list(argv[1]!).map(x => x + '\n').join('')) }
    else if (argv[0] === 'stage' && argv.length === 4) { stage(argv[1]!, argv[2]!, argv[3]!) }
    else { die('usage: component list <board> | stage <board> <component> <dir>') }
    return 0
  }
  catch (e) {
    if (e instanceof ComponentError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['BoardsError', 'ProducersError'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
