// The owner keyring fixtures of the acceptance disk (runtime-build.sh), for a kernel with CONFIG_MICA_OWNER_KEYRING:
// two owner identities made as an owner makes one (driver-key init); the reference out-of-tree module
// (kdk-hello/) built with the kernel's KDK (kernel/kdk.tar) and packed by driver-ext as each owner, taken out of
// the extension image; their CAs in DER (what add_key takes); and owner-keyring, the static helper that drives the
// keyring the way core's runkit does (owner-keyring.c). runtime.sh enrols one CA, seals, and checks which load.
// The module is the KDK's own rather than one the kernel ships: a shipped module the suite has already loaded
// and removed need not load again in QEMU.
//
//   bun tests/suites/lifecycle-uefi/owner-modules.ts BSP_KERNEL ARCH OUT
//   -> OUT/{owner.ko,other.ko,owner-ca.der,other-ca.der,owner-keyring,module.name}
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from '../../../src/drivers/driver-ext.ts'
import { init } from '../../../src/drivers/driver-key.ts'
import { COMPONENT_TOOLS } from '../../../src/image/component-build.ts'
import { Toolbox } from '../../../src/image/toolbox.ts'
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
const der = (pem: string) => Buffer.from(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(readFileSync(pem, 'utf8'))![1]!.replace(/\s+/g, ''), 'base64')
for (const [who, name] of [['owner', 'Test owner'], ['other', 'Other owner']] as const) {
  const identity = init(join(out, `.${who}`), name)
  // The chain form: each module signature carries the signing leaf, which the owner's CA issued.
  await build({ kdk: join(kernel, 'kdk.tar'), src: join(import.meta.dir, 'kdk-hello'), load: ['hello'], name: 'hello', version: '1.0', kernelId: '0'.repeat(64),
    signing: { key: join(identity, 'signer.key.pem'), certificate: join(identity, 'signer.cert.pem') }, out: join(out, `.${who}-ext`) })
  const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [out] })
  try { await tb.must(['unsquashfs', '-no-progress', '-d', join(out, `.${who}-tree`), join(out, `.${who}-ext/ext.img`)]) }
  finally { await tb.close() }
  copyFileSync(join(out, `.${who}-tree/modules/${release}/updates/mica-ext/hello/hello.ko`), join(out, `${who}.ko`))
  writeFileSync(join(out, `${who}-ca.der`), der(join(identity, 'owner-ca.cert.pem')))
}
writeFileSync(join(out, 'module.name'), 'hello\n')

const image = run(['bash', 'bin/mica-tools', 'from', '--ref', 'mica-build-env:bsp']).trim()
const cc = arch === 'amd64' ? 'gcc' : 'aarch64-linux-gnu-gcc'
const source = realpathSync(join(import.meta.dir, 'owner-keyring.c'))
run([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--platform', 'linux/amd64', '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-v', `${hostPath(source)}:/owner-keyring.c:ro`, '-v', `${hostPath(out)}:/out`, '--entrypoint', cc, image, '-static', '-O2', '-Wall', '-Werror', '-o', '/out/owner-keyring', '/owner-keyring.c'])
console.log(`owner-modules: the KDK's hello module packed by two owners, ${release}`)
