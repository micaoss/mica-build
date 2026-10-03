// Publish an isolated offline test input using the production component format.
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { COMPONENT_TOOLS, coreRecords, describeRoot, packComponent, rootCompression } from '../../../src/image/component-build.ts'
import { loadBoardFacts } from '../../../src/image/board-facts.ts'
import { canonicalJson, componentId, parseDeployment, productFromConf } from '../../../src/image/components.ts'
import { packKernel } from '../../../src/image/kernel-package.ts'
import { loadLayout, partitionOf } from '../../../src/image/file-layout.ts'
import { Toolbox } from '../../../src/image/toolbox.ts'
import { Signer } from '../../../src/shared/update-envelope.ts'

const KINDS = ['root', 'kernel', 'combined', 'bad-health', 'core', 'core-beyond-root']
const [evidenceArg, certArg, keyArg, generationArg, kind, rootDirArg, kernelDirArg, runkitArg, coreDirArg] = Bun.argv.slice(2)
if (!evidenceArg || !certArg || !keyArg || !generationArg || !rootDirArg || !kernelDirArg || !runkitArg || !coreDirArg || !KINDS.includes(kind ?? ''))
  throw new Error(`Usage: update.ts EVIDENCE CERT KEY GENERATION ${KINDS.join('|')} ROOT_COMPONENT KERNEL_COMPONENT MICA_RUNKIT CORES`)

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
let coreDirectory = resolve(coreDirArg)
let core = coreRecords(coreDirectory)
let rootfs = JSON.parse(readFileSync(join(rootDirectory, 'rootfs.json'), 'utf8'))
let kernel = JSON.parse(readFileSync(join(kernelDirectory, 'kernel.json'), 'utf8'))
const board = kernel.board
if (loadBoardFacts(board).backend !== 'systemd-boot') throw new Error(`${board} boots a FIT; this suite boots UEFI boards`)
const arch = kernel.arch
const bsp = resolve(`_out/boards/${board}/kernel`)
const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [evidence, resolve(join(evidence, '../tree')), bsp, coreDirectory] })
try {
  if (kind === 'kernel' || kind === 'combined') {
    const extra = new Signer(generateKeyPairSync('ed25519').privateKey, true).publicKey
    kernelDirectory = join(output, 'kernel')
    kernel = await packKernel({ board, profile: 'dev', kernelDirectory: bsp, runkit: resolve(runkitArg),
      publicKeys: [signer.publicKey, extra], systemPartUuid: partitionOf(loadLayout(`_out/boards/${board}`), 'system').guid,
      dataPartUuid: partitionOf(loadLayout(`_out/boards/${board}`), 'data').guid,
      output: kernelDirectory, contentSigning: signing,
      bootSigning: { key: join(evidence, 'db.key.pem'), certificate: join(evidence, 'db.cert.pem') } }, tb)
  }
  // A core update: the micad component again, with a proof file the updated device must show, over the running
  // kernel and root; beyond-root states a root interface range this tree's roots are not in, so the device refuses it.
  let proof = ''
  if (kind === 'core' || kind === 'core-beyond-root') {
    const micad = core.find(c => c.package === 'micad')
    if (micad === undefined) throw new Error('the product carries no micad core component to update')
    const tree = join(output, 'core-tree')
    const image = join(output, 'micad.squashfs')
    await tb.must(['dd', `if=${join(coreDirectory, 'micad', 'core.img')}`, `of=${image}`, 'bs=4096', `count=${micad.content.verity.dataBlocks}`, 'status=none'])
    await tb.must(['unsquashfs', '-no-progress', '-d', tree, image])
    proof = `core-generation=${generation}\n`
    writeFileSync(join(tree, 'usr/share/doc/micad/core-proof'), proof)
    const next = join(output, 'cores')
    for (const c of core) if (c.package !== 'micad') cpSync(join(coreDirectory, c.package), join(next, c.package), { recursive: true })
    const content = await packComponent(tree, join(next, 'micad'), 'core', signing, tb)
    const record = { ...micad, id: '', content, ...(kind === 'core-beyond-root' ? { root: { min: rootfs.interfaceLevel + 1 } } : {}) }
    record.id = componentId(record)
    writeFileSync(join(next, 'micad', 'core.json'), canonicalJson(record))
    coreDirectory = next
    core = coreRecords(next)
  }
  if (kind !== 'kernel' && kind !== 'core' && kind !== 'core-beyond-root') {
    const tree = join(output, 'tree')
    await tb.must(['cp', '-a', resolve(join(evidence, '../tree')), tree])
    writeFileSync(join(tree, 'etc/mica/component-proof'), `root-generation=${generation}\n`)
    if (kind === 'bad-health') writeFileSync(join(tree, 'etc/mica/health.conf'), 'require=invalid-acceptance-probe\n')
    rootDirectory = join(output, 'root')
    rootfs = describeRoot(arch, await packComponent(tree, rootDirectory, 'rootfs', signing, tb, rootCompression(board)))
    writeFileSync(join(rootDirectory, 'rootfs.json'), canonicalJson(rootfs))
  }
  const product = productFromConf(readFileSync(join(resolve(join(evidence, '../tree')), 'usr/lib/mica/product.conf'), 'utf8'))
  const payload = { schema: 'mica/deployment/v1', board, arch, product, generation, version: `acceptance-${generation}`, dataPolicy: 'unchanged', kernel, rootfs, core }
  // The refused deployment is signed as it is: the parser here refuses it too, which is the point of the case.
  const deployment = kind === 'core-beyond-root' ? JSON.parse(canonicalJson(payload)) : parseDeployment(canonicalJson(payload))
  const id = componentId(deployment)
  const offline = join(output, 'offline')
  mkdirSync(join(offline, 'objects'), { recursive: true })
  for (const [path, artifact] of [
    [join(kernelDirectory, 'boot.efi'), kernel.boot.artifact],
    [join(kernelDirectory, 'support.img'), kernel.support.image],
    [join(kernelDirectory, 'support.roothash.p7s'), kernel.support.signature],
    [join(rootDirectory, 'rootfs.img'), rootfs.content.image],
    [join(rootDirectory, 'rootfs.roothash.p7s'), rootfs.content.signature],
    ...core.flatMap(c => [[join(coreDirectory, c.package, 'core.img'), c.content.image], [join(coreDirectory, c.package, 'core.roothash.p7s'), c.content.signature]] as const),
  ] as const) {
    // Reused component bytes are deliberately absent from the update media: a root update carries the root, a
    // kernel update the kernel, a core update the core component it changes.
    const carried = kind === 'combined'
      ? true
      : kind === 'kernel'
        ? path.startsWith(kernelDirectory + '/')
        : kind === 'core' || kind === 'core-beyond-root'
          ? path.startsWith(join(coreDirectory, 'micad') + '/')
          : path.startsWith(rootDirectory + '/')
    if (!carried) continue
    copyFileSync(path, join(offline, 'objects', artifact.sha256))
  }
  if (proof !== '') writeFileSync(join(offline, 'core-proof'), proof)
  if (kind === 'core-beyond-root') writeFileSync(join(offline, 'expect-refusal'), 'a core component does not run on this root\'s interface level\n')
  writeFileSync(join(offline, 'deployment.json'), JSON.stringify(signer.sign(JSON.parse(canonicalJson(deployment)))))
  writeFileSync(join(offline, 'expected-id'), id)
  writeFileSync(join(output, 'inputs.json'), JSON.stringify({ id, rootDirectory, kernelDirectory, coreDirectory }))
  if (existsSync(join(evidence, 'offline'))) renameSync(join(evidence, 'offline'), join(output, 'previous-offline'))
  cpSync(offline, join(evidence, 'offline'), { recursive: true })
  console.log(`FILE_AB_UPDATE_READY: ${id}`)
}
finally { await tb.close() }
