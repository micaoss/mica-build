// One product, one closure: from the product's recipe to its signed image, under _out/products/<name>/,
// reusing the result when nothing it was built from has changed.
//
//   bun src/cli.ts product-build <name> [--generation <g>]
//                                                  build (or reuse) the product; its update archives are of
//                                                  generation <g> (default 2), so a device on an earlier local
//                                                  build is offered it
//   bun src/cli.ts product-build <name> --verify   verify its image against the contract
//   bun src/cli.ts product-build <name> --version <v> [--generation <g>]
//                                                  build it stamped <v>: a NAME and nothing else
//   bun src/cli.ts product-build <name> --release <YYYYMMDD-HHMM> [--generation <g>]
//                                                  that name PLUS the release MODE -- the gates and the gated
//                                                  release directory for the development channel (release/);
//                                                  the release's deployment is generation <g> (default 2, at
//                                                  least 2), one above its previous release's; with
//                                                  MICA_PREVIOUS_ROOT=<dir> (scoped-release previous-root) the
//                                                  previous release's root ships in place of the one packed here
//                                                  when their rootfs inputs digests match (reuseRoot)
//
// *** THE NAME AND THE MODE ARE TWO THINGS. *** The NAME reaches content: the
// receipt, and VERSION -- which becomes MICA_VERSION in /etc/issue and /usr/lib/os-release, `--version` on every
// signed component, and product.json's `release`. The MODE is gates and extra work: a clean tree, `CI=1 locks
// check`, double-packing every image kind, release notes, and the release assembly. The split is not a
// convenience: the MODE's lock check under CI refuses offline pins by design, and offline pins are what the
// offline chain produces, so without the split an offline build could not carry a release's version at all. And
// "is this a real release?" is not a question the flag answers: a build carrying a release's name either
// reproduces that release's published root hash or provably does not, by anybody, with no key; a marker in the
// root would destroy that comparison.
//
//   reads   boards/<board>/products/<variant>/ (src/product/product.ts), locks/, _out/boards/<board>/ (make board-fetch),
//           _out/debs/<arch>/ (src/cli.ts pool), the signing workspace (MICA_SIGNING_OUTPUT, default meta/)
//   writes  _out/products/<name>/{receipt.txt,lifecycle/,root/,core-set/,kernel/,firmware/,deployments/,records.json,image/,update.micaupd}
//
// THE STEPS, in the order the components depend on one another: fetch (the product's closure out of the pool of
// the board's architecture, and the board bundle); compose (src/rootfs/build.ts); root (the signed root
// component out of that composition); core set (the seed core set of the image: the published set of
// MICA_SEED_CORE_SET, or every core component of the pool, signed, as one mica/set/v1; either held to this product's
// features on its root, src/image/core-set.ts); kernel (the signed
// kernel/support component out of the bundle and the pinned lifecycle binaries); firmware (built and signed on an
// efi board, the bundle's loader on a FIT board); deploy (two signed factory deployment records, generations
// <g>-1 and <g>, each naming the seed core set as coreSet); image (every IMAGE_KIND the product names, carrying the
// seed core set); archive (the signed update archives of generation <g>, each carrying the seed core set).
//
// THE RECEIPT is the sha256 of everything the build read: the product directory, every pin, the board's
// board.env and kernel release, the public certificates of the three signing domains and the tree's commit. A
// product whose receipt matches the one on disk and whose image exists is not rebuilt; a changed input rebuilds
// it whole (the components bind one another by identity, so a partial rebuild would be a different product with
// an old name). The FIT tools label hashes `Dockerfile.fit fit.sh regdb.sh` under stages/boot.
import { BACKENDS } from '../image/backends/index.ts'
import { loadBoardFacts } from '../image/board-facts.ts'
import { FIRMWARE_FORMATS } from '../image/firmware-formats.ts'
import { unpackArchive } from '../image/component-archive.ts'
import { channelModuleSigning } from '../image/module-signing.ts'
import { canonicalJson, type RootComponent, type RootFacts } from '../image/components.ts'
import { ROOT_INTERFACE_LEVEL } from '../image/core-components.ts'
import { authenticateCoreSet, checkCoreSetForProduct, coreSetId, type ServedProduct } from '../image/core-set.ts'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fetch as boardFetch, kernelDir } from '../boards/board-pool.ts'
import { build as buildTools, debianSources } from '../boot/build-tools.ts'
import { checkout } from '../locks/source.ts'
import { buildArgs, inputs, LOCKS, rows as lockRows } from '../locks/inputs.ts'
import { lifecycle } from '../pool/deploy-pool.ts'
import { fetchPool, index as poolIndex } from '../pool/pool.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { checkLocks, version as treeVersion } from '@mica/build-tools'
import { compose } from '../rootfs/build.ts'
import { pack, updateKinds } from './image-kinds.ts'
import { product, productBoard, productDir, products } from './product.ts'
import { dockerBin } from '../shared/docker.ts'
import type { Arch } from '../rootfs/runtime/arch.ts'
import { imageContexts } from '../locks/local-images.ts'

export class ProductBuildError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

const CLI = join(REPO_ROOT, 'src/cli.ts')
const USAGE = 'usage: bun src/cli.ts product-build <name> [--generation <g> | --verify | --version <v> [--generation <g>] | --release <YYYYMMDD-HHMM> [--generation <g>]]'
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const words = (s: string) => s.split(/[ \t\n]+/).filter(w => w !== '')

/** A release's notes: what the product is, and what its device does that a reader would not assume. */
export function releaseNotes(release: string, name: string, board: string, profile: string, features: string, claim: string, ssh: string, engine: string): string {
  const notes = [`# Mica OS ${release}`, '', `Product ${name} (board ${board}, profile ${profile}), development channel.`]
  const lines: string[] = []
  if (words(features).includes('micad')) lines.push('- No fallback DNS: a site whose router hands out no DNS resolves nothing.')
  if (words(features).includes('wifi')) {
    lines.push('- The factory access point is on: SSID `mica-XXXX` and the key printed on the device\'s label, with its device code.')
    lines.push('- The label\'s key stays the access point\'s until a key is set on the console\'s Wi-Fi page (`wifi.ap.psk`); claiming the device does not change it.')
  }
  if (words(features).includes('micad'))
    lines.push(claim === 'off' ? '- Claiming the device does not ask for its device code.' : '- Claiming the device asks for its device code, printed on its label.')
  if (ssh !== '') lines.push(`- SSH server: ${ssh === 'openssh' ? 'OpenSSH' : 'Dropbear'}.`)
  if (engine !== '') lines.push(engine === 'docker' ? '- Container engine: Docker, with `docker compose`.' : '- Container engine: Podman.')
  if (words(features).includes('micad') && words(features).includes('bluetooth'))
    lines.push('- BLE provisioning sets up the network and nothing else: it claims nothing and sets no administrator password, access-point key or hostname.')
  if (words(features).includes('micad'))
    lines.push('- A factory reset asks for the administrator password and is refused on an unclaimed device; it erases everything configured and keeps the installed software.')
  return [...notes, ...(lines.length > 0 ? ['', ...lines] : [])].map(l => `${l}\n`).join('')
}
const say = (line: string) => console.log(line)

function fail(message: string, code = 1): never {
  throw new ProductBuildError(message, code)
}

/** The architecture a board's FIT host tool runs on, from its ELF header: the host that built its U-Boot. */
export function toolArch(path: string): 'amd64' | 'arm64' {
  const elf = readFileSync(path)
  if (elf.length < 20 || elf.subarray(0, 4).toString('latin1') !== '\x7fELF' || elf[4] !== 2 || elf[5] !== 1)
    fail(`error: ${path} is not a little-endian 64-bit ELF tool`)
  const machine = elf.readUInt16LE(18)
  if (machine === 62) return 'amd64'
  if (machine === 183) return 'arm64'
  fail(`error: ${path} has unsupported ELF machine ${machine}`)
}

/** A src/cli.ts command, its output shown; a failure ends the build with its status, as `set -e` did. */
function cli(args: string[], env: Record<string, string> = {}, stdout: 'inherit' | 'pipe' = 'inherit'): string {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { stdout, stderr: 'inherit', env: { ...process.env, ...env } as Record<string, string> })
  if (r.exitCode !== 0) fail('', r.exitCode)
  return stdout === 'pipe' ? (r.stdout?.toString() ?? '') : ''
}

export type Options = { name: string, mode: 'build' | 'verify', release: string, stamp: string, generation: number }

/** The command line: the name, then the mode and its stamp and generation. */
export function parseArgs(argv: string[]): Options {
  const name = argv[0] ?? ''
  if (name === '') fail(USAGE)
  const mode = argv[1] ?? 'build'
  const o: Options = { name, mode: 'build', release: '', stamp: '', generation: 2 }
  if (mode === '--verify') { if (argv.length !== 2) fail(USAGE); o.mode = 'verify'; return o }
  if (mode === 'build') { if (argv.length !== 1) fail(USAGE); return o }
  if (mode !== '--release' && mode !== '--version' && mode !== '--generation') fail(USAGE)
  const refuse = () => fail(`error: ${mode === '--generation' ? 'a build' : mode} takes an optional --generation <g>, a decimal of at least 2`)
  if (mode !== '--generation') o.stamp = argv[2] ?? ''
  if (mode !== '--generation' && o.stamp === '') fail(USAGE)
  for (let i = mode === '--generation' ? 1 : 3; i < argv.length; i += 2) {
    const value = argv[i + 1] ?? ''
    if (argv[i] === '--generation' && /^[1-9][0-9]*$/.test(value) && Number(value) >= 2) o.generation = Number(value)
    else refuse()
  }
  if (mode === '--release') {
    // THE MODE'S GATES. A release form is required here and not for --version: the name is a string the tag,
    // the lock's release row and the pin all already carry, and an offline build is entitled to any of them.
    if (!/^[0-9]{8}-[0-9]{4}$/.test(o.stamp)) fail('error: --release takes the UTC release name YYYYMMDD-HHMM')
    o.release = o.stamp
  }
  return o
}

function git(...args: string[]): string {
  return Bun.spawnSync(['git', '-C', REPO_ROOT, ...args], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
}

/** Every file under a directory of the tree, relative to the tree, in byte order. */
function treeFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(d).sort()) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push(p) } }
  walk(join(REPO_ROOT, dir))
  return out.map(p => p.slice(REPO_ROOT.length + 1)).sort()
}

export type ReceiptInputs = { name: string, boardDir: string, kernelDirectory: string, signing: string, release: string, version: string, generation: number, storageLayout?: string, seedCoreSet?: string, previousRoot?: string }

/** A published core set a product image takes as its seed (MICA_SEED_CORE_SET, src/release/core.ts seed): signed by
 * the build's updates key, of the product's architecture, and selecting for the product on `root` -- before the
 * compose this tree's root interface level alone, once the root component is built its level and provides. Its id. */
export function seedCoreSet(envelope: string, publicKey: string, served: ServedProduct, root: RootFacts = { level: ROOT_INTERFACE_LEVEL }): string {
  const set = authenticateCoreSet(envelope, [publicKey])
  checkCoreSetForProduct(set, served, root)
  return coreSetId(canonicalJson(set))
}

/** The receipt: what this build reads, the REUSE KEY. The version has a line of its own because `--version <v>`
 * makes it independent of the release and the tree, and it reaches the signed root. */
export function receipt(i: ReceiptInputs): string {
  const strip = (p: string) => (p.startsWith(`${REPO_ROOT}/`) ? p.slice(REPO_ROOT.length + 1) : p)
  const lines: string[] = []
  for (const f of treeFiles(relative(REPO_ROOT, productDir(i.name)))) lines.push(`${sha256(join(REPO_ROOT, f))}  ${f}`)
  for (const f of treeFiles('locks')) lines.push(`${sha256(join(REPO_ROOT, f))}  ${f}`)
  for (const f of [join(i.boardDir, 'board.env'), join(i.kernelDirectory, 'kernel.release'), join(i.kernelDirectory, 'config'),
    join(i.signing, 'verity/signer.cert.pem'), join(i.signing, 'boot/signer.cert.pem'), join(i.signing, 'updates/public.key')]) lines.push(`${sha256(f)}  ${strip(f)}`)
  if (i.storageLayout) {
    lines.push(`storage-layout ${i.storageLayout}`)
    const f = join(i.boardDir, `layout-${i.storageLayout}.tsv`)
    lines.push(`${sha256(f)}  ${strip(f)}`)
  }
  if (i.seedCoreSet) lines.push(`seed-core-set ${i.seedCoreSet}`)
  if (i.previousRoot) lines.push(`previous-root ${i.previousRoot}`)
  lines.push(`tree ${git('rev-parse', 'HEAD').trim()}${git('status', '--porcelain') === '' ? '' : ' dirty'}`)
  lines.push(`release ${i.release === '' ? 'none' : i.release}`)
  lines.push(`version ${i.version}`)
  lines.push(`generation ${i.generation}`)
  return lines.map(l => `${l}\n`).join('')
}

/** THE PREVIOUS RELEASE'S ROOT, reused: when the inputs digest of the root packed here (out/rootfs-inputs.txt) is
 * the previous release's (its lock's rootfs row, `previous`/rootfs-inputs.txt), that release's root component, out of
 * its full update archive (`previous`/update.micaupd, authenticated with the updates key), replaces out/root. The
 * two differ only in the release stamp, so the release ships the previous root id, which reads the version of the
 * release that built it, and a device fetches no root. Otherwise the root packed here ships. What it did, as a line. */
export function reuseRoot(out: string, previous: string, publicKey: string): string {
  const inputs = readFileSync(join(out, 'rootfs-inputs.txt'), 'utf8').trim()
  if (!existsSync(join(previous, 'rootfs-inputs.txt'))) return 'root: no previous rootfs inputs digest; the root packed here ships'
  const was = readFileSync(join(previous, 'rootfs-inputs.txt'), 'utf8').trim()
  if (was !== inputs) return `root: the rootfs inputs digest ${inputs} differs from the previous release's ${was}; the root packed here ships`
  const work = join(out, 'previous-root')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work)
  try {
    const d = unpackArchive(join(previous, 'update.micaupd'), [publicKey], join(work, 'kernel'), join(work, 'root'))
    const packed = (JSON.parse(readFileSync(join(out, 'root/rootfs.json'), 'utf8')) as { id: string }).id
    rmSync(join(out, 'root'), { recursive: true, force: true })
    renameSync(join(work, 'root'), join(out, 'root'))
    return `root: the rootfs inputs digest ${inputs} is the previous release's; its root ${d.rootfs.id} ships in place of the one packed here (${packed})`
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}

/** The root's inputs digest: what the root packs minus the release's stamp (the pack stage's rootfs-content.sha256,
 * stages/compose/scripts/pack-content-digest.sh), the verity knobs and certificate that sign it, and the record's
 * interface level. Two builds with this digest produce the same root component up to the stamp. */
export function rootfsInputs(content: string, verityEnv: string, certificate: Uint8Array, level: number): string {
  const knob = (key: string) => verityEnv.split('\n').find(l => l.startsWith(`${key}=`)) ?? `${key}=`
  return createHash('sha256').update([`content ${content.trim()}`,
    ...['VERITY_SALT', 'VERITY_HASH_ALGO', 'VERITY_DATA_BLOCK_SIZE', 'VERITY_HASH_BLOCK_SIZE'].map(knob),
    `certificate ${createHash('sha256').update(certificate).digest('hex')}`, `interface-level ${level}`].map(l => `${l}\n`).join('')).digest('hex')
}

/** The kernel release each deployment document names, held to the board's KERNEL_EXPECT (boards/<board>/bsp.env, or
 * board.env on a board with no bsp.env: a UEFI board's kernel build takes its row as it is). The
 * kernel comes from the board bundle, and a stale bundle (a board kernel built from an older row) packs and verifies
 * like any other, so this is the release the device will report compared with the one the tree expects. A refusal,
 * or undefined. */
export function kernelReleaseRefusal(boardDir: string, deployments: string[]): string | undefined {
  const bsp = existsSync(join(boardDir, 'bsp.env')) ? join(boardDir, 'bsp.env') : join(boardDir, 'board.env')
  const line = existsSync(bsp) ? readFileSync(bsp, 'utf8').split('\n').find(l => l.startsWith('KERNEL_EXPECT=')) : undefined
  const expect = (line ?? '').slice('KERNEL_EXPECT='.length).replace(/^"|"$/g, '')
  if (expect === '') return `${bsp} names no KERNEL_EXPECT; the kernel release the board's products ship is not checked without it`
  if (deployments.length === 0) return 'no deployment document to read the kernel release from; build the product first'
  for (const file of deployments) {
    const release = JSON.parse(Buffer.from(JSON.parse(readFileSync(file, 'utf8')).payload, 'base64').toString()).kernel?.release
    if (release !== expect) return `${file} carries kernel ${release}, and ${bsp} expects ${expect}; the board bundle is stale (make ${boardDir.split('/').pop()}-kernel, then make board-fetch BOARD=${boardDir.split('/').pop()})`
  }
  return undefined
}

/** The EFI target of an architecture, as UEFI names it, in lower case. */
export function efiTarget(arch: string): 'x64' | 'aa64' {
  if (arch === 'amd64') return 'x64'
  if (arch === 'arm64') return 'aa64'
  fail(`error: no EFI architecture for ${arch}`)
}

/** The image SHA256SUMS names, under the product's image directory. */
function imagePath(out: string): string {
  const sums = join(out, 'image/SHA256SUMS')
  const name = existsSync(sums) ? (readFileSync(sums, 'utf8').split('\n')[0] ?? '').split(/\s+/)[1] ?? '' : ''
  return join(out, 'image', name)
}

export async function build(o: Options): Promise<void> {
  if (o.release !== '') {
    if (git('status', '--porcelain') !== '') fail('error: a release is built from a clean checkout of its tag; this tree is dirty')
    try { checkLocks(LOCKS, 'ci') }
    catch (e) { fail(`${e instanceof Error ? e.message : String(e)}\nerror: locks/ holds an offline pin (bin/mica-tools local-lock) or breaks a rule; a release imports published releases only`) }
  }
  const signing = process.env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta')
  const out = join(REPO_ROOT, '_out/products', o.name)

  // The product, validated against its fetched board; the board is fetched first so a fresh clone gets a
  // refusal that names the fetch, not a path.
  const boardName = products().includes(o.name) ? productBoard(o.name) : ''
  if (boardName === '') fail(`error: ${o.name} is no product (boards/<board>/products/<variant>/ is <board>.<variant>); the products are: ${products().map(p => `${p} `).join('')}`)
  if (!existsSync(join(REPO_ROOT, '_out/boards', boardName, 'board.env'))) for (const l of await boardFetch(boardName)) say(l)
  const p = product(o.name)
  // The kernel directory of the product's profile: kernel/<profile> on a FIT board, kernel on a UEFI board.
  const kernelDirectory = kernelDir(p.board, p.profile)
  // The board's backend and firmware format, through their registries (src/image/backends/, src/image/firmware-formats.ts).
  const facts = loadBoardFacts(p.board, p.storageLayout)
  const layoutArgs = p.storageLayout ? ['--storage-layout', p.storageLayout] : []
  const backend = BACKENDS[facts.backend], firmwareFormat = FIRMWARE_FORMATS[facts.firmware.format]

  // The signing inputs: public certificates enter the build, private keys sign.
  for (const f of ['verity/signer.key.pem', 'verity/signer.cert.pem', 'boot/signer.key.pem', 'boot/signer.cert.pem', 'updates/signer.key.pem', 'updates/public.key'])
    if (!existsSync(join(signing, f))) fail(`error: ${join(signing, f)} does not exist; the signing workspace is incomplete (development inputs: make os-devkeys)`)
  const publicKey = readFileSync(join(signing, 'updates/public.key'), 'utf8').replace(/\n/g, '')

  if (o.mode === 'verify') {
    // The image is the one SHA256SUMS names; the directory also holds the partition images the assembler built it from.
    const image = imagePath(out)
    if (image.endsWith('/') || !existsSync(image)) fail(`error: ${out}/image holds no image; build the product first (make product PRODUCT=${o.name})`)
    const documents = existsSync(join(out, 'deployments')) ? readdirSync(join(out, 'deployments')).filter(f => f.endsWith('.json')).sort().map(f => join(out, 'deployments', f)) : []
    const refusal = kernelReleaseRefusal(join(REPO_ROOT, 'boards', p.board), documents)
    if (refusal !== undefined) fail(`error: ${refusal}`)
    say(`verify: the deployments carry the kernel release boards/${p.board} expects (KERNEL_EXPECT)`)
    // The connd contract the verifier compares against is read out of mica-core's source at its pinned release.
    checkout('mica-core')
    cli(['verify', '--board', p.board, ...layoutArgs, '--image', image, '--public-key', join(signing, 'updates/public.key')])
    return
  }

  // THE VERSION THIS BUILD IS STAMPED WITH, computed BEFORE the receipt because the receipt records it and
  // BEFORE the compose because /etc/issue and /usr/lib/os-release are written there.
  const version = o.stamp === '' ? treeVersion(REPO_ROOT) : o.stamp
  // THE SEED CORE SET of a release image is the published one of the general channel, handed in unpacked; any
  // other build signs the pool's components as its own set below.
  const seedDir = process.env['MICA_SEED_CORE_SET'] ?? ''
  let seedId = ''
  if (seedDir !== '') {
    try { seedId = seedCoreSet(readFileSync(join(seedDir, 'core-set.json'), 'utf8'), publicKey, { name: o.name, arch: p.arch, features: words(p.features) }) }
    catch (e) { fail(`error: MICA_SEED_CORE_SET=${seedDir} is not a seed for ${o.name}: ${(e as Error).message}`) }
  }
  // THE PREVIOUS RELEASE'S ROOT, which a release reuses when the root packed here has its inputs digest (reuseRoot):
  // the directory scoped-release previous-root writes (src/release/scoped.ts).
  const previousDir = process.env['MICA_PREVIOUS_ROOT'] ?? ''
  const previousRoot = previousDir !== '' && existsSync(join(previousDir, 'rootfs-inputs.txt')) ? readFileSync(join(previousDir, 'rootfs-inputs.txt'), 'utf8').trim() : ''
  const want = receipt({ name: o.name, boardDir: p.boardDir, kernelDirectory, signing, release: o.release, version, generation: o.generation, storageLayout: p.storageLayout, seedCoreSet: seedId, previousRoot })
  if (existsSync(join(out, 'receipt.txt')) && readFileSync(join(out, 'receipt.txt'), 'utf8') === want && existsSync(join(out, 'image/SHA256SUMS'))) {
    say(`product: ${o.name} is up to date -- every input in ${out}/receipt.txt is unchanged and the image exists; nothing to do`)
    for (const l of readFileSync(join(out, 'image/SHA256SUMS'), 'utf8').split('\n').filter(l => l !== '')) say(`${out}/image/${l.split(/\s+/)[1]}`)
    return
  }
  if (want.includes(' dirty\n')) say('note: the tree is dirty; this build is recorded as such and is not a release candidate')

  // THE POOL of the board's architecture, whole: the source lineage requires every archive the locks pin for it
  // (src/rootfs/lineage.ts), and the composer installs only what the resolver selects out of it.
  say(`=== product ${o.name}: fetch (board ${p.board}, ${p.arch}) ===`)
  say(await fetchPool(p.arch, [], false))
  checkout('mica-system-base')
  say(await poolIndex(p.arch))
  for (const l of await boardFetch(p.board)) say(l)

  const clear = () => {
    for (const d of ['lifecycle', 'fit-tools', 'root', 'cores', 'core-set', 'kernel', 'firmware', 'deployments', 'image', 'records.json', 'update.micaupd', 'updates', 'updates.tsv', 'kinds', 'kinds.tsv', 'release', 'release-notes.md', 'release-packages.tsv', 'receipt.txt', 'previous', 'previous-root', 'rootfs-inputs.txt'])
      rmSync(join(out, d), { recursive: true, force: true })
    mkdirSync(join(out, 'deployments'), { recursive: true })
  }
  say(`=== product ${o.name}: compose ===`)
  await compose({ ...process.env, MICA_PRODUCT: o.name, MICA_VERSION: version })
  // The composition (build/) stays; the components are made afresh.
  clear()
  say(`=== product ${o.name}: components at version ${version} ===`)
  say(await lifecycle(p.arch, join(out, 'lifecycle')))
  cli(['components', 'root', '--input', join(out, 'build'), '--arch', p.arch, '--out', join(out, 'root'),
    '--content-key', join(signing, 'verity/signer.key.pem'), '--content-cert', join(signing, 'verity/signer.cert.pem')])
  writeFileSync(join(out, 'rootfs-inputs.txt'), `${rootfsInputs(readFileSync(join(out, 'build/rootfs-content.sha256'), 'utf8'), readFileSync(join(out, 'build/rootfs-verity.env'), 'utf8'),
    readFileSync(join(signing, 'verity/signer.cert.pem')), (JSON.parse(readFileSync(join(out, 'root/rootfs.json'), 'utf8')) as RootComponent).interfaceLevel)}\n`)
  if (previousDir !== '') say(reuseRoot(out, previousDir, publicKey))
  // THE SEED CORE SET, the device's first: the published set handed in, or the pool's core components as one set of
  // the general channel, held to this product's features on the root just built (its level and provides).
  if (seedId !== '') {
    const rootfs = JSON.parse(readFileSync(join(out, 'root/rootfs.json'), 'utf8')) as RootComponent
    try { seedCoreSet(readFileSync(join(seedDir, 'core-set.json'), 'utf8'), publicKey, { name: o.name, arch: p.arch, features: words(p.features) }, { level: rootfs.interfaceLevel, provides: rootfs.provides }) }
    catch (e) { fail(`error: MICA_SEED_CORE_SET=${seedDir} is not a seed for ${o.name}'s root: ${(e as Error).message}`) }
    cpSync(seedDir, join(out, 'core-set'), { recursive: true }); say(`Core set ${seedId} (the published seed, ${seedDir})`)
  }
  else {
    cli(['components', 'core-set', '--pool', join(REPO_ROOT, '_out/debs', p.arch, 'pool'), '--arch', p.arch, '--channel', 'general', '--generation', '1', '--product', o.name, '--root', join(out, 'root'), '--out', join(out, 'core-set'),
      '--content-key', join(signing, 'verity/signer.key.pem'), '--content-cert', join(signing, 'verity/signer.cert.pem'), '--metadata-key', join(signing, 'updates/signer.key.pem')])
  }
  // THE PACKAGER, built from the pinned stages/boot tree before the kernel component runs in it: a UEFI board's
  // boot-tools image for its EFI architecture, a FIT board's fit-tools image over the board's own mkimage
  // (uboot/tools in the bundle). docker's cache makes an unchanged image free; what this refuses to inherit is a
  // local tag built from another tree.
  if (backend.packMode === 'fit') {
    // The EFI boot tools that inspect the manifest still install the amd64 loader archive.
    say(await fetchPool('amd64', ['mica-systemd-boot'], false))
    buildTools('x64')
    // The bundle's files are all 0644 (a board archive ships data, not executables); the packager runs these
    // four, so they are staged executable.
    const tools = ['mkimage', 'fit_check_sign', 'fdt_add_pubkey', 'dumpimage']
    rmSync(join(out, 'fit-tools'), { recursive: true, force: true }); mkdirSync(join(out, 'fit-tools'), { recursive: true })
    for (const t of tools) { copyFileSync(join(p.boardDir, 'uboot/tools', t), join(out, 'fit-tools', t)); chmodSync(join(out, 'fit-tools', t), 0o755) }
    // The signed regulatory database, pinned in locks/upstream.lock.
    const regdb = lockRows('source', 'upstream.lock', undefined, inputs()).find(r => r[1] === 'wireless-regdb')
    const regdbSha = regdb?.[4] ?? '', regdbUrl = regdb?.[5] ?? ''
    if (regdbUrl === '') fail('error: locks/upstream.lock has no source row for wireless-regdb')
    // The tools are ELF for the host that built the board's U-Boot, so the packager runs on that platform, from
    // the same pinned Debian base and apt rows as the boot tools (src/boot/build-tools.ts).
    const archs = new Set(tools.map(t => toolArch(join(out, 'fit-tools', t))))
    if (archs.size !== 1) fail('error: the board FIT tools have different ELF architectures')
    const fitArch = [...archs][0]!
    const base = buildArgs(['MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim'], inputs())
    if (base.length !== 2) fail('error: the image resolver yielded no Debian base for the FIT tools')
    const apt = lockRows('apt', 'mica-system-base', undefined, inputs())
    if (apt.length === 0) fail('error: locks/mica-system-base.lock names no apt rows for the FIT tools')
    const sources = debianSources(apt)
    // Its pinned inputs, as the label mica.boot.inputs the kernel component's buildId names.
    const fitInputs = createHash('sha256').update([
      `${base[1]}\nplatform linux/${fitArch}\nsources ${createHash('sha256').update(sources).digest('hex')}\nregdb ${regdbUrl} ${regdbSha}\n`,
      ...['Dockerfile.fit', 'fit.sh', 'regdb.sh', 'initramfs.sh', 'compression.sh', 'elf-closure.sh'].map(f => `${sha256(join(REPO_ROOT, 'stages/boot', f))}  ${f}\n`),
      ...tools.map(t => `${sha256(join(out, 'fit-tools', t))}  ${t}\n`),
    ].join('')).digest('hex')
    const r = Bun.spawnSync([dockerBin(), 'build', '--platform', `linux/${fitArch}`, '--label', 'ai-agent=true', '--label', `mica.boot.inputs=${fitInputs}`, '-t', 'ai-agent/mica-fit-tools',
      ...base, '--build-arg', `MICA_DEBIAN_SOURCES=${sources}`, '--build-arg', `REGDB_URL=${regdbUrl}`, '--build-arg', `REGDB_SHA256=${regdbSha}`,
      '--build-context', `fit-tools=${join(out, 'fit-tools')}`, ...imageContexts(base), '-f', join(REPO_ROOT, 'stages/boot/Dockerfile.fit'), join(REPO_ROOT, 'stages/boot')], { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) fail('', r.exitCode)
  }
  else { buildTools(efiTarget(p.arch)) }
  // A kernel that enforces module signatures has its modules signed with the mica driver key of the build's channel.
  const modules = channelModuleSigning(kernelDirectory, { ...process.env, MICA_SIGNING_OUTPUT: signing })
  const moduleArgs = modules === undefined ? [] : ['--module-key', modules.key, '--module-cert', modules.certificate]
  for (const f of modules === undefined ? [] : [modules.key, modules.certificate])
    if (!existsSync(f)) fail(`error: ${f} does not exist; the ${p.board} kernel enforces module signatures, so its modules are signed with the driver key (MICA_MODULE_SIGNING names its directory)`)
  cli(['components', 'kernel', '--board', p.board, '--profile', p.profile, ...layoutArgs, '--input', kernelDirectory,
    '--runkit', join(out, 'lifecycle/mica-runkit'), '--public-key', publicKey, '--out', join(out, 'kernel'),
    '--content-key', join(signing, 'verity/signer.key.pem'), '--content-cert', join(signing, 'verity/signer.cert.pem'),
    '--boot-key', join(signing, 'boot/signer.key.pem'), '--boot-cert', join(signing, 'boot/signer.cert.pem'), ...moduleArgs,
    ...(p.ownerConfirm === 'on' ? ['--owner-confirmation'] : [])])
  if (!firmwareFormat.builtHere) {
    const ubootBinName = firmwareFormat.loaderFile(facts.firmware)
    if (ubootBinName === '' || !existsSync(join(p.boardDir, 'uboot', ubootBinName))) fail(`error: the ${p.board} bundle carries no uboot/${ubootBinName || '?'}; a FIT board's firmware is its loader`)
    cli(['components', 'firmware', '--board', p.board, ...layoutArgs, '--out', join(out, 'firmware'), '--metadata-key', join(signing, 'updates/signer.key.pem'),
      '--generation', '1', '--version', version, '--input', join(p.boardDir, 'uboot', ubootBinName)])
  }
  else {
    cli(['components', 'firmware', '--board', p.board, ...layoutArgs, '--out', join(out, 'firmware'), '--metadata-key', join(signing, 'updates/signer.key.pem'),
      '--generation', '1', '--version', version, '--boot-key', join(signing, 'boot/signer.key.pem'), '--boot-cert', join(signing, 'boot/signer.cert.pem')])
  }
  for (const generation of [o.generation - 1, o.generation]) {
    cli(['components', 'deployment', '--kernel', join(out, 'kernel'), '--root', join(out, 'root'), '--product', o.name, '--generation', String(generation), '--version', version,
      '--metadata-key', join(signing, 'updates/signer.key.pem'), '--core-set', join(out, 'core-set'), '--out', join(out, 'deployments', `${generation}.json`)])
  }
  writeFileSync(join(out, 'records.json'), JSON.stringify([o.generation - 1, o.generation].map(g => ({ envelope: readFileSync(join(out, 'deployments', `${g}.json`), 'utf8'), kernelDirectory: join(out, 'kernel'), rootDirectory: join(out, 'root') }))))
  say(`=== product ${o.name}: image ===`)
  cli(['components', 'image', '--board', p.board, ...layoutArgs, '--records', join(out, 'records.json'), '--core-set', join(out, 'core-set'), '--public-key', publicKey,
    '--firmware', join(out, 'firmware'), '--out', join(out, 'image'), ...(p.provisioning === '' ? [] : ['--provisioning', p.provisioning])])
  cli(['components', 'archive', '--input', join(out, 'deployments', `${o.generation}.json`), '--kernel', join(out, 'kernel'), '--root', join(out, 'root'), '--kind', 'full',
    '--core-set', join(out, 'core-set'), '--public-key', publicKey, '--out', join(out, 'update.micaupd')])
  // The update packages of the product's update kinds (the board's images.tsv update rows): the one signed
  // descriptor with every object (full), or only the root's or the kernel's. updates.tsv names them.
  mkdirSync(join(out, 'updates'), { recursive: true })
  const updates: string[] = []
  const kinds = updateKinds(p.boardDir, words(p.updateKinds)).map(r => ({ kind: r.kind, suffix: r.suffix }))
  for (const row of kinds) {
    const file = `updates/mica-${o.name}-${version}.${row.suffix}`
    cli(['components', 'archive', '--input', join(out, 'deployments', `${o.generation}.json`), '--kernel', join(out, 'kernel'), '--root', join(out, 'root'), '--kind', row.kind,
      '--core-set', join(out, 'core-set'), '--public-key', publicKey, '--out', join(out, file)])
    updates.push(`${row.kind}\t${file}\t${sha256(join(out, file))}\n`)
  }
  writeFileSync(join(out, 'updates.tsv'), updates.join(''))
  // The flashing formats of the product's image kinds, each packed and verified by its board's packer
  // (src/product/image-kinds.ts; the product reader already checked them against the board's images.tsv).
  pack({ out, boardDir: p.boardDir, product: o.name, version, profile: p.profile, release: o.release !== '', kinds: words(p.imageKinds) })
  if (o.release !== '') {
    // THE CHANNEL IS DEVELOPMENT, stated here and nowhere else: releases sign with
    // the development trust material, and the release gate refuses development-marked material on the candidate
    // and stable channels (src/image/release-manifest.ts). A customer channel is a change to
    // this line together with production keys.
    say(`=== product ${o.name}: release ${o.release}, development channel ===`)
    rmSync(join(out, 'release'), { recursive: true, force: true })
    writeFileSync(join(out, 'release-notes.md'), releaseNotes(o.release, o.name, p.board, p.profile, p.features, p.claim, p.ssh, p.engine))
    const image = imagePath(out)
    // The package inventory the root ships, read out of the signed root: the composer rewrites
    // /usr/share/mica/manifest.tsv to the packages whose files the selection kept.
    const toolsArch = backend.toolsArch(p.arch as Arch)
    const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${join(out, 'root')}:/root-component:ro`, `ai-agent/mica-boot-tools-${toolsArch}`,
      'unsquashfs', '-cat', '/root-component/rootfs.img', 'usr/share/mica/manifest.tsv'], { stdout: 'pipe', stderr: 'inherit' })
    if (r.exitCode !== 0) fail('', r.exitCode)
    writeFileSync(join(out, 'release-packages.tsv'), r.stdout)
    cli(['release', 'assemble', '--channel', 'development', '--profile', p.profile, '--board', p.board, '--version', o.release,
      '--image', image, '--update', join(out, 'update.micaupd'), '--firmware', join(out, 'firmware'),
      '--package-manifest', join(out, 'release-packages.tsv'), '--runtime-report', join(out, 'build/rootfs-report.runtime.json'),
      '--baked-meta', join(out, 'build/compose/meta-public/usr/share/mica/meta'), '--notes', join(out, 'release-notes.md'),
      '--out', join(out, 'release'), '--public-key', join(signing, 'updates/public.key')])
    cli(['release', 'gate', '--dir', join(out, 'release'), '--public-key', join(signing, 'updates/public.key')])
  }
  writeFileSync(join(out, 'receipt.txt'), want)
  say(`=== product ${o.name}: done ===`)
  for (const l of readFileSync(join(out, 'image/SHA256SUMS'), 'utf8').split('\n').filter(l => l !== '')) say(`${out}/image/${l.split(/\s+/)[1]}`)
  say(join(out, 'update.micaupd'))
}

export async function main(argv: string[]): Promise<number> {
  try {
    await build(parseArgs(argv))
    return 0
  }
  catch (e) {
    if (e instanceof ProductBuildError) {
      if (e.message !== '') console.error(e.message)
      return e.code
    }
    if (e instanceof Error && ['ProductError', 'ImageKindsError', 'DeployPoolError', 'BuildToolsError', 'BuildError', 'BoardPoolError', 'PoolError', 'SourceError', 'ToolError', 'VersionError', 'ToolError', 'Refused'].includes(e.constructor.name)) {
      if (e.message !== '') console.error(e.constructor.name === 'SourceError' ? `source: error: ${e.message}` : e.constructor.name === 'PoolError' ? `pool: error: ${e.message}` : e.message)
      return 'code' in e && typeof (e as { code: unknown }).code === 'number' ? (e as { code: number }).code : 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
