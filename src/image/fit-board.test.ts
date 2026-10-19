import { expect, test } from 'bun:test'
import { validateFitKernel } from './fit-board.ts'

// The s905x5m load map, as its board.env states it.
const S905X5M = ['0x08000000', '0x18000000', '0x20000000'] as const

function kernel() {
  const bytes = Buffer.alloc(64)
  bytes.write('ARMd', 56, 'ascii')
  bytes.writeBigUInt64LE(33816576n, 16)
  return bytes
}

test('S905X5M FIT uses the actual ARM64 extent and clears the reserved memory', () => {
  expect(() => validateFitKernel('arm64', S905X5M, kernel(), 33065472, 65536)).not.toThrow()
  const relocated = kernel()
  relocated.writeBigUInt64LE(0x80000n, 8)
  expect(() => validateFitKernel('arm64', S905X5M, relocated, 33065472, 65536)).toThrow('alignment')
  const oversized = kernel()
  oversized.writeBigUInt64LE(256n * 1048576n, 16)
  expect(() => validateFitKernel('arm64', S905X5M, oversized, 33065472, 65536)).toThrow('extent')
  expect(() => validateFitKernel('arm64', S905X5M, kernel(), 33065472, 3 * 1048576)).toThrow('DTB')
  expect(() => validateFitKernel('arm64', S905X5M, Buffer.alloc(64), 33065472, 65536)).toThrow('ARM64')
})

/** A zImage header: the magic at 0x24, its start and end at 0x28 and 0x2c. */
function zImage(end: number) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0x016f2818, 0x24)
  bytes.writeUInt32LE(0, 0x28)
  bytes.writeUInt32LE(end, 0x2c)
  return bytes
}

test('an armhf FIT boots a zImage: its magic and its extent are checked, no load alignment', () => {
  const QEMU = ['0x40400000', '0x43f00000', '0x44000000'] as const
  expect(() => validateFitKernel('arm', QEMU, zImage(4194304), 4194304, 65536)).not.toThrow()
  expect(() => validateFitKernel('arm', QEMU, zImage(4194305), 4194304, 65536)).toThrow('extent')
  expect(() => validateFitKernel('arm', QEMU, Buffer.alloc(64), 4194304, 65536)).toThrow('zImage header')
  expect(() => validateFitKernel('arm', QEMU, zImage(4194304), 4194304, 3 * 1048576)).toThrow('DTB')
})
