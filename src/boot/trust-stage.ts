// Stage a public certificate bundle as the trust context a kernel or U-Boot build embeds.
//
//   bun src/cli.ts trust-stage CERTIFICATE_BUNDLE CONTEXT_PARENT
//   -> prints CONTEXT_PARENT/<sha256>, a directory holding exactly signer.cert.pem (the bundle, byte for
//      byte) and sha256 (its digest)
//
// The bundle is validated by common/trust/stage-inner.sh in the mica-build-env base image
// (locks/mica-build-env.lock, which carries openssl): non-empty PEM certificates only, no private key or other
// material, parseable by OpenSSL. This repository takes only public certificates (VERITY_TRUST_CERT,
// FIT_TRUST_CERT); the private keys and signing stay with the assembly. The container needs no network. The
// port of common/trust/stage.sh (deleted 2026-09-23), message for message; the boards' Makefiles call it.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as fromResolve } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { hostPath } from '../shared/host-path.ts'

export class TrustStageError extends Error {}

const INNER = join(REPO_ROOT, 'common/trust/stage-inner.sh')

function die(message: string): never {
  throw new TrustStageError(`trust-stage: ${message}`)
}

const same = (a: string, b: string) => existsSync(a) && existsSync(b) && Buffer.compare(readFileSync(a), readFileSync(b)) === 0

/** Stage `bundle` under `parent`; the context directory's path. */
export function stage(bundle: string, parent: string): string {
  if (Bun.spawnSync(['docker', '--version'], { stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) die('docker is required')
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : die('unsupported build architecture')
  const image = fromResolve(`mica-build-env:base@${arch}`, inputs())
  if (!existsSync(bundle) || !statSync(bundle).isFile() || statSync(bundle).size === 0) die(`explicit input is missing: ${bundle}`)
  const cert = realpathSync(bundle)
  mkdirSync(parent, { recursive: true })
  const parentReal = realpathSync(parent)
  const temporary = mkdtempSync(join(parentReal, '.trust.'))
  try {
    const r = Bun.spawnSync(['docker', 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--name', `ai-agent-trust-stage-${process.pid}`,
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '-v', `${hostPath(INNER)}:/stage.sh:ro`,
      '-v', `${hostPath(cert)}:/certificate.pem:ro`,
      '-v', `${hostPath(temporary)}:/output`,
      '--entrypoint', '/bin/bash', image, '/stage.sh'], { stdout: 'inherit', stderr: 'inherit' })
    if (r.exitCode !== 0) die(`the certificate bundle was refused: ${bundle}`)
    const digest = readFileSync(join(temporary, 'sha256'), 'utf8').replace(/\n$/, '')
    if (!/^[0-9a-f]{64}$/.test(digest)) die('invalid staged certificate digest')
    const destination = join(parentReal, digest)
    let moved = false
    try { renameSync(temporary, destination); moved = true }
    catch { moved = false }
    if (!moved) {
      if (!existsSync(destination) || lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) die('invalid existing trust context')
      if (!same(join(temporary, 'signer.cert.pem'), join(destination, 'signer.cert.pem'))) die('existing trust context differs')
      if (!same(join(temporary, 'sha256'), join(destination, 'sha256'))) die('existing trust digest differs')
      if (readdirSync(destination).length !== 2) die('unexpected material in trust context')
    }
    return destination
  }
  finally {
    rmSync(join(temporary, 'signer.cert.pem'), { force: true })
    rmSync(join(temporary, 'sha256'), { force: true })
    try { rmdirSync(temporary) }
    catch { /* moved into place, or not empty */ }
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv.length !== 2) die('usage: trust-stage CERTIFICATE_BUNDLE CONTEXT_PARENT')
    console.log(stage(argv[0]!, argv[1]!))
    return 0
  }
  catch (e) {
    if (e instanceof TrustStageError) { console.error(e.message); return 1 }
    if (e instanceof Error && ['FromError', 'Exit', 'Refused'].includes(e.constructor.name)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
