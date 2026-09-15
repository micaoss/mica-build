import { loadBoardFacts } from './board-facts.ts'
import { parseArgs } from 'node:util'
import { createPrivateKey } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Signer } from '../../shared/update-envelope.ts'
import { packArchive } from './component-archive.ts'
import { artifactFile, COMPONENT_TOOLS, describeRoot } from './component-build.ts'
import { canonicalJson, componentId, deploymentIdentity, parseDeployment, validateVerityImage, type VerityImage } from './components.ts'
import { assembleFileImage, FILE_IMAGE_TOOLS } from './file-image.ts'
import { parseFileLayout } from './file-layout.ts'
import { packBootFirmware, packKernel } from './kernel-package.ts'
import { maintainFirmware } from './firmware-maintenance.ts'
import { factoryImageFilename } from './image-name.ts'
import { fileSha256 } from './release-manifest.ts'
import { REPO_ROOT } from './paths.ts'
import { Toolbox } from './toolbox.ts'

const USAGE = `Usage: bash build/run.sh --components COMMAND [OPTIONS]
  root        --input COMPOSED_ROOT --arch ARCH --version VERSION --out DIR
              --content-key FILE --content-cert FILE
  kernel      --input BSP_KERNEL --runkit MICA_RUNKIT --profile dev|prod --public-key BASE64 (repeatable)
              --board BOARD --out DIR --content-key FILE --content-cert FILE
              --boot-key FILE --boot-cert FILE
  firmware    --board BOARD --out DIR --metadata-key FILE --generation N --version VERSION
              UEFI: --boot-key FILE --boot-cert FILE; FIT boards: --input BOARD_LOADER
  firmware-maintain --board BOARD --input FIRMWARE_PACKAGE --installed SIGNED_RECEIPT
              --public-key BASE64 (repeatable) --out RECOVERY_DIR
              UEFI: --esp OFFLINE_MOUNT; a rockchip-loader board: --rkdeveloptool EXECUTABLE
  deployment  --kernel DIR --root DIR --product PRODUCT --generation N --version VERSION
              --metadata-key FILE --out FILE
  image       --records FILE --public-key BASE64 (repeatable) --firmware DIR
              --board BOARD --out DIR
              [--provisioning FILE]  a factory seed (mica-provisioning.toml on the ESP; UEFI boards only)
  archive     --input DEPLOYMENT --kernel DIR --root DIR --kind full|root|kernel
              --public-key BASE64 (repeatable) --out FILE.micaupd
  identity    --input DEPLOYMENT --public-key BASE64 (repeatable) --out FILE
              one line: product, board, generation, deployment id, kernel id, rootfs id (tab-separated)

Paths are relative to the repository root. Signing inputs are explicit.
The image records file is an array of {envelope, kernelDirectory, rootDirectory}.
Image output: mica-BOARD-YYYYMMDD-HHmmss.img (UTC) and SHA256SUMS; prints the image path.
`

async function main() {
  const options: Record<string, { type: 'string' | 'boolean', multiple?: boolean }> = Object.fromEntries([
    'input', 'arch', 'version', 'out', 'content-key', 'content-cert', 'runkit', 'board', 'boot-key', 'boot-cert',
    'kernel', 'root', 'generation', 'metadata-key', 'records', 'firmware', 'installed', 'esp', 'rkdeveloptool', 'provisioning', 'profile', 'product', 'kind',
  ].map(name => [name, { type: 'string' }]))
  options['public-key'] = { type: 'string', multiple: true }
  options.help = { type: 'boolean' }
  const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, strict: true, options })
  if (values.help) { console.log(USAGE); return }
  if (positionals.length !== 1) throw new Error(USAGE)
  const value = (name: string): string => {
    const item = values[name]
    if (typeof item !== 'string' || !item) throw new Error(`Missing --${name}\n${USAGE}`)
    return item
  }
  const path = (name: string) => resolve(REPO_ROOT, value(name))
  const output = path('out')
  if (existsSync(output)) throw new Error(`Output exists: ${output}`)
  const signing = () => ({ key: path('content-key'), certificate: path('content-cert') })
  const bootSigning = () => ({ key: path('boot-key'), certificate: path('boot-cert') })
  const keys = (): string[] => {
    const list = values['public-key']
    if (!Array.isArray(list) || !list.length) throw new Error('At least one --public-key is required')
    return list.map(item => { if (typeof item !== 'string') throw new Error('Invalid public key'); return item })
  }
  const layout = () => parseFileLayout(readFileSync(join(REPO_ROOT, '_out', 'boards', value('board'), 'board.env'), 'utf8'))
  // A pinned, fetched board: loadBoardFacts refuses anything else by name.
  const kernelBoard = () => loadBoardFacts(value('board')).board
  mkdirSync(dirname(output), { recursive: true })
  switch (positionals[0]) {
    case 'firmware-maintain': {
      const firmware = maintainFirmware({ board: kernelBoard(), input: path('input'), installed: path('installed'),
        keys: keys(), recovery: output, ...(values.esp ? { esp: path('esp') } : {}),
        ...(values.rkdeveloptool ? { rkdeveloptool: path('rkdeveloptool') } : {}) })
      console.log(`Firmware readback verified: ${firmware.id}`)
      break
    }
    case 'archive': {
      const kind = value('kind')
      if (kind !== 'full' && kind !== 'root' && kind !== 'kernel') throw new Error('--kind must be full, root or kernel')
      packArchive(readFileSync(path('input'), 'utf8'), path('kernel'), path('root'), keys(), output, kind)
      break
    }
    case 'identity': {
      const i = deploymentIdentity(readFileSync(path('input'), 'utf8'), keys())
      writeFileSync(output, [i.product, i.board, i.generation, i.deployment, i.kernel, i.rootfs].join('\t') + '\n', { flag: 'wx' })
      break
    }
    case 'root': {
      const input = path('input')
      const pairs = readFileSync(join(input, 'rootfs-verity.env'), 'utf8').trim().split('\n').map(line => {
        const pair = /^([A-Z_]+)=([a-z0-9]+)$/.exec(line)
        if (!pair) throw new Error('Invalid root build parameters')
        return [pair[1]!, pair[2]!]
      })
      const data = Object.fromEntries(pairs)
      const parameters = ['VERITY_ROOT_HASH', 'VERITY_SALT', 'VERITY_HASH_ALGO', 'VERITY_DATA_BLOCK_SIZE',
        'VERITY_HASH_BLOCK_SIZE', 'VERITY_DATA_BLOCKS', 'VERITY_HASH_START_BLOCK', 'VERITY_DATA_SECTORS', 'SQUASHFS_BYTES', 'IMAGE_BYTES']
      if (pairs.length !== parameters.length || parameters.some(name => !Object.hasOwn(data, name))) throw new Error('Duplicate or missing root build parameters')
      const integer = (name: string) => {
        const number = Number(data[name])
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${name}`)
        return number
      }
      if (data.VERITY_HASH_ALGO !== 'sha256' || integer('VERITY_DATA_BLOCK_SIZE') !== 4096 || integer('VERITY_HASH_BLOCK_SIZE') !== 4096) throw new Error('Unsupported root geometry')
      const work = `${output}.building`
      mkdirSync(work)
      const image = join(work, 'rootfs.img')
      copyFileSync(join(input, 'rootfs-verity.img'), image)
      const hash = data.VERITY_ROOT_HASH!
      if (!/^[0-9a-f]{64}$/.test(hash) || !/^[0-9a-f]{64}$/.test(data.VERITY_SALT!)) throw new Error('Invalid root hash or salt')
      const metadata = artifactFile(image)
      if (metadata.bytes !== integer('IMAGE_BYTES') || integer('SQUASHFS_BYTES') !== integer('VERITY_DATA_BLOCKS') * 4096
        || integer('VERITY_HASH_START_BLOCK') !== integer('VERITY_DATA_BLOCKS')
        || integer('VERITY_DATA_SECTORS') * 512 !== integer('SQUASHFS_BYTES')) throw new Error('Root geometry mismatch')
      const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [work] })
      try {
        await tb.must(['veritysetup', 'verify', image, image, hash, '--no-superblock', '--data-blocks', data.VERITY_DATA_BLOCKS!, '--hash-offset', data.SQUASHFS_BYTES!, '--salt', data.VERITY_SALT!])
        const check = join(work, 'mountpoint-check')
        await tb.must(['unsquashfs', '-no-progress', '-d', check, image, 'usr/lib/modules', 'usr/lib/firmware'])
        for (const leaf of ['usr/lib/modules', 'usr/lib/firmware']) {
          const mountpoint = join(check, leaf)
          if (!existsSync(mountpoint) || !lstatSync(mountpoint).isDirectory() || readdirSync(mountpoint).length !== 0) {
            throw new Error(`Rootfs must have an empty kernel support mountpoint: ${leaf}`)
          }
        }
        rmSync(check, { recursive: true })
      } finally { await tb.close() }
      writeFileSync(join(work, 'rootfs.roothash'), hash)
      const material = signing()
      const signed = spawnSync('bash', [join(REPO_ROOT, 'boot/verity-tool.sh'), 'sign', join(work, 'rootfs.roothash'), material.key, material.certificate, join(work, 'rootfs.roothash.p7s')], { encoding: 'utf8', timeout: 120000 })
      if (signed.status !== 0) throw new Error(`Content signing failed: ${signed.error?.message ?? signed.signal ?? signed.status}: ${signed.stderr}`)
      const content: VerityImage = { image: metadata, rootHash: hash, signature: artifactFile(join(work, 'rootfs.roothash.p7s')),
        verity: { version: 1, algorithm: 'sha256', dataBlockSize: 4096, hashBlockSize: 4096, dataBlocks: integer('VERITY_DATA_BLOCKS'), hashOffset: integer('SQUASHFS_BYTES'), salt: data.VERITY_SALT! } }
      validateVerityImage(content)
      writeFileSync(join(work, 'rootfs.json'), canonicalJson(describeRoot(value('arch'), value('version'), content)))
      renameSync(work, output)
      break
    }
    case 'kernel': {
      const input = path('input')
      const board = layout()
      const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [input, dirname(output)] })
      try {
        const profile = value('profile')
        if (profile !== 'dev' && profile !== 'prod') throw new Error('--profile must be dev or prod')
        await packKernel({ board: kernelBoard(), profile, kernelDirectory: input, runkit: path('runkit'), publicKeys: keys(), systemPartUuid: board.partitions[1]!.guid, dataPartUuid: board.partitions[2]!.guid,
          output, contentSigning: signing(), bootSigning: bootSigning() }, tb)
      } finally { await tb.close() }
      break
    }
    case 'firmware': {
      const board = kernelBoard()
      const metadata = { output, metadataKey: path('metadata-key'), generation: Number(value('generation')), version: value('version') }
      packBootFirmware(loadBoardFacts(board).backend === 'uboot-fit' ? { ...metadata, board, input: path('input') } : { ...metadata, board, bootSigning: bootSigning() })
      break
    }
    case 'deployment': {
      const kernel = JSON.parse(readFileSync(join(path('kernel'), 'kernel.json'), 'utf8'))
      const rootfs = JSON.parse(readFileSync(join(path('root'), 'rootfs.json'), 'utf8'))
      const deployment = parseDeployment(canonicalJson({ schema: 'mica/deployment/v2', board: kernel.board, arch: kernel.arch, product: value('product'),
        generation: Number(value('generation')), version: value('version'), dataPolicy: 'unchanged', kernel, rootfs }))
      const signer = new Signer(createPrivateKey(readFileSync(path('metadata-key'))), false)
      writeFileSync(output, JSON.stringify(signer.sign(JSON.parse(canonicalJson(deployment)))), { flag: 'wx' })
      console.log(`Deployment ${componentId(deployment)}`)
      break
    }
    case 'image': {
      const input = JSON.parse(readFileSync(path('records'), 'utf8'))
      if (!Array.isArray(input)) throw new Error('Expected factory deployment records')
      const records = input.map(record => {
        if (!record || Object.keys(record).sort().join() !== 'envelope,kernelDirectory,rootDirectory'
          || [record.envelope, record.kernelDirectory, record.rootDirectory].some(value => typeof value !== 'string')) throw new Error('Invalid factory deployment record')
        return { envelope: record.envelope, kernelDirectory: resolve(REPO_ROOT, record.kernelDirectory), rootDirectory: resolve(REPO_ROOT, record.rootDirectory) }
      })
      const provisioning = typeof values.provisioning === 'string' && values.provisioning ? resolve(REPO_ROOT, values.provisioning) : undefined
      const mounts = [dirname(output), ...records.flatMap(record => [record.kernelDirectory, record.rootDirectory]), ...(provisioning ? [dirname(provisioning)] : [])]
      const tb = await Toolbox.open(FILE_IMAGE_TOOLS, { mounts })
      let disk: string
      try { disk = await assembleFileImage(layout(), records, keys(), path('firmware'), output, tb, { provisioning }) }
      finally { await tb.close() }
      const filename = factoryImageFilename(value('board'), new Date())
      const image = join(output, filename)
      renameSync(disk, image)
      writeFileSync(join(output, 'SHA256SUMS'), `${fileSha256(image)}  ${filename}\n`, { flag: 'wx' })
      console.log(image)
      return
    }
    default: throw new Error(USAGE)
  }
  console.log(output)
}
if (import.meta.main) main().catch(error => { console.error(error.message); process.exitCode = 1 })
