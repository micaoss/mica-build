// The whole build of this checkout, locally: what CI builds, from the clean commit and the inputs it pins,
// with nothing published.
//
//   bun src/cli.ts board-offline            (make board-offline; docker; on an x64 host the arm64 pool is emulated)
//
//   reads   meta/verity/signer.cert.pem, meta/boot/signer.cert.pem   (or VERITY_TRUST_CERT, FIT_TRUST_CERT: the
//                                                                      public certificates, which must be the ones
//                                                                      trust-certificates.sha256 records)
//   writes  _out/<board>/                     every board's kernel and firmware (make kernels firmware)
//           _out/debs/<amd64|arm64>/          both pools: pool/, Packages, SHA256SUMS, manifest.txt (make
//                                             board-pool), gated per architecture and across both (make
//                                             board-package-gate)
//           _out/components/<board>/<component>/  each board's components (kernel, uboot, firmware and the
//                                             board's own files), each with its inputs hash beside it
//           _out/boards/<board>/              THE ASSEMBLED BUNDLE: the same shape a consumer FETCHES from a
//                                             release -- the board component's files at the root, kernel/,
//                                             uboot/ and firmware/ beside them, outputs.tsv among them --
//                                             verified against outputs.tsv as a whole
//
// The boards are boards/boards.tsv's, and each one's outputs must be what its outputs.tsv lists: the archives of
// its pool and exactly each component's files. A dirty tree is refused: every archive carries the commit it was
// built from. _out/debs, _out/boards and _out/components are replaced, so they hold only this commit's build.
// The port of tools/offline.sh (deleted 2026-09-25), step for step.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { board, boards, bundleIs, check, packages, poolHas } from '../boards/boards.ts'
import { list as componentList, stage } from '../boards/component.ts'
import { hash as inputsHash } from '../boards/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'

export class OfflineError extends Error {}

function die(message: string): never {
  throw new OfflineError(`offline: error: ${message}`)
}

function sh(argv: string[], env: Record<string, string> = {}): void {
  const r = Bun.spawnSync(argv, { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env } })
  if (r.exitCode !== 0) die(`${argv.join(' ')} failed (status ${r.exitCode})`)
}

function sha256(path: string): string {
  return new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')
}

/** A certificate the environment names, else meta/'s, resolved and checked against trust-certificates.sha256. */
export function trustCert(env: string | undefined, recorded: string, label: string, root = REPO_ROOT): string {
  const named = env || recorded
  let path: string
  try { path = realpathSync(resolve(root, named)) }
  catch { die(`no ${label} certificate at ${named}`) }
  const want = readFileSync(join(root, 'trust-certificates.sha256'), 'utf8').split('\n')
    .map(l => /^([0-9a-f]{64}) {2}(.+)$/.exec(l)).find(m => m?.[2] === recorded)?.[1]
  if (want === undefined) die(`trust-certificates.sha256 records no ${recorded}`)
  if (sha256(path) !== want) die(`${path} is not the certificate trust-certificates.sha256 records for ${recorded}`)
  return path
}

export function offline(): string[] {
  const git = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  if (git.exitCode !== 0 || git.stdout.toString() !== '') die('the tree has uncommitted changes; commit them, then build')
  console.log(check())
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: REPO_ROOT, stdout: 'pipe' }).stdout.toString().trim()

  const verity = trustCert(process.env.VERITY_TRUST_CERT, 'meta/verity/signer.cert.pem', 'verity')
  const fit = trustCert(process.env.FIT_TRUST_CERT, 'meta/boot/signer.cert.pem', 'FIT boot')

  for (const d of ['_out/debs', '_out/boards', '_out/components']) rmSync(join(REPO_ROOT, d), { recursive: true, force: true })
  sh(['make', 'kernels', 'firmware', `VERITY_TRUST_CERT=${verity}`, `FIT_TRUST_CERT=${fit}`])
  sh(['make', 'board-pool'], { VERITY_TRUST_CERT: verity })
  sh(['make', 'board-package-gate', 'GATE_ARGS=--arch amd64'])
  sh(['make', 'board-package-gate', 'GATE_ARGS=--arch arm64'])
  sh(['make', 'board-package-gate', 'GATE_ARGS=--static'])
  // The version guard compares with a published release, which an offline build does not read.
  console.log('offline: warning: the package-version guard (src/cli.ts version-guard) is not run offline; packages carry their declared versions, unchecked against the latest releases')

  for (const { name, arch } of boards()) {
    poolHas(name, join(REPO_ROOT, '_out/debs', arch, 'pool'))
    mkdirSync(join(REPO_ROOT, '_out/boards', name), { recursive: true })
    for (const component of componentList(name)) {
      const dir = join(REPO_ROOT, '_out/components', name, component)
      stage(name, component, dir, verity)
      writeFileSync(`${dir}.inputs.sha256`, inputsHash(name, component, undefined, { verity, fit }) + '\n')
      // ...and into the bundle. A component's paths are already bundle-relative (the board component's at the
      // root, kernel/ under kernel), so the components compose into exactly the tree a release publishes.
      cpSync(dir, join(REPO_ROOT, '_out/boards', name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
    }
    // AN OFFLINE BUILD ASSEMBLES THE SAME BUNDLE A RELEASE DOES: a consumer building from source and one
    // building from a release read one shape with one reader (local-pins reads the bundle).
    bundleIs(name, join(REPO_ROOT, '_out/boards', name))
  }

  const lines = [`offline: built ${commit}`, `offline: kernels and firmware  ${REPO_ROOT}/_out/<board>/`]
  for (const a of ['amd64', 'arm64']) {
    const sums = join(REPO_ROOT, '_out/debs', a, 'SHA256SUMS')
    const n = existsSync(sums) ? readFileSync(sums, 'utf8').split('\n').filter(l => l !== '').length : 0
    lines.push(`offline: ${a} pool  ${REPO_ROOT}/_out/debs/${a}/ (${n} archives)`)
  }
  for (const { name } of boards()) {
    const arch = board(name).arch
    lines.push(`offline: ${name} (${arch})  pool ${REPO_ROOT}/_out/debs/${arch}/ (${packages(name).length} archives listed), bundle ${REPO_ROOT}/_out/boards/${name}/ (components ${REPO_ROOT}/_out/components/${name}/{${componentList(name).join(',')}}/)`)
  }
  return lines
}

export function main(argv: string[]): number {
  if (argv.length !== 0) { console.error('usage: bun src/cli.ts board-offline'); return 2 }
  try {
    for (const l of offline()) console.log(l)
    return 0
  }
  catch (e) {
    if (e instanceof OfflineError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['BoardsError', 'ComponentError', 'InputsError', 'ProducersError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
