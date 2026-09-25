// The board bundle every host-time reader consumes, assembled under _out/boards/<board>/.
//
//   bun src/cli.ts board-pool --list               the boards of boards/boards.tsv, one per line
//   bun src/cli.ts board-pool --fetch <board>      the board's bundle, assembled into _out/boards/<board>/
//   bun src/cli.ts board-pool --fetch-all          the same for every board
//   bun src/cli.ts board-pool --check <dir>        the bundle rules over an assembled bundle directory
//   bun src/cli.ts board-pool --kernel-dir <board> <dev|prod>
//                                                 the kernel directory a product of that profile packs
//
//   reads   boards/<board>/ (src/boards/component.ts: the board and firmware components, staged from the tree)
//           _out/<board>/kernel, _out/<board>/uboot* (a local `make <board>-kernel`, `make <board>-firmware`, or a
//                                                     CI job's unpacked outputs: src/release/ci-outputs.ts)
//           this repository's releases (src/boards/reuse.ts: a kernel or uboot component whose inputs hash
//                                       equals the one the latest release published, read by digest,
//                                       src/pool/oci.ts)
//           meta/verity/signer.cert.pem                              (the trust domain this assembly signs with)
//   writes  _out/boards/<board>/{board.env,layout.tsv,evidence.json,images.tsv,manifests/,outputs.tsv,trust/,kernel/,firmware/,
//                                component-copyright,uboot/}
//           _out/cache/boards/<sha256> (the layer cache of reused components; a cached layer is hashed again)
//
// THE BOARD IS THE DIRECTORY boards/<board>/ OF THIS TREE. A board exists exactly when boards/boards.tsv lists
// it; its definition, manifests, flashing formats and firmware files are source of the commit being built, so
// the board and firmware components are staged from the tree. Its kernel and U-Boot are BUILT components: a
// product takes them from a local build of this checkout when one exists under _out/<board>/, and otherwise
// from the latest release of this repository that published them with the same inputs hash
// (src/boards/inputs.ts, mica.inputs), by digest. Neither present is a refusal naming `make <board>-kernel`,
// never a silent build: building a kernel is minutes to hours and is asked for by name.
//
// THE KERNEL DIRECTORY FOLLOWS THE BOOT BACKEND. A uboot-fit board forces its built-in command line, which
// carries the image profile, so its bundle carries kernel/dev/ and kernel/prod/, each a complete kernel
// directory, and no kernel/ files of its own; a systemd-boot board carries one kernel/ whose command line is
// the signed UKI's.
//
// THE BUNDLE SAYS WHAT IT HOLDS. boards/<board>/outputs.tsv (mica-boards board outputs v1: `package <package>`
// rows, the archives of its pool, and `file <component> <path>` rows, the files of each component at their
// assembled paths, outputs.tsv included) is what the assembled bundle must be, file for file (bundle-is).
//
// --fetch refuses a reused component built against another verity trust certificate than
// meta/verity/signer.cert.pem: a kernel that trusts another domain would boot a root this assembly did not
// sign; a local build embeds the certificate it was given (the inputs hash covers it). The port of
// tools/board-pool.sh (deleted 2026-09-23), message for message.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { blob, manifest as ociManifest } from '../pool/oci.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { boards, board as findBoard, bundleIs } from './boards.ts'
import { list as componentList, stage, ComponentError } from './component.ts'
import { hash as inputsHash } from './inputs.ts'
import { reuse } from './reuse.ts'

export class BoardPoolError extends Error {}

const BOARDS_OUT = process.env.MICA_BOARDS_OUT || join(REPO_ROOT, '_out/boards')
const LAYERS = process.env.MICA_BOARD_CACHE || join(REPO_ROOT, '_out/cache/boards')
const TRUST_CERT = process.env.MICA_VERITY_TRUST_CERT || join(REPO_ROOT, 'meta/verity/signer.cert.pem')

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function relative(path: string): string {
  return path.startsWith(REPO_ROOT + '/') ? path.slice(REPO_ROOT.length + 1) : path
}

/** The kernel directories of a bundle, relative to it: kernel/dev and kernel/prod for a uboot-fit board, kernel
 * for a systemd-boot board; undefined when board.env names no such backend. */
export function kernelDirs(dir: string): string[] | undefined {
  const env = join(dir, 'board.env')
  const backend = existsSync(env) ? (readFileSync(env, 'utf8').split('\n').find(l => l.startsWith('BOOT_BACKEND='))?.slice('BOOT_BACKEND='.length) ?? '') : ''
  if (backend === 'uboot-fit') return ['kernel/dev', 'kernel/prod']
  if (backend === 'systemd-boot') return ['kernel']
  return undefined
}

/** The bundle files every reader needs, and the trust check, over a staged directory. */
export function checkBundle(staging: string, what: string): string[] {
  for (const f of ['board.env', 'layout.tsv', 'images.tsv', 'manifests/board.pkgs', 'trust/verity-signer.cert.pem'])
    if (!existsSync(join(staging, f))) throw new BoardPoolError(`error: ${what} carries no ${f}; it is not a board bundle this assembly can read (mica:docs/boards/contract.md section 3)`)

  const dirs = kernelDirs(staging)
  if (dirs === undefined) throw new BoardPoolError(`error: ${what} names no BOOT_BACKEND of systemd-boot or uboot-fit in board.env`)
  for (const d of dirs) {
    for (const f of ['config', 'kernel.release', 'modules.tar'])
      if (!existsSync(join(staging, d, f))) throw new BoardPoolError(`error: ${what} carries no ${d}/${f}; its boot backend needs ${dirs.join(' and ')} as complete kernel directories`)
  }
  if (dirs.length === 1) {
    if (existsSync(join(staging, 'kernel/dev')) || existsSync(join(staging, 'kernel/prod'))) throw new BoardPoolError(`error: ${what} is a systemd-boot bundle with profile kernel directories; its one kernel takes the profile from the signed UKI command line`)
  }
  else if (existsSync(join(staging, 'kernel/config'))) { throw new BoardPoolError(`error: ${what} is a uboot-fit bundle with a kernel/ of its own; its kernels are kernel/dev and kernel/prod only`) }
  if (Buffer.compare(readFileSync(join(staging, 'trust/verity-signer.cert.pem')), readFileSync(TRUST_CERT)) !== 0)
    throw new BoardPoolError(`error: ${what} was built against a verity trust certificate that is not ${relative(TRUST_CERT)}. A kernel that trusts another domain would boot a root this assembly did not sign; build the board's kernel against this assembly's certificate`)
  return dirs
}

type Manifest = { artifactType?: string, annotations?: Record<string, string>, layers?: { digest: string, annotations?: Record<string, string> }[] }

function tar(args: string[]): { code: number, out: string } {
  const r = Bun.spawnSync(['tar', ...args], { stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() }
}

/** A reused component out of the registry, by the digest the reuse answered: every layer verified by digest at
 * its title; firmware.tar unpacks into firmware/. */
async function fetchComponent(board: string, component: string, digest: string, staging: string): Promise<string> {
  const ref = `ghcr.io/micaoss/mica-build@${digest}`
  let m: Manifest
  try { m = JSON.parse(readFileSync(await ociManifest(ref), 'utf8')) as Manifest }
  catch (e) { throw new BoardPoolError(`${e instanceof Error ? e.message : String(e)}\nerror: the ${component} component ${ref} could not be read (see above)`) }
  const a = m.annotations ?? {}, layers = m.layers ?? []
  const title = (l: { annotations?: Record<string, string> }) => l.annotations?.['org.opencontainers.image.title'] ?? ''
  const wellFormed = m.artifactType === `application/vnd.mica.board.${component}` && a['mica.board'] === board && a['mica.component'] === component
    && a['mica.source-repo'] === 'mica-build' && /^[0-9a-f]{40}$/.test(a['mica.source-commit'] ?? '') && /^[0-9a-f]{64}$/.test(a['mica.inputs'] ?? '')
    && layers.length > 0 && layers.every(l => /^sha256:[0-9a-f]{64}$/.test(l.digest) && /^[A-Za-z0-9_+-][A-Za-z0-9._+-]*(\/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*$/.test(title(l)))
    && new Set(layers.map(title)).size === layers.length
  if (!wellFormed) throw new BoardPoolError(`error: ${ref} is not the ${component} component of ${board} from mica-build, or a layer title is not a relative path`)
  const cert = sha256File(TRUST_CERT)
  if ((a['mica.verity-cert-sha256'] ?? cert) !== cert) throw new BoardPoolError(`error: ${ref} was built against a verity trust certificate that is not ${relative(TRUST_CERT)}. A kernel that trusts another domain would boot a root this assembly did not sign`)
  mkdirSync(LAYERS, { recursive: true }); mkdirSync(staging, { recursive: true })
  let n = 0
  for (const l of layers) {
    const layer = l.digest.slice('sha256:'.length), t = title(l), cached = join(LAYERS, layer)
    if (!existsSync(cached) || sha256File(cached) !== layer) {
      try { await blob(ref.split(/[:@]/)[0]!, layer, cached) }
      catch (e) { throw new BoardPoolError(`${e instanceof Error ? e.message : String(e)}\nerror: layer ${t} of ${ref} could not be read (see above)`) }
    }
    if (component === 'firmware' && t === 'firmware.tar') {
      const listing = tar(['-tvf', cached])
      if (listing.code !== 0 || listing.out.split('\n').filter(x => x !== '').some(x => !/^[-d]/.test(x))) throw new BoardPoolError(`error: firmware.tar of ${ref} holds a member that is neither a file nor a directory`)
      const names = tar(['-tf', cached]).out.split('\n').filter(x => x !== '')
      if (names.some(x => !/^firmware\/([A-Za-z0-9._+-]+\/?)*$/.test(x) || /(^|\/)\.\.?(\/|$)/.test(x))) throw new BoardPoolError(`error: firmware.tar of ${ref} holds a member outside firmware/`)
      const x = tar(['-xf', cached, '-C', staging, '--no-same-owner', '--no-same-permissions'])
      if (x.code !== 0) throw new BoardPoolError(`error: firmware.tar of ${ref} did not unpack`)
    }
    else {
      mkdirSync(dirname(join(staging, t)), { recursive: true })
      copyFileSync(cached, join(staging, t)); chmodSync(join(staging, t), 0o644)
    }
    n += 1
  }
  return `board-pool: ${board} ${component}: ${n} layer(s) of ${ref}, reused`
}

/** The board's bundle, assembled into _out/boards/<board>/; the lines it printed. */
export async function fetch(board: string): Promise<string[]> {
  findBoard(board)
  if (!existsSync(TRUST_CERT)) throw new BoardPoolError(`error: ${TRUST_CERT} does not exist; the kernel's embedded trust certificate is compared against it (MICA_VERITY_TRUST_CERT overrides the path)`)
  const dest = join(BOARDS_OUT, board)
  // Staged beside the destination and moved into place only once every check has passed; a refusal leaves
  // nothing behind for a discovery to mistake for a board.
  mkdirSync(BOARDS_OUT, { recursive: true })
  const staging = join(BOARDS_OUT, `.${board}.fetch`)
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true })
  const said: string[] = []
  const say = (l: string) => { said.push(l); console.log(l) }
  try {
    for (const component of componentList(board)) {
      const part = join(staging, `.${component}`)
      if (component === 'board' || component === 'firmware') {
        stage(board, component, part, TRUST_CERT)
        cpSync(part, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }); rmSync(part, { recursive: true, force: true })
        say(`board-pool: ${board} ${component}: staged from boards/${board}/`)
        continue
      }
      // A local build is staged as it is; its absence (the stager names the make target) is the one failure
      // that means "look in the registry", any other refusal is this fetch's.
      let absent = false
      try { stage(board, component, part, TRUST_CERT) }
      catch (e) {
        if (e instanceof ComponentError && e.message.includes('does not exist; run \'make')) absent = true
        else throw e
      }
      if (!absent) {
        cpSync(part, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }); rmSync(part, { recursive: true, force: true })
        say(`board-pool: ${board} ${component}: staged from _out/${board}/ (a local build)`)
        continue
      }
      rmSync(part, { recursive: true, force: true })
      const inputs = inputsHash(board, component, undefined, { verity: TRUST_CERT })
      const digest = await reuse(board, component, inputs)
      if (digest === '') throw new BoardPoolError(`error: no ${component} of ${board} is built under _out/${board}/ and no release of this repository publishes one with the inputs ${inputs.slice(0, 12)}; run make ${board}-${component === 'kernel' ? 'kernel' : 'firmware'}`)
      say(await fetchComponent(board, component, digest, staging))
    }
    checkBundle(staging, `${board} (boards/${board})`)
    bundleIs(board, staging)
    rmSync(dest, { recursive: true, force: true }); renameSync(staging, dest)
  }
  finally { rmSync(staging, { recursive: true, force: true }) }
  return said
}

export async function fetchAll(): Promise<string> {
  const list = boards().map(b => b.name)
  for (const b of list) await fetch(b)
  if (list.length === 0) throw new BoardPoolError('error: boards/boards.tsv lists no board, so nothing was fetched')
  // An assembled board the list no longer names is a stale directory a discovery would still find.
  if (existsSync(BOARDS_OUT)) {
    for (const d of readdirSync(BOARDS_OUT, { withFileTypes: true })) {
      if (!d.isDirectory() || list.includes(d.name)) continue
      console.log(`board-pool: removing _out/boards/${d.name}, which boards/boards.tsv does not list`)
      rmSync(join(BOARDS_OUT, d.name), { recursive: true, force: true })
    }
  }
  return `board-pool: ${list.length} board(s) assembled into _out/boards/`
}

/** The kernel directory a product of that profile packs. */
export function kernelDir(board: string, profile: string): string {
  if (profile !== 'dev' && profile !== 'prod') throw new BoardPoolError('usage: board-pool --kernel-dir <board> <dev|prod>')
  if (!existsSync(join(BOARDS_OUT, board, 'board.env'))) throw new BoardPoolError(`error: ${board} is not assembled (make board-fetch BOARD=${board})`)
  const dirs = kernelDirs(join(BOARDS_OUT, board))
  return dirs?.length === 1 ? join(BOARDS_OUT, board, 'kernel') : join(BOARDS_OUT, board, 'kernel', profile)
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, a, b] = argv
    if (cmd === '--list') { await Bun.write(Bun.stdout, boards().map(x => x.name + '\n').join('')) }
    else if (cmd === '--fetch') {
      if (!a) throw new BoardPoolError('usage: board-pool --fetch <board>')
      await fetch(a)
    }
    else if (cmd === '--fetch-all') { console.log(await fetchAll()) }
    else if (cmd === '--check') {
      if (!a || !existsSync(a) || !readdirSync(a)) throw new BoardPoolError('usage: board-pool --check <bundle dir>')
      const board = existsSync(join(a, 'board.env')) ? (readFileSync(join(a, 'board.env'), 'utf8').split('\n').find(l => l.startsWith('LAYOUT_BOARD='))?.slice('LAYOUT_BOARD='.length) ?? '') : ''
      const dirs = checkBundle(a, a)
      console.log(`board-pool: ${a} is a readable bundle of ${board || '?'} (${dirs.join(' ')} )`)
    }
    else if (cmd === '--kernel-dir') { console.log(kernelDir(a ?? '', b ?? '')) }
    else { throw new BoardPoolError('usage: board-pool --list | --fetch <board> | --fetch-all | --check <dir> | --kernel-dir <board> <dev|prod>') }
    return 0
  }
  catch (e) {
    if (e instanceof BoardPoolError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['BoardsError', 'ComponentError', 'InputsError', 'ReuseError', 'RegistryError', 'ProducersError', 'OciError', 'FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
