import { describe, expect, test } from 'bun:test'
import { seedPath } from './seed-data.ts'

describe('offline DATA seed paths', () => {
  test('requires bounded literal state paths', () => {
    expect(seedPath('/state/systemd-units/multi-user.target.wants/api.service')).toBe('/state/systemd-units/multi-user.target.wants/api.service')
    for (const path of ['/meta/firmware.json', '/state', 'state/x', '/state/../meta/x', '/state/./x', '/state//x', '/state/x\nwrite y', '/state/"x', '/state/x y', '/state/' + 'x'.repeat(256)]) {
      expect(() => seedPath(path)).toThrow()
    }
  })
})
