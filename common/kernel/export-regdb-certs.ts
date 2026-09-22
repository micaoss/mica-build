// mica-build-side: container -- export the built-in regulatory trust certificates from the configured kernel.
//
//   bun export-regdb-certs.ts <kernel-source> <out.pem>
//
// <kernel-source> holds the built kernel's .config, net/wireless/certs/*.hex and arch/arm64/boot/Image (the
// board kernel Dockerfiles stage exactly those three out of the BSP build). Every certificate's DER must be
// present in the Image, or the kernel does not trust what its config says it trusts. Runs in a stage on the
// build-env base image, whose openssl writes the PEM. The port of export-regdb-certs.py (deleted 2026-09-22).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function exit(message: string): never {
  console.error(message)
  process.exit(1)
}

const [source, output] = Bun.argv.slice(2) as [string, string]
const config = readFileSync(join(source, '.config'), 'utf8').split('\n')
for (const option of ['CFG80211_REQUIRE_SIGNED_REGDB', 'CFG80211_USE_KERNEL_REGDB_KEYS'])
  if (!config.includes(`CONFIG_${option}=y`)) exit(`Missing built-in ${option}`)

const certsDir = join(source, 'net/wireless/certs')
const certs = readdirSync(certsDir).filter(n => n.endsWith('.hex')).sort()
if (certs.length === 0) exit('No kernel regulatory certificates')
const image = readFileSync(join(source, 'arch/arm64/boot/Image'))
const pems: Buffer[] = []
for (const cert of certs) {
  const der = Buffer.from([...readFileSync(join(certsDir, cert), 'utf8').matchAll(/0x([0-9a-fA-F]{2})/g)].map(m => parseInt(m[1]!, 16)))
  if (der.length === 0 || image.indexOf(der) < 0) exit(`Regulatory certificate is absent from the built kernel: ${cert}`)
  const r = Bun.spawnSync(['openssl', 'x509', '-inform', 'DER', '-outform', 'PEM'], { stdin: der, stdout: 'pipe', stderr: 'inherit' })
  if (r.exitCode !== 0) exit(`openssl x509 failed on ${cert}: exit ${r.exitCode}`)
  pems.push(Buffer.from(r.stdout))
}
writeFileSync(output, Buffer.concat(pems))
