// The driver extensions of the extension trial suite (extension-trials.sh), all by one owner whose CA the suite
// enrols: the KDK's hello module for the booted kernel (`hello`, 1.0), a change to it that restarts the machine as
// its module loads (`crash`, hello 2.0, so that no boot of its trial comes up), and hello 1.0 for each further
// kernel an update brings (`hello-<kernel id>`).
//
//   bun tests/suites/lifecycle-uefi/trial-extensions.ts BSP_KERNEL OUT KERNEL_ID [KERNEL_ID...]
//   -> OUT/{hello,crash,hello-<id>...}/{ext.json,ext.img,ext.roothash.p7s}, OUT/owner-ca.der
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../src/drivers/driver-ext.ts'
import { init } from '../../../src/drivers/driver-key.ts'

const [kernelArg, outArg, ...kernels] = Bun.argv.slice(2)
if (!kernelArg || !outArg || kernels.length === 0 || !kernels.every(k => /^[0-9a-f]{64}$/.test(k)))
  throw new Error('Usage: trial-extensions.ts BSP_KERNEL OUT KERNEL_ID [KERNEL_ID...]')
const kernel = resolve(kernelArg), out = resolve(outArg)
mkdirSync(out)
const der = (pem: string) => Buffer.from(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(readFileSync(pem, 'utf8'))![1]!.replace(/\s+/g, ''), 'base64')

const hello = join(import.meta.dir, 'kdk-hello')
const crash = join(out, '.crash-src')
cpSync(hello, crash, { recursive: true })
writeFileSync(join(crash, 'hello.c'), `// SPDX-License-Identifier: GPL-2.0
#include <linux/module.h>
#include <linux/init.h>
#include <linux/reboot.h>

static int __init hello_init(void) { pr_emerg("mica hello: restarting the machine\\n"); emergency_restart(); return 0; }
module_init(hello_init);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("A KDK module whose load restarts the machine");
`)

const identity = init(join(out, '.owner'), 'Test owner')
const signing = { key: join(identity, 'signer.key.pem'), certificate: join(identity, 'signer.cert.pem') }
const [booted, ...updates] = kernels as [string, ...string[]]
for (const [dir, src, version, kernelId] of [
  ['hello', hello, '1.0', booted], ['crash', crash, '2.0', booted], ...updates.map(k => [`hello-${k}`, hello, '1.0', k] as const),
] as const)
  await build({ kdk: join(kernel, 'kdk.tar'), src, load: ['hello'], name: 'hello', version, kernelId, signing, out: join(out, dir) })
writeFileSync(join(out, 'owner-ca.der'), der(join(identity, 'owner-ca.cert.pem')))
console.log(`trial-extensions: hello 1.0 and 2.0 (restarts) for ${booted}, hello 1.0 for ${updates.join(', ') || 'no update'}`)
