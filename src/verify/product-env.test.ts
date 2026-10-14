import { describe, expect, test } from 'bun:test'
import { parseProductEnv, productBuildDir, readProductEnv } from './product-env.ts'
import { REPO_ROOT } from './paths.ts'

describe('product.env', () => {
  test('parses the recipe and strips quotes; the board is the name\'s', () => {
    const p = parseProductEnv('# a comment\nPROFILE=dev\nFEATURES="wifi bluetooth"\nCOMPONENTS=""\n', 'b.x')
    expect(p).toEqual({ name: 'b.x', board: 'b', profile: 'dev', features: ['wifi', 'bluetooth'] })
  })
  test('refuses a recipe that lacks a key', () => {
    expect(() => parseProductEnv('FEATURES=""\n', 'b.x')).toThrow(/declares no PROFILE/)
  })
  test('an unknown product is refused by name; the build directory is under _out/products', () => {
    expect(() => readProductEnv('no-such.product')).toThrow(/is not a product/)
    expect(() => readProductEnv('Bad Name')).toThrow(/not a product name/)
    expect(productBuildDir('x')).toBe(`${REPO_ROOT}/_out/products/x/build`)
  })
})
