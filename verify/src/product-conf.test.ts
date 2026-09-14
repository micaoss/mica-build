import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChecks, featuresMissing, type CheckCase } from './checks.ts'
import { packedRootFixture } from './checks-fixture.ts'
import { EVERY_FEATURE, PRODUCT_CONF, parseProductConf, readProductConf } from './product-conf.ts'
import { SHIPPED } from './board-scope.ts'
import { verdict } from './verdict.ts'

const CONF = 'PRODUCT=cx3576-dev\nBOARD=cx3576\nPROFILE=dev\nFEATURES="micad mqtt containers wifi bluetooth"\nCOMPONENTS=""\n'

describe('product.conf', () => {
  test('is read as the product, its features and its components', () => {
    const p = parseProductConf(CONF)
    expect(p.name).toBe('cx3576-dev')
    expect(p.board).toBe('cx3576')
    expect([...p.features].sort()).toEqual(['bluetooth', 'containers', 'micad', 'mqtt', 'wifi'])
    expect(p.components.size).toBe(0)
  })
  test('the minimal image selects nothing', () => {
    expect(parseProductConf(CONF.replace(/FEATURES=.*/, 'FEATURES=""')).features.size).toBe(0)
  })
  test.each([
    ['a missing key', CONF.replace(/PROFILE=.*\n/, ''), 'declares no PROFILE'],
    ['a profile that is neither', CONF.replace('PROFILE=dev', 'PROFILE=staging'), 'neither dev nor prod'],
    ['a line that is not KEY=value', `${CONF}export X=1\n`, 'not a KEY=value line'],
    ['a key twice', `${CONF}PRODUCT=other\n`, 'declared twice'],
  ])('%s is refused by name', (_label, text, fragment) => {
    expect(() => parseProductConf(text)).toThrow(fragment)
  })
  test('a root without the file is refused, naming the composer', () => {
    const fx = packedRootFixture(SHIPPED[0]!)
    try {
      expect(() => readProductConf(fx.root)).toThrow('composed by another composer')
      mkdirSync(join(fx.root, 'usr/lib/mica'), { recursive: true })
      writeFileSync(join(fx.root, PRODUCT_CONF), CONF)
      expect(readProductConf(fx.root).name).toBe('cx3576-dev')
    } finally { fx.dispose() }
  })
})

describe('the register is scoped to the product', () => {
  const needsMqtt: CheckCase = { id: 'needs-mqtt', features: ['mqtt'], shell: { pass: 'mqtt ok' },
    run: async () => [verdict('needs-mqtt', true, 'mqtt ok')] }
  const floor: CheckCase = { id: 'floor', shell: { pass: 'floor ok' }, run: async () => [verdict('floor', true, 'floor ok')] }
  test('a check whose feature the product did not select is not run, and says so', async () => {
    const fx = packedRootFixture(SHIPPED[0]!)
    try {
      const minimal = { ...EVERY_FEATURE, name: 'minimal', features: new Set<string>() }
      const run = await runChecks({ ...fx.ctx, product: minimal }, [needsMqtt, floor])
      expect(run.results.map(r => r.id)).toEqual(['floor'])
      expect(run.notRun).toEqual([{ id: 'needs-mqtt', features: ['mqtt'] }])
      const full = await runChecks(fx.ctx, [needsMqtt, floor])
      expect(full.results.map(r => r.id).sort()).toEqual(['floor', 'needs-mqtt'])
      expect(full.notRun).toEqual([])
    } finally { fx.dispose() }
  })
  test('featuresMissing names exactly the features the product lacks', () => {
    expect(featuresMissing({ id: 'x', features: ['mqtt', 'wifi'], shell: { pass: 'x' } }, { ...EVERY_FEATURE, features: new Set(['wifi']) })).toEqual(['mqtt'])
    expect(featuresMissing({ id: 'x', shell: { pass: 'x' } }, { ...EVERY_FEATURE, features: new Set() })).toEqual([])
  })
})
