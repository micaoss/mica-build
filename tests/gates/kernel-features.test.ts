// The kernel features (common/kernel/features.tsv) and their two readers: src/boards/kernel-features.ts, which holds
// products, roots and fetched kernels to a board's KERNEL_FEATURES, and common/kernel/compose-floor.sh, which
// composes the floor a board's kernel build merges. Both read one table and must give one answer: the features in
// table order and the LSM boot list. Every refusal fires by name.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/kernel-features.test.ts     (make kernel-features-test)
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boards } from '../../src/boards/boards.ts'
import {
  boardKernelFeatures, floorFeatures, kernelFeatures, kernelFloorRefusal, missingKernelFeatures, neededKernelFeatures, parseKernelFeatures,
} from '../../src/boards/kernel-features.ts'
import { plainValue } from '../../src/product/product.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const KERNEL = join(REPO_ROOT, 'common/kernel')
const COMPOSE = join(KERNEL, 'compose-floor.sh')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'kernel-features.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const TABLE = kernelFeatures()
const ALL = TABLE.slice(1).filter(f => f.name !== 'storage-ubi').map(f => f.name)

function compose(features: string, dir = KERNEL): { code: number, out: string, err: string } {
  const r = Bun.spawnSync(['bash', COMPOSE, dir, features], { stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('the table', () => {
  test('every feature has its fragment, and no fragment is without a row', () => {
    const rows = TABLE.map(f => f.name).sort()
    const files = [...new Bun.Glob('*.fragment').scanSync(join(KERNEL, 'fragments'))].map(f => f.replace(/\.fragment$/, '')).sort()
    expect(files).toEqual(rows)
  })
  test('no symbol is stated by two fragments, and no fragment sets CONFIG_LSM (the composition does)', () => {
    const seen = new Map<string, string>()
    for (const f of TABLE) {
      for (const line of readFileSync(join(KERNEL, 'fragments', `${f.name}.fragment`), 'utf8').split('\n')) {
        const sym = /^(CONFIG_[A-Z0-9_]+)=/.exec(line)?.[1] ?? /^# (CONFIG_[A-Z0-9_]+) is not set$/.exec(line)?.[1]
        if (sym === undefined) continue
        expect(sym).not.toBe('CONFIG_LSM')
        expect(seen.get(sym) ?? f.name).toBe(f.name)
        seen.set(sym, f.name)
      }
    }
  })
  test.each([
    ['a wrong first line', 'mica kernel features v1\ncore\t-\t-\t-\n', 'the first line'],
    ['a row of three columns', '# mica kernel features v1\ncore\t-\t-\n', 'four columns'],
    ['core not first', '# mica kernel features v1\nnet\t-\t-\t-\ncore\t-\t-\t-\n', 'the first row is not core'],
    ['core with a trigger', '# mica kernel features v1\ncore\t-\t-\tinit:systemd\n', 'core requires nothing'],
    ['a second row', '# mica kernel features v1\ncore\t-\t-\t-\nnet\t-\t-\t-\nnet\t-\t-\t-\n', 'a second row for net'],
    ['an unknown trigger kind', '# mica kernel features v1\ncore\t-\t-\t-\nnet\t-\t-\tboard:x\n', 'is no trigger'],
    ['an unknown required feature', '# mica kernel features v1\ncore\t-\t-\t-\nnet\tfirewall\t-\t-\n', 'requires \'firewall\''],
  ])('%s is refused', (_, text, message) => {
    expect(() => parseKernelFeatures(text)).toThrow(message)
  })
})

describe('compose-floor.sh and src/boards/kernel-features.ts agree', () => {
  for (const b of boards()) {
    const value = plainValue(join(REPO_ROOT, 'boards', b.name, 'board.env'), 'KERNEL_FEATURES')
    const storage = plainValue(join(REPO_ROOT, 'boards', b.name, 'board.env'), 'BOARD_STORAGE') || 'gpt'
    test(`${b.name}: the composed floor names the board's features in table order and their LSM list`, () => {
      const names = boardKernelFeatures(TABLE, value, storage, b.name)
      const r = compose(value)
      expect(r.code).toBe(0)
      const ordered = TABLE.map(f => f.name).filter(n => names.includes(n))
      expect(floorFeatures(r.out)).toEqual(ordered)
      const lsm = TABLE.filter(f => f.name === 'core' || names.includes(f.name)).flatMap(f => f.lsm).join(',')
      expect(r.out.split('\n').filter(l => l.startsWith('CONFIG_LSM='))).toEqual([`CONFIG_LSM="${lsm}"`])
      // merge_config.sh greps comments for symbol names: the composition's own comments name none.
      const fragmentLines = new Set(TABLE.flatMap(f => readFileSync(join(KERNEL, 'fragments', `${f.name}.fragment`), 'utf8').split('\n')))
      expect(r.out.split('\n').filter(l => !fragmentLines.has(l) && !l.startsWith('CONFIG_LSM=') && l.includes('CONFIG_'))).toEqual([])
    })
  }
  test('the full list, in any order, composes the same floor', () => {
    const a = compose(ALL.join(' ')), b = compose([...ALL].reverse().join(' '))
    expect(a.code).toBe(0)
    expect(b.out).toBe(a.out)
  })
  test.each([
    ['an unknown feature', 'storage-gpt zigbee', 'names \'zigbee\''],
    ['core', 'core storage-gpt', 'names core'],
    ['a feature twice', 'storage-gpt storage-gpt', 'names \'storage-gpt\' twice'],
    ['a feature without what it requires', 'storage-gpt containers', 'requires firewall'],
  ])('compose-floor.sh refuses %s', (_, features, message) => {
    const r = compose(features)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain(message)
  })
  test('compose-floor.sh refuses a feature whose fragment is missing', () => {
    const dir = join(T, 'no-fragment')
    cpSync(KERNEL, dir, { recursive: true })
    rmSync(join(dir, 'fragments', 'wireguard.fragment'))
    const r = compose('storage-gpt wireguard', dir)
    expect(r.code).not.toBe(0)
    expect(r.err).toContain('fragments/wireguard.fragment does not exist')
  })
})

describe('a board\'s KERNEL_FEATURES', () => {
  test.each([
    ['no key', undefined, 'declares no KERNEL_FEATURES'],
    ['core', 'core storage-gpt', 'names core'],
    ['an unknown feature', 'storage-gpt zigbee', 'names \'zigbee\''],
    ['a feature twice', 'storage-gpt netdev netdev', 'names \'netdev\' twice'],
    ['a feature without what it requires', 'storage-gpt firewall containers', 'which requires netdev'],
    ['no storage feature', 'init-systemd', 'storage feature(s) none'],
    ['the other storage model', 'storage-ubi', 'whose kernel feature is storage-gpt'],
    ['two storage models', 'storage-gpt storage-ubi', 'storage-gpt storage-ubi'],
  ])('%s is refused', (_, value, message) => {
    expect(() => boardKernelFeatures(TABLE, value, 'gpt')).toThrow(message)
  })
  test('the ubi storage model is its own feature', () => {
    expect(boardKernelFeatures(TABLE, 'storage-ubi', 'ubi')).toEqual(['storage-ubi'])
  })
})

describe('what a product needs', () => {
  const need = (n: Parameters<typeof neededKernelFeatures>[1]) => [...neededKernelFeatures(TABLE, n).keys()].sort()
  test('systemd needs init-systemd and netdev; openrc neither', () => {
    expect(need({ init: 'systemd', storage: 'gpt' })).toEqual(['init-systemd', 'netdev', 'storage-gpt'])
    expect(need({ init: 'openrc', storage: 'gpt' })).toEqual(['storage-gpt'])
  })
  test('containers bring what they require', () => {
    expect(need({ init: 'openrc', features: ['containers'] })).toEqual(['containers', 'firewall', 'netdev'])
  })
  test('an installed nftables or iptables needs the firewall', () => {
    expect(need({ packages: ['nftables'] })).toEqual(['firewall'])
    expect(need({ packages: ['iptables', 'bash'] })).toEqual(['firewall'])
    expect(need({ packages: ['bash'] })).toEqual([])
  })
  test('a missing feature is named with what needs it', () => {
    const needed = neededKernelFeatures(TABLE, { init: 'openrc', storage: 'gpt', features: ['containers'] })
    expect(missingKernelFeatures(['storage-gpt', 'netdev'], needed)).toEqual(['containers (feature:containers)', 'firewall (required by containers)'])
    expect(missingKernelFeatures(['storage-gpt', 'netdev', 'firewall', 'containers'], needed)).toEqual([])
  })
})

describe('a fetched kernel against its board', () => {
  const floor = compose('storage-gpt wireguard').out
  const config = floor.split('\n').filter(l => /^CONFIG_[A-Z0-9_]+=y$/.test(l)).join('\n') + '\n'
  test('its floor and config agree with the board', () => {
    expect(kernelFloorRefusal(floor, config, ['wireguard', 'storage-gpt'])).toBeUndefined()
  })
  test('a floor of other features is refused', () => {
    expect(kernelFloorRefusal(floor, config, ['storage-gpt'])).toContain('built with the kernel features "storage-gpt wireguard"')
    expect(kernelFloorRefusal(floor, config, ['storage-gpt', 'wireguard', 'dm-crypt'])).toContain('KERNEL_FEATURES="storage-gpt wireguard dm-crypt"')
  })
  test('a config lacking a line of its floor is refused', () => {
    expect(kernelFloorRefusal(floor, config.replace('CONFIG_WIREGUARD=y\n', ''), ['storage-gpt', 'wireguard'])).toContain('lacks CONFIG_WIREGUARD=y')
  })
  test('a floor that was not composed is refused', () => {
    const file = join(T, 'old.fragment')
    writeFileSync(file, 'CONFIG_DM_VERITY=y\n')
    expect(kernelFloorRefusal(readFileSync(file, 'utf8'), config, ['storage-gpt'])).toContain('not composed by common/kernel/compose-floor.sh')
  })
})
