// Sign a root hash with pinned tooling: an RSA-2048 CMS signature over the 64-byte hex root hash, verified
// against the public certificate. Staging a public trust certificate into a kernel or U-Boot build is
// src/boot/trust-stage.ts's.
//
//   bun src/cli.ts verity-tool sign ROOTHASH PRIVATE_KEY CERTIFICATE OUTPUT
//
// The signing runs in the mica-build-env base image (stages/boot/verity-tool-inner.sh, the container side);
// this is the host side: the inputs by their explicit paths, the output refused when it exists, the signature
// linked into place only after the container verified it. The port of boot/verity-tool.sh (deleted
// 2026-09-23), message for message; the component builders call sign() in-process.
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolve as fromResolve } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { hostPath } from '../shared/host-path.ts'

export class VerityToolError extends Error {}

const USAGE = 'usage: verity-tool sign ROOTHASH PRIVATE_KEY CERTIFICATE OUTPUT'
const INNER = join(REPO_ROOT, 'stages/boot/verity-tool-inner.sh')

function die(message: string): never {
  throw new VerityToolError(`verity-tool: ${message}`)
}

function input(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) die(`explicit input is missing: ${path}`)
  return realpathSync(path)
}

/** Sign the root hash file into `output`; the signature's path. */
export function sign(hashPath: string, keyPath: string, certPath: string, outputPath: string): string {
  if (Bun.spawnSync(['docker', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) die('docker is required')
  const image = fromResolve('mica-build-env:base', inputs())
  const hash = input(hashPath), key = input(keyPath), cert = input(certPath)
  let exists = false
  try { lstatSync(outputPath); exists = true }
  catch { exists = false }
  if (exists) die('signature output already exists')
  mkdirSync(dirname(outputPath), { recursive: true })
  const output = resolve(outputPath)
  const parent = dirname(output)
  const temporary = mkdtempSync(join(parent, '.verity.'))
  try {
    const args = ['run', '--rm', '--label', 'ai-agent=true', '--network', 'traefik', '--name', `ai-agent-verity-tool-${process.pid}`,
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '-v', `${hostPath(INNER)}:/tool.sh:ro`,
      '-v', `${hostPath(cert)}:/certificate.pem:ro`,
      '-v', `${hostPath(temporary)}:/output`,
      '-v', `${hostPath(hash)}:/roothash:ro`, '-v', `${hostPath(key)}:/private.pem:ro`,
      '--entrypoint', '/bin/bash', image, '/tool.sh', 'sign']
    const r = Bun.spawnSync(['docker', ...args], { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) die('the signing container failed (see above)')
    linkSync(join(temporary, 'signature'), output)
    return output
  }
  finally {
    rmSync(join(temporary, 'signer.cert.pem'), { force: true })
    rmSync(join(temporary, 'signature'), { force: true })
    try { rmdirSync(temporary) }
    catch { /* left as the shell left it: a directory that is not empty stays */ }
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] !== 'sign') die(USAGE)
    if (argv.length !== 5) die(USAGE)
    sign(argv[1]!, argv[2]!, argv[3]!, argv[4]!)
    return 0
  }
  catch (e) {
    if (e instanceof VerityToolError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
