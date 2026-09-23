// What this tree reads out of the imported mica-podman archives.
//
//   bun src/cli.ts podman-pool --check      the engine's pins, and the arm64 quadlet, out of the pinned archives the pools hold
//
//   reads   _out/debs/<arch>/pool/mica-podman_*.deb   (fetched at the package row by src/cli.ts pool fetch)
//   writes  _out/debs/mica-podman/upstream.lock        (the archives' /usr/share/mica-podman/upstream.lock)
//           _out/debs/arm64/mica-podman/quadlet
//
// The container engine is built and released by micaoss/mica-podman; this repository imports the archives
// through the package rows of locks/mica-podman.lock and never sees that repository's tree. Four of its
// consumers still need two things out of it: the upstream trees the seven binaries were built from (the smoke
// register, the install-closure gate and the netavark kernel check compare what a binary reports against their
// git tags) and the aarch64 quadlet binary (tests/gates/quadlet-doc-test.sh runs the generator the image ships).
// The package carries the first as /usr/share/mica-podman/upstream.lock, which both architectures' archives
// must carry identically; the quadlet is taken when the arm64 pool holds its archive. The port of
// tools/podman-pool.sh (deleted 2026-09-23), message for message; the archives are read by src/pool/deb.ts
// in-process. MICA_POOL_DIR points at another pool root (tests/gates/podman-pool.test.ts).
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { payloadMember } from './deb.ts'
import { REPO_ROOT } from './producers.ts'

export class PodmanPoolError extends Error {}

const LOCK_PATH = 'usr/share/mica-podman/upstream.lock'
const QUADLET_PATH = 'usr/libexec/podman/quadlet'

/** The one mica-podman archive of that pool, or nothing. */
function archiveFor(pool: string, arch: string): string | undefined {
  const dir = join(pool, arch, 'pool')
  if (!existsSync(dir)) return undefined
  const found = readdirSync(dir).filter(f => f.startsWith('mica-podman_') && f.endsWith(`_${arch}.deb`)).sort()
  if (found.length > 1) throw new PodmanPoolError(`error: ${found.length} mica-podman archives in ${dir}; a pool holds one`)
  return found[0] === undefined ? undefined : join(dir, found[0])
}

const relative = (p: string) => (p.startsWith(`${REPO_ROOT}/`) ? p.slice(REPO_ROOT.length + 1) : p)

/** Take upstream.lock (and the arm64 quadlet) out of the pools under `pool`; the summary line. */
export async function check(pool = process.env['MICA_POOL_DIR'] ?? join(REPO_ROOT, '_out/debs')): Promise<string> {
  const locks = new Map<string, Uint8Array>()
  for (const arch of ['amd64', 'arm64']) {
    const archive = archiveFor(pool, arch)
    if (archive === undefined) continue
    locks.set(arch, (await payloadMember(archive, LOCK_PATH)).body)
  }
  if (locks.size === 0) throw new PodmanPoolError(`error: no mica-podman archive in ${pool}/amd64/pool or ${pool}/arm64/pool. locks/mica-podman.lock pins it; fetch it with \`make os-pool\``)
  const amd64 = locks.get('amd64'), arm64 = locks.get('arm64')
  if (amd64 !== undefined && arm64 !== undefined && Buffer.compare(amd64, arm64) !== 0) {
    throw new PodmanPoolError(`error: the amd64 and arm64 mica-podman archives in ${pool} carry different ${LOCK_PATH}; one release builds both from one set of trees\n`
      + `--- amd64\n+++ arm64\n${Buffer.from(amd64).toString()}\n---\n${Buffer.from(arm64).toString()}`)
  }
  mkdirSync(join(pool, 'mica-podman'), { recursive: true })
  writeFileSync(join(pool, 'mica-podman/upstream.lock'), [...locks.values()].at(-1)!)
  let quadlet = ''
  if (arm64 !== undefined) {
    const { body, mode } = await payloadMember(archiveFor(pool, 'arm64')!, QUADLET_PATH)
    const out = join(pool, 'arm64/mica-podman/quadlet')
    mkdirSync(join(pool, 'arm64/mica-podman'), { recursive: true })
    writeFileSync(out, body)
    chmodSync(out, mode & 0o777)
    quadlet = `; arm64 quadlet at ${relative(pool)}/arm64/mica-podman/quadlet`
  }
  return `podman-pool: ${relative(pool)}/mica-podman/upstream.lock from the${[...locks.keys()].map(a => ` ${a}`).join('')} archive(s)${quadlet}`
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 1 || argv[0] !== '--check') { console.error('usage: bun src/cli.ts podman-pool --check'); return 1 }
    console.log(await check())
    return 0
  }
  catch (e) {
    if (e instanceof PodmanPoolError) { console.error(e.message); return 1 }
    if (e instanceof Error && e.constructor.name === 'Exit') { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
