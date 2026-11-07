// The owner keyring fixtures of the acceptance disk (runtime-build.sh), for a kernel with CONFIG_MICA_OWNER_KEYRING:
// two owner identities made as an owner makes one (driver-key init), the kernel's first module signed by each with
// its chain, their CAs in DER (what add_key takes), and owner-keyring, the static helper that drives the keyring the
// way core's runkit does (owner-keyring.c). runtime.sh enrols one CA, seals, and checks which modules load.
//
//   bun tests/suites/lifecycle-uefi/owner-modules.ts BSP_KERNEL ARCH OUT
//   -> OUT/{owner.ko,other.ko,owner-ca.der,other-ca.der,owner-keyring,module.name}
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { init } from '../../../src/drivers/driver-key.ts'
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
writeFileSync(join(out, 'module.name'), `${basename(module, '.ko').replace(/-/g, '_')}\n`)

const image = run(['bash', 'bin/mica-tools', 'from', '--ref', 'mica-build-env:bsp']).trim()
const cc = arch === 'amd64' ? 'gcc' : 'aarch64-linux-gnu-gcc'
const source = realpathSync(join(import.meta.dir, 'owner-keyring.c'))
run([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '--platform', 'linux/amd64', '--user', `${process.getuid!()}:${process.getgid!()}`,
  '-v', `${hostPath(source)}:/owner-keyring.c:ro`, '-v', `${hostPath(out)}:/out`, '--entrypoint', cc, image, '-static', '-O2', '-Wall', '-Werror', '-o', '/out/owner-keyring', '/owner-keyring.c'])
console.log(`owner-modules: ${module} signed by two owners, ${release}`)
