// mica-core's core components in a pool: two items of `_out/debs/<arch>/pool` each (lock 1.2.7, `item core.json`
// and `item core.img` rows) -- `<package>_<version>_<arch>.core.json`, the unsigned `mica/core/v1` record, and
// `<package>_<version>_<arch>.core.img`, the squashfs with its dm-verity tree that the record names by length and
// sha256. mica-build-tools knows no item's type; what a core component is, this repository reads here.
import { poolItems, type Item } from '@mica/build-tools'

export class CoreItemError extends Error {}

export const CORE_RECORD = 'core.json'
export const CORE_IMAGE = 'core.img'

export type CoreFile = { file: string, bytes: Uint8Array, sha256: string }
export type Component = { name: string, version: string, arch: string, record: CoreFile, image: CoreFile }

/** A record's identity and the image it names, or why it is not the unsigned core record of this file. */
export function readRecord(text: string, file: string, arch: string): { name: string, version: string, image: { bytes: number, sha256: string } } {
  let record: unknown
  try { record = JSON.parse(text) }
  catch { throw new CoreItemError(`${arch}/pool/${file} is not JSON`) }
  const r = record as { schema?: unknown, id?: unknown, package?: unknown, version?: unknown, arch?: unknown, content?: { image?: { bytes?: unknown, sha256?: unknown }, signature?: unknown } }
  if (r.schema !== 'mica/core/v1') throw new CoreItemError(`${arch}/pool/${file} is not a mica/core/v1 record`)
  if (r.id !== undefined || r.content?.signature !== undefined)
    throw new CoreItemError(`${arch}/pool/${file} carries an id or a signature; a published record is unsigned, and the product release completes it`)
  const name = typeof r.package === 'string' ? r.package : '', version = typeof r.version === 'string' ? r.version : ''
  if (r.arch !== arch) throw new CoreItemError(`${arch}/pool/${file} is for ${String(r.arch)}, not ${arch}`)
  if (file !== `${name}_${version}_${arch}.${CORE_RECORD}`) throw new CoreItemError(`${arch}/pool/${file} is not named ${name}_${version}_${arch}.${CORE_RECORD}`)
  const bytes = r.content?.image?.bytes, sha256 = r.content?.image?.sha256
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    throw new CoreItemError(`${arch}/pool/${file} names no image by length and sha256`)
  return { name, version, image: { bytes, sha256 } }
}

/** The core components of one pool directory, each record with the image it names; an image no record names is refused. */
export function poolComponents(pool: string, arch: string): Component[] {
  const items = poolItems(pool, arch)
  const file = (i: Item): CoreFile => ({ file: i.file, bytes: i.bytes, sha256: i.sha256 })
  const images = items.filter(i => i.type === CORE_IMAGE)
  const components = items.filter(i => i.type === CORE_RECORD).map((record) => {
    const { name, version, image } = readRecord(new TextDecoder().decode(record.bytes), record.file, arch)
    const found = images.find(i => i.name === name && i.version === version)
    if (found === undefined) throw new CoreItemError(`${arch}/pool/${record.file} names ${name}_${version}_${arch}.${CORE_IMAGE}, which is not in the pool`)
    if (found.bytes.length !== image.bytes || found.sha256 !== image.sha256)
      throw new CoreItemError(`${arch}/pool/${found.file} is not the image ${record.file} names (length ${image.bytes}, sha256 ${image.sha256})`)
    return { name, version, arch, record: file(record), image: file(found) }
  })
  const stray = images.filter(i => !components.some(c => c.image.file === i.file)).map(i => i.file)
  if (stray.length > 0) throw new CoreItemError(`${arch}/pool holds ${stray.join(', ')}, which no record names`)
  return components
}
