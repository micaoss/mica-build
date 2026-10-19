import { expect, test } from 'bun:test'
import { FIRMWARE_FORMATS, formatOfTarget } from './firmware-formats.ts'

const MIB = 1048576
const mtd = FIRMWARE_FORMATS['mtd-loader']
const facts = { format: 'mtd-loader', binName: 'u-boot.bin', partition: 'u-boot', maxBytes: MIB } as const

test('an mtd-loader: its target is the loader\'s MTD partition and size, read back and replaced by the recovery package', () => {
  expect(mtd.target(facts)).toEqual({ format: 'mtd-loader', partition: 'u-boot', maxBytes: MIB })
  expect(formatOfTarget('mtd-loader')).toBe(mtd)
  expect(mtd.loaderFile(facts)).toBe('u-boot.bin')
  expect([mtd.storage, mtd.builtHere, mtd.inImage, mtd.maintenance]).toEqual(['ubi', false, 'flash', 'recovery-package'])
})

test.each([
  ['the partition\'s size', { format: 'mtd-loader', partition: 'u-boot', maxBytes: MIB }, MIB, { limit: MIB }],
  ['a loader above it', { format: 'mtd-loader', partition: 'u-boot', maxBytes: MIB }, MIB + 1, { refusal: 'invalid MTD loader' }],
  ['a partition name out of form', { format: 'mtd-loader', partition: 'u boot', maxBytes: MIB }, 1, { refusal: 'invalid MTD loader' }],
  ['more than 64 MiB', { format: 'mtd-loader', partition: 'u-boot', maxBytes: 65 * MIB }, 1, { refusal: 'invalid MTD loader' }],
])('an mtd-loader receipt target: %s', (_what, target, bytes, want) => {
  expect(mtd.checkTarget(target, 'armhf', bytes)).toEqual(want)
})

test('an mtd-loader is held to its partition, and is never empty', () => {
  expect(mtd.checkLoader(facts, Buffer.alloc(MIB))).toBeUndefined()
  expect(mtd.checkLoader(facts, Buffer.alloc(MIB + 1))).toBe('Invalid bounded MTD loader')
  expect(mtd.checkLoader(facts, Buffer.alloc(0))).toBe('Invalid bounded MTD loader')
})
