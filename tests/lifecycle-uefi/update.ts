// Publish an isolated offline test input using the production component format.
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { COMPONENT_TOOLS, describeRoot, packComponent } from '../../build/src/component-build.ts'
import { loadBoardFacts } from '../../build/src/board-facts.ts'
import { canonicalJson, componentId, parseDeployment } from '../../build/src/components.ts'
import { packKernel } from '../../build/src/kernel-package.ts'
import { parseFileLayout } from '../../build/src/file-layout.ts'
import { Toolbox } from '../../build/src/toolbox.ts'
import { Signer } from '../../shared/update-envelope.ts'

const [evidenceArg, certArg, keyArg, generationArg, kind, rootDirArg, kernelDirArg, runkitArg] = Bun.argv.slice(2)
if (!evidenceArg || !certArg || !keyArg || !generationArg || !rootDirArg || !kernelDirArg || !runkitArg || !['root', 'kernel', 'combined', 'bad-health'].includes(kind ?? '')) {
  throw new Error('Usage: update.ts EVIDENCE CERT KEY GENERATION root|kernel|combined|bad-health ROOT_COMPONENT KERNEL_COMPONENT MICA_RUNKIT')
}
const evidence = resolve(evidenceArg)
const generation = Number(generationArg)
if (!Number.isSafeInteger(generation) || generation < 3) throw new Error('Invalid test generation')
const output = join(evidence, 'updates', String(generation))
mkdirSync(join(evidence, 'updates'), { recursive: true })
mkdirSync(output)
const signer = new Signer(createPrivateKey(readFileSync(join(evidence, 'metadata.key.pem'))), true)
const signing = { certificate: resolve(certArg), key: resolve(keyArg) }
let rootDirectory = resolve(rootDirArg)
let kernelDirectory = resolve(kernelDirArg)
let rootfs = JSON.parse(readFileSync(join(rootDirectory, 'rootfs.json'), 'utf8'))
let kernel = JSON.parse(readFileSync(join(kernelDirectory, 'kernel.json'), 'utf8'))
const board = kernel.board
if (loadBoardFacts(board).backend !== 'systemd-boot') throw new Error(`${board} boots a FIT; this suite boots UEFI boards`)
const arch = kernel.arch
const bsp = resolve(`_out/boards/${board}/kernel`)
const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [evidence, resolve(join(evidence, '../tree')), bsp] })
try {
  if (kind === 'kernel' || kind === 'combined') {
    const extra = new Signer(generateKeyPairSync('ed25519').privateKey, true).publicKey
    kernelDirectory = join(output, 'kernel')
    kernel = await packKernel({ board, profile: 'dev', kernelDirectory: bsp, runkit: resolve(runkitArg),
      publicKeys: [signer.publicKey, extra], systemPartUuid: parseFileLayout(readFileSync(`_out/boards/${board}/board.env`, 'utf8')).partitions[1]!.guid,
      dataPartUuid: parseFileLayout(readFileSync(`_out/boards/${board}/board.env`, 'utf8')).partitions[2]!.guid,
      output: kernelDirectory, contentSigning: signing,
      bootSigning: { key: join(evidence, 'db.key.pem'), certificate: join(evidence, 'db.cert.pem') } }, tb)
  }
  if (kind !== 'kernel') {
    const tree = join(output, 'tree')
    await tb.must(['cp', '-a', resolve(join(evidence, '../tree')), tree])
    writeFileSync(join(tree, 'etc/mica/component-proof'), `root-generation=${generation}\n`)
    if (kind === 'bad-health') writeFileSync(join(tree, 'etc/mica/health.conf'), 'require=invalid-acceptance-probe\n')
    rootDirectory = join(output, 'root')
    rootfs = describeRoot(arch, `acceptance-${generation}`, await packComponent(tree, rootDirectory, 'rootfs', signing, tb))
    writeFileSync(join(rootDirectory, 'rootfs.json'), canonicalJson(rootfs))
  }
  const deployment = parseDeployment(canonicalJson({ schema: 'mica/deployment/v1', board, arch, generation,
    version: `acceptance-${generation}`, dataPolicy: 'unchanged', kernel, rootfs }))
  const id = componentId(deployment)
  const offline = join(output, 'offline')
  mkdirSync(join(offline, 'objects'), { recursive: true })
  for (const [path, artifact] of [
    [join(kernelDirectory, 'boot.efi'), kernel.boot.artifact],
    [join(kernelDirectory, 'support.img'), kernel.support.image],
    [join(kernelDirectory, 'support.roothash.p7s'), kernel.support.signature],
    [join(rootDirectory, 'rootfs.img'), rootfs.content.image],
    [join(rootDirectory, 'rootfs.roothash.p7s'), rootfs.content.signature],
  ] as const) {
    // Reused component bytes are deliberately absent from the update media.
    if (kind !== 'combined' && (kind === 'kernel' ? path.startsWith(rootDirectory + '/') : path.startsWith(kernelDirectory + '/'))) continue
    copyFileSync(path, join(offline, 'objects', artifact.sha256))
  }
  writeFileSync(join(offline, 'deployment.json'), JSON.stringify(signer.sign(JSON.parse(canonicalJson(deployment)))))
  writeFileSync(join(offline, 'expected-id'), id)
  writeFileSync(join(output, 'inputs.json'), JSON.stringify({ id, rootDirectory, kernelDirectory }))
  if (existsSync(join(evidence, 'offline'))) renameSync(join(evidence, 'offline'), join(output, 'previous-offline'))
  cpSync(offline, join(evidence, 'offline'), { recursive: true })
  console.log(`FILE_AB_UPDATE_READY: ${id}`)
} finally { await tb.close() }
