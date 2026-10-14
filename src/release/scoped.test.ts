import { expect, test } from 'bun:test'
import { publishedImage } from './scoped.ts'

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
