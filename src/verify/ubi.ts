// A UBI device read back out of its raw PEBs, as the kernel attaches it (drivers/mtd/ubi): each PEB's erase counter
// (EC) and volume identifier (VID) headers, the layout volume's table of names, and every volume's LEBs. Nothing is
// trusted that a CRC does not cover: a header, a volume table record or a static LEB's data whose CRC is wrong is
// refused, and so are two PEBs claiming one LEB -- a factory image has written each LEB once.
//
// The CRC is UBI's crc32_le seeded with all ones and not inverted, the one UBIFS uses (ubifsCrc).

import { ubifsCrc } from '../image/flash-image.ts'

export class UbiError extends Error {}

const EC_MAGIC = 0x55424923 // "UBI#"
const VID_MAGIC = 0x55424921 // "UBI!"
const HEADER = 64
const LAYOUT_VOLUME = 0x7fffefff
const VTBL_RECORD = 172
const MAX_VOLUMES = 128
const VOLUME_TYPES = { 1: 'dynamic', 2: 'static' } as const

export interface UbiVolumeRead {
  id: number
  name: string
  type: 'dynamic' | 'static'
  /** The PEBs the volume table reserves for it. */
  reservedPebs: number
  /** The mapped LEBs' data: a dynamic LEB whole, a static LEB its data_size bytes. */
  lebs: Map<number, Buffer>
  /** A static volume's LEB count (used_ebs); 0 for a dynamic volume. */
  usedEbs: number
}

export interface UbiDevice {
  leb: number
  imageSequence: number
  volumes: Map<string, UbiVolumeRead>
}

const erased = (b: Buffer) => b.every(x => x === 0xff)

function fail(message: string): never { throw new UbiError(message) }

/** The UBI device in `bytes`, PEBs of `eraseBlock` bytes. */
export function readUbi(bytes: Buffer, eraseBlock: number): UbiDevice {
  if (bytes.length === 0 || bytes.length % eraseBlock !== 0) fail(`the UBI region is ${bytes.length} bytes, not whole PEBs of ${eraseBlock}`)
  let dataOffset = -1, sequence = -1
  // vol_id -> lnum -> { type, data, used_ebs }
  const found = new Map<number, Map<number, { type: number, data: Buffer, usedEbs: number }>>()
  for (let peb = 0; peb * eraseBlock < bytes.length; peb++) {
    const p = bytes.subarray(peb * eraseBlock, (peb + 1) * eraseBlock)
    if (erased(p)) continue
    const at = `PEB ${peb}`
    if (p.readUInt32BE(0) !== EC_MAGIC) fail(`${at}: no erase counter header`)
    if (ubifsCrc(p.subarray(0, 60)) !== p.readUInt32BE(60)) fail(`${at}: the erase counter header's CRC is wrong`)
    if (p[4] !== 1) fail(`${at}: UBI version ${p[4]}`)
    const vidOffset = p.readUInt32BE(16), offset = p.readUInt32BE(20), seq = p.readUInt32BE(24)
    if (dataOffset === -1) { dataOffset = offset; sequence = seq }
    if (offset !== dataOffset || seq !== sequence) fail(`${at}: the data offset or image sequence differs from the first PEB's`)
    if (vidOffset + HEADER > offset || offset >= eraseBlock) fail(`${at}: the VID header at ${vidOffset} overlaps the data at ${offset}`)
    const vid = p.subarray(vidOffset, vidOffset + HEADER)
    if (erased(vid)) { if (!erased(p.subarray(offset))) fail(`${at}: data without a VID header`); continue }
    if (vid.readUInt32BE(0) !== VID_MAGIC) fail(`${at}: no VID header`)
    if (ubifsCrc(vid.subarray(0, 60)) !== vid.readUInt32BE(60)) fail(`${at}: the VID header's CRC is wrong`)
    const type = vid[5]!, volId = vid.readUInt32BE(8), lnum = vid.readUInt32BE(12)
    const dataSize = vid.readUInt32BE(20), usedEbs = vid.readUInt32BE(24), dataPad = vid.readUInt32BE(28), dataCrc = vid.readUInt32BE(32)
    if (!(type in VOLUME_TYPES)) fail(`${at}: volume type ${type}`)
    if (vid[6] !== 0) fail(`${at}: a copy of a LEB (copy_flag), which a factory image never writes`)
    if (dataPad !== 0) fail(`${at}: data_pad ${dataPad}; every volume is aligned to 1`)
    const leb = eraseBlock - offset
    let data = p.subarray(offset)
    if (type === 2) {
      if (dataSize === 0 || dataSize > leb) fail(`${at}: a static LEB of ${dataSize} bytes`)
      data = data.subarray(0, dataSize)
      if (ubifsCrc(data) !== dataCrc) fail(`${at}: the data CRC of volume ${volId} LEB ${lnum} is wrong`)
    }
    const lebs = found.get(volId) ?? new Map()
    found.set(volId, lebs)
    if (lebs.has(lnum)) fail(`${at}: a second PEB holds volume ${volId} LEB ${lnum}`)
    lebs.set(lnum, { type, data, usedEbs })
  }
  if (dataOffset === -1) fail('the UBI region holds no PEB')
  const leb = eraseBlock - dataOffset
  // The volume table: two identical copies, LEBs 0 and 1 of the layout volume.
  const layout = found.get(LAYOUT_VOLUME)
  const copies = [0, 1].map(n => layout?.get(n)?.data)
  if (copies[0] === undefined || copies[1] === undefined || layout!.size !== 2 || !copies[0].equals(copies[1])) fail('the layout volume is not two identical copies of the volume table')
  found.delete(LAYOUT_VOLUME)
  const table = copies[0]
  const records = Math.min(MAX_VOLUMES, Math.floor(leb / VTBL_RECORD))
  const volumes = new Map<string, UbiVolumeRead>()
  for (let id = 0; id < records; id++) {
    const r = table.subarray(id * VTBL_RECORD, (id + 1) * VTBL_RECORD)
    if (ubifsCrc(r.subarray(0, 168)) !== r.readUInt32BE(168)) fail(`volume table record ${id}: the CRC is wrong`)
    const reservedPebs = r.readUInt32BE(0)
    if (reservedPebs === 0) { if (found.has(id)) fail(`volume ${id} has LEBs and no volume table record`); continue }
    const type = r[12]!, nameLen = r.readUInt16BE(14)
    if (!(type in VOLUME_TYPES) || nameLen === 0 || nameLen > 127 || r.readUInt32BE(4) !== 1 || r.readUInt32BE(8) !== 0 || r[13] !== 0)
      fail(`volume table record ${id}: not a volume of alignment 1 without an update marker`)
    const name = r.subarray(16, 16 + nameLen).toString('latin1')
    if (volumes.has(name)) fail(`the volume name ${name} is used twice`)
    const lebs = new Map<number, Buffer>()
    let usedEbs = 0
    for (const [lnum, l] of found.get(id) ?? []) {
      if (l.type !== type) fail(`volume ${name} LEB ${lnum}: its VID header's type differs from the volume table's`)
      if (lnum >= reservedPebs) fail(`volume ${name} LEB ${lnum}: beyond its ${reservedPebs} reserved PEBs`)
      if (type === 2) {
        if (usedEbs !== 0 && l.usedEbs !== usedEbs) fail(`volume ${name}: its LEBs disagree on used_ebs`)
        usedEbs = l.usedEbs
      }
      lebs.set(lnum, l.data)
    }
    found.delete(id)
    if (type === 2) {
      if (usedEbs === 0 || lebs.size !== usedEbs) fail(`static volume ${name}: ${lebs.size} LEBs of the ${usedEbs} it names`)
      for (let n = 0; n < usedEbs; n++) if (n < usedEbs - 1 && lebs.get(n)!.length !== leb) fail(`static volume ${name}: LEB ${n} is not full`)
    }
    volumes.set(name, { id, name, type: VOLUME_TYPES[type as 1 | 2], reservedPebs, lebs, usedEbs })
  }
  if (found.size !== 0) fail(`volume ${[...found.keys()][0]} has LEBs and no volume table record`)
  return { leb, imageSequence: sequence, volumes }
}

/** A static volume's bytes, its LEBs in order. */
export function staticBytes(volume: UbiVolumeRead): Buffer {
  if (volume.type !== 'static') throw new UbiError(`${volume.name} is not a static volume`)
  return Buffer.concat([...Array(volume.usedEbs).keys()].map(n => volume.lebs.get(n)!))
}

/** A dynamic volume's bytes over its reserved LEBs, an unmapped LEB erased. */
export function dynamicBytes(volume: UbiVolumeRead, leb: number): Buffer {
  if (volume.type !== 'dynamic') throw new UbiError(`${volume.name} is not a dynamic volume`)
  return Buffer.concat([...Array(volume.reservedPebs).keys()].map(n => volume.lebs.get(n) ?? Buffer.alloc(leb, 0xff)))
}
