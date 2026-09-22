import { describe, expect, test } from 'bun:test'
import { parseProductEnv, productBuildDir, readProductEnv } from './product-env.ts'
import { REPO_ROOT } from './paths.ts'

describe('product.env', () => {
  test('parses the recipe and strips quotes', () => {
    const p = parseProductEnv('# a comment\nPRODUCT=x\nBOARD=b\nPROFILE=dev\nFEATURES="wifi bluetooth"\nCOMPONENTS=""\n', 'x')
    expect(p).toEqual({ name: 'x', board: 'b', profile: 'dev', features: ['wifi', 'bluetooth'] })
  })
  test('refuses a recipe that names another product or lacks a key', () => {
    expect(() => parseProductEnv('PRODUCT=y\nBOARD=b\nPROFILE=dev\nFEATURES=""\n', 'x')).toThrow(/declares PRODUCT=y/)
    expect(() => parseProductEnv('PRODUCT=x\nPROFILE=dev\nFEATURES=""\n', 'x')).toThrow(/declares no BOARD/)
  })
  test('an unknown product is refused by name; the build directory is under _out/products', () => {
    expect(() => readProductEnv('no-such-product')).toThrow(/is not a product/)
    expect(() => readProductEnv('Bad Name')).toThrow(/not a product name/)
    expect(productBuildDir('x')).toBe(`${REPO_ROOT}/_out/products/x/build`)
  })
})
