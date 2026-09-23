// The product reader: WHAT one image is made of, read out of products/<name>/ and validated against the fetched
// board bundle, printed as plain KEY=value for the composer, the assembler, the suites and the tests to consume.
// Nothing else re-derives a product's inputs.
//
//   bun src/cli.ts product <name>            validate, print the resolved inputs
//   bun src/cli.ts product --list            every product, one per line
//
//   reads   products/<name>/product.env, defaults.toml, provisioning.toml, meta/
//           _out/boards/<board>/board.env and manifests/ (make board-fetch)
//           rootfs/packages/{feature,radio}-*.pkgs (the feature names that exist)
//   prints  PRODUCT, BOARD, BOARD_DIR, MICA_ARCH, PROFILE, FEATURES, RADIOS,
//           COMPONENTS, IMAGE_KINDS, UPDATE_KINDS, SIZE_BUDGET_MB, META_DIR, DEFAULTS, PROVISIONING
//
// Every refusal names what was wrong and what the legal values are. The port of tools/product.sh (deleted
// 2026-09-23), refusal for refusal; the TOML documents the shell handed to Python are read by Bun's parser, so a
// malformed file is refused with that parser's words. MICA_PRODUCTS_DIR and MICA_BOARDS_DIR point the reader at
// perturbed copies (tests/gates/product.test.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { boards, BoardsError } from '../boards/boards.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { imageKinds, updateKinds } from './image-kinds.ts'

export class ProductError extends Error {}

const PACKAGES = join(REPO_ROOT, 'rootfs/packages')
const CONTRACT = ['PRODUCT', 'BOARD', 'PROFILE', 'FEATURES', 'COMPONENTS', 'IMAGE_KINDS', 'UPDATE_KINDS', 'SIZE_BUDGET_MB']
const HARDWARE_FEATURES = ['wifi', 'bluetooth', 'display', 'status-led', 'can', 'usb-gadget', 'audio', 'containers']
const SECRET_KEYS = new Set(['psk', 'password', 'passwordHash', 'pin', 'key'])

export type Product = {
  product: string, board: string, boardDir: string, arch: string, profile: string,
  features: string, radios: string, components: string, imageKinds: string, updateKinds: string,
  sizeBudgetMb: string, metaDir: string, defaults: string, provisioning: string,
}

export type Dirs = { productsDir?: string, boardsDir?: string }

function die(message: string): never {
  throw new ProductError(`error: ${message}`)
}

function productsDir(dirs: Dirs): string {
  return dirs.productsDir ?? process.env['MICA_PRODUCTS_DIR'] ?? join(REPO_ROOT, 'products')
}

function boardsDir(dirs: Dirs): string {
  return dirs.boardsDir ?? process.env['MICA_BOARDS_DIR'] ?? join(REPO_ROOT, '_out/boards')
}

/** Every product: the directories of products/ holding a product.env, in name order. */
export function products(dirs: Dirs = {}): string[] {
  const dir = productsDir(dirs)
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().filter(d => statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, 'product.env')))
}

/** The value of a KEY=value or KEY="value" line of a plain environment file; a refusal names the file. */
export function plainValue(file: string, key: string, required = false): string {
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith(`${key}=`))
  if (lines.length > 1) die(`${file} declares ${key} more than once`)
  if (lines.length === 0) {
    if (required) die(`${file} declares no ${key}`)
    return ''
  }
  const line = lines[0]!
  if (line.includes('$(') || line.includes('`') || line.includes('${')) die(`${file}: ${key} carries a substitution; a product file is plain KEY=value`)
  let value = line.slice(line.indexOf('=') + 1)
  if (value.startsWith('"')) value = value.slice(1)
  if (value.endsWith('"')) value = value.slice(0, -1)
  return value
}

const words = (s: string) => s.split(/[ \t\n]+/).filter(w => w !== '')

/** Python's repr of a TOML scalar, for the message the shell's Python wrote. */
function repr(value: unknown): string {
  if (value === undefined || value === null) return 'None'
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

function toml(path: string): Record<string, unknown> {
  try { return Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
  catch (e) { throw new ProductError(`error: ${path}: not valid TOML: ${(e as Error).message}`) }
}

/** defaults.toml: version = 1 and no secret-bearing key at any depth. */
function checkDefaults(path: string): void {
  const doc = toml(path)
  if (doc['version'] !== 1) throw new ProductError(`error: ${path}: version = 1 is required (found ${repr(doc['version'])})`)
  const walk = (table: Record<string, unknown>, at: string[]) => {
    for (const [k, v] of Object.entries(table)) {
      if (SECRET_KEYS.has(k)) throw new ProductError(`error: ${path}: ${[...at, k].join('.')} is a secret-bearing key; a product default is never a secret, and a value like this travels in provisioning.toml`)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v as Record<string, unknown>, [...at, k])
    }
  }
  walk(doc, [])
}

/** One product, validated against its fetched board. */
export function product(name: string, dirs: Dirs = {}): Product {
  if (name === 'mica') die('mica is the reserved scope of the Mica version index (mica.<YYYYMMDD-HHMM>); no product is named mica')
  const dir = join(productsDir(dirs), name)
  const env = join(dir, 'product.env')
  if (!existsSync(env)) die(`products/${name}/product.env does not exist; the products are: ${products(dirs).map(p => `${p} `).join('')}`)

  // Every line is KEY=value or a comment, and every key is one this contract names.
  for (const line of readFileSync(env, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    if (!/^[A-Z_]+=/.test(line)) die(`products/${name}/product.env: a line that is neither KEY=value nor a comment: ${line}`)
    const key = line.slice(0, line.indexOf('='))
    if (!CONTRACT.includes(key)) die(`products/${name}/product.env declares ${key}, which the product contract does not name (products/README.md)`)
  }

  const productName = plainValue(env, 'PRODUCT', true)
  if (productName !== name) die(`products/${name}/product.env declares PRODUCT=${productName}; the directory name is the product`)
  const board = plainValue(env, 'BOARD', true)
  let pinned: string[]
  try { pinned = boards().map(b => b.name) }
  catch (e) {
    if (!(e instanceof BoardsError)) throw e
    die(`boards/boards.tsv could not be read (${e.message})`)
  }
  if (!pinned.includes(board)) die(`product ${name}: BOARD=${board} is not a pinned board; the pinned boards are: ${pinned.map(b => `${b} `).join('')}`)
  const boardDir = join(boardsDir(dirs), board)
  const boardEnv = join(boardDir, 'board.env')
  if (!existsSync(boardEnv)) die(`product ${name}: the board ${board} is not fetched (make board-fetch BOARD=${board})`)
  const arch = plainValue(boardEnv, 'MICA_ARCH', true)
  const boardFeatures = words(plainValue(boardEnv, 'BOARD_FEATURES', true))
  const boardBudget = plainValue(boardEnv, 'BOARD_SIZE_BUDGET_MB', true)

  const profile = plainValue(env, 'PROFILE', true)
  if (profile !== 'dev' && profile !== 'prod') die(`product ${name}: PROFILE=${profile}; it is dev or prod`)

  // The features that exist: the engine's feature-*.pkgs and radio-*.pkgs.
  const manifests = readdirSync(PACKAGES).sort()
  const known = manifests.filter(f => /^feature-.*\.pkgs$/.test(f)).map(f => f.slice('feature-'.length, -'.pkgs'.length))
  const radiosKnown = manifests.filter(f => /^radio-.*\.pkgs$/.test(f)).map(f => f.slice('radio-'.length, -'.pkgs'.length))
  known.push(...radiosKnown)
  const features = plainValue(env, 'FEATURES', true)
  const radios: string[] = []
  for (const f of words(features)) {
    if (!known.includes(f)) die(`product ${name}: FEATURES names '${f}', which no feature-*.pkgs or radio-*.pkgs under rootfs/packages defines; the features are:${known.map(k => ` ${k}`).join('')}`)
    if (HARDWARE_FEATURES.includes(f) && !boardFeatures.includes(f))
      die(`product ${name}: FEATURES names '${f}', which the board ${board} does not have (BOARD_FEATURES="${plainValue(boardEnv, 'BOARD_FEATURES')}")`)
    if (radiosKnown.includes(f)) radios.push(f)
  }

  const components = plainValue(env, 'COMPONENTS')
  for (const c of words(components))
    if (!existsSync(join(boardDir, 'manifests', `component-${c}.pkgs`))) die(`product ${name}: COMPONENTS names '${c}', and the board ${board} ships no manifests/component-${c}.pkgs`)

  // The flashing formats: the kinds the board's images.tsv declares, all of them unless the product names a
  // subset; disk is always one (src/product/image-kinds.ts).
  const imageKindsGiven = plainValue(env, 'IMAGE_KINDS')
  let imageKindsRows: string[]
  try { imageKindsRows = imageKinds(boardDir, words(imageKindsGiven)).map(r => r.kind) }
  catch (e) { die(`product ${name}: IMAGE_KINDS="${imageKindsGiven}" is not a set of the image kinds of the board ${board} (${(e as Error).message})`) }
  // The update packages likewise: the board's update rows, all unless the product names a subset; full is always one.
  const updateKindsGiven = plainValue(env, 'UPDATE_KINDS')
  let updateKindsRows: string[]
  try { updateKindsRows = updateKinds(boardDir, words(updateKindsGiven)).map(r => r.kind) }
  catch (e) { die(`product ${name}: UPDATE_KINDS="${updateKindsGiven}" is not a set of the update kinds of the board ${board} (${(e as Error).message})`) }

  let sizeBudgetMb = plainValue(env, 'SIZE_BUDGET_MB')
  if (sizeBudgetMb !== '') {
    if (!/^[0-9]+$/.test(sizeBudgetMb)) die(`product ${name}: SIZE_BUDGET_MB=${sizeBudgetMb} is not a number`)
    if (Number(sizeBudgetMb) > Number(boardBudget)) die(`product ${name}: SIZE_BUDGET_MB=${sizeBudgetMb} exceeds the board's BOARD_SIZE_BUDGET_MB=${boardBudget}; a product may only lower it`)
  }
  else { sizeBudgetMb = boardBudget }

  const metaDir = join(dir, 'meta')
  if (!existsSync(join(metaDir, 'updates/manifest.json'))) die(`product ${name}: meta/updates/manifest.json is missing; the public factory manifest is a product's (meta.example/README.md)`)

  let defaults = ''
  if (existsSync(join(dir, 'defaults.toml'))) {
    defaults = join(dir, 'defaults.toml')
    checkDefaults(defaults)
  }
  let provisioning = ''
  if (existsSync(join(dir, 'provisioning.toml'))) {
    provisioning = join(dir, 'provisioning.toml')
    let ok = false
    try { ok = toml(provisioning)['version'] === 1 }
    catch { ok = false }
    if (!ok) die(`product ${name}: provisioning.toml is not a valid provisioning document (TOML with version = 1)`)
  }

  return {
    product: productName, board, boardDir, arch, profile, features, radios: radios.join(' '), components,
    imageKinds: imageKindsRows.join(' '), updateKinds: updateKindsRows.join(' '), sizeBudgetMb, metaDir, defaults, provisioning,
  }
}

/** The KEY=value lines a shell caller evals. */
export function render(p: Product): string {
  return [
    `PRODUCT=${p.product}`, `BOARD=${p.board}`, `BOARD_DIR=${p.boardDir}`, `MICA_ARCH=${p.arch}`, `PROFILE=${p.profile}`,
    `FEATURES="${p.features}"`, `RADIOS="${p.radios}"`, `COMPONENTS="${p.components}"`, `IMAGE_KINDS="${p.imageKinds}"`,
    `UPDATE_KINDS="${p.updateKinds}"`, `SIZE_BUDGET_MB=${p.sizeBudgetMb}`, `META_DIR=${p.metaDir}`, `DEFAULTS=${p.defaults}`,
    `PROVISIONING=${p.provisioning}`,
  ].map(l => `${l}\n`).join('')
}

export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === '--list' && argv.length === 1) {
      await Bun.write(Bun.stdout, products().map(p => `${p}\n`).join(''))
      return 0
    }
    if (argv.length !== 1 || argv[0]!.startsWith('--')) { console.error('usage: bun src/cli.ts product <name> | --list'); return 1 }
    await Bun.write(Bun.stdout, render(product(argv[0]!)))
    return 0
  }
  catch (e) {
    if (e instanceof ProductError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
