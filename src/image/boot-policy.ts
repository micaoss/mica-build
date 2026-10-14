/** Read the storage contract from the initrd in the authenticated boot object, including imported kernels. */
export function bootPolicy(boot: Buffer, format: 'fit' | 'uki'): { identity: unknown, board: unknown, systemPartUuid: unknown, dataPartUuid: unknown } {
  const slice = (start: number, bytes: number) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(bytes) || start < 0 || bytes < 0 || start + bytes > boot.length) throw new Error('Truncated boot object')
    return boot.subarray(start, start + bytes)
  }
  let initrd: Buffer | undefined
  if (format === 'uki') {
    if (slice(0, 2).toString() !== 'MZ') throw new Error('Invalid UKI')
    const pe = slice(60, 4).readUInt32LE()
    if (slice(pe, 4).toString() !== 'PE\0\0') throw new Error('Invalid PE header')
    const count = slice(pe + 6, 2).readUInt16LE(), optional = slice(pe + 20, 2).readUInt16LE()
    for (let i = 0; i < count; i++) {
      const h = slice(pe + 24 + optional + 40 * i, 40)
      if (h.subarray(0, 8).toString().replace(/\0+$/, '') === '.initrd') {
        if (initrd) throw new Error('Duplicate UKI initrd')
        const size = h.readUInt32LE(8)
        if (size > h.readUInt32LE(16)) throw new Error('Truncated UKI initrd')
        initrd = slice(h.readUInt32LE(20), size)
      }
    }
  }
  else {
    const h = slice(0, 40)
    if (h.readUInt32BE(0) !== 0xd00dfeed || h.readUInt32BE(4) > boot.length) throw new Error('Invalid FIT')
    const structure = slice(h.readUInt32BE(8), h.readUInt32BE(36)), strings = slice(h.readUInt32BE(12), h.readUInt32BE(32))
    const nodes: string[] = []
    let offset = 0
    while (offset < structure.length) {
      const token = structure.readUInt32BE(offset); offset += 4
      if (token === 1) {
        const end = structure.indexOf(0, offset)
        if (end < offset) throw new Error('Invalid FIT node')
        nodes.push(structure.subarray(offset, end).toString()); offset = (end + 4) & ~3
      }
      else if (token === 2) { if (!nodes.length) throw new Error('Invalid FIT nesting'); nodes.pop() }
      else if (token === 3) {
        const size = structure.readUInt32BE(offset), name = structure.readUInt32BE(offset + 4); offset += 8
        const end = strings.indexOf(0, name)
        if (end < name || offset + size > structure.length) throw new Error('Invalid FIT property')
        if (nodes.join('/') === '/images/ramdisk' && strings.subarray(name, end).toString() === 'data') {
          if (initrd) throw new Error('Duplicate FIT initrd')
          initrd = structure.subarray(offset, offset + size)
        }
        offset = (offset + size + 3) & ~3
      }
      else if (token === 9) { break }
      else if (token !== 4) { throw new Error('Invalid FIT token') }
    }
  }
  if (!initrd) throw new Error('Boot object has no embedded initrd')
  const cpio = Bun.zstdDecompressSync(initrd)
  if (cpio.length > 67108864) throw new Error('Initrd exceeds the boot payload bound')
  let found: ReturnType<typeof bootPolicy> | undefined
  for (let offset = 0; offset < cpio.length;) {
    const header = cpio.subarray(offset, offset + 110).toString()
    if (header.length !== 110 || !/^070701[0-9a-fA-F]{104}$/.test(header)) throw new Error('Invalid initrd newc header')
    const bytes = Number.parseInt(header.slice(54, 62), 16), names = Number.parseInt(header.slice(94, 102), 16)
    const nameEnd = offset + 110 + names, data = (nameEnd + 3) & ~3
    if (names < 1 || nameEnd > cpio.length || cpio[nameEnd - 1] !== 0 || data + bytes > cpio.length) throw new Error('Truncated initrd member')
    const name = cpio.subarray(offset + 110, nameEnd - 1).toString().replace(/^\.\//, '')
    if (name === 'TRAILER!!!') break
    if (name === 'etc/mica/boot.json') {
      if (found) throw new Error('Duplicate boot policy')
      found = JSON.parse(cpio.subarray(data, data + bytes).toString()) as ReturnType<typeof bootPolicy>
    }
    offset = (data + bytes + 3) & ~3
  }
  if (!found || typeof found !== 'object') throw new Error('Initrd has no boot policy')
  return found
}
