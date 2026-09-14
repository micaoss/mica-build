// Build a complete current-system rotation fixture with disposable trust keys.
import { spawnSync } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Signer } from '../../shared/update-envelope.ts'
import { artifactFile, COMPONENT_TOOLS, describeRoot } from '../../build/src/component-build.ts'
import { canonicalJson, componentId, parseDeployment } from '../../build/src/components.ts'
import { assembleFileImage, FILE_IMAGE_TOOLS } from '../../build/src/file-image.ts'
import { parseFileLayout } from '../../build/src/file-layout.ts'
import { packBootFirmware, packKernel } from '../../build/src/kernel-package.ts'
import { Toolbox } from '../../build/src/toolbox.ts'
import { loadBoardFacts } from '../../build/src/board-facts.ts'

const [workArg, baselineArg, runkitArg, oldCertArg, oldKeyArg, boardArg] = Bun.argv.slice(2)
if (!workArg || !baselineArg || !runkitArg || !oldCertArg || !oldKeyArg || !boardArg) throw new Error('Usage: trust-rotation.ts KERNEL_WORK BASELINE MICA_RUNKIT CONTENT_CERT CONTENT_KEY BOARD')
const board = boardArg
const facts = loadBoardFacts(board)
if (facts.backend !== 'systemd-boot') throw new Error(`${board} boots a FIT; this suite boots UEFI boards`)
const work = resolve(workArg)
const baseline = resolve(baselineArg)
const output = join(work, 'boot')
mkdirSync(output)
const oldContent = { certificate: resolve(oldCertArg), key: resolve(oldKeyArg) }
const newContent = { certificate: join(work, 'content-next.crt'), key: join(work, 'content-next.key') }
const oldSigner = new Signer(createPrivateKey(readFileSync(join(baseline, 'metadata.key.pem'))), false)
const newKey = generateKeyPairSync('ed25519').privateKey
const newSigner = new Signer(newKey, false)
writeFileSync(join(output, 'metadata-next.pem'), newKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
for (const name of ['db.cert.pem', 'db.key.pem']) copyFileSync(join(baseline, name), join(output, name))
const oldBoot = { certificate: join(output, 'db.cert.pem'), key: join(output, 'db.key.pem') }
const newBoot = { certificate: join(output, 'db-next.cert.pem'), key: join(output, 'db-next.key.pem') }
const layout = parseFileLayout(readFileSync(`_out/boards/${board}/board.env`, 'utf8'))
const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [work, baseline] })
try {
  await tb.must(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=MICA-boot-rotation-lab', '-keyout', newBoot.key, '-out', newBoot.certificate])
  const kernel = async (name: string, source: string, trust: string[], contentSigning: typeof oldContent, bootSigning: typeof oldBoot) => {
    const directory = join(output, name)
    await packKernel({ board, profile: 'dev', kernelDirectory: join(work, source, 'kernel'), runkit: resolve(runkitArg),
      publicKeys: trust, systemPartUuid: layout.partitions[1]!.guid, dataPartUuid: layout.partitions[2]!.guid,
      output: directory, contentSigning, bootSigning }, tb)
    return directory
  }
  const firstKernel = await kernel('kernel', 'overlap', [oldSigner.publicKey, newSigner.publicKey], oldContent, oldBoot)
  const transitionKernel = await kernel('kernel-transition', 'overlap', [newSigner.publicKey], newContent, newBoot)
  const nextKernel = await kernel('kernel-next', 'next', [newSigner.publicKey], newContent, newBoot)
  const oldRoot = join(baseline, 'root')
  const nextRoot = join(output, 'root-next')
  mkdirSync(nextRoot)
  for (const name of ['rootfs.img', 'rootfs.roothash']) copyFileSync(join(oldRoot, name), join(nextRoot, name))
  const result = spawnSync('bash', ['boot/verity-tool.sh', 'sign', join(nextRoot, 'rootfs.roothash'), newContent.key, newContent.certificate, join(nextRoot, 'rootfs.roothash.p7s')], { timeout: 120000, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`New content signing failed: ${result.stderr}`)
  const content = JSON.parse(readFileSync(join(oldRoot, 'rootfs.json'), 'utf8')).content
  content.signature = artifactFile(join(nextRoot, 'rootfs.roothash.p7s'))
  writeFileSync(join(nextRoot, 'rootfs.json'), canonicalJson(describeRoot('amd64', 'new-content-key', content)))
  copyFileSync(join(baseline, 'firmware/BOOTX64.EFI'), join(output, 'original-loader.efi'))
  packBootFirmware({ board, output: join(output, 'firmware'), metadataKey: join(baseline, 'metadata.key.pem'), generation: 1, version: 'rotation-1', bootSigning: oldBoot })
  packBootFirmware({ board, output: join(output, 'firmware-next'), metadataKey: join(output, 'metadata-next.pem'), generation: 2, version: 'rotation-2', bootSigning: newBoot })
  const record = (generation: number, kernelDirectory: string, rootDirectory: string, signer: Signer) => {
    const kernel = JSON.parse(readFileSync(join(kernelDirectory, 'kernel.json'), 'utf8'))
    const rootfs = JSON.parse(readFileSync(join(rootDirectory, 'rootfs.json'), 'utf8'))
    const deployment = parseDeployment(canonicalJson({ schema: 'mos/deployment/v1', board, arch: facts.arch, generation, version: `rotation-${generation}`, dataPolicy: 'unchanged', kernel, rootfs }))
    return { id: componentId(deployment), envelope: JSON.stringify(signer.sign(JSON.parse(canonicalJson(deployment)))), kernelDirectory, rootDirectory, deployment }
  }
  const factory = [1, 2].map(generation => record(generation, firstKernel, oldRoot, oldSigner))
  const diskTools = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts: [work, baseline] })
  try { await assembleFileImage(layout, factory, [oldSigner.publicKey, newSigner.publicKey], join(output, 'firmware'), join(output, 'image'), diskTools) }
  finally { await diskTools.close() }
  const records = [record(3, firstKernel, nextRoot, newSigner), record(4, transitionKernel, nextRoot, newSigner),
    record(5, nextKernel, nextRoot, newSigner), record(6, nextKernel, oldRoot, newSigner)]
  for (const record of records) {
    const directory = join(output, 'updates', String(record.deployment.generation))
    const objects = join(directory, 'offline/objects')
    mkdirSync(objects, { recursive: true })
    const { kernel: k, rootfs: r } = record.deployment
    for (const [path, artifact] of [[join(record.kernelDirectory, 'boot.efi'), k.boot.artifact], [join(record.kernelDirectory, 'support.img'), k.support.image],
      [join(record.kernelDirectory, 'support.roothash.p7s'), k.support.signature], [join(record.rootDirectory, 'rootfs.img'), r.content.image],
      [join(record.rootDirectory, 'rootfs.roothash.p7s'), r.content.signature]] as const) copyFileSync(path, join(objects, artifact.sha256))
    writeFileSync(join(directory, 'offline/deployment.json'), record.envelope)
    writeFileSync(join(directory, 'offline/expected-id'), record.id)
    writeFileSync(join(directory, 'inputs.json'), JSON.stringify(record))
  }
  writeFileSync(join(output, 'public-keys.json'), JSON.stringify([oldSigner.publicKey, newSigner.publicKey]))
  writeFileSync(join(output, 'records.json'), JSON.stringify(records))
  console.log(`TRUST_ROTATION_IMAGE_READY: ${output}`)
} finally { await tb.close() }
