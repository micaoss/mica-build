// One product, one closure: from the product's recipe to its signed image, under _out/products/<name>/,
// reusing the result when nothing it was built from has changed.
//
//   bun src/cli.ts product-build <name>            build (or reuse) the product
//   bun src/cli.ts product-build <name> --verify   verify its image against the contract
//   bun src/cli.ts product-build <name> --version <v> [--generation <g>]
//                                                  build it stamped <v>: a NAME and nothing else
//   bun src/cli.ts product-build <name> --release <YYYYMMDD-HHMM> [--generation <g>]
//                                                  that name PLUS the release MODE -- the gates and the gated
//                                                  release directory for the development channel (release/);
//                                                  the release's deployment is generation <g> (default 2, at
//                                                  least 2), one above its previous release's
//
// *** THE NAME AND THE MODE ARE TWO THINGS AND `--release` USED TO BE BOTH. *** The NAME reaches content: the
// receipt, and VERSION -- which becomes MICA_VERSION in /etc/issue and /usr/lib/os-release, `--version` on every
// signed component, and product.json's `release`. The MODE is gates and extra work: a clean tree, `CI=1 locks
// check`, double-packing every image kind, release notes, and the release assembly. The split is not a
// convenience: the MODE's lock check under CI refuses offline pins by design, and offline pins are what the
// offline chain produces, so before the split an offline build could not carry a release's version at all. And
// "is this a real release?" is not a question the flag answers: a build carrying a release's name either
// reproduces that release's published root hash or provably does not, by anybody, with no key; a marker in the
// root would destroy that comparison.
//
//   reads   products/<name>/ (src/product/product.ts), locks/, _out/boards/<board>/ (make board-fetch),
//           _out/debs/<arch>/ (src/cli.ts pool), the signing workspace (MICA_SIGNING_OUTPUT, default meta/)
//   writes  _out/products/<name>/{receipt.txt,lifecycle/,root/,kernel/,firmware/,deployments/,records.json,image/,update.micaupd}
//
// THE STEPS, in the order the components depend on one another: fetch (the product's closure out of the pool of
// the board's architecture, and the board bundle); compose (src/rootfs/build.ts); root (the signed root
// component out of that composition); kernel (the signed kernel/support component out of the bundle and the
// pinned lifecycle binaries); firmware (built and signed on an efi board, the bundle's loader on a FIT board);
// deploy (two signed factory deployment records, generations <g>-1 and <g>); image (every IMAGE_KIND the
// product names); archive (the signed update archives of generation <g>).
//
// THE RECEIPT is the sha256 of everything the build read: the product directory, every pin, the board's
// board.env and kernel release, the public certificates of the three signing domains and the tree's commit. A
// product whose receipt matches the one on disk and whose image exists is not rebuilt; a changed input rebuilds
// it whole (the components bind one another by identity, so a partial rebuild would be a different product with
// an old name). The port of tools/product-build.sh (deleted 2026-09-23), step for step; the product reader, the
// version stamp, the pool, the source checkout, the board bundle, the composer, the lifecycle reader, the boot
// tools and the image kinds run in-process, and the component, verify and release commands are the ones of
// src/cli.ts they were. One repair: the FIT tools label hashed `Dockerfile.fit fit.sh regdb.sh` under boot/,
// where they had not been since the stages/ move, so the shell hashed nothing there; the port hashes them under
// stages/boot.
import { BACKENDS } from '../image/backends/index.ts'
import { loadBoardFacts } from '../image/board-facts.ts'
import { FIRMWARE_FORMATS } from '../image/firmware-formats.ts'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetch as boardFetch, kernelDir } from '../boards/board-pool.ts'
import { build as buildTools, TOOLS_PLATFORM } from '../boot/build-tools.ts'
import { checkout } from '../locks/source.ts'
import { inputs, rows as lockRows } from '../locks/locks.ts'
import { lifecycle } from '../pool/deploy-pool.ts'
import { fetchPool, index as poolIndex } from '../pool/pool.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { version as treeVersion } from '../release/version.ts'
import { compose } from '../rootfs/build.ts'
import { pack, updateKinds } from './image-kinds.ts'
import { plainValue, product, products } from './product.ts'
import { dockerBin } from '../shared/docker.ts'

export class ProductBuildError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

const CLI = join(REPO_ROOT, 'src/cli.ts')
const USAGE = 'usage: bun src/cli.ts product-build <name> [--verify | --version <v> [--generation <g>] | --release <YYYYMMDD-HHMM> [--generation <g>]]'
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const words = (s: string) => s.split(/[ \t\n]+/).filter(w => w !== '')
const say = (line: string) => console.log(line)

function fail(message: string, code = 1): never {
  throw new ProductBuildError(message, code)
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
  if (mode !== '--release' && mode !== '--version') fail(USAGE)
  o.stamp = argv[2] ?? ''
  if (o.stamp === '') fail(USAGE)
  if (argv.length > 3) {
    if (argv.length !== 5 || argv[3] !== '--generation' || !/^[1-9][0-9]*$/.test(argv[4]!) || Number(argv[4]) < 2)
      fail(`error: ${mode} takes an optional --generation <g>, a decimal of at least 2`)
    o.generation = Number(argv[4])
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

export type ReceiptInputs = { name: string, boardDir: string, kernelDirectory: string, signing: string, release: string, version: string, generation: number }

/** The receipt: what this build reads, the REUSE KEY. The version has a line of its own because `--version <v>`
 * makes it independent of the release and the tree, and it reaches the signed root. */
export function receipt(i: ReceiptInputs): string {
  const strip = (p: string) => (p.startsWith(`${REPO_ROOT}/`) ? p.slice(REPO_ROOT.length + 1) : p)
  const lines: string[] = []
  for (const f of treeFiles(`products/${i.name}`)) lines.push(`${sha256(join(REPO_ROOT, f))}  ${f}`)
  for (const f of treeFiles('locks')) lines.push(`${sha256(join(REPO_ROOT, f))}  ${f}`)
  for (const f of [join(i.boardDir, 'board.env'), join(i.kernelDirectory, 'kernel.release'), join(i.kernelDirectory, 'config'),
    join(i.signing, 'verity/signer.cert.pem'), join(i.signing, 'boot/signer.cert.pem'), join(i.signing, 'updates/public.key')]) lines.push(`${sha256(f)}  ${strip(f)}`)
  lines.push(`tree ${git('rev-parse', 'HEAD').trim()}${git('status', '--porcelain') === '' ? '' : ' dirty'}`)
  lines.push(`release ${i.release === '' ? 'none' : i.release}`)
  lines.push(`version ${i.version}`)
  lines.push(`generation ${i.generation}`)
  return lines.map(l => `${l}\n`).join('')
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
    if (Bun.spawnSync([process.execPath, CLI, 'locks', 'check'], { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, CI: '1' } as Record<string, string> }).exitCode !== 0)
      fail('error: locks/ holds an offline pin (src/cli.ts local-pins) or breaks a rule (see above); a release imports published releases only')
  }
  const signing = process.env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta')
  const out = join(REPO_ROOT, '_out/products', o.name)

  // The product, validated against its fetched board; the board is fetched first so a fresh clone gets a
  // refusal that names the fetch, not a path.
  const envPath = join(REPO_ROOT, 'products', o.name, 'product.env')
  const boardName = existsSync(envPath) ? plainValue(envPath, 'BOARD') : ''
  if (boardName === '') fail(`error: products/${o.name}/product.env declares no BOARD (or the product does not exist; the products are: ${products().map(p => `${p} `).join('')})`)
  if (!existsSync(join(REPO_ROOT, '_out/boards', boardName, 'board.env'))) for (const l of await boardFetch(boardName)) say(l)
  const p = product(o.name)
  // The kernel directory of the product's profile: kernel/<profile> on a FIT board, kernel on a UEFI board.
  const kernelDirectory = kernelDir(p.board, p.profile)
  // The board's backend and firmware format, through their registries (src/image/backends/, src/image/firmware-formats.ts).
  const facts = loadBoardFacts(p.board)
  const backend = BACKENDS[facts.backend], firmwareFormat = FIRMWARE_FORMATS[facts.firmware.format]

  // The signing inputs: public certificates enter the build, private keys sign.
  for (const f of ['verity/signer.key.pem', 'verity/signer.cert.pem', 'boot/signer.key.pem', 'boot/signer.cert.pem', 'updates/signer.key.pem', 'updates/public.key'])
    if (!existsSync(join(signing, f))) fail(`error: ${join(signing, f)} does not exist; the signing workspace is incomplete (development inputs: make os-devkeys)`)
  const publicKey = readFileSync(join(signing, 'updates/public.key'), 'utf8').replace(/\n/g, '')

  if (o.mode === 'verify') {
    // The image is the one SHA256SUMS names; the directory also holds the partition images the assembler built it from.
    const image = imagePath(out)
    if (image.endsWith('/') || !existsSync(image)) fail(`error: ${out}/image holds no image; build the product first (make product PRODUCT=${o.name})`)
    // The connd contract the verifier compares against is read out of mica-core's source at its pinned release.
    checkout('mica-core')
    cli(['verify', '--board', p.board, '--image', image, '--public-key', join(signing, 'updates/public.key')])
    return
  }

  // THE VERSION THIS BUILD IS STAMPED WITH, computed BEFORE the receipt because the receipt records it and
  // BEFORE the compose because /etc/issue and /usr/lib/os-release are written there.
  const version = o.stamp === '' ? treeVersion() : o.stamp
  const want = receipt({ name: o.name, boardDir: p.boardDir, kernelDirectory, signing, release: o.release, version, generation: o.generation })
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

  say(`=== product ${o.name}: compose ===`)
  await compose({ ...process.env, MICA_PRODUCT: o.name, MICA_VERSION: version })

  // The composition (build/) stays; the components are made afresh.
  for (const d of ['lifecycle', 'fit-tools', 'root', 'kernel', 'firmware', 'deployments', 'image', 'records.json', 'update.micaupd', 'updates', 'updates.tsv', 'kinds', 'kinds.tsv', 'release', 'release-notes.md', 'release-packages.tsv', 'receipt.txt'])
    rmSync(join(out, d), { recursive: true, force: true })
  mkdirSync(join(out, 'deployments'), { recursive: true })
  say(`=== product ${o.name}: components at version ${version} ===`)
  say(await lifecycle(p.arch, join(out, 'lifecycle')))
  cli(['components', 'root', '--input', join(out, 'build'), '--arch', p.arch, '--out', join(out, 'root'),
    '--content-key', join(signing, 'verity/signer.key.pem'), '--content-cert', join(signing, 'verity/signer.cert.pem')])
  // THE PACKAGER, built from the pinned stages/boot tree before the kernel component runs in it: a UEFI board's
  // boot-tools image for its EFI architecture, a FIT board's fit-tools image over the board's own mkimage
  // (uboot/tools in the bundle). docker's cache makes an unchanged image free; what this refuses to inherit is a
  // local tag left behind by an older tree, which packaged with the wrong tool names until the next hand-run
  // make os-boot-tools.
  if (backend.packMode === 'fit') {
    // The FIT packaging tools are linux/amd64 on every board and install the amd64 loader archive.
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
    // Its pinned inputs, as the label mica.boot.inputs the kernel component's buildId names (src/boot/build-tools.ts).
    const label = Bun.spawnSync([dockerBin(), 'image', 'inspect', '--format', '{{index .Config.Labels "mica.boot.inputs"}}', 'ai-agent/mica-boot-tools-amd64'], { stdout: 'pipe', stderr: 'inherit' }).stdout.toString().trim()
    const fitInputs = createHash('sha256').update([
      `boot-tools ${label}\nregdb ${regdbUrl} ${regdbSha}\n`,
      ...['Dockerfile.fit', 'fit.sh', 'regdb.sh'].map(f => `${sha256(join(REPO_ROOT, 'stages/boot', f))}  ${f}\n`),
      ...tools.map(t => `${sha256(join(out, 'fit-tools', t))}  ${t}\n`),
    ].join('')).digest('hex')
    const r = Bun.spawnSync([dockerBin(), 'build', '--platform', TOOLS_PLATFORM, '--label', 'ai-agent=true', '--label', `mica.boot.inputs=${fitInputs}`, '-t', 'ai-agent/mica-fit-tools-amd64',
      '--build-arg', 'MICA_BOOT_TOOLS=ai-agent/mica-boot-tools-amd64', '--build-arg', `REGDB_URL=${regdbUrl}`, '--build-arg', `REGDB_SHA256=${regdbSha}`,
      '--build-context', `fit-tools=${join(out, 'fit-tools')}`, '-f', join(REPO_ROOT, 'stages/boot/Dockerfile.fit'), join(REPO_ROOT, 'stages/boot')], { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) fail('', r.exitCode)
  }
  else { buildTools(efiTarget(p.arch)) }
  cli(['components', 'kernel', '--board', p.board, '--profile', p.profile, '--input', kernelDirectory,
    '--runkit', join(out, 'lifecycle/mica-runkit'), '--public-key', publicKey, '--out', join(out, 'kernel'),
    '--content-key', join(signing, 'verity/signer.key.pem'), '--content-cert', join(signing, 'verity/signer.cert.pem'),
    '--boot-key', join(signing, 'boot/signer.key.pem'), '--boot-cert', join(signing, 'boot/signer.cert.pem')])
  if (!firmwareFormat.builtHere) {
    const ubootBinName = firmwareFormat.loaderFile(facts.firmware)
    if (ubootBinName === '' || !existsSync(join(p.boardDir, 'uboot', ubootBinName))) fail(`error: the ${p.board} bundle carries no uboot/${ubootBinName || '?'}; a FIT board's firmware is its loader`)
    cli(['components', 'firmware', '--board', p.board, '--out', join(out, 'firmware'), '--metadata-key', join(signing, 'updates/signer.key.pem'),
      '--generation', '1', '--version', version, '--input', join(p.boardDir, 'uboot', ubootBinName)])
  }
  else {
    cli(['components', 'firmware', '--board', p.board, '--out', join(out, 'firmware'), '--metadata-key', join(signing, 'updates/signer.key.pem'),
      '--generation', '1', '--version', version, '--boot-key', join(signing, 'boot/signer.key.pem'), '--boot-cert', join(signing, 'boot/signer.cert.pem')])
  }
  for (const generation of [o.generation - 1, o.generation]) {
    cli(['components', 'deployment', '--kernel', join(out, 'kernel'), '--root', join(out, 'root'), '--product', o.name, '--generation', String(generation), '--version', version,
      '--metadata-key', join(signing, 'updates/signer.key.pem'), '--out', join(out, 'deployments', `${generation}.json`)])
  }
  writeFileSync(join(out, 'records.json'), JSON.stringify([o.generation - 1, o.generation].map(g => ({ envelope: readFileSync(join(out, 'deployments', `${g}.json`), 'utf8'), kernelDirectory: join(out, 'kernel'), rootDirectory: join(out, 'root') }))))
  say(`=== product ${o.name}: image ===`)
  cli(['components', 'image', '--board', p.board, '--records', join(out, 'records.json'), '--public-key', publicKey,
    '--firmware', join(out, 'firmware'), '--out', join(out, 'image'), ...(p.provisioning === '' ? [] : ['--provisioning', p.provisioning])])
  cli(['components', 'archive', '--input', join(out, 'deployments', `${o.generation}.json`), '--kernel', join(out, 'kernel'), '--root', join(out, 'root'), '--kind', 'full',
    '--public-key', publicKey, '--out', join(out, 'update.micaupd')])
  // The update packages of the product's update kinds (the board's images.tsv update rows): the one signed
  // descriptor with every object (full), or only the root's or the kernel's; updates.tsv names them.
  mkdirSync(join(out, 'updates'), { recursive: true })
  const updates: string[] = []
  for (const row of updateKinds(p.boardDir, words(p.updateKinds))) {
    const file = `updates/mica-${o.name}-${version}.${row.suffix}`
    cli(['components', 'archive', '--input', join(out, 'deployments', `${o.generation}.json`), '--kernel', join(out, 'kernel'), '--root', join(out, 'root'), '--kind', row.kind,
      '--public-key', publicKey, '--out', join(out, file)])
    updates.push(`${row.kind}\t${file}\t${sha256(join(out, file))}\n`)
  }
  writeFileSync(join(out, 'updates.tsv'), updates.join(''))
  // The flashing formats of the product's image kinds, each packed and verified by its board's packer
  // (src/product/image-kinds.ts; the product reader already checked them against the board's images.tsv).
  pack({ out, boardDir: p.boardDir, product: o.name, version, profile: p.profile, release: o.release !== '', kinds: words(p.imageKinds) })
  if (o.release !== '') {
    // THE CHANNEL IS DEVELOPMENT, stated here and nowhere else (user decision 2026-09-14): releases sign with
    // the development trust material, and the release gate refuses development-marked material on the candidate
    // and stable channels (src/image/release-manifest.ts), which stays so. A customer channel is a change to
    // this line together with production keys.
    say(`=== product ${o.name}: release ${o.release}, development channel ===`)
    rmSync(join(out, 'release'), { recursive: true, force: true })
    writeFileSync(join(out, 'release-notes.md'), `# Mica OS ${o.release}\n\nProduct ${o.name} (board ${p.board}, profile ${p.profile}), development channel.\n`)
    const image = imagePath(out)
    // The package inventory the root ships, read out of the signed root: the composer rewrites
    // /usr/share/mica/manifest.tsv to the packages whose files the selection kept.
    const toolsArch = backend.toolsArch(p.arch as 'amd64' | 'arm64')
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
    if (e instanceof Error && ['ProductError', 'ImageKindsError', 'DeployPoolError', 'BuildToolsError', 'BuildError', 'BoardPoolError', 'PoolError', 'SourceError', 'FromError', 'VersionError', 'Exit', 'Refused'].includes(e.constructor.name)) {
      if (e.message !== '') console.error(e.constructor.name === 'SourceError' ? `source: error: ${e.message}` : e.constructor.name === 'PoolError' ? `pool: error: ${e.message}` : e.message)
      return 'code' in e && typeof (e as { code: unknown }).code === 'number' ? (e as { code: number }).code : 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
