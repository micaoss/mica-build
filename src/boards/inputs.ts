// The inputs hash of a board component: sha256 over a sorted manifest of everything that determines its bytes.
// A release reuses a published component whose mica.inputs annotation equals it, instead of building it again.
//
//   bun src/cli.ts board-inputs <board> <component>            the hash
//   bun src/cli.ts board-inputs --manifest <board> <component> the manifest it is taken over
//
// Manifest lines are `<kind> <name> <value>`: `file <path> <sha256>` for a tracked file (paths under
// boards/<board>/ are recorded without the board's directory, and the board's Makefile without its BOARD
// line, so two boards with identical inputs hash alike), `pin` rows of locks/ without their board-named key,
// `cert` the sha256 of a trust certificate, `builder` the architecture that builds it. The set is
// deliberately wide: a file that might matter is in it, since a missed input would reuse a stale component
// and an extra one only rebuilds.
//
//   kernel    boards/<board>/kernel/, bsp.env, Makefile, board.env's BOARD_CMDLINE_ARGS and MICA_ARCH,
//             common/kernel/, common/scripts/, common/trust/, the kernel git row, the mica-build-env bsp image
//             row (the toolchain), the verity certificate, the builder
//   uboot     boards/<board>/loader/, bsp.env, Makefile, common/uboot/, common/scripts/, common/trust/, the uboot
//             and rkbin git rows, the board's source rows, the bsp and debian image rows, the boot certificate,
//             the builder
//   firmware  boards/<board>/firmware/ and board.env's BOARD_FIRMWARE_FILES
//   board     board.env, evidence.json, images.tsv, manifests/, outputs.tsv, the verity certificate
//
// VERITY_TRUST_CERT and FIT_TRUST_CERT name the certificates (default meta/verity/ and
// meta/boot/signer.cert.pem). The builder is the runner a release builds on: the board's architecture for
// its kernel (native), amd64 for U-Boot (whose FIT host tools the assembly runs on x86-64). The port of
// tools/inputs.sh (deleted 2026-09-23), line for line.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolve as resolveImage } from '../locks/from.ts'
import { inputs as lockInputs, type Records } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { board } from './boards.ts'
import { list as componentList } from './component.ts'

export class InputsError extends Error {}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** `file <path> <sha256>` for the tracked files under the paths, board paths without boards/<board>/. */
function files(boardDir: string, paths: string[]): string[] {
  const r = Bun.spawnSync(['git', '-C', REPO_ROOT, 'ls-files', '-z', '--', ...paths], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new InputsError(`inputs: error: git ls-files failed: ${r.stderr.toString().trim()}`)
  return r.stdout.toString().split('\0').filter(f => f !== '').map((f) => {
    if (f === `${boardDir}/Makefile`) {
      // Without its BOARD line, as grep -v left it: every kept line with its newline.
      const text = readFileSync(join(REPO_ROOT, f), 'utf8')
      return `file Makefile ${sha256(text.split('\n').filter(l => !l.startsWith('BOARD := ')).join('\n') + (text.endsWith('\n') ? '' : '\n'))}`
    }
    if (f.startsWith(`${boardDir}/`)) return `file ${f.slice(boardDir.length + 1)} ${sha256(readFileSync(join(REPO_ROOT, f)))}`
    return `file ${f} ${sha256(readFileSync(join(REPO_ROOT, f)))}`
  })
}

export type Certs = { verity?: string, fit?: string }

/** The manifest lines, sorted; <certs> the certificates (VERITY_TRUST_CERT and FIT_TRUST_CERT, else meta/). */
export function manifest(name: string, component: string, records: Records = lockInputs(), certs: Certs = {}): string[] {
  const arch = board(name).arch
  if (!componentList(name).includes(component)) throw new InputsError(`inputs: error: ${name} has no ${component} component`)
  const b = `boards/${name}`
  const boardEnv = readFileSync(join(REPO_ROOT, b, 'board.env'), 'utf8')
  const envValue = (key: string) => `env ${key} ${boardEnv.split('\n').filter(l => l.startsWith(`${key}=`)).map(l => l.slice(key.length + 1)).join('\n')}`
  const upstream = readFileSync(join(REPO_ROOT, 'locks/upstream.lock'), 'utf8').split('\n').map(l => l.split('\t'))
  const gitRow = (what: string) => upstream.filter(r => r[0] === 'git' && r[1] === `${name}-${what}`).map(r => `pin git-${what} ${r[2]} ${r[3]} ${r[4]}`)
  const sourceRows = () => upstream.filter(r => r[0] === 'source' && r[1]!.startsWith(`${name}-`)).map(r => `pin source-${r[1]!.slice(name.length + 1)} ${r[2]} ${r[3]} ${r[4]} ${r[5]}`)
  const imageRow = (image: string) => `pin image-${image} ${resolveImage(`upstream:${image}`, records)}`
  // The toolchain is an image now: its digest is the pin (mica-build-env bsp).
  const bspRow = () => `pin image-bsp ${resolveImage('mica-build-env:bsp', records)}`
  const cert = (kind: string, file: string) => {
    if (!existsSync(file)) throw new InputsError(`inputs: error: ${file} does not exist; the ${kind} certificate is an input of the ${component} component`)
    return `cert ${kind} ${sha256(readFileSync(file))}`
  }
  const at = (p: string) => (isAbsolute(p) ? p : join(REPO_ROOT, p))
  const verity = at(certs.verity || process.env.VERITY_TRUST_CERT || 'meta/verity/signer.cert.pem'), fit = at(certs.fit || process.env.FIT_TRUST_CERT || 'meta/boot/signer.cert.pem')
  const lines = [`component ${component}`]
  if (component === 'kernel') {
    lines.push(...files(b, [`${b}/kernel`, `${b}/bsp.env`, `${b}/Makefile`, 'common/kernel', 'common/scripts', 'common/trust']))
    lines.push(envValue('BOARD_CMDLINE_ARGS'), envValue('MICA_ARCH'), ...gitRow('kernel'), bspRow(), cert('verity', verity), `builder ${arch}`)
  }
  else if (component === 'uboot') {
    lines.push(...files(b, [`${b}/loader`, `${b}/bsp.env`, `${b}/Makefile`, 'common/uboot', 'common/scripts', 'common/trust']))
    // U-Boot is cross-compiled on x86-64 for every board: it ships FIT host tools the assembly runs on x86-64.
    lines.push(...gitRow('uboot'), ...gitRow('rkbin'), ...sourceRows(), bspRow(), imageRow('debian:trixie-slim'), cert('boot', fit), 'builder amd64')
  }
  else if (component === 'firmware') {
    lines.push(...files(b, [`${b}/firmware`]), envValue('BOARD_FIRMWARE_FILES'))
  }
  else if (component === 'board') {
    lines.push(...files(b, [`${b}/board.env`, `${b}/evidence.json`, `${b}/images.tsv`, `${b}/manifests`, `${b}/outputs.tsv`]), cert('verity', verity))
  }
  return lines.sort()
}

export function hash(name: string, component: string, records: Records = lockInputs(), certs: Certs = {}): string {
  return sha256(manifest(name, component, records, certs).map(l => l + '\n').join(''))
}

export async function main(argv: string[]): Promise<number> {
  try {
    let mode = 'hash'
    if (argv[0] === '--manifest') { mode = 'manifest'; argv = argv.slice(1) }
    if (argv.length !== 2) throw new InputsError('inputs: error: usage: board-inputs [--manifest] <board> <component>')
    if (mode === 'manifest') await Bun.write(Bun.stdout, manifest(argv[0]!, argv[1]!).map(l => l + '\n').join(''))
    else console.log(hash(argv[0]!, argv[1]!))
    return 0
  }
  catch (e) {
    if (e instanceof InputsError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['BoardsError', 'ComponentError', 'ProducersError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
