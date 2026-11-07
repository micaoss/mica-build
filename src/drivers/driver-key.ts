// An owner's driver signing identity, made offline: the CA a device admin enrols on a device, and a signing leaf
// under it that signs modules and driver extensions (src/drivers/driver-ext.ts). Nothing of mica's signs or
// issues it; a device trusts it once its admin has enrolled owner-ca.cert.pem.
//
//   bun src/cli.ts driver-key init --out NEW_DIRECTORY [--name NAME] [--type rsa|ecdsa]
//   -> owner-ca.cert.pem   the certificate to enrol (public)
//      owner-ca.key.pem    the CA key: keep it offline; it issues further signing leaves
//      signer.key.pem      the signing key the driver tools take (--key)
//      signer.cert.pem     its certificate (--cert), which every signature carries
//
// rsa is RSA-3072; ecdsa is P-256, which a kernel verifies only with CONFIG_CRYPTO_ECDSA. The keys are made by
// openssl in the mica-build-env base image (stages/drivers/driver-key-inner.sh), with no network.
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolve as fromResolve } from '../locks/inputs.ts'
import { inputs } from '../locks/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { hostPath } from '../shared/host-path.ts'
import { dockerAvailable, dockerBin } from '../shared/docker.ts'

const INNER = join(REPO_ROOT, 'stages/drivers/driver-key-inner.sh')
const USAGE = 'usage: driver-key init --out NEW_DIRECTORY [--name NAME] [--type rsa|ecdsa]'

export class DriverKeyError extends Error {}

/** Make an owner's driver signing identity in `out`, which must not exist; the files' directory. */
export function init(out: string, name = 'Device owner', type: 'rsa' | 'ecdsa' = 'rsa'): string {
  if (existsSync(out)) throw new DriverKeyError(`driver-key: ${out} exists; the identity is made into a new directory`)
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) throw new DriverKeyError('driver-key: the name is letters, digits, spaces and ._- (at most 64)')
  if (!dockerAvailable()) throw new DriverKeyError('driver-key: docker is required')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const dir = realpathSync(out)
  const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--name', `ai-agent-driver-key-${process.pid}`,
    '--user', `${process.getuid!()}:${process.getgid!()}`, '-v', `${hostPath(INNER)}:/key.sh:ro`, '-v', `${hostPath(dir)}:/out`,
    '--entrypoint', '/bin/bash', fromResolve('mica-build-env:base', inputs()), '/key.sh', type, name], { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new DriverKeyError('driver-key: the key container failed (see above)')
  return dir
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { out: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' } } })
    if (positionals.join(' ') !== 'init' || values.out === undefined) throw new DriverKeyError(USAGE)
    if (values.type !== undefined && values.type !== 'rsa' && values.type !== 'ecdsa') throw new DriverKeyError(USAGE)
    const dir = init(values.out, values.name, values.type as 'rsa' | 'ecdsa' | undefined)
    console.log(`driver-key: enrol ${join(dir, 'owner-ca.cert.pem')} on the device; keep owner-ca.key.pem offline; sign with signer.key.pem and signer.cert.pem`)
    return 0
  }
  catch (e) {
    if (e instanceof DriverKeyError || (e instanceof TypeError && 'code' in e)) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
