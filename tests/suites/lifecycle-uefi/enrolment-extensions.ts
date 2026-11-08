// The inputs of the owner enrolment suite (owner-enrolment.sh): the KDK's hello module for each kernel named, by one
// owner, each as the MICAUPD1 archive an owner uploads (driver-ext build --archive), that owner's CA, and the CA of
// a second owner, enrolled only to be confirmed on the console.
//
//   bun tests/suites/lifecycle-uefi/enrolment-extensions.ts BSP_KERNEL OUT KERNEL_ID...
//   -> OUT/hello-<id>/{ext.json,ext.img,ext.roothash.p7s,ext.micaupd}, OUT/owner-ca.der, OUT/second-ca.der
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../src/drivers/driver-ext.ts'
import { init } from '../../../src/drivers/driver-key.ts'

const [kernelArg, outArg, ...kernels] = Bun.argv.slice(2)
if (!kernelArg || !outArg || kernels.length === 0 || !kernels.every(k => /^[0-9a-f]{64}$/.test(k)))
  throw new Error('Usage: enrolment-extensions.ts BSP_KERNEL OUT KERNEL_ID...')
const kernel = resolve(kernelArg), out = resolve(outArg)
mkdirSync(out)
const der = (pem: string) => Buffer.from(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(readFileSync(pem, 'utf8'))![1]!.replace(/\s+/g, ''), 'base64')

const owner = init(join(out, '.owner'), 'Test owner')
const signing = { key: join(owner, 'signer.key.pem'), certificate: join(owner, 'signer.cert.pem') }
for (const kernelId of kernels) {
  await build({ kdk: join(kernel, 'kdk.tar'), src: join(import.meta.dir, 'kdk-hello'), load: ['hello'], name: 'hello', version: '1.0', kernelId,
    signing, out: join(out, `hello-${kernelId}`), archive: true })
}
writeFileSync(join(out, 'owner-ca.der'), der(join(owner, 'owner-ca.cert.pem')))
writeFileSync(join(out, 'second-ca.der'), der(join(init(join(out, '.second'), 'Second owner'), 'owner-ca.cert.pem')))
console.log(`enrolment-extensions: hello archives for ${kernels.join(', ')}, two owner CAs`)
