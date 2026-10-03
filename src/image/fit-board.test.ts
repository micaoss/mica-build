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
  expect(() => validateFitKernel(S905X5M, kernel(), 33065472, 65536)).not.toThrow()
  const relocated = kernel()
  relocated.writeBigUInt64LE(0x80000n, 8)
  expect(() => validateFitKernel(S905X5M, relocated, 33065472, 65536)).toThrow('alignment')
  const oversized = kernel()
  oversized.writeBigUInt64LE(256n * 1048576n, 16)
  expect(() => validateFitKernel(S905X5M, oversized, 33065472, 65536)).toThrow('extent')
  expect(() => validateFitKernel(S905X5M, kernel(), 33065472, 3 * 1048576)).toThrow('DTB')
  expect(() => validateFitKernel(S905X5M, Buffer.alloc(64), 33065472, 65536)).toThrow('ARM64')
})
