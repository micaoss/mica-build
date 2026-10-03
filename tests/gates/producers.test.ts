// Every producer's mica-inputs declares exactly the packages it builds: the inputs hash the version guard and the
// board publish read (src/pool/producers.ts inputsOf) refuses any other, and only a release would find out.
import { expect, test } from 'bun:test'
import { discover, inputsOf } from '../../src/pool/producers.ts'

const producers = discover()

test('the tree has producers to hold', () => {
  expect(producers.length).toBeGreaterThan(0)
})

test.each(producers.map(p => [p.name, p] as const))('%s declares in its mica-inputs every package it builds', (_name, p) => {
  for (const arch of p.arches) expect(inputsOf(p, arch)).toMatch(/^[0-9a-f]{64}$/)
})
