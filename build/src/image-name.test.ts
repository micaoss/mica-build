import { expect, test } from 'bun:test'
import { factoryImageFilename, isFactoryImageFilename } from './image-name.ts'

test.each(['uefi-x64', 'uefi-arm64', 'cx3576', 's905x5m'])('factory image names use UTC seconds for %s', board => {
  const filename = factoryImageFilename(board, new Date('2026-09-10T00:42:33.999+08:00'))
  expect(filename).toBe(`mica-${board}-20260909-164233.img`)
  expect(isFactoryImageFilename(filename, board)).toBe(true)
  const next = factoryImageFilename(board, new Date('2026-09-09T16:42:34Z'))
  expect(next).not.toBe(filename)
  expect([next, filename].sort()).toEqual([filename, next])
})

test.each([
  'disk.img', 'image.img', 'mica-cx3576-20260909-164233.img',
  '../mica-uefi-x64-20260909-164233.img', 'mica-uefi-x64-20260230-164233.img',
  'mica-uefi-x64-20260229-164233.img', 'mica-uefi-x64-20261301-164233.img',
  'mica-uefi-x64-20260909-240000.img', 'mica-uefi-x64-20260909-166033.img',
  'mica-uefi-x64-20260909-164260.img', 'mica-uefi-x64-20260909-1642.img',
  'mica-uefi-x64-20260909-164233.img.old',
])('invalid image name is refused: %s', filename => {
  expect(isFactoryImageFilename(filename, 'uefi-x64')).toBe(false)
})

test('leap dates are accepted and invalid build inputs are refused', () => {
  expect(isFactoryImageFilename('mica-uefi-x64-20280229-000000.img', 'uefi-x64')).toBe(true)
  expect(() => factoryImageFilename('unknown', new Date())).toThrow('board')
  expect(() => factoryImageFilename('uefi-x64', new Date(NaN))).toThrow('build time')
})
