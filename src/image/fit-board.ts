/** Reject payloads whose in-memory extent violates the board's FIT load map (FIT_LOAD_ADDRESSES). */
export function validateFitKernel(addresses: readonly string[], header: Buffer, fileBytes: number, dtbBytes: number) {
  if (header.length < 64 || header.subarray(56, 60).toString('ascii') !== 'ARMd') throw new Error('Invalid ARM64 Image header')
  const offset = header.readBigUInt64LE(8), extent = header.readBigUInt64LE(16)
  const address = BigInt(addresses[0]!)
  if (address < offset || (address - offset) % 0x200000n !== 0n) throw new Error('ARM64 Image load alignment mismatch')
  if (fileBytes < 64 || BigInt(fileBytes) > extent || extent > 128n * 1048576n) throw new Error('ARM64 Image extent exceeds FIT memory budget')
  if (dtbBytes <= 0 || dtbBytes > 2 * 1048576) throw new Error('DTB exceeds FIT memory budget')
}
