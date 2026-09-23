// Build the boot packager image for one EFI architecture.
//
//   bun src/cli.ts boot-tools [--target {x64|aa64}]      -> ai-agent/mica-boot-tools-<amd64|arm64>
//
// Its Debian packages come from the one archive the Base release names (the apt row of
// locks/mica-system-base.lock), and its unsigned systemd-boot loader from the Base pool's mica-systemd-boot of
// the target architecture. The producer tools run on amd64; the target selects the produced EFI ABI.
// MICA_BOOT_LOADER_DEB names another copy of the loader; MICA_BOOT_TARGET the target when no argument does.
// The image and the tools it copies in are stages/boot (shell that runs inside the image). The port of
// boot/build-tools.sh (deleted 2026-09-23), message for message and label for label.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs } from '../locks/from.ts'
import { inputs, rows } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'

export class BuildToolsError extends Error {
  constructor(message: string, readonly code = 1) { super(message) }
}

/** Every packaging tools image is linux/amd64; the target selects only the EFI ABI it packs (src/image/kernel-package.ts). */
export const TOOLS_PLATFORM = 'linux/amd64'
const STAGE = join(REPO_ROOT, 'stages/boot')
/** The stage files the image copies in, hashed into its inputs label. */
export const STAGE_FILES = ['Dockerfile', 'initramfs.sh', 'kernel.sh', 'compression.sh', 'elf-closure.sh']
const USAGE = 'usage: boot-tools [--target {x64|aa64}]'

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** The target: the argument, or MICA_BOOT_TARGET, or x64; both given must agree. */
export function target(argv: string[], env: Record<string, string | undefined>): 'x64' | 'aa64' {
  let t = env['MICA_BOOT_TARGET'] ?? 'x64'
  if (argv.length !== 0) {
    if (argv.length !== 2 || argv[0] !== '--target') throw new BuildToolsError(USAGE, 64)
    if (env['MICA_BOOT_TARGET'] !== undefined && t !== argv[1]) throw new BuildToolsError('error: conflicting boot-tools targets', 64)
    t = argv[1]!
  }
  if (t !== 'x64' && t !== 'aa64') throw new BuildToolsError('error: boot-tools target must be x64 or aa64', 64)
  return t
}

/** The image's pinned inputs, as the label mica.boot.inputs: what a kernel component's buildId names of its
 * packager, rather than the local image id, which moves with every rebuild of the same inputs. */
export function inputsLabel(base: string, snapshot: string, t: string, loaderDeb: string): string {
  const lines = [`base ${base}\nsnapshot ${snapshot}\ntarget ${t}\nloader ${sha256(readFileSync(loaderDeb))}\n`]
  for (const f of STAGE_FILES) lines.push(`${sha256(readFileSync(join(STAGE, f)))}  ${f}\n`)
  return sha256(lines.join(''))
}

/** Build the image for the target; its tag. */
export function build(t: 'x64' | 'aa64', env: Record<string, string | undefined> = process.env): string {
  const imageTarget = t === 'x64' ? 'amd64' : 'arm64'
  if (Bun.spawnSync(['docker', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) throw new BuildToolsError('error: docker is required')
  const records = inputs()
  // Both inputs are read, never fetched, here: locks/mica-system-base.lock is committed, and
  // `pool fetch --arch <arch> --packages mica-systemd-boot` puts the loader in place (tools/product-build.sh runs it).
  const apt = rows('apt', 'mica-system-base', undefined, records)
  const snapshotHttps = apt[0]?.[1] ?? ''
  if (snapshotHttps === '') throw new BuildToolsError('error: the boot tools install from the one Debian archive the apt row of locks/mica-system-base.lock names (see above)')
  const snapshot = snapshotHttps.replace(/^https:\/\//, 'http://')
  let loaderDeb = env['MICA_BOOT_LOADER_DEB'] ?? ''
  if (loaderDeb === '') {
    const pool = join(REPO_ROOT, '_out/debs', imageTarget, 'pool')
    const found = existsSync(pool) ? readdirSync(pool).filter(f => f.startsWith('mica-systemd-boot_') && f.endsWith(`_${imageTarget}.deb`)) : []
    if (found.length !== 1) throw new BuildToolsError(`error: expected exactly one mica-systemd-boot archive in _out/debs/${imageTarget}/pool (bash bin/bun.sh src/cli.ts pool fetch --arch ${imageTarget} --packages mica-systemd-boot)`)
    loaderDeb = join(pool, found[0]!)
  }
  const loaderContext = join(REPO_ROOT, '_out/boot-tools', `loader-${imageTarget}`)
  rmSync(loaderContext, { recursive: true, force: true })
  mkdirSync(loaderContext, { recursive: true })
  copyFileSync(loaderDeb, join(loaderContext, 'mica-systemd-boot.deb'))
  const base = buildArgs(['MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim'], records)
  if (base.length !== 2) throw new BuildToolsError('error: the image resolver yielded no base image')
  const label = inputsLabel(base[1]!.slice(base[1]!.indexOf('=') + 1), snapshot, t, loaderDeb)
  const tag = `ai-agent/mica-boot-tools-${imageTarget}`
  const r = Bun.spawnSync(['docker', 'build', '--platform', TOOLS_PLATFORM, '--label', 'ai-agent=true', '--label', `mica.boot.inputs=${label}`, '-t', tag,
    ...base, '--build-arg', `MICA_DEBIAN_SNAPSHOT=${snapshot}`, '--build-arg', `MICA_BOOT_TARGET=${t}`,
    '--build-context', `loader=${loaderContext}`, STAGE], { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new BuildToolsError('error: docker build failed (see above)')
  return tag
}

export async function main(argv: string[]): Promise<number> {
  try {
    build(target(argv, process.env))
    return 0
  }
  catch (e) {
    if (e instanceof BuildToolsError) { console.error(e.message); return e.code }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
