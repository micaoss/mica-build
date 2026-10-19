// Read-only inspection of a ubi board's complete factory flash image (src/image/flash-image.ts), held to what a disk
// image is held to (src/verify/file-image.ts): every region where flash.tsv puts it, the loader exactly the board's,
// the UBI device's volumes exactly the records, SYSTEM, DATA and the objects the deployments and the seed core set
// name, and those objects, their detached root hashes and signatures and their verity trees complete. Boot trust
// enforcement is a separate boot gate.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKENDS } from '../image/backends/index.ts'
import { loadBoardFacts } from '../image/board-facts.ts'
import { bootPolicy } from '../image/boot-policy.ts'
import { artifactFile } from '../image/component-build.ts'
import { authenticatePayload, canonicalJson, verifyDeployment, type Artifact, type BootIdentity, type RootFacts, type VerityImage } from '../image/components.ts'
import { coreSetId, coreSetRef, MAX_CORE_SET_BYTES, parseCoreSet } from '../image/core-set.ts'
import { FIRMWARE_FORMATS } from '../image/firmware-formats.ts'
import { encodeFitEnvironment } from '../image/fit-environment.ts'
import { checkFlashKernel } from '../image/flash-image.ts'
import { lebs, objectVolume, ubiRegion, type FlashLayout } from '../image/flash-layout.ts'
import { parseBoardEnv } from './board-env.ts'
import { authenticateFactoryRecords, composeFactoryRoots } from './file-image.ts'
import { squashfsExtract, verityVerify } from './image.ts'
import type { ToolRuntime } from './tools.ts'
import { dynamicBytes, readUbi, staticBytes } from './ubi.ts'
import { openUbifs } from './ubifs.ts'

function requireFact(ok: boolean, fact: string): asserts ok {
  if (!ok) throw new Error(fact)
}

const erased = (b: Uint8Array) => b.every(x => x === 0xff)

export async function verifyFlashImage(layout: FlashLayout, image: string, publicKeys: string[], workDir: string,
  tools: ToolRuntime, report: (fact: string) => void, bundle: string): Promise<{ root: string, packedRootfs: string }[]> {
  const facts = loadBoardFacts(layout.board), backend = BACKENDS[facts.backend]
  const radio = (parseBoardEnv(readFileSync(join(bundle, 'board.env'), 'utf8'), 'board.env').values.get('BOARD_FEATURES') ?? '').split(/\s+/).includes('wifi')
  const flash = readFileSync(image)
  requireFact(flash.length === layout.flash.size, `Factory flash image is ${flash.length} bytes, and flash.tsv's flash ${layout.flash.size}`)
  // The regions outside UBI: the loader exactly the board's, a fixed region its file or erased, and erased beyond.
  const loaderFile = join(bundle, 'uboot', FIRMWARE_FORMATS[facts.firmware.format].loaderFile(facts.firmware))
  for (const r of layout.regions.filter(r => r.role !== 'ubi')) {
    const expected = r.role === 'loader' ? readFileSync(loaderFile) : r.source === '-' ? Buffer.alloc(0) : readFileSync(join(bundle, r.source.slice('file:'.length)))
    const bytes = flash.subarray(r.offset, r.offset + r.size)
    requireFact(bytes.subarray(0, expected.length).equals(expected) && erased(bytes.subarray(expected.length)), `Factory flash region ${r.name} mismatch`)
  }
  report(`the flash regions of flash.tsv (${layout.regions.map(r => `${r.name}:${r.role}`).join(' ')}), the loader exactly the board's ${loaderFile.split('/').pop()}`)

  const region = ubiRegion(layout)
  const ubi = readUbi(flash.subarray(region.offset, region.offset + region.size), layout.flash.eraseBlock)
  const leb = ubi.leb
  const volume = (name: string, type: 'dynamic' | 'static') => {
    const v = ubi.volumes.get(name)
    requireFact(v !== undefined && v.type === type, `Factory UBI volume ${name} is not a ${type} volume`)
    return v
  }
  const fixed = [['records-a', 1], ['records-b', 1], ['system', layout.volumes.system], ['data', layout.volumes.data]] as const
  for (const [i, [name, size]] of fixed.entries()) {
    const v = volume(name, 'dynamic')
    requireFact(v.id === i && v.reservedPebs === size, `Factory UBI volume ${name} is not volume ${i} of ${size} LEBs`)
  }
  requireFact(volume('data', 'dynamic').lebs.size === 0, 'Factory DATA volume is not empty')
  report('the UBI device: records-a, records-b, system and data at their fixed ids and sizes, DATA empty')

  const system = openUbifs(dynamicBytes(volume('system', 'dynamic'), leb), leb)
  const regular = (path: string) => system.list(path).map(e => e.name)
  const dump = (path: string, expectedBytes?: number) => {
    const bytes = system.read(path)
    requireFact(expectedBytes === undefined || bytes.length === expectedBytes, `Image member size mismatch: ${path}`)
    return bytes
  }
  requireFact(regular('/').join() === 'deployments,kernels,roots,sets', 'SYSTEM holds other than deployments, kernels, roots and sets')
  const names = system.list('/deployments')
  requireFact(names.length === 2 && names.every(e => /^[0-9a-f]{64}\.json$/.test(e.name) && e.type === 'file'), 'Invalid factory deployment directory')
  const envelopes = names.map(e => dump(`/deployments/${e.name}`).toString('utf8'))
  const records = authenticateFactoryRecords(envelopes, publicKeys, layout.board)
  requireFact(records.every(r => names.some(n => n.name === `${r.id}.json`)), 'Deployment filenames do not match authenticated identities')
  report('two distinct authenticated factory deployments')

  const objects = new Set<string>()
  const checkArtifact = (bytes: Buffer, expected: Artifact) => {
    const file = join(workDir, `object-${objects.size}-${expected.sha256}`)
    writeFileSync(file, bytes)
    const actual = artifactFile(file)
    requireFact(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, `Object integrity mismatch: ${expected.sha256}`)
    return file
  }
  const verified = new Map<string, string>()
  // An object's static volume, its detached root hash and signature on SYSTEM, and its complete verity tree.
  const content = async (kind: 's' | 'r' | 'c', id: string, directory: string, name: 'rootfs' | 'support' | 'core', descriptor: VerityImage) => {
    const v = objectVolume(kind, id), cached = verified.get(v)
    if (cached) return cached
    objects.add(v)
    const static_ = volume(v, 'static')
    requireFact(static_.reservedPebs === lebs(layout, descriptor.image.bytes), `Factory UBI volume ${v} is not sized to its object`)
    const file = checkArtifact(staticBytes(static_), descriptor.image)
    checkArtifact(dump(`${directory}/${name}.roothash.p7s`, descriptor.signature.bytes), descriptor.signature)
    requireFact(regular(directory).join() === `${name}.roothash,${name}.roothash.p7s`, `${directory} holds other than ${name}'s root hash and signature`)
    requireFact(dump(`${directory}/${name}.roothash`).toString('utf8') === descriptor.rootHash, 'Detached root hash mismatch')
    requireFact(await verityVerify(tools, { dataFile: file, hashFile: file, rootHash: descriptor.rootHash,
      hashOffset: descriptor.verity.hashOffset, hashAlgo: descriptor.verity.algorithm,
      dataBlockSize: descriptor.verity.dataBlockSize, hashBlockSize: descriptor.verity.hashBlockSize,
      dataBlocks: descriptor.verity.dataBlocks, salt: descriptor.verity.salt }) === 'verified', 'Verity content mismatch')
    verified.set(v, file)
    return file
  }

  // The seed core set (mica-core:docs/mica-core.md 6.2 "Core sets"): one signed set, current, with exactly its
  // components under sets/core/objects/<component id>/, each image in c-<id>.
  requireFact(regular('/sets').join() === 'core', 'SYSTEM sets/ holds other than the core kind')
  const setFiles = regular('/sets/core')
  const setName = setFiles.find(n => /^[0-9a-f]{64}\.json$/.test(n)) ?? ''
  requireFact(setFiles.length === 3 && setName !== '' && setFiles.includes('objects') && setFiles.includes('state.json'), 'Invalid factory core set directory')
  const setEnvelope = dump(`/sets/core/${setName}`)
  const setPayload = authenticatePayload(setEnvelope.toString('utf8'), publicKeys, MAX_CORE_SET_BYTES)
  const set = parseCoreSet(setPayload)
  requireFact(`${coreSetId(setPayload)}.json` === setName, 'Core set filename does not match its authenticated identity')
  requireFact(dump('/sets/core/state.json').toString('utf8') === JSON.stringify({ current: coreSetId(setPayload) }), 'The factory core set is not the current one')
  requireFact(regular('/sets/core/objects').join() === set.components.map(c => c.id).sort().join(), 'The core set objects are not exactly its components')
  const cores = new Map<string, string>()
  for (const c of set.components) cores.set(c.id, await content('c', c.id, `/sets/core/objects/${c.id}`, 'core', c.content))
  report(`one authenticated seed core set (${set.channel} generation ${set.generation}, ${set.version}), current, with exactly its components`)

  const roots = new Map<string, { root: string, facts: RootFacts }>()
  for (const { id, deployment: d } of records) {
    requireFact(d.arch === set.arch, 'Factory core set architecture mismatch')
    // A deployment that names its image's set (coreSet) names this one, by its envelope's digest and length.
    requireFact(d.coreSet === undefined || canonicalJson(d.coreSet) === canonicalJson(coreSetRef(set, setEnvelope)), 'A deployment names a core set other than the seed')
    roots.set(d.rootfs.id, { root: await content('r', d.rootfs.id, `/roots/${d.rootfs.id}`, 'rootfs', d.rootfs.content), facts: { level: d.rootfs.interfaceLevel, ...(d.rootfs.provides === undefined ? {} : { provides: d.rootfs.provides }) } })
    const support = await content('s', d.kernel.id, `/kernels/${d.kernel.id}`, 'support', d.kernel.support)
    const supportRoot = join(workDir, `support-${d.kernel.id}`)
    if (!verified.has(supportRoot)) {
      await squashfsExtract(tools, support, supportRoot)
      requireFact(readdirSync(join(supportRoot, 'modules')).join() === d.kernel.release, 'Support modules release mismatch')
      requireFact(statSync(join(supportRoot, 'modules', d.kernel.release, 'modules.dep')).isFile(), 'Support modules.dep missing')
      // The radio firmware and the signed regulatory database of a board with a wireless radio (src/image/kernel-package.ts).
      if (backend.supportFirmware && radio)
        for (const name of ['regulatory.db', 'regulatory.db.p7s']) requireFact(statSync(join(supportRoot, 'firmware', name)).isFile(), `Support regulatory database missing: ${name}`)
      verified.set(supportRoot, support)
    }
    // The boot object in k-<kernel id>: the deployment's artifact, the board's policy, and the kernel and support
    // the deployment names.
    const k = objectVolume('k', d.kernel.id)
    if (!objects.has(k)) {
      objects.add(k)
      const boot = staticBytes(volume(k, 'static'))
      checkArtifact(boot, d.kernel.boot.artifact)
      checkFlashKernel(bootPolicy(boot, d.kernel.boot.format), facts)
    }
    verifyDeployment(envelopes[names.findIndex(n => n.name === `${id}.json`)]!, publicKeys, bootPolicy(staticBytes(volume(k, 'static')), d.kernel.boot.format).identity as BootIdentity)
  }
  const unexpected = [...ubi.volumes.keys()].filter(n => !fixed.some(([f]) => f === n) && !objects.has(n))
  requireFact(unexpected.length === 0, `Factory UBI volumes no deployment or core set names: ${unexpected.join(' ')}`)
  report('all referenced boot, root, core and matching support objects in their static volumes, detached signatures and complete verity trees, and no other volume')

  // The boot record copies: each LEB 0 of its volume, the newest deployment first, three attempts each.
  for (const [i, name] of (['records-a', 'records-b'] as const).entries()) {
    const expected = encodeFitEnvironment(records.map(r => ({ id: r.id, kernelId: r.deployment.kernel.id,
      generation: r.deployment.generation, tries: 3 })), i)
    const v = volume(name, 'dynamic'), bytes = v.lebs.get(0)
    requireFact(v.lebs.size === 1 && bytes !== undefined && bytes.subarray(0, expected.length).equals(expected) && erased(bytes.subarray(expected.length)), 'Factory FIT counter copy mismatch')
  }
  report('factory boot selection and exactly three attempts per deployment')
  return composeFactoryRoots(tools, workDir, roots, set.components, cores, report)
}
