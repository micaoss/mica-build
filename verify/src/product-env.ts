/**
 * A product's recipe, `products/<name>/product.env`: the one place the
 * verifier and the smoke runners learn which board a product is on and where
 * its composition is (`_out/products/<name>/build`).
 *
 * tools/product.sh is the reader every shell entry point uses; this is the
 * same file read the same way (plain KEY=value, quotes stripped) for the
 * TypeScript entry points, and it reads nothing product.sh would refuse.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './paths.ts'

export interface ProductEnv {
  readonly name: string
  readonly board: string
  readonly profile: string
  readonly features: readonly string[]
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

export function productEnvPath(name: string): string {
  return join(REPO_ROOT, 'products', name, 'product.env')
}

/** `_out/products/<name>/build`: where rootfs/build.sh composes the product. */
export function productBuildDir(name: string): string {
  return join(REPO_ROOT, '_out', 'products', name, 'build')
}

export function parseProductEnv(text: string, name: string): ProductEnv {
  const values = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!m) throw new Error(`products/${name}/product.env: not a KEY=value line: ${line}`)
    values.set(m[1]!, m[2]!.replace(/^"(.*)"$/, '$1'))
  }
  const get = (key: string) => {
    const v = values.get(key)
    if (v === undefined) throw new Error(`products/${name}/product.env declares no ${key}`)
    return v
  }
  if (get('PRODUCT') !== name) throw new Error(`products/${name}/product.env declares PRODUCT=${get('PRODUCT')}`)
  return { name, board: get('BOARD'), profile: get('PROFILE'), features: get('FEATURES').split(/\s+/).filter(Boolean) }
}

export function readProductEnv(name: string): ProductEnv {
  if (!NAME.test(name)) throw new Error(`'${name}' is not a product name`)
  const path = productEnvPath(name)
  if (!existsSync(path)) throw new Error(`'${name}' is not a product: ${path} does not exist. The products are what products/ holds.`)
  return parseProductEnv(readFileSync(path, 'utf8'), name)
}
