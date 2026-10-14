import { describe, expect, test } from 'bun:test'
import { neededRoots } from './base-packages.ts'

type Fields = Record<string, string>
const row = (control: Fields, roots: string[]) => ({ control, roots: new Set(roots) })

// A lock where libnl-genl-3-200 is a root and libnl-3-200 only comes with it (and with iw).
const LOCK = new Map<string, { control: Fields, roots: Set<string> }>([
  ['libnl-3-200', row({ Package: 'libnl-3-200' }, ['iw', 'libnl-genl-3-200'])],
  ['libnl-genl-3-200', row({ Package: 'libnl-genl-3-200', Depends: 'libnl-3-200' }, ['iw', 'libnl-genl-3-200'])],
  ['iw', row({ Package: 'iw', Depends: 'libnl-3-200, libnl-genl-3-200' }, ['iw'])],
])

describe('neededRoots', () => {
  test('a dependency is met by the closure of a root another dependency needs', () => {
    const local = new Map<string, Fields>([['mica-wifi', { Package: 'mica-wifi', Depends: 'libnl-3-200 (>= 3.2), libnl-genl-3-200 (>= 3.2)' }]])
    const got = neededRoots(new Set(), local, LOCK, ['mica-wifi'])
    expect(got.missing).toEqual([])
    expect([...got.needed.keys()]).toEqual(['libnl-genl-3-200'])
    expect([...got.needed.get('libnl-genl-3-200')!]).toEqual(['mica-wifi'])
  })

  test('a root the product names satisfies its pool packages, which need no root of their own', () => {
    const local = new Map<string, Fields>([['mica-wifi', { Package: 'mica-wifi', Depends: 'libnl-3-200' }]])
    const got = neededRoots(new Set(), local, LOCK, ['mica-wifi', 'iw'])
    expect(got.missing).toEqual([])
    expect([...got.needed.keys()]).toEqual(['iw'])
  })

  test('a dependency no root provides is missing, by name', () => {
    const local = new Map<string, Fields>([['mica-wifi', { Package: 'mica-wifi', Depends: 'libssl3t64' }]])
    expect(neededRoots(new Set(), local, LOCK, ['mica-wifi']).missing).toEqual(['mica-wifi needs libssl3t64'])
  })

  test('the Base root and the pool satisfy before any root is taken', () => {
    const local = new Map<string, Fields>([['mica-wifi', { Package: 'mica-wifi', Depends: 'libnl-3-200, rfkill' }], ['rfkill', { Package: 'rfkill' }]])
    const got = neededRoots(new Set(['libnl-3-200']), local, LOCK, ['mica-wifi', 'rfkill'])
    expect(got.missing).toEqual([])
    expect(got.needed.size).toBe(0)
  })
})
