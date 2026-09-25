// Assemble a fresh full-system acceptance image with isolated development keys.
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { COMPONENT_TOOLS, describeRoot, packComponent } from '../../../src/image/component-build.ts'
import { canonicalJson, componentId, parseDeployment, productFromConf } from '../../../src/image/components.ts'
import { FILE_IMAGE_TOOLS, assembleFileImage } from '../../../src/image/file-image.ts'
import { loadLayout, partitionOf } from '../../../src/image/file-layout.ts'
import { packBootFirmware, packKernel } from '../../../src/image/kernel-package.ts'
import { Toolbox } from '../../../src/image/toolbox.ts'
import { loadBoardFacts } from '../../../src/image/board-facts.ts'
import { Signer } from '../../../src/shared/update-envelope.ts'

const [outputArg, board, kernelArg, certificateArg, keyArg, runkitArg, rootArg] = Bun.argv.slice(2)
if (!outputArg || !board || !kernelArg || !certificateArg || !keyArg || !runkitArg || !rootArg)
  throw new Error('Usage: build.ts OUTPUT BOARD BSP_KERNEL CERTIFICATE CONTENT_KEY MICA_RUNKIT FULL_ROOT_TREE')

// A UEFI board of either architecture; the suite dispatches on its facts.
const facts = loadBoardFacts(board!)
if (facts.backend !== 'systemd-boot') throw new Error(`${board} boots a FIT; this suite boots UEFI boards`)
const output = resolve(outputArg)
mkdirSync(output)
const signing = { certificate: resolve(certificateArg), key: resolve(keyArg) }
const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [output, resolve(kernelArg), resolve(rootArg)] })
try {
  const key = generateKeyPairSync('ed25519').privateKey
  const signer = new Signer(key, true)
  writeFileSync(join(output, 'metadata.key.pem'), key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  writeFileSync(join(output, 'metadata.pub'), signer.publicKey)
  const bootSigning = { key: join(output, 'db.key.pem'), certificate: join(output, 'db.cert.pem') }
  await tb.must(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=file-ab-boot-test', '-keyout', bootSigning.key, '-out', bootSigning.certificate])
  const layout = loadLayout(resolve(`_out/boards/${board}`))
  const kernel = await packKernel({ board, profile: 'dev', kernelDirectory: resolve(kernelArg), runkit: resolve(runkitArg), publicKeys: [signer.publicKey],
    systemPartUuid: partitionOf(layout, 'system').guid, dataPartUuid: partitionOf(layout, 'data').guid, output: join(output, 'kernel'), contentSigning: signing, bootSigning }, tb)
  // The deployment installs on the product the root was composed for.
  const product = productFromConf(readFileSync(join(resolve(rootArg), 'usr/lib/mica/product.conf'), 'utf8'))
  const content = await packComponent(resolve(rootArg), join(output, 'root'), 'rootfs', signing, tb)
  const rootfs = describeRoot(facts.arch, content)
  writeFileSync(join(output, 'root/rootfs.json'), canonicalJson(rootfs))
  packBootFirmware({ output: join(output, 'firmware'), bootSigning, board, metadataKey: join(output, 'metadata.key.pem'), generation: 1, version: 'proof-1' })
  const records = [1, 2].map((generation) => {
    const deployment = parseDeployment(canonicalJson({ schema: 'mica/deployment/v2', board, arch: rootfs.arch, product, generation, version: `proof-${generation}`, dataPolicy: 'unchanged', kernel, rootfs }))
    return { envelope: JSON.stringify(signer.sign(JSON.parse(canonicalJson(deployment)))), kernelDirectory: join(output, 'kernel'), rootDirectory: join(output, 'root') }
  })
  const diskTools = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [output] })
  try {
    await assembleFileImage(layout, records, [signer.publicKey], join(output, 'firmware'), join(output, 'image'), diskTools)
  }
  finally { await diskTools.close() }
  writeFileSync(join(output, 'factory-records.json'), JSON.stringify(records))
  writeFileSync(join(output, 'deployments.json'), JSON.stringify(records.map(r => ({ id: componentId(JSON.parse(Buffer.from(JSON.parse(r.envelope).payload, 'base64').toString())), ...r }))))
  console.log(`File A/B disk: ${output}/image/disk.img`)
}
finally { await tb.close() }
