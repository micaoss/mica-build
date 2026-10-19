// A ubi board's raw flash image: its flash.tsv's regions in order -- the board's loader, the fixed regions its
// first-stage loader reads, erased bytes -- and over the UBI region the UBI device mica-core's store reads
// (docs/mica-core.md 6.6): records-a and records-b (dynamic, one LEB, the boot record copies), system (dynamic,
// the UBIFS of SYSTEM's small files), data (dynamic, empty, formatted by UBIFS on its first mount) and one static
// volume per object, at exactly its bytes. No volume is resized on attach: the free PEBs are where the store
// writes the next deployments' objects.
//
// Every byte is reproducible. ubinize takes its image sequence from the content; mkfs.ubifs numbers inodes in the
// order it reads the tree, so the tree is staged on a tmpfs in name order, and the superblock's random UUID and
// every inode's atime and ctime -- the clock of the staging -- are rewritten afterwards (pinUbifs).

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BACKENDS } from './backends/index.ts'
import { loadBoardFacts, type BoardFacts } from './board-facts.ts'
import { bootPolicy } from './boot-policy.ts'
import { artifactFile } from './component-build.ts'
import { authenticatePayload, canonicalJson, componentId, verifyDeployment, type BootIdentity } from './components.ts'
import { authenticateCoreSet, coreSetId, MAX_CORE_SET_BYTES } from './core-set.ts'
import type { FactoryCoreSet, FactoryDeployment } from './file-image.ts'
import { encodeFitEnvironment, type FitBootRecord } from './fit-environment.ts'
import { FIRMWARE_FORMATS } from './firmware-formats.ts'
import { authenticateFirmware } from './firmware.ts'
import { FlashLayoutError, objectVolume, ubiCapacity, ubiGeometry, ubiRegion, type FlashLayout } from './flash-layout.ts'
import type { Toolbox } from './toolbox.ts'

/** A static volume and the file whose bytes it holds: k-, s-, r- or c-<id>. */
export interface FlashObject { volume: string, file: string }

export interface FlashContent {
  /** The board's loader, written at the start of its loader region. */
  loader: string
  /** The deployments the two record copies name. */
  records: FitBootRecord[]
  /** The staged SYSTEM tree. */
  system: string
  objects: FlashObject[]
}

export interface UbiVolume { name: string, type: 'static' | 'dynamic', image?: string, bytes?: number }

const UBIFS_MAGIC = 0x06101831
const UBIFS_INO_NODE = 0
const UBIFS_PAD_NODE = 5
const UBIFS_SB_NODE = 6
const ERASED = 0xff

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest()

// SYSTEM's tree, copied in name order onto the container's tmpfs (whose directories list in creation order), then
// formatted uncompressed, as the verifier reads it back (src/verify/ubifs.ts): $1 the tree, $2 the min I/O, $3 the LEB size, $4 the volume's LEBs, $5 the image.
const MKFS_SYSTEM = ['set -eu', 'rm -rf /dev/shm/mica-system', 'mkdir /dev/shm/mica-system',
  'tar -C "$1" --sort=name --numeric-owner -cf - . | tar -C /dev/shm/mica-system -xpf -',
  'mkfs.ubifs -m "$2" -e "$3" -c "$4" -x none -U -r /dev/shm/mica-system "$5"', 'rm -rf /dev/shm/mica-system'].join('; ')

/** UBIFS's node CRC and UBI's header and data CRC: CRC-32 seeded with all ones and not inverted at the end (UBIFS_CRC32_INIT). */
export function ubifsCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return crc >>> 0
}

/**
 * A mkfs.ubifs image with what the build's clock and randomness put in it replaced: the superblock's UUID by one
 * taken from the image itself, and each inode's atime and ctime by its mtime, every node's CRC recomputed. Nothing
 * else in a UBIFS image without authentication covers those bytes.
 */
export function pinUbifs(image: Buffer, leb: number): Buffer {
  const out = Buffer.from(image)
  if (out.length % leb !== 0 || out.readUInt32LE(0) !== UBIFS_MAGIC || out[20] !== UBIFS_SB_NODE) throw new FlashLayoutError('not a UBIFS image of whole LEBs with its superblock first')
  const node = (at: number) => {
    const len = out.readUInt32LE(at + 16)
    if (len < 24 || at + len > out.length) throw new FlashLayoutError(`a UBIFS node at ${at} runs past its LEB`)
    return len
  }
  const seal = (at: number, len: number) => out.writeUInt32LE(ubifsCrc(out.subarray(at + 8, at + len)), at + 4)
  for (let start = 0; start < out.length; start += leb) {
    for (let at = start; at + 24 <= start + leb && out.readUInt32LE(at) === UBIFS_MAGIC;) {
      const len = node(at), type = out[at + 20]
      if (type === UBIFS_INO_NODE) {
        // atime_sec 56, ctime_sec 64, mtime_sec 72; atime_nsec 80, ctime_nsec 84, mtime_nsec 88.
        out.copy(out, at + 56, at + 72, at + 80)
        out.copy(out, at + 64, at + 72, at + 80)
        out.writeUInt32LE(out.readUInt32LE(at + 88), at + 80)
        out.writeUInt32LE(out.readUInt32LE(at + 88), at + 84)
        seal(at, len)
      }
      at = type === UBIFS_PAD_NODE ? at + len + out.readUInt32LE(at + 24) : at + Math.ceil(len / 8) * 8
    }
  }
  // The UUID (superblock offset 108), version 4 in form, from the image with neither a UUID nor the superblock's CRC.
  const sb = node(0)
  out.fill(0, 108, 124)
  out.fill(0, 4, 8)
  const uuid = sha256(out).subarray(0, 16)
  uuid[6] = (uuid[6]! & 0x0f) | 0x40
  uuid[8] = (uuid[8]! & 0x3f) | 0x80
  uuid.copy(out, 108)
  seal(0, sb)
  return out
}

/** ubinize's configuration: the volumes in order, ids from 0. */
export function ubinizeIni(volumes: readonly UbiVolume[]): string {
  return volumes.map((v, id) => [`[${v.name}]`, 'mode=ubi', `vol_id=${id}`, `vol_type=${v.type}`, `vol_name=${v.name}`,
    ...(v.bytes !== undefined ? [`vol_size=${v.bytes}`] : []), ...(v.image !== undefined ? [`image=${v.image}`] : [])].join('\n') + '\n').join('\n')
}

/** The gates an image's content is held to before anything is written: names, sizes and the capacity rule. */
export function checkFlashContent(layout: FlashLayout, content: FlashContent): void {
  const names = content.objects.map(o => o.volume)
  for (const name of names) {
    const m = /^([ksrc])-(.*)$/.exec(name)
    if (m === null) throw new FlashLayoutError(`'${name}' is not an object volume (k-, s-, r- or c-<id>)`)
    objectVolume(m[1] as 'k' | 's' | 'r' | 'c', m[2]!)
  }
  if (new Set(names).size !== names.length) throw new FlashLayoutError('an object volume is named twice')
  const loader = layout.regions.find(r => r.role === 'loader')
  const loaderBytes = statSync(content.loader).size
  if (loader === undefined) throw new FlashLayoutError(`${layout.board}'s flash.tsv has no loader region`)
  if (loaderBytes === 0 || loaderBytes > loader.size) throw new FlashLayoutError(`the loader is ${loaderBytes} bytes, and its region ${loader.name} is ${loader.size}`)
  const sizes = (core: boolean) => content.objects.filter(o => o.volume.startsWith('c-') === core).map(o => statSync(o.file).size)
  const refusal = ubiCapacity(layout, sizes(false), sizes(true))
  if (refusal !== undefined) throw new FlashLayoutError(`${layout.board}: ${refusal}`)
}

/**
 * Assemble the flash image at `output`. `boardDir` holds the fixed regions' files, `work` is scratch; both, the
 * content's files and `output`'s directory are mounted in the MTD_UTILS toolbox `tb`.
 */
export async function assembleFlash(tb: Toolbox, layout: FlashLayout, boardDir: string, content: FlashContent, work: string, output: string): Promise<void> {
  checkFlashContent(layout, content)
  const { leb } = ubiGeometry(layout), f = layout.flash
  writeFileSync(join(work, 'records-a.bin'), encodeFitEnvironment(content.records, 0))
  writeFileSync(join(work, 'records-b.bin'), encodeFitEnvironment(content.records, 1))
  const raw = join(work, 'system.raw.ubifs'), system = join(work, 'system.ubifs')
  await tb.must(['sh', '-c', MKFS_SYSTEM, 'sh', content.system, String(f.minIo), String(leb), String(layout.volumes.system), raw])
  writeFileSync(system, pinUbifs(readFileSync(raw), leb))
  const volumes: UbiVolume[] = [
    { name: 'records-a', type: 'dynamic', image: join(work, 'records-a.bin'), bytes: leb },
    { name: 'records-b', type: 'dynamic', image: join(work, 'records-b.bin'), bytes: leb },
    { name: 'system', type: 'dynamic', image: system, bytes: layout.volumes.system * leb },
    { name: 'data', type: 'dynamic', bytes: layout.volumes.data * leb },
    ...content.objects.map(o => ({ name: o.volume, type: 'static' as const, image: o.file })),
  ]
  const ini = ubinizeIni(volumes)
  writeFileSync(join(work, 'ubinize.ini'), ini)
  // The image sequence number names this UBI image; it is taken from what the image holds, not from where.
  const sequence = sha256(JSON.stringify(volumes.map(v => ({ ...v, image: v.image === undefined ? null : sha256(readFileSync(v.image)).toString('hex') })))).readUInt32LE(0)
  const ubi = join(work, 'ubi.img')
  await tb.must(['ubinize', '-o', ubi, '-p', String(f.eraseBlock), '-m', String(f.minIo), '-s', String(f.subPage), '-O', String(f.vidOffset),
    '-Q', String(sequence), '-e', '0', join(work, 'ubinize.ini')])
  const region = ubiRegion(layout), ubiBytes = readFileSync(ubi)
  if (ubiBytes.length > region.size) throw new FlashLayoutError(`the UBI image is ${ubiBytes.length} bytes, and the region ${region.name} is ${region.size}`)

  const fd = openSync(output, 'w')
  try {
    for (const r of layout.regions) {
      const bytes = r.role === 'loader'
        ? readFileSync(content.loader)
        : r.role === 'ubi'
          ? ubiBytes
          : r.source === '-' ? Buffer.alloc(0) : readFileSync(join(boardDir, r.source.slice('file:'.length)))
      if (bytes.length > r.size) throw new FlashLayoutError(`${r.source} is ${bytes.length} bytes, and the region ${r.name} is ${r.size}`)
      writeSync(fd, bytes, 0, bytes.length, r.offset)
      const pad = Buffer.alloc(r.size - bytes.length, ERASED)
      writeSync(fd, pad, 0, pad.length, r.offset + bytes.length)
    }
  }
  finally { closeSync(fd) }
}

/** The policy entering a ubi board's signed boot artifact is the board's, and names no partition. */
export function checkFlashKernel(boot: { board: unknown, systemPartUuid: unknown, dataPartUuid: unknown }, facts: BoardFacts): void {
  if (canonicalJson(boot.board) !== canonicalJson(facts.policy)) throw new Error('Factory kernel policy differs from the board')
  if (boot.systemPartUuid !== undefined || boot.dataPartUuid !== undefined) throw new Error('Factory kernel of a ubi board names partition UUIDs')
}

/**
 * The factory flash image of a ubi board at `output`/flash.img, out of two signed deployments, the seed core set and
 * the board's firmware (the loader), held to them as a disk image is (src/image/file-image.ts): SYSTEM's small files
 * as docs/mica-core.md 6.6 names them, and each object -- the FIT, the support image, the root, every core
 * component -- in its static volume. `boardDir` is the fetched board bundle; it, `output`'s directory and every
 * input directory are mounted in the MTD_UTILS toolbox `tb`.
 */
export async function assembleFlashImage(layout: FlashLayout, boardDir: string, deployments: FactoryDeployment[], seed: FactoryCoreSet, keys: string[], firmwareDirectory: string, output: string, tb: Toolbox): Promise<string> {
  if (deployments.length !== 2) throw new Error('Factory image requires two deployments')
  const facts = loadBoardFacts(layout.board)
  if (facts.storage !== 'ubi') throw new Error(`Board ${layout.board} does not keep its deployments on UBI`)
  const backend = BACKENDS[facts.backend]
  const firmwareEnvelope = readFileSync(join(firmwareDirectory, 'firmware.json'), 'utf8')
  const manifest = authenticateFirmware(firmwareEnvelope, keys, facts)
  if (manifest.board !== layout.board) throw new Error('Factory firmware board mismatch')
  const loader = join(firmwareDirectory, FIRMWARE_FORMATS[facts.firmware.format].loaderFile(facts.firmware))
  const artifact = artifactFile(loader)
  if (artifact.bytes !== manifest.artifact.bytes || artifact.sha256 !== manifest.artifact.sha256) throw new Error('Factory firmware integrity mismatch')
  if (existsSync(output)) throw new Error(`Image output exists: ${output}`)
  const records = deployments.map((input) => {
    const boot = bootPolicy(readFileSync(join(input.kernelDirectory, backend.bootFile)), backend.bootFormat)
    checkFlashKernel(boot, facts)
    const descriptor = verifyDeployment(input.envelope, keys, boot.identity as BootIdentity)
    if (descriptor.board !== layout.board) throw new Error('Factory deployment board mismatch')
    return { ...input, descriptor, id: componentId(descriptor) }
  })
  if (new Set(records.map(r => r.id)).size !== 2 || new Set(records.map(r => r.descriptor.generation)).size !== 2) throw new Error('Factory deployment IDs and generations must differ')
  const set = authenticateCoreSet(seed.envelope, keys)
  if (records.some(r => r.descriptor.arch !== set.arch)) throw new Error('Factory core set architecture mismatch')
  mkdirSync(dirname(output), { recursive: true })
  const work = `${output}.building`
  mkdirSync(work)
  try {
    const system = join(work, 'system-tree')
    mkdirSync(join(system, 'deployments'), { recursive: true })
    const objects = new Map<string, string>()
    const object = (volume: string, source: string, expected: { bytes: number, sha256: string }) => {
      const actual = artifactFile(source)
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Factory object integrity mismatch: ${source}`)
      objects.set(volume, source)
    }
    // A signed root hash and its signature, the small files of an object on SYSTEM.
    const roothash = (dir: string, name: string, content: { rootHash: string, signature: { bytes: number, sha256: string } }, signature: string) => {
      const actual = artifactFile(signature)
      if (actual.bytes !== content.signature.bytes || actual.sha256 !== content.signature.sha256) throw new Error(`Factory object integrity mismatch: ${signature}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${name}.roothash`), content.rootHash)
      writeFileSync(join(dir, `${name}.roothash.p7s`), readFileSync(signature))
    }
    for (const r of records) {
      const d = r.descriptor
      object(objectVolume('k', d.kernel.id), join(r.kernelDirectory, backend.bootFile), d.kernel.boot.artifact)
      object(objectVolume('s', d.kernel.id), join(r.kernelDirectory, 'support.img'), d.kernel.support.image)
      object(objectVolume('r', d.rootfs.id), join(r.rootDirectory, 'rootfs.img'), d.rootfs.content.image)
      roothash(join(system, 'kernels', d.kernel.id), 'support', d.kernel.support, join(r.kernelDirectory, 'support.roothash.p7s'))
      roothash(join(system, 'roots', d.rootfs.id), 'rootfs', d.rootfs.content, join(r.rootDirectory, 'rootfs.roothash.p7s'))
      writeFileSync(join(system, 'deployments', `${r.id}.json`), r.envelope)
    }
    // The seed core set as the running system would have installed it: the signed set, the state naming it
    // current, and each component's root hash under sets/core/objects/<component id>/, its image in c-<id>.
    const setId = coreSetId(authenticatePayload(seed.envelope, keys, MAX_CORE_SET_BYTES))
    for (const c of set.components) {
      object(objectVolume('c', c.id), join(seed.coreDirectory, c.package, 'core.img'), c.content.image)
      roothash(join(system, 'sets/core/objects', c.id), 'core', c.content, join(seed.coreDirectory, c.package, 'core.roothash.p7s'))
    }
    writeFileSync(join(system, 'sets/core', `${setId}.json`), seed.envelope)
    writeFileSync(join(system, 'sets/core/state.json'), JSON.stringify({ current: setId }))
    const pin = (path: string) => {
      if (statSync(path).isDirectory()) for (const e of readdirSync(path)) pin(join(path, e))
      utimesSync(path, 1577836800, 1577836800)
    }
    pin(system)
    const fitRecords: FitBootRecord[] = records.toSorted((a, b) => b.descriptor.generation - a.descriptor.generation)
      .map(r => ({ id: r.id, kernelId: r.descriptor.kernel.id, generation: r.descriptor.generation, tries: 3 }))
    const image = join(work, 'flash.img')
    await assembleFlash(tb, layout, boardDir, { loader, records: fitRecords, system, objects: [...objects].map(([volume, file]) => ({ volume, file })) }, work, image)
    for (const e of readdirSync(work)) if (e !== 'flash.img') rmSync(join(work, e), { recursive: true })
    renameSync(work, output)
    return join(output, 'flash.img')
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}
