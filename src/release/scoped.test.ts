import { expect, test } from 'bun:test'
import { apSecretGate, apSecretGrade, publishedImage, ScopedReleaseError } from './scoped.ts'

test('a product naming no image kinds publishes every kind it packs, disk included', () => {
  for (const kind of ['disk', 'usb-burn']) expect(publishedImage('', kind)).toBe(true)
})

test('a product naming its image kinds publishes those alone: disk, always built, ships only when named', () => {
  expect(publishedImage('usb-burn', 'usb-burn')).toBe(true)
  expect(publishedImage('usb-burn', 'disk')).toBe(false)
  expect(publishedImage('disk sd-boot', 'disk')).toBe(true)
  expect(publishedImage('disk sd-boot', 'sd-boot')).toBe(true)
  expect(publishedImage('disk', 'sd-boot')).toBe(false)
})

test('the access-point secret a record names, and publish refusing the development one alone', () => {
  expect(apSecretGrade('#factory-seeded\t0\n#ap-secret\tbuild-secret\n#pool\tx\n', 'r')).toBe('build-secret')
  expect(apSecretGrade('#ap-secret\t(none)\n', 'r')).toBe('(none)')
  expect(() => apSecretGrade('#factory-seeded\t0\n', 'r')).toThrow(ScopedReleaseError)
  expect(() => apSecretGrade('#ap-secret\tsomething\n', 'r')).toThrow(ScopedReleaseError)
  expect(() => apSecretGate('cx3576.full', 'build-secret')).not.toThrow()
  expect(() => apSecretGate('uefi-x64.full', '(none)')).not.toThrow()
  expect(() => apSecretGate('cx3576.full', 'development')).toThrow('development access-point secret')
})
