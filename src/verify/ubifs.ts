// A factory UBIFS read back without the kernel (fs/ubifs): the superblock, the master node and, from the index root
// it names, every node the index reaches -- inodes, directory entries and data. A factory image is mkfs.ubifs's
// and never mounted, so its whole content is in the index: the log holds only its commit start node, and nothing is
// read from a journal. Every node's CRC is checked, and each leaf must carry the key its index branch names.
//
// SYSTEM is written uncompressed (src/image/flash-image.ts), so a compressed data node is refused rather than
// decompressed.

import { ubifsCrc } from '../image/flash-image.ts'

export class UbifsError extends Error {}

const MAGIC = 0x06101831
const NODE = { ino: 0, data: 1, dent: 2, pad: 5, sb: 6, mst: 7, idx: 9, cs: 10 } as const
const KEY = { ino: 0, data: 1, dent: 2 } as const
const MST_LNUM = 1, LOG_LNUM = 3
const ROOT_INO = 1
const BLOCK = 4096
const MAX_LEVELS = 64
const TYPES = ['file', 'directory', 'symlink', 'block', 'char', 'fifo', 'socket'] as const

export interface UbifsEntry { name: string, inum: number, type: typeof TYPES[number] }
interface Inode { mode: number, size: number }

function fail(message: string): never { throw new UbifsError(message) }

const align8 = (n: number) => Math.ceil(n / 8) * 8
const erased = (b: Buffer) => b.every(x => x === 0xff)

export interface Ubifs {
  /** The entries of the directory at `path`, by name. */
  list(path: string): UbifsEntry[]
  /** The regular file at `path`, whole. */
  read(path: string): Buffer
  /** The mode of the inode at `path`. */
  mode(path: string): number
}

/** The UBIFS in a volume's bytes, LEBs of `leb` bytes. */
export function openUbifs(volume: Buffer, leb: number): Ubifs {
  if (volume.length === 0 || volume.length % leb !== 0) fail(`the volume is ${volume.length} bytes, not whole LEBs of ${leb}`)
  const node = (lnum: number, offs: number, what: string) => {
    const at = `${what} at LEB ${lnum}:${offs}`
    if (lnum * leb >= volume.length || offs + 24 > leb) fail(`${at}: outside the volume`)
    const l = volume.subarray(lnum * leb, (lnum + 1) * leb)
    if (l.readUInt32LE(offs) !== MAGIC) fail(`${at}: no node`)
    const len = l.readUInt32LE(offs + 16)
    if (len < 24 || offs + len > leb) fail(`${at}: a node of ${len} bytes runs past its LEB`)
    const n = l.subarray(offs, offs + len)
    if (ubifsCrc(n.subarray(8)) !== n.readUInt32LE(4)) fail(`${at}: the node's CRC is wrong`)
    return { n, type: n[20]!, end: offs + len }
  }
  const sb = node(0, 0, 'the superblock')
  if (sb.type !== NODE.sb) fail('LEB 0 does not start with the superblock')
  if (sb.n[27] !== 0) fail(`key format ${sb.n[27]}; only the simple key format is read`)
  if (sb.n.readUInt32LE(36) !== leb) fail(`the superblock's LEB size is ${sb.n.readUInt32LE(36)}, the volume's ${leb}`)
  const logLebs = sb.n.readUInt32LE(56)
  if (sb.n.readUInt16LE(84) !== 0) fail(`the default compressor is ${sb.n.readUInt16LE(84)}; SYSTEM is written uncompressed`)
  // The master node, the same in both master LEBs, and nothing after it: one commit, mkfs.ubifs's.
  const masters = [MST_LNUM, MST_LNUM + 1].map((lnum) => {
    const m = node(lnum, 0, 'the master node')
    if (m.type !== NODE.mst) fail(`LEB ${lnum} does not start with the master node`)
    if (!erased(volume.subarray(lnum * leb + align8(m.end), (lnum + 1) * leb))) fail(`LEB ${lnum} holds more than one master node`)
    return m.n
  })
  // Beyond each node's own sequence number and CRC.
  if (!masters[0]!.subarray(16).equals(masters[1]!.subarray(16))) fail('the two master nodes differ')
  // The log: its commit start node, and nothing else, so no journal replays over the index.
  const cs = node(LOG_LNUM, 0, 'the log')
  if (cs.type !== NODE.cs || !erased(volume.subarray(LOG_LNUM * leb + align8(cs.end), (LOG_LNUM + logLebs) * leb))) fail('the log holds more than its commit start node')
  const mst = masters[0]!
  const inodes = new Map<number, Inode>(), dents = new Map<number, Map<string, UbifsEntry>>(), data = new Map<number, Map<number, Buffer>>()
  const walk = (lnum: number, offs: number, len: number, depth: number) => {
    if (depth > MAX_LEVELS) fail('the index is deeper than any UBIFS')
    const { n, type } = node(lnum, offs, 'an index branch')
    if (n.length !== len) fail(`the node at LEB ${lnum}:${offs} is ${n.length} bytes, and its branch says ${len}`)
    if (type === NODE.idx) {
      const children = n.readUInt16LE(24), level = n.readUInt16LE(26)
      if (children === 0 || 28 + children * 20 > n.length) fail(`the index node at LEB ${lnum}:${offs} has ${children} branches in ${n.length} bytes`)
      for (let i = 0; i < children; i++) {
        const b = n.subarray(28 + i * 20, 48 + i * 20)
        const child = { lnum: b.readUInt32LE(0), offs: b.readUInt32LE(4), len: b.readUInt32LE(8), key: b.subarray(12, 20) }
        if (level === 0) leaf(child.lnum, child.offs, child.len, child.key)
        else walk(child.lnum, child.offs, child.len, depth + 1)
      }
      return
    }
    fail(`the index branch at LEB ${lnum}:${offs} is not an index node`)
  }
  const leaf = (lnum: number, offs: number, len: number, key: Buffer) => {
    const { n, type } = node(lnum, offs, 'a leaf')
    if (n.length !== len || !n.subarray(24, 32).equals(key)) fail(`the leaf at LEB ${lnum}:${offs} is not the node its branch names`)
    const inum = n.readUInt32LE(24), keyType = n.readUInt32LE(28) >>> 29, low = n.readUInt32LE(28) & 0x1fffffff
    if (type === NODE.ino && keyType === KEY.ino) {
      if (inodes.has(inum)) fail(`inode ${inum} is indexed twice`)
      if (n.readUInt32LE(116) !== 0) fail(`inode ${inum} has extended attributes, which SYSTEM never carries`)
      inodes.set(inum, { size: Number(n.readBigUInt64LE(48)), mode: n.readUInt32LE(104) })
    }
    else if (type === NODE.dent && keyType === KEY.dent) {
      const nlen = n.readUInt16LE(50), name = n.subarray(56, 56 + nlen).toString('utf8'), kind = TYPES[n[49]!]
      if (kind === undefined || nlen === 0 || name.includes('/')) fail(`a directory entry of inode ${inum} is malformed`)
      const dir = dents.get(inum) ?? new Map<string, UbifsEntry>()
      dents.set(inum, dir)
      if (dir.has(name)) fail(`inode ${inum} names ${name} twice`)
      dir.set(name, { name, inum: Number(n.readBigUInt64LE(40)), type: kind })
    }
    else if (type === NODE.data && keyType === KEY.data) {
      if (n.readUInt16LE(44) !== 0) fail(`a data node of inode ${inum} is compressed; SYSTEM is written uncompressed`)
      const bytes = n.subarray(48)
      if (bytes.length !== n.readUInt32LE(40) || bytes.length > BLOCK) fail(`a data node of inode ${inum} holds ${bytes.length} bytes and says ${n.readUInt32LE(40)}`)
      const blocks = data.get(inum) ?? new Map<number, Buffer>()
      data.set(inum, blocks)
      if (blocks.has(low)) fail(`inode ${inum} block ${low} is indexed twice`)
      blocks.set(low, bytes)
    }
    else { fail(`the leaf at LEB ${lnum}:${offs} is node type ${type} under key type ${keyType}`) }
  }
  walk(mst.readUInt32LE(48), mst.readUInt32LE(52), mst.readUInt32LE(56), 0)
  if (!inodes.has(ROOT_INO)) fail('the index holds no root inode')

  const lookup = (path: string): number => {
    if (!/^\/([^/]+(\/[^/]+)*)?$/.test(path)) fail(`'${path}' is not an absolute path`)
    let inum = ROOT_INO
    for (const part of path.split('/').filter(p => p !== '')) {
      const e = dents.get(inum)?.get(part)
      if (e === undefined) fail(`${path}: no such entry`)
      inum = e.inum
    }
    if (!inodes.has(inum)) fail(`${path}: its inode ${inum} is not indexed`)
    return inum
  }
  const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000
  return {
    list(path) {
      const inum = lookup(path)
      if ((inodes.get(inum)!.mode & S_IFMT) !== S_IFDIR) fail(`${path} is not a directory`)
      const entries = [...(dents.get(inum)?.values() ?? [])]
      for (const e of entries) if (!inodes.has(e.inum)) fail(`${path}/${e.name}: its inode ${e.inum} is not indexed`)
      return entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))
    },
    read(path) {
      const inum = lookup(path), inode = inodes.get(inum)!
      if ((inode.mode & S_IFMT) !== S_IFREG) fail(`${path} is not a regular file`)
      const blocks = data.get(inum) ?? new Map<number, Buffer>(), count = Math.ceil(inode.size / BLOCK)
      for (const b of blocks.keys()) if (b >= count) fail(`${path}: block ${b} lies beyond its ${inode.size} bytes`)
      // A block the index does not name is a hole, read as zeros, as the kernel reads it.
      const out = Buffer.alloc(inode.size)
      for (const [b, bytes] of blocks) bytes.copy(out, b * BLOCK, 0, Math.min(bytes.length, inode.size - b * BLOCK))
      return out
    },
    mode(path) { return inodes.get(lookup(path))!.mode },
  }
}
