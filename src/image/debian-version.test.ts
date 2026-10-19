// src/image/debian-version.ts against mica-core's own cases (mica_deploy::debian_version tests).
import { expect, test } from 'bun:test'
import { compareDebianVersions, validDebianVersion } from './debian-version.ts'

test('versions order as dpkg orders them', () => {
  for (const [a, b] of [
    ['6.1.4-5', '6.1.4-7'], ['6.1.4-7', '6.1.10-1'], ['6.1.4~rc1-1', '6.1.4-1'], ['6.1.4-1', '6.1.4+b1-1'],
    ['6.1.4', '6.1.4a'], ['0.0.16-1', '1:0.0.1-1'], ['1.0-1', '1.0-1.1'], ['1.0~~-1', '1.0~-1'],
  ] as const) {
    expect(compareDebianVersions(a, b)).toBe(-1)
    expect(compareDebianVersions(b, a)).toBe(1)
  }
  expect(compareDebianVersions('6.1.04-7', '6.1.4-7')).toBe(0)
  expect(compareDebianVersions('0:1.0', '1.0')).toBe(0)
})

test('what is not a version is refused', () => {
  for (const bad of ['', 'a1.0', '1.0-', ':1.0', 'x:1.0', '1.0 1', '1.0-a_b', '1'.repeat(65)]) {
    expect(validDebianVersion(bad)).toBe(false)
    expect(compareDebianVersions(bad, '1.0')).toBeUndefined()
  }
  for (const good of ['1', '6.1.4-7', '2:1.0~rc1+dfsg-3ubuntu1', '1.0-1-2']) expect(validDebianVersion(good)).toBe(true)
})
