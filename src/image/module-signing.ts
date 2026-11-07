// Kernel module signing: every module of a kernel that checks signatures (CONFIG_MODULE_SIG, the module-signing
// kernel feature) is signed with the mica driver key of the build's channel when the kernel component packs its
// support image; a prod command line enforces the check (MODULE_SIG_ENFORCEMENT). The kernel build signs nothing and holds no private key; its builtin
// keyring holds the certificate (the trust bundle the board's Makefile stages, exported as
// kernel/trusted-keys.pem).
//
// The signature is the kernel's appended form (scripts/sign-file): the module, a detached PKCS#7 signature
// over it, a struct module_signature naming its length, and the magic string. The signature itself is made
// by openssl in the mica-build-env base image (stages/boot/module-sign-inner.sh): RSA PKCS#1 v1.5 over SHA-256
// with no signed attributes, so a module and a key give the same bytes on every build.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as fromResolve } from '../locks/inputs.ts'
import { inputs } from '../locks/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { hostPath } from '../shared/host-path.ts'
import { dockerAvailable, dockerBin } from '../shared/docker.ts'
import type { ContentSigning } from './component-build.ts'

const INNER = join(REPO_ROOT, 'stages/boot/module-sign-inner.sh')
export const MODULE_SIGNATURE_MAGIC = '~Module signature appended~\n'
// PKEY_ID_PKCS7: the signer is named inside the PKCS#7 message, so algo, hash, signer_len and key_id_len are 0.
const PKEY_ID_PKCS7 = 2

/** A module with its detached PKCS#7 signature appended, as the kernel reads it. */
export function appendModuleSignature(module: Buffer, signature: Buffer): Buffer {
  const info = Buffer.alloc(12)
  info[2] = PKEY_ID_PKCS7
  info.writeUInt32BE(signature.length, 8)
  return Buffer.concat([module, signature, info, Buffer.from(MODULE_SIGNATURE_MAGIC)])
}

/** The appended PKCS#7 signature of a module, or undefined when it carries none. */
export function moduleSignature(module: Buffer): Buffer | undefined {
  const magic = Buffer.from(MODULE_SIGNATURE_MAGIC)
  if (module.length < magic.length + 12 || !module.subarray(module.length - magic.length).equals(magic)) return undefined
  const info = module.subarray(module.length - magic.length - 12, module.length - magic.length)
  if (info[2] !== PKEY_ID_PKCS7) return undefined
  const length = info.readUInt32BE(8), end = module.length - magic.length - 12
  return length > 0 && length <= end ? module.subarray(end - length, end) : undefined
}

/** The modules under a directory, sorted. */
export function modulesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.ko') && statSync(join(dir, f)).isFile()).sort()
}

/** True when the kernel config checks module signatures, so its modules are signed. */
export function signsModules(config: string): boolean {
  return config.split('\n').includes('CONFIG_MODULE_SIG=y')
}

/** What a prod command line of a module-signing kernel carries: the signature check enforced, locked down. */
export const MODULE_SIG_ENFORCEMENT = ['module.sig_enforce=1', 'lockdown=integrity'] as const

/** The mica driver key of the build's channel for the kernel in `kernelDirectory`, or undefined when that kernel
 * does not check module signatures: MICA_MODULE_SIGNING (signer.key.pem, signer.cert.pem), else the signing
 * workspace's modules/ (MICA_SIGNING_OUTPUT, default meta/). The kernel embeds the certificate when it is built,
 * so a throwaway key cannot stand in for it. A directory without a config is the packer's to refuse. */
export function channelModuleSigning(kernelDirectory: string, env: NodeJS.ProcessEnv = process.env): ContentSigning | undefined {
  const config = join(kernelDirectory, 'config')
  if (!existsSync(config) || !signsModules(readFileSync(config, 'utf8'))) return undefined
  const dir = env['MICA_MODULE_SIGNING'] || join(env['MICA_SIGNING_OUTPUT'] || join(REPO_ROOT, 'meta'), 'modules')
  return { key: join(dir, 'signer.key.pem'), certificate: join(dir, 'signer.cert.pem') }
}

/** The PEM certificates of a bundle, each normalised to its base64 body. */
function pemBodies(pem: string): string[] {
  return [...pem.matchAll(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/g)].map(m => m[1]!.replace(/\s+/g, ''))
}

/** Why `certificate` is not one of the certificates of the kernel's builtin keyring, or undefined. */
export function untrustedSigner(certificate: string, trustedKeys: string): string | undefined {
  const [cert] = pemBodies(certificate)
  if (cert === undefined) return 'the module signing certificate holds no PEM certificate'
  return pemBodies(trustedKeys).includes(cert) ? undefined : 'the module signing certificate is not in the kernel\'s builtin keyring (kernel/trusted-keys.pem): the kernel would refuse every module it signs'
}

/** Detached signatures beside the files under `dir` named `pattern` (<file>.p7s), made in the signing container. */
function signFiles(dir: string, pattern: string, signing: ContentSigning, chain?: { intermediates?: string }): void {
  if (!dockerAvailable()) throw new Error('Module signing needs docker')
  const file = (p: string) => {
    if (!existsSync(p) || !statSync(p).isFile() || statSync(p).size === 0) throw new Error(`Module signing input is missing: ${p}`)
    return realpathSync(p)
  }
  const key = file(signing.key), cert = file(signing.certificate)
  const image = fromResolve('mica-build-env:base', inputs())
  const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--name', `ai-agent-module-sign-${process.pid}`,
    '--user', `${process.getuid!()}:${process.getgid!()}`, '-e', `SIGN_NAME=${pattern}`,
    '-v', `${hostPath(INNER)}:/sign.sh:ro`, '-v', `${hostPath(cert)}:/certificate.pem:ro`, '-v', `${hostPath(key)}:/private.pem:ro`,
    ...(chain === undefined ? [] : ['-e', 'MODULE_SIGN_CHAIN=1', ...(chain.intermediates === undefined ? [] : ['-v', `${hostPath(file(chain.intermediates))}:/chain.pem:ro`])]),
    '-v', `${hostPath(realpathSync(dir))}:/modules`, '--entrypoint', '/bin/bash', image, '/sign.sh'], { stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new Error('Module signing failed (see above)')
}

/** Sign every module under `dir` in place; the number signed. A module already signed is refused. With `chain`,
 * each signature carries the signer's certificate and, when it names a file, those intermediates: an owner's key,
 * trusted through the CA a device enrolled rather than the kernel's builtin keyring. */
export function signModules(dir: string, signing: ContentSigning, chain?: { intermediates?: string }): number {
  const modules = modulesUnder(dir)
  for (const m of modules) if (moduleSignature(readFileSync(join(dir, m))) !== undefined) throw new Error(`Module is already signed: ${m}`)
  if (modules.length === 0) return 0
  signFiles(dir, '*.ko', signing, chain)
  for (const m of modules) {
    const path = join(dir, m), signature = `${path}.p7s`
    writeFileSync(path, appendModuleSignature(readFileSync(path), readFileSync(signature)))
    rmSync(signature)
  }
  return modules.length
}

/** A detached signature of `dir`/`name` beside it (<name>.p7s), in the form a module's: a driver extension's root
 * hash, which the kernel verifies against the keyring the owner's CA was enrolled into. */
export function signDetached(dir: string, name: string, signing: ContentSigning, chain?: { intermediates?: string }): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || !existsSync(join(dir, name))) throw new Error(`Module signing input is missing: ${join(dir, name)}`)
  if (existsSync(join(dir, `${name}.p7s`))) throw new Error(`Signature exists: ${join(dir, `${name}.p7s`)}`)
  signFiles(dir, name, signing, chain)
}
