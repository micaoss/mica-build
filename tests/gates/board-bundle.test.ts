// tools/board-pool.sh's bundle rules and its assembly of a board's bundle. The rules over fixture bundles: a
// uboot-fit board carries kernel/dev and kernel/prod and no kernel/ of its own, a systemd-boot board one
// kernel/, and --kernel-dir names the directory a product of each profile packs. The assembly over a scratch
// clone of this tree and its first board: the board and firmware components staged from the tree, the kernel
// from a local build under _out/<board>/ when there is one, else from the latest release that published it
// with the same inputs hash -- a file:// release listing and a registry that is this process (Bun.serve,
// handed to src/pool/oci.ts as MICA_OCI_REGISTRY) answering the token, manifest and blob endpoints from files
// -- and refused, by name, when neither is there or the published component is not this board's, this
// domain's or a well-formed one.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/board-bundle.test.ts     (make os-board-bundle-test; no docker)
//
// The port of tests/gates/board-bundle-test.sh (deleted 2026-09-23), case for case; the shell test handed the
// reader a curl of its own, which src/pool/oci.ts no longer runs.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp/board-bundle-test.'))
const CERT = join(SCRATCH, 'cert.pem')
const FIX = join(SCRATCH, 'registry'), RELEASES = join(SCRATCH, 'releases'), REG = 'micaoss/mica-build'
let server: ReturnType<typeof Bun.serve>
let clone: string, board: string, arch: string, kernelFiles: string[], inputsHash: string

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function boardsSh(...args: string[]): string {
  const r = Bun.spawnSync(['bash', join(REPO_ROOT, 'tools/boards.sh'), ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`tools/boards.sh ${args.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

/** tools/board-pool.sh, asynchronously: the registry it may read is this process. */
async function boardPool(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT): Promise<{ ok: boolean, out: string }> {
  const p = Bun.spawn(['bash', join(cwd, 'tools/board-pool.sh'), ...args], { cwd, env: { ...process.env as Record<string, string>, MICA_VERITY_TRUST_CERT: CERT, MICA_BOARDS_OUT: join(SCRATCH, 'boards'), ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { ok: await p.exited === 0, out: out + err }
}

// --- 1. The bundle rules over fixture bundles.
function bundle(name: string, backend: string, ...kernelDirs: string[]): string {
  const dir = join(SCRATCH, 'boards', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'manifests'), { recursive: true }); mkdirSync(join(dir, 'trust'), { recursive: true })
  writeFileSync(join(dir, 'board.env'), `LAYOUT_BOARD=${name}\nBOOT_BACKEND=${backend}\n`)
  writeFileSync(join(dir, 'manifests/board.pkgs'), '')
  writeFileSync(join(dir, 'images.tsv'), '# mica-boards images v1\nimage\tdisk\tbuiltin\tmica-build-env:base\timg\n')
  writeFileSync(join(dir, 'trust/verity-signer.cert.pem'), readFileSync(CERT))
  for (const d of kernelDirs) {
    mkdirSync(join(dir, d), { recursive: true })
    for (const f of ['config', 'kernel.release', 'modules.tar']) writeFileSync(join(dir, d, f), `${d}\n`)
  }
  return dir
}

async function accepts(dir: string): Promise<void> {
  const r = await boardPool(['--check', dir])
  expect(r.ok, r.out).toBe(true)
}

async function refuses(fragment: string, dir: string): Promise<void> {
  const r = await boardPool(['--check', dir])
  expect(r.ok, 'accepted').toBe(false)
  expect(r.out).toContain(fragment)
}

beforeAll(() => {
  writeFileSync(CERT, 'fixture certificate\n')
  mkdirSync(FIX, { recursive: true })
  // The registry: URL -> fixture file, 200 or 404.
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    let file = ''
    if (url.pathname === '/token') file = join(FIX, 'token.json')
    else if (url.pathname.startsWith('/v2/')) file = join(FIX, url.pathname.slice('/v2/'.length))
    if (file === '' || !existsSync(file)) return new Response('not found', { status: 404 })
    return new Response(Bun.file(file))
  } })
})

afterAll(() => {
  server?.stop(true)
  rmSync(SCRATCH, { recursive: true, force: true })
})

test('the bundle rules over fixture bundles', async () => {
  await accepts(bundle('fitboard', 'uboot-fit', 'kernel/dev', 'kernel/prod'))
  await refuses('carries no kernel/prod/config', bundle('fitboard', 'uboot-fit', 'kernel/dev'))
  await refuses('with a kernel/ of its own', bundle('fitboard', 'uboot-fit', 'kernel', 'kernel/dev', 'kernel/prod'))
  await refuses('carries no kernel/dev/config', bundle('fitboard', 'uboot-fit', 'kernel'))
  await accepts(bundle('efiboard', 'systemd-boot', 'kernel'))
  await refuses('with profile kernel directories', bundle('efiboard', 'systemd-boot', 'kernel', 'kernel/dev'))
  await refuses('names no BOOT_BACKEND', bundle('oddboard', 'grub', 'kernel'))
  const dir = bundle('fitboard', 'uboot-fit', 'kernel/dev', 'kernel/prod')
  writeFileSync(join(dir, 'trust/verity-signer.cert.pem'), 'another certificate\n')
  await refuses('verity trust certificate that is not', dir)
})

test('--kernel-dir names the directory a product of each profile packs', async () => {
  bundle('fitboard', 'uboot-fit', 'kernel/dev', 'kernel/prod')
  bundle('efiboard', 'systemd-boot', 'kernel')
  for (const [b, profile, want] of [['fitboard', 'dev', 'boards/fitboard/kernel/dev'], ['fitboard', 'prod', 'boards/fitboard/kernel/prod'], ['efiboard', 'dev', 'boards/efiboard/kernel'], ['efiboard', 'prod', 'boards/efiboard/kernel']]) {
    const r = await boardPool(['--kernel-dir', b!, profile!])
    expect(r.out.trim(), `--kernel-dir ${b} ${profile}`).toBe(join(SCRATCH, want!))
  }
  const staging = await boardPool(['--kernel-dir', 'fitboard', 'staging'])
  expect(staging.ok).toBe(false)
  rmSync(join(SCRATCH, 'boards'), { recursive: true, force: true })
})

// --- 2. --fetch over a scratch clone of this tree and its first board (a UEFI board: one kernel/ of
// bzImage|Image, config, kernel.release, modules.tar and the fragment, as its outputs.tsv lists).
function run(argv: string[], cwd = REPO_ROOT, env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(argv, { cwd, env: { ...process.env as Record<string, string>, ...env }, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

function fetchEnv(): Record<string, string> {
  // MICA_SOURCE_REPO: the clone's origin is a path, and the registry name is this repository's. Both readers
  // are pointed at this process: src/pool/oci.ts through MICA_OCI_REGISTRY, the shell client tools/reuse.sh
  // sources through a registry.env naming the same host over plain HTTP.
  const registryEnv = join(SCRATCH, 'registry.env')
  writeFileSync(registryEnv, `MICA_REGISTRY=127.0.0.1:${server.port}/micaoss\nMICA_REGISTRY_USER=nobody\nMICA_RELEASE_TOKEN_VAR=BUNDLE_TEST_TOKEN\nMICA_SOURCE_URL=https://github.com/micaoss\n`)
  return { MICA_BOARDS_OUT: join(clone, '_out/boards'), MICA_OCI_CACHE: join(SCRATCH, 'cache/oci'), MICA_BOARD_CACHE: join(SCRATCH, 'cache/boards'),
    MICA_OCI_REGISTRY: `http://127.0.0.1:${server.port}`, MICA_REGISTRY_ENV: registryEnv, MICA_REGISTRY_PLAIN_HTTP: '1', MICA_RELEASE_NO_GH: '1', MICA_SOURCE_REPO: 'mica-build',
    MICA_RELEASE_LIST: `file://${join(RELEASES, 'releases.json')}`, MICA_RELEASE_DOWNLOAD: `file://${join(RELEASES, 'download')}` }
}

async function fetchBoard(): Promise<{ ok: boolean, out: string }> {
  return boardPool(['--fetch', board], fetchEnv(), clone)
}

async function fetchRefuses(fragment: string): Promise<void> {
  const r = await fetchBoard()
  expect(r.ok, 'accepted').toBe(false)
  expect(r.out).toContain(fragment)
  expect(existsSync(join(clone, '_out/boards', board)), `left _out/boards/${board} behind`).toBe(false)
}

/** The kernel files under _out/<board>/kernel, as make <board>-kernel leaves them. */
function localBuild(): void {
  const dir = join(clone, '_out', board, 'kernel')
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  for (const f of kernelFiles) writeFileSync(join(dir, f), `local ${f}\n`)
}

type Manifest = { layers: { annotations: Record<string, string> }[], annotations: Record<string, string> }

/** The kernel component of the board in the fixture registry, and a release <label> whose lock names it. */
function publish(label: string, edit: (m: Manifest) => void = () => undefined, editTree: (tree: string) => void = () => undefined): void {
  const tree = join(SCRATCH, 'artifact')
  for (const d of [FIX, tree, RELEASES]) rmSync(d, { recursive: true, force: true })
  for (const d of [join(FIX, REG, 'blobs'), join(FIX, REG, 'manifests'), join(tree, 'kernel'), join(RELEASES, 'download', label)]) mkdirSync(d, { recursive: true })
  writeFileSync(join(FIX, 'token.json'), '{"token":"fixture"}\n')
  for (const f of kernelFiles) writeFileSync(join(tree, 'kernel', f), `published ${f}\n`)
  editTree(tree)
  const files: string[] = []
  const walk = (dir: string, rel: string) => { for (const e of readdirSync(dir).sort()) { const p = join(dir, e); if (statSync(p).isDirectory()) walk(p, `${rel}${e}/`); else files.push(`${rel}${e}`) } }
  walk(tree, '')
  const layers = files.map((f) => {
    const digest = sha(join(tree, f))
    writeFileSync(join(FIX, REG, 'blobs', `sha256:${digest}`), readFileSync(join(tree, f)))
    return { mediaType: 'application/octet-stream', digest: `sha256:${digest}`, size: 1, annotations: { 'org.opencontainers.image.title': f } }
  })
  const commit = 'd'.repeat(40)
  const m: Manifest = { ...{ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType: 'application/vnd.mica.board.kernel',
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2 } }, layers,
  annotations: { 'mica.source-repo': 'mica-build', 'mica.source-commit': commit, 'org.opencontainers.image.revision': commit, 'mica.board': board, 'mica.arch': arch, 'mica.component': 'kernel', 'mica.inputs': inputsHash, 'mica.verity-cert-sha256': sha(CERT) } }
  edit(m)
  const bytes = JSON.stringify(m, null, 2) + '\n'
  const digest = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(FIX, REG, 'manifests', `sha256:${digest}`), bytes)
  writeFileSync(join(RELEASES, 'download', label, 'mica-build.lock'), `# mica-lock v1\nrelease\tmica-build\t${label}\t${commit}\nboard\t${board}\tkernel\t${arch}\tghcr.io/micaoss/mica-build:kernel.${board}.${label.slice(label.indexOf('.') + 1)}@sha256:${digest}\n`)
  writeFileSync(join(RELEASES, 'releases.json'), JSON.stringify([{ tag_name: label, draft: false, assets: [{ name: 'mica-build.lock' }, { name: 'SHA256SUMS' }] }]) + '\n')
}

test('--fetch assembles the board from the tree and a local kernel build, exactly its outputs.tsv', async () => {
  clone = join(SCRATCH, 'clone')
  run(['git', 'clone', '-q', REPO_ROOT, clone])
  const list = run(['git', 'ls-files', '-z'])
  const tar = Bun.spawnSync(['tar', '--null', '-T', '-', '-cf', '-'], { cwd: REPO_ROOT, stdin: Buffer.from(list), stdout: 'pipe', stderr: 'pipe' })
  const untar = Bun.spawnSync(['tar', '-xf', '-', '-C', clone], { stdin: tar.stdout, stdout: 'pipe', stderr: 'pipe' })
  expect(untar.exitCode, untar.stderr.toString()).toBe(0)
  run(['git', '-C', clone, 'add', '-A'])
  if (run(['git', '-C', clone, 'status', '--porcelain']) !== '') run(['git', '-C', clone, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'the working tree under test'])
  board = boardsSh('list').split('\n').filter(b => b !== '').find(b => boardsSh('boot', b).trim() === 'systemd-boot') ?? ''
  expect(board, 'boards/boards.tsv lists no systemd-boot board for this test to assemble').not.toBe('')
  arch = boardsSh('arch', board).trim()
  mkdirSync(join(clone, 'meta/verity'), { recursive: true })
  writeFileSync(join(clone, 'meta/verity/signer.cert.pem'), readFileSync(CERT))
  kernelFiles = boardsSh('files', board, 'kernel').split('\n').filter(l => l !== '').map(l => l.replace(/^kernel\//, ''))
  inputsHash = run(['bash', 'tools/inputs.sh', board, 'kernel'], clone, { VERITY_TRUST_CERT: join(clone, 'meta/verity/signer.cert.pem') }).trim()
  localBuild()
  const r = await fetchBoard()
  expect(r.ok, r.out).toBe(true)
  const out = join(clone, '_out/boards', board)
  expect(readFileSync(join(out, 'kernel/config'), 'utf8')).toBe('local config\n')
  expect(existsSync(join(out, 'board.env'))).toBe(true)
  expect(existsSync(join(out, 'manifests/board.pkgs'))).toBe(true)
  expect(readFileSync(join(out, 'trust/verity-signer.cert.pem'), 'utf8')).toBe(readFileSync(CERT, 'utf8'))
  run(['bash', 'tools/boards.sh', 'bundle-is', board, `_out/boards/${board}`], clone)
  rmSync(join(clone, '_out', board), { recursive: true, force: true }); rmSync(join(clone, '_out/boards'), { recursive: true, force: true })
})

test('no local build and no release: refused', async () => {
  mkdirSync(RELEASES, { recursive: true })
  writeFileSync(join(RELEASES, 'releases.json'), '[]\n')
  await fetchRefuses(`run make ${board}-kernel`)
})

test('--fetch takes the kernel of the latest release that published it with these inputs, by digest', async () => {
  publish(`${board}.20260914-0001`)
  const r = await fetchBoard()
  expect(r.ok, r.out).toBe(true)
  expect(readFileSync(join(clone, '_out/boards', board, 'kernel/config'), 'utf8')).toBe('published config\n')
  run(['bash', 'tools/boards.sh', 'bundle-is', board, `_out/boards/${board}`], clone)
  rmSync(join(clone, '_out/boards'), { recursive: true, force: true })
})

test('a published kernel that is not this board\'s, this domain\'s or a well-formed one is refused by name', async () => {
  publish(`${board}.20260914-0001`, (m) => { m.annotations['mica.inputs'] = '2'.repeat(64) })
  await fetchRefuses(`run make ${board}-kernel`)
  publish(`${board}.20260914-0001`, (m) => { m.annotations['mica.verity-cert-sha256'] = '0'.repeat(64) })
  await fetchRefuses('verity trust certificate that is not')
  publish(`${board}.20260914-0001`, (m) => { m.annotations['mica.component'] = 'uboot' })
  await fetchRefuses(`is not the kernel component of ${board}`)
  publish(`${board}.20260914-0001`, (m) => { m.annotations['mica.source-repo'] = 'mica-boards' })
  await fetchRefuses(`is not the kernel component of ${board}`)
  publish(`${board}.20260914-0001`, (m) => { m.layers[0]!.annotations['org.opencontainers.image.title'] = '../kernel/config' })
  await fetchRefuses('a layer title is not a relative path')
  publish(`${board}.20260914-0001`, () => undefined, tree => writeFileSync(join(tree, 'kernel/extra.bin'), 'extra\n'))
  await fetchRefuses('kernel/extra.bin')
  publish(`${board}.20260914-0001`, () => undefined, tree => rmSync(join(tree, 'kernel/config')))
  await fetchRefuses('kernel/config')
})
