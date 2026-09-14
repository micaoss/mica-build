import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { artifactFile } from '../../build/src/component-build.ts'
import { authenticatePayload, componentId, parseDeployment, type Artifact, type VerityImage } from '../../build/src/components.ts'
import type { FileLayout } from '../../build/src/file-layout.ts'
import { encodeFitEnvironment } from '../../build/src/fit-environment.ts'
import { loadBoardFacts } from '../../build/src/board-facts.ts'
import { authenticateFirmware } from '../../build/src/firmware.ts'
import { debugfsRun, e2fsckClean, ext4List, ext4Super, extractRange, fatCopyOut, fatList, fatReadFile,
  readBytes, readGpt, sgdiskVerify, squashfsExtract, verityVerify, type GptTable } from './image.ts'
import type { ToolRuntime } from './tools.ts'

function requireFact(ok: boolean, fact: string): asserts ok {
  if (!ok) throw new Error(fact)
}

export function checkFactoryGpt(layout: FileLayout, table: GptTable, bytes: number): void {
  requireFact(bytes === layout.sizeSectors * 512 && table.totalSectors === layout.sizeSectors
    && table.sectorSize === 512 && table.diskGuid.toLowerCase() === layout.diskGuid
    && table.partitions.length === 3, 'Factory GPT size, identity or partition count mismatch')
  for (const expected of layout.partitions) {
    const actual = table.partitions.find(p => p.number === expected.number)
    requireFact(actual !== undefined && actual.firstSector === expected.startSector
      && actual.lastSector === expected.startSector + expected.sizeSectors - 1
      && actual.sizeSectors === expected.sizeSectors && actual.name.toLowerCase() === expected.name.toLowerCase()
      && actual.typeGuid.toLowerCase() === expected.type && actual.uniqueGuid.toLowerCase() === expected.guid
      && actual.attributeFlags === '0000000000000000', `Factory GPT mismatch: ${expected.name}`)
  }
}

export function authenticateFactoryRecords(envelopes: string[], publicKeys: string[], board: string) {
  requireFact(envelopes.length === 2, 'Factory image requires exactly two signed deployment records')
  const records = envelopes.map(envelope => {
    const deployment = parseDeployment(authenticatePayload(envelope, publicKeys))
    requireFact(deployment.board === board, 'Factory deployment board mismatch')
    return { id: componentId(deployment), deployment }
  }).toSorted((a, b) => b.deployment.generation - a.deployment.generation)
  requireFact(new Set(records.map(r => r.id)).size === 2
    && new Set(records.map(r => r.deployment.generation)).size === 2, 'Duplicate factory deployment identity or generation')
  return records
}

/** Read-only inspection of a complete factory image. Boot trust enforcement is a separate boot gate. */
export async function verifyFactoryImage(layout: FileLayout, image: string, publicKeys: string[], workDir: string,
  tools: ToolRuntime, report: (fact: string) => void): Promise<string[]> {
  mkdirSync(workDir, { recursive: true })
  const table = await readGpt(tools, image)
  checkFactoryGpt(layout, table, statSync(image).size)
  const gpt = await sgdiskVerify(tools, image)
  requireFact(gpt.clean, 'GPT CRC or backup table verification failed')
  report('current three-partition factory GPT and backup table')
  const extracted = layout.partitions.map(p => extractRange(image, p.startSector * 512, p.sizeSectors * 512, join(workDir, `${p.name}.img`)))
  const system = extracted[1]!, data = extracted[2]!
  for (const [index, file] of [[1, system], [2, data]] as const) {
    const p = layout.partitions[index]!, fs = await ext4Super(tools, file)
    requireFact(fs.uuid.toLowerCase() === p.fsUuid && fs.volumeName === p.name.toLowerCase()
      && fs.blockSize === 4096 && fs.blockCount * fs.blockSize === p.sizeSectors * 512
      && fs.features.includes('has_journal') && !fs.features.includes('needs_recovery')
      && !fs.features.includes('orphan_file') && !fs.features.includes('metadata_csum_seed'), `${p.name} filesystem identity, geometry or features mismatch`)
    const checked = await e2fsckClean(tools, file)
    requireFact(checked.clean, `${p.name} filesystem is not clean: ${checked.report.join('; ')}`)
    if (index === 2) requireFact(fs.features.includes('project') && fs.features.includes('quota'), 'DATA project quotas absent')
  }
  report('clean SYSTEM and DATA ext4, including DATA project quotas')
  let serial = 0
  const dump = async (fs: string, path: string, expectedBytes?: number) => {
    requireFact(/^\/[A-Za-z0-9/_.-]+$/.test(path), 'Invalid image member path')
    const info = await debugfsRun(tools, fs, `stat ${path}`)
    requireFact(/Type:\s+regular/.test(info), `Image member is not regular: ${path}`)
    const size = Number(/Size:\s+(\d+)/.exec(info)?.[1])
    requireFact(Number.isSafeInteger(size) && size >= 0 && size === (expectedBytes ?? size)
      && (expectedBytes !== undefined || size <= 16384), `Image member size mismatch: ${path}`)
    const target = join(workDir, `member-${serial++}`)
    await debugfsRun(tools, fs, `dump ${path} ${JSON.stringify(target)}`)
    requireFact(statSync(target).size === size, `Short extracted image member: ${path}`)
    return target
  }
  const names = (await ext4List(tools, system, '/deployments')).filter(e => e.name !== '.' && e.name !== '..')
  requireFact(names.length === 2 && names.every(e => /^[0-9a-f]{64}\.json$/.test(e.name) && /^10/.test(e.mode)), 'Invalid factory deployment directory')
  const envelopes: string[] = []
  for (const name of names) envelopes.push(readFileSync(await dump(system, `/deployments/${name.name}`), 'utf8'))
  const records = authenticateFactoryRecords(envelopes, publicKeys, layout.board)
  requireFact(records.every(r => names.some(n => n.name === `${r.id}.json`)), 'Deployment filenames do not match authenticated identities')
  report('two distinct authenticated factory deployments')
  const fit = layout.backend === 'uboot-fit', esp = { image: extracted[0]!, offsetBytes: 0 }
  const verified = new Map<string, string>()
  const checkArtifact = (file: string, expected: Artifact) => {
    const actual = artifactFile(file)
    requireFact(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, `Object integrity mismatch: ${expected.sha256}`)
  }
  const content = async (directory: string, name: 'rootfs' | 'support', descriptor: VerityImage) => {
    const cached = verified.get(directory)
    if (cached) return cached
    const file = await dump(system, `${directory}/${name}.img`, descriptor.image.bytes)
    checkArtifact(file, descriptor.image)
    checkArtifact(await dump(system, `${directory}/${name}.roothash.p7s`, descriptor.signature.bytes), descriptor.signature)
    requireFact(readFileSync(await dump(system, `${directory}/${name}.roothash`), 'utf8') === descriptor.rootHash, 'Detached root hash mismatch')
    requireFact(await verityVerify(tools, { dataFile: file, hashFile: file, rootHash: descriptor.rootHash,
      hashOffset: descriptor.verity.hashOffset, hashAlgo: descriptor.verity.algorithm,
      dataBlockSize: descriptor.verity.dataBlockSize, hashBlockSize: descriptor.verity.hashBlockSize,
      dataBlocks: descriptor.verity.dataBlocks, salt: descriptor.verity.salt }) === 'verified', 'Verity content mismatch')
    verified.set(directory, file)
    return file
  }
  const roots = new Map<string, string>()
  for (const { deployment: d } of records) {
    const root = await content(`/roots/${d.rootfs.id}`, 'rootfs', d.rootfs.content)
    roots.set(d.rootfs.id, root)
    const support = await content(`/kernels/${d.kernel.id}`, 'support', d.kernel.support)
    const supportRoot = join(workDir, `support-${d.kernel.id}`)
    if (!verified.has(supportRoot)) {
      await squashfsExtract(tools, support, supportRoot)
      const { readdirSync } = await import('node:fs')
      requireFact(readdirSync(join(supportRoot, 'modules')).join() === d.kernel.release, 'Support modules release mismatch')
      requireFact(statSync(join(supportRoot, 'modules', d.kernel.release, 'modules.dep')).isFile(), 'Support modules.dep missing')
      if (fit) {
        for (const name of ['regulatory.db', 'regulatory.db.p7s']) requireFact(statSync(join(supportRoot, 'firmware', name)).isFile(), `Support regulatory database missing: ${name}`)
      }
      verified.set(supportRoot, support)
    }
    const boot = join(workDir, `boot-${d.kernel.id}`)
    if (!verified.has(boot)) {
      if (fit) checkArtifact(await dump(system, `/kernels/${d.kernel.id}/boot.itb`, d.kernel.boot.artifact.bytes), d.kernel.boot.artifact)
      else { await fatCopyOut(tools, esp, `EFI/mica/kernels/${d.kernel.id}.efi`, boot); checkArtifact(boot, d.kernel.boot.artifact) }
      verified.set(boot, boot)
    }
  }
  report('all referenced boot, root and matching support objects, detached signatures and complete verity trees')
  if (fit) {
    for (const [i, offset] of layout.firmware!.envOffsets.entries()) {
      const expected = encodeFitEnvironment(records.map(r => ({ id: r.id, kernelId: r.deployment.kernel.id,
        generation: r.deployment.generation, tries: 3 })), i)
      requireFact(Buffer.from(readBytes(image, offset, 65536)).equals(expected), 'Factory FIT counter copy mismatch')
    }
  } else {
    const paths = await fatList(tools, esp)
    const entries = paths.filter(p => /^loader\/entries\/[^/]+$/i.test(p.replace(/^::\//, '').replace(/^\//, '')))
    requireFact(entries.length === 2, 'Unexpected factory boot entry count')
    for (const { id, deployment: d } of records) {
      const text = await fatReadFile(tools, esp, `loader/entries/mica-${id}+3.conf`)
      requireFact(text === `title MICA ${d.version}\nversion ${d.generation}\nsort-key mica\nefi /EFI/mica/kernels/${d.kernel.id}.efi\n`, 'Factory boot entry mismatch')
    }
    requireFact(await fatReadFile(tools, esp, 'loader/loader.conf') === 'timeout 0\nconsole-mode keep\neditor no\nauto-entries no\nauto-firmware no\n', 'Unexpected boot selection policy')
  }
  report('factory boot selection and exactly three attempts per deployment')
  const firmware = authenticateFirmware(readFileSync(await dump(data, '/meta/firmware.json'), 'utf8'), publicKeys, loadBoardFacts(layout.board))
  requireFact(firmware.board === layout.board, 'Firmware receipt board mismatch')
  if (firmware.target.format === 'rockchip-loader') {
    const loader = extractRange(image, firmware.target.diskOffset, firmware.artifact.bytes, join(workDir, 'loader'))
    checkArtifact(loader, firmware.artifact)
  } else if (firmware.target.format === 'amlogic-boot0') {
    checkArtifact(join(dirname(image), 'firmware.bin'), firmware.artifact)
  } else {
    const loader = join(workDir, 'loader')
    await fatCopyOut(tools, esp, firmware.target.path, loader)
    checkArtifact(loader, firmware.artifact)
  }
  report(firmware.target.format === 'amlogic-boot0'
    ? 'authenticated external Amlogic firmware payload; installed boot0 requires device readback'
    : 'separately authenticated installed firmware receipt and exact loader readback')
  const result: string[] = []
  for (const [id, file] of roots) {
    const root = join(workDir, `root-${id}`)
    await squashfsExtract(tools, file, root)
    result.push(root)
  }
  return result
}
