import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { encodeFitEnvironment } from './fit-environment.ts'

const records = [
  { id: 'a'.repeat(64), kernelId: 'c'.repeat(64), generation: 2, tries: 3 },
  { id: 'b'.repeat(64), kernelId: 'c'.repeat(64), generation: 1, tries: null },
]
test('factory environment matches native firmware and the independent CRC fixture', () => {
  const bytes = encodeFitEnvironment(records, 7)
  expect(bytes.length).toBe(65536)
  expect(bytes.readUInt32LE(0)).toBe(0xc2800412)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('91f6bfd298a72e948eff9b04908c9c01487e102bc5a806a6827ba4e4954554a3')
  for (const bad of [[], [{ ...records[0]!, id: 'd'.repeat(64), generation: 3 }, ...records], [...records, ...records], records.toReversed(),
    [{ ...records[0]!, tries: 4 }], [{ ...records[0]!, generation: 0 }],
    [{ ...records[0]!, id: 'A'.repeat(64) }], [{ ...records[0]!, generation: Number.MAX_SAFE_INTEGER + 1 }]])
    expect(() => encodeFitEnvironment(bad, 0)).toThrow()
})
