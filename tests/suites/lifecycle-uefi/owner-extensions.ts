// The driver extensions of the extensions suite (extensions.sh), for the kernel the acceptance disk boots: the KDK's
// hello module packed by driver-ext as an owner whose CA the suite enrols (`hello`), and a second module packed by
// an owner never enrolled (`other`, module hello_other, so that only its signature can refuse it). Both are built
// for the booted kernel's id, which extension-install holds them to.
//
//   bun tests/suites/lifecycle-uefi/owner-extensions.ts BSP_KERNEL KERNEL_ID OUT
//   -> OUT/{hello,other}/{ext.json,ext.img,ext.roothash.p7s}, OUT/owner-ca.der
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../src/drivers/driver-ext.ts'
import { init } from '../../../src/drivers/driver-key.ts'

const [kernelArg, kernelId, outArg] = Bun.argv.slice(2)
if (!kernelArg || !outArg || !/^[0-9a-f]{64}$/.test(kernelId ?? '')) throw new Error('Usage: owner-extensions.ts BSP_KERNEL KERNEL_ID OUT')
const kernel = resolve(kernelArg), out = resolve(outArg)
mkdirSync(out)
const der = (pem: string) => Buffer.from(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(readFileSync(pem, 'utf8'))![1]!.replace(/\s+/g, ''), 'base64')

// The second module: the same source under another module name.
const otherSrc = join(out, '.other-src')
cpSync(join(import.meta.dir, 'kdk-hello'), otherSrc, { recursive: true })
renameSync(join(otherSrc, 'hello.c'), join(otherSrc, 'hello_other.c'))
writeFileSync(join(otherSrc, 'Kbuild'), 'obj-m := hello_other.o\n')

for (const [ext, who, src, module] of [['hello', 'Test owner', join(import.meta.dir, 'kdk-hello'), 'hello'], ['other', 'Other owner', otherSrc, 'hello_other']] as const) {
  const identity = init(join(out, `.${ext}-owner`), who)
  await build({ kdk: join(kernel, 'kdk.tar'), src, load: [module], name: ext, version: '1.0', kernelId: kernelId!,
    signing: { key: join(identity, 'signer.key.pem'), certificate: join(identity, 'signer.cert.pem') }, out: join(out, ext) })
  if (ext === 'hello') writeFileSync(join(out, 'owner-ca.der'), der(join(identity, 'owner-ca.cert.pem')))
}
console.log(`owner-extensions: hello (enrolled owner) and other (unenrolled owner) for kernel ${kernelId}`)
