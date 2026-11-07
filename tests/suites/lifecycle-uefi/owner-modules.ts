// The owner keyring fixtures of the acceptance disk (runtime-build.sh), for a kernel with CONFIG_MICA_OWNER_KEYRING:
// two owner identities made as an owner makes one (driver-key init), the kernel's first module signed by each with
// its chain, their CAs in DER (what add_key takes), and owner-keyring, the static helper that drives the keyring the
// way core's runkit does (owner-keyring.c). runtime.sh enrols one CA, seals, and checks which modules load.
//
//   bun tests/suites/lifecycle-uefi/owner-modules.ts BSP_KERNEL ARCH OUT
//   -> OUT/{owner.ko,other.ko,owner-ca.der,other-ca.der,owner-keyring,module.name}, and hello.ko: kdk-hello/ built
//      with the kernel's KDK (kernel/kdk.tar) by driver-ext as the owner, taken out of the extension image
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { build } from '../../../src/drivers/driver-ext.ts'
import { init } from '../../../src/drivers/driver-key.ts'
import { COMPONENT_TOOLS } from '../../../src/image/component-build.ts'
import { Toolbox } from '../../../src/image/toolbox.ts'
import { signModules } from '../../../src/image/module-signing.ts'
import { dockerBin } from '../../../src/shared/docker.ts'
import { hostPath } from '../../../src/shared/host-path.ts'

const [kernelArg, arch, outArg] = Bun.argv.slice(2)
if (!kernelArg || !outArg || (arch !== 'amd64' && arch !== 'arm64')) throw new Error('Usage: owner-modules.ts BSP_KERNEL amd64|arm64 OUT')
const kernel = resolve(kernelArg), out = resolve(outArg)
mkdirSync(out)
const run = (argv: string[]) => {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new Error(`${argv[0]} failed (see above)`)
  return r.stdout.toString()
}

const release = readFileSync(join(kernel, 'kernel.release'), 'utf8').trim()
const unpacked = join(out, '.modules')
mkdirSync(unpacked)
run(['tar', '-xf', join(kernel, 'modules.tar'), '-C', unpacked, `lib/modules/${release}/modules.order`])
const module = readFileSync(join(unpacked, `lib/modules/${release}/modules.order`), 'utf8').split('\n')[0]!
if (!module.endsWith('.ko')) throw new Error(`the kernel's first module is not a .ko: '${module}'`)
run(['tar', '-xf', join(kernel, 'modules.tar'), '-C', unpacked, `lib/modules/${release}/${module}`])

const der = (pem: string) => Buffer.from(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(readFileSync(pem, 'utf8'))![1]!.replace(/\s+/g, ''), 'base64')
for (const [who, name] of [['owner', 'Test owner'], ['other', 'Other owner']] as const) {
  const identity = init(join(out, `.${who}`), name)
  const dir = join(out, `.${who}-signed`)
  mkdirSync(dir)
  copyFileSync(join(unpacked, `lib/modules/${release}`, module), join(dir, basename(module)))
  // The chain form: the signature carries the signing leaf, which the enrolled CA issued.
  signModules(dir, { key: join(identity, 'signer.key.pem'), certificate: join(identity, 'signer.cert.pem') }, {})
  copyFileSync(join(dir, basename(module)), join(out, `${who}.ko`))
  writeFileSync(join(out, `${who}-ca.der`), der(join(identity, 'owner-ca.cert.pem')))
}
// The reference out-of-tree module: built with the KDK and packed by driver-ext as an owner would.
const owner = join(out, '.owner')
await build({ kdk: join(kernel, 'kdk.tar'), src: join(import.meta.dir, 'kdk-hello'), load: ['hello'], name: 'hello', version: '1.0', kernelId: '0'.repeat(64),
  signing: { key: join(owner, 'signer.key.pem'), certificate: join(owner, 'signer.cert.pem') }, out: join(out, '.hello-ext') })
const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [out] })
try { await tb.must(['unsquashfs', '-no-progress', '-d', join(out, '.hello-tree'), join(out, '.hello-ext/ext.img')]) }
finally { await tb.close() }
copyFileSync(join(out, `.hello-tree/modules/${release}/updates/mica-ext/hello/hello.ko`), join(out, 'hello.ko'))
writeFileSync(join(out, 'module.name'), `${basename(module, '.ko').replace(/-/g, '_')}\n`)

const image = run(['bash', 'bin/mica-tools', 'from', '--ref', 'mica-build-env:bsp']).trim()
const cc = arch === 'amd64' ? 'gcc' : 'aarch64-linux-gnu-gcc'
const source = realpathSync(join(import.meta.dir, 'owner-keyring.c'))
run([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--platform', 'linux/amd64', '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-v', `${hostPath(source)}:/owner-keyring.c:ro`, '-v', `${hostPath(out)}:/out`, '--entrypoint', cc, image, '-static', '-O2', '-Wall', '-Werror', '-o', '/out/owner-keyring', '/owner-keyring.c'])
console.log(`owner-modules: ${module} signed by two owners, ${release}`)
