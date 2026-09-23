// src/product/product.ts, driven over the tracked products and over perturbed copies of them: every product
// validates against its fetched board, and each refusal of the product contract (products/README.md) fires by
// name. The port of tests/gates/product-test.sh (deleted 2026-09-23), case for case.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/product.test.ts     (make os-product-test; needs make board-fetch-all)
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boards } from '../../src/boards/boards.ts'
import { product, ProductError, products, render } from '../../src/product/product.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'product-test.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

const TRACKED = products()

describe('every tracked product', () => {
  test('there is at least one', () => { expect(TRACKED.length).toBeGreaterThan(0) })
  for (const p of TRACKED) {
    test(`${p} validates and names its board's architecture`, () => {
      const r = product(p)
      expect(r.board).not.toBe('')
      expect(r.arch).toMatch(/^(amd64|arm64)$/)
      expect(render(r)).toContain(`MICA_ARCH=${r.arch}\n`)
    })
  }
  // Every board has a development product; there is no minimal product any more (user, 2026-09-16).
  for (const b of boards().map(b => b.name)) {
    test(`board ${b} has its development product and no minimal product`, () => {
      expect(existsSync(join(REPO_ROOT, 'products', `${b}-dev`, 'product.env'))).toBe(true)
      expect(existsSync(join(REPO_ROOT, 'products', `${b}-minimal`))).toBe(false)
    })
  }
})

/** A copy of products/ under scratch, its path. */
function mutate(name: string): string {
  const dir = join(SCRATCH, name)
  rmSync(dir, { recursive: true, force: true })
  cpSync(join(REPO_ROOT, 'products'), dir, { recursive: true })
  return dir
}

function setKey(dir: string, p: string, key: string, value: string): void {
  const file = join(dir, p, 'product.env')
  const kept = readFileSync(file, 'utf8').split('\n').filter(l => !l.startsWith(`${key}=`))
  writeFileSync(file, `${kept.join('\n').replace(/\n*$/, '\n')}${key}=${value}\n`)
}

function refuse(label: string, fragment: string, name: string, dirs: { productsDir?: string, boardsDir?: string }): void {
  test(`${label}: refused, naming '${fragment}'`, () => {
    expect(() => product(name, dirs)).toThrow(ProductError)
    expect(() => product(name, dirs)).toThrow(fragment)
  })
}

describe('the refusals, each on a perturbed copy', () => {
  let d = mutate('unknown-key'); writeFileSync(join(d, 'uefi-x64-dev/product.env'), 'COLOUR=blue\n', { flag: 'a' })
  refuse('an unknown key', 'does not name', 'uefi-x64-dev', { productsDir: d })
  d = mutate('wrong-name'); setKey(d, 'uefi-x64-dev', 'PRODUCT', 'other')
  refuse('PRODUCT differs from the directory name', 'directory name is the product', 'uefi-x64-dev', { productsDir: d })
  d = mutate('unknown-board'); setKey(d, 'uefi-x64-dev', 'BOARD', 'nosuch')
  refuse('an unpinned board', 'not a pinned board', 'uefi-x64-dev', { productsDir: d })
  d = mutate('bad-profile'); setKey(d, 'uefi-x64-dev', 'PROFILE', 'staging')
  refuse('a profile that is neither dev nor prod', 'dev or prod', 'uefi-x64-dev', { productsDir: d })
  d = mutate('unknown-feature'); setKey(d, 'uefi-x64-dev', 'FEATURES', '"micad zigbee"')
  refuse('a feature no manifest defines', 'no feature-*.pkgs', 'uefi-x64-dev', { productsDir: d })
  d = mutate('radio-off-board'); setKey(d, 'uefi-x64-dev', 'FEATURES', '"micad wifi"')
  refuse('a radio the board does not have', 'does not have', 'uefi-x64-dev', { productsDir: d })
  d = mutate('unknown-component'); setKey(d, 's905x5m-dev', 'COMPONENTS', '"hologram"')
  refuse('a component the board does not ship', 'ships no manifests/component-hologram.pkgs', 's905x5m-dev', { productsDir: d })
  d = mutate('unknown-kind'); setKey(d, 'uefi-x64-dev', 'IMAGE_KINDS', '"disk floppy"')
  refuse('an image kind the board\'s images.tsv does not declare', 'the image kind floppy is not declared', 'uefi-x64-dev', { productsDir: d })
  d = mutate('unknown-update-kind'); setKey(d, 'uefi-x64-dev', 'UPDATE_KINDS', '"full delta"')
  refuse('an update kind the board\'s images.tsv does not declare', 'the update kind delta is not declared', 'uefi-x64-dev', { productsDir: d })
  d = mutate('bad-key'); setKey(d, 'uefi-x64-dev', 'PUBLISH', '0')
  refuse('a key the product contract does not name', 'which the product contract does not name', 'uefi-x64-dev', { productsDir: d })
  d = mutate('over-budget'); setKey(d, 'uefi-x64-dev', 'SIZE_BUDGET_MB', '9999')
  refuse('a budget above the board\'s', 'may only lower it', 'uefi-x64-dev', { productsDir: d })
  d = mutate('not-a-number'); setKey(d, 'uefi-x64-dev', 'SIZE_BUDGET_MB', '5MB')
  refuse('a budget that is not a number', 'is not a number', 'uefi-x64-dev', { productsDir: d })
  d = mutate('substitution'); setKey(d, 'uefi-x64-dev', 'PROFILE', '"$(id)"')
  refuse('a substitution in a value', 'carries a substitution', 'uefi-x64-dev', { productsDir: d })
  d = mutate('twice'); writeFileSync(join(d, 'uefi-x64-dev/product.env'), 'PROFILE=dev\n', { flag: 'a' })
  refuse('a key declared twice', 'more than once', 'uefi-x64-dev', { productsDir: d })
  d = mutate('no-meta'); rmSync(join(d, 'uefi-x64-dev/meta/updates/manifest.json'))
  refuse('a product with no public manifest', 'meta/updates/manifest.json is missing', 'uefi-x64-dev', { productsDir: d })
  d = mutate('secret-default'); writeFileSync(join(d, 'uefi-x64-dev/defaults.toml'), 'version = 1\n[access.device]\npassword = "hunter2"\n')
  refuse('a secret in defaults.toml', 'secret-bearing key', 'uefi-x64-dev', { productsDir: d })
  d = mutate('bad-defaults'); writeFileSync(join(d, 'uefi-x64-dev/defaults.toml'), 'version = 2\n')
  refuse('defaults.toml without version = 1', 'version = 1 is required', 'uefi-x64-dev', { productsDir: d })
  d = mutate('not-toml-defaults'); writeFileSync(join(d, 'uefi-x64-dev/defaults.toml'), 'not toml [\n')
  refuse('defaults.toml that is not TOML', 'not valid TOML', 'uefi-x64-dev', { productsDir: d })
  d = mutate('bad-provisioning'); writeFileSync(join(d, 'uefi-x64-dev/provisioning.toml'), 'not toml [\n')
  refuse('an invalid provisioning.toml', 'not a valid provisioning document', 'uefi-x64-dev', { productsDir: d })
  refuse('the reserved scope', 'no product is named mica', 'mica', {})
  refuse('a product that does not exist', 'the products are: ', 'nosuch', {})
  // A board without room for the engine refuses a product that wants it.
  const bdir = join(SCRATCH, 'boards'); rmSync(bdir, { recursive: true, force: true }); cpSync(join(REPO_ROOT, '_out/boards'), bdir, { recursive: true })
  const env = join(bdir, 'uefi-x64/board.env')
  writeFileSync(env, readFileSync(env, 'utf8').replace(/^BOARD_FEATURES=.*$/m, 'BOARD_FEATURES=""'))
  refuse('containers on a board without room for the engine', 'does not have', 'uefi-x64-dev', { boardsDir: bdir })
  refuse('an unfetched board', 'is not fetched (make board-fetch BOARD=uefi-x64)', 'uefi-x64-dev', { boardsDir: join(SCRATCH, 'no-boards') })
})

describe('the positive controls', () => {
  test('a valid defaults.toml and provisioning.toml are accepted and reported', () => {
    const d = mutate('good-optional')
    writeFileSync(join(d, 'uefi-x64-dev/defaults.toml'), 'version = 1\n[access.ssh]\nenabled = true\n')
    writeFileSync(join(d, 'uefi-x64-dev/provisioning.toml'), 'version = 1\n[admin]\npassword = "factory"\n')
    const r = product('uefi-x64-dev', { productsDir: d })
    expect(r.defaults).toBe(join(d, 'uefi-x64-dev/defaults.toml'))
    expect(r.provisioning).toBe(join(d, 'uefi-x64-dev/provisioning.toml'))
    expect(render(r)).toMatch(/^DEFAULTS=.*\/defaults\.toml$/m)
    expect(render(r)).toMatch(/^PROVISIONING=.*\/provisioning\.toml$/m)
  })
  test('a product lowering its budget keeps the lower value; the board\'s otherwise', () => {
    const d = mutate('lower-budget'); setKey(d, 'uefi-x64-dev', 'SIZE_BUDGET_MB', '100')
    expect(product('uefi-x64-dev', { productsDir: d }).sizeBudgetMb).toBe('100')
    expect(product('uefi-x64-dev').sizeBudgetMb).toBe(readFileSync(join(REPO_ROOT, '_out/boards/uefi-x64/board.env'), 'utf8').match(/^BOARD_SIZE_BUDGET_MB=(\d+)$/m)![1]!)
  })
  test('the radios of a product are the radio features it selects, and a subset of image kinds keeps disk', () => {
    const cx = product('cx3576-dev')
    expect(cx.radios.split(' ').filter(Boolean).every(r => cx.features.split(' ').includes(r))).toBe(true)
    const d = mutate('kinds-subset'); setKey(d, 'cx3576-dev', 'IMAGE_KINDS', '"disk"')
    expect(product('cx3576-dev', { productsDir: d }).imageKinds).toBe('disk')
  })
})
