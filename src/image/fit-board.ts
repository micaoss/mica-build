/** Reject payloads whose in-memory extent violates the board's FIT load map (FIT_LOAD_ADDRESSES). */
export function validateFitKernel(fitArch: 'arm64' | 'arm', addresses: readonly string[], header: Buffer, fileBytes: number, dtbBytes: number) {
  if (fitArch === 'arm') {
    // A zImage decompresses itself to wherever it is loaded: the header holds its magic, and nothing aligns it.
    if (header.length < 64 || header.readUInt32LE(0x24) !== 0x016f2818) throw new Error('Invalid ARM zImage header')
    const start = header.readUInt32LE(0x28), end = header.readUInt32LE(0x2c)
    if (fileBytes < 64 || end <= start || end - start > fileBytes || fileBytes > 128 * 1048576) throw new Error('ARM zImage extent exceeds FIT memory budget')
  }
  else {
    if (header.length < 64 || header.subarray(56, 60).toString('ascii') !== 'ARMd') throw new Error('Invalid ARM64 Image header')
    const offset = header.readBigUInt64LE(8), extent = header.readBigUInt64LE(16)
    const address = BigInt(addresses[0]!)
    if (address < offset || (address - offset) % 0x200000n !== 0n) throw new Error('ARM64 Image load alignment mismatch')
    if (fileBytes < 64 || BigInt(fileBytes) > extent || extent > 128n * 1048576n) throw new Error('ARM64 Image extent exceeds FIT memory budget')
  }
  if (dtbBytes <= 0 || dtbBytes > 2 * 1048576) throw new Error('DTB exceeds FIT memory budget')
}
