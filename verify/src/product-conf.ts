// The product a root was composed for, out of the root itself:
// /usr/lib/mica/product.conf, written by the composer beside profile.conf.
// The verifier scopes its register to the product's features (checks.ts
// checksFor), the way it scopes to the board: a check for the container
// engine is not a check to run over a product that ships none.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProductFacts {
  readonly name: string
  readonly board: string
  readonly profile: string
  readonly features: ReadonlySet<string>
  readonly components: ReadonlySet<string>
}

export const PRODUCT_CONF = '/usr/lib/mica/product.conf'

/** The features every check may assume in a fixture: a product that selected everything. */
export const EVERY_FEATURE: ProductFacts = {
  name: 'fixture', board: 'fixture', profile: 'dev',
  features: new Set(['micad', 'mqtt', 'containers', 'wifi', 'bluetooth']), components: new Set(),
}

export function parseProductConf(text: string, path: string = PRODUCT_CONF): ProductFacts {
  const values = new Map<string, string>()
  for (const [n, line] of text.split('\n').entries()) {
    if (line === '' || line.startsWith('#')) continue
    const m = /^([A-Z_]+)="?([^"]*)"?$/.exec(line)
    if (!m) throw new Error(`${path}:${n + 1}: not a KEY=value line: ${line}`)
    if (values.has(m[1]!)) throw new Error(`${path}: ${m[1]} is declared twice`)
    values.set(m[1]!, m[2]!)
  }
  const get = (key: string) => {
    const v = values.get(key)
    if (v === undefined) throw new Error(`${path} declares no ${key}`)
    return v
  }
  const list = (key: string) => new Set(get(key).split(' ').filter(Boolean))
  const name = get('PRODUCT'), board = get('BOARD'), profile = get('PROFILE')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`${path}: PRODUCT '${name}' is not a product name`)
  if (profile !== 'dev' && profile !== 'prod') throw new Error(`${path}: PROFILE '${profile}' is neither dev nor prod`)
  return { name, board, profile, features: list('FEATURES'), components: list('COMPONENTS') }
}

/** The product of an unpacked root; a root without the file is not one this verifier can scope. */
export function readProductConf(root: string): ProductFacts {
  let text: string
  try { text = readFileSync(join(root, PRODUCT_CONF), 'utf8') }
  catch (e) { throw new Error(`${PRODUCT_CONF} is not in the root: the composer writes it for every product, so this root was composed by another composer (${(e as Error).message})`) }
  return parseProductConf(text)
}
