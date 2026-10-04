import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { product, products } from '../../src/product/product.ts'
import { loadLayout, partitionOf, regionOf } from '../../src/image/file-layout.ts'
import { discover } from '../../src/pool/producers.ts'
import { validatePublicMeta } from '../../src/rootfs/validate-public-meta.ts'

const root = resolve(import.meta.dir, '../..')

test('the development eMMC product binds its own geometry and conflicting board package', () => {
  expect(products()).toContain('s905x5m.emmc-dev')
  expect(products().filter(p => p.startsWith('s905x5m.emmc'))).toEqual(['s905x5m.emmc-dev', 's905x5m.emmc-full'])
  const selected = product('s905x5m.emmc-dev')
  expect(selected.profile).toBe('dev')
  expect(selected.storageLayout).toBe('emmc')
  expect(selected.imageKinds).toBe('disk usb-burn')
  const layout = loadLayout(join(root, 'boards/s905x5m'), 'emmc')
  expect(layout.discard).toBe('no')
  expect(layout.partitions.map(p => p.number)).toEqual([4, 5, 6, 1, 2, 3])
  expect(partitionOf(layout, 'system').guid).toBe('5a9055a0-0004-4000-8000-000000000002')
  expect([regionOf(layout, 'records-a')!.diskOffset, regionOf(layout, 'records-b')!.diskOffset]).toEqual([128 * 1048576, 132 * 1048576])
  expect(discover().find(p => p.name === 'board@s905x5m')!.packages).toContain('mica-board-s905x5m-emmc')
  for (const name of ['mica-board-s905x5m', 'mica-board-s905x5m-emmc'])
    expect(readFileSync(join(root, 'boards/s905x5m/package/control', `${name}.control`), 'utf8')).toContain('Conflicts: mica-board')
})

test('board extras accept either layout package at its exact declared version', () => {
  const boardVersion = (name: string) => /^Version: (.+)$/m.exec(readFileSync(join(root, 'boards/s905x5m/package/control', `${name}.control`), 'utf8'))![1]
  const dependency = ['mica-board-s905x5m', 'mica-board-s905x5m-emmc'].map(name => `${name} (= ${boardVersion(name)})`).join(' | ')
  for (const name of ['mica-bm201-front-panel', 'mica-s905x5m-wireless']) {
    const text = readFileSync(join(root, 'boards/s905x5m/extras/wireless/control', `${name}.control`), 'utf8')
    expect(text).toContain(`Depends: ${dependency}`)
  }
  const wireless = readFileSync(join(root, 'boards/s905x5m/extras/wireless/control/mica-s905x5m-wireless.control'), 'utf8')
  const version = /^Version: (.+)$/m.exec(wireless)![1]
  for (const [dir, name] of [['wireless', 'mica-s905x5m-wifi'], ['bluetooth', 'mica-s905x5m-bluetooth']])
    expect(readFileSync(join(root, 'boards/s905x5m/extras', dir!, 'control', `${name}.control`), 'utf8')).toContain(`mica-s905x5m-wireless (= ${version})`)
})

test('the released eMMC product is the full image on the eMMC layout, with its USB burning package', () => {
  const full = product('s905x5m.full'), emmc = product('s905x5m.emmc-full')
  expect([emmc.profile, emmc.features, emmc.storageLayout, emmc.imageKinds]).toEqual([full.profile, full.features, 'emmc', 'disk usb-burn'])
  expect([full.storageLayout, full.imageKinds]).toEqual(['', 'disk'])
  for (const p of [full, emmc]) expect(() => validatePublicMeta(p.metaDir)).not.toThrow()
})

test('both development products use the current upstream public metadata contract', () => {
  for (const name of ['s905x5m.dev', 's905x5m.emmc-dev'])
    expect(() => validatePublicMeta(product(name).metaDir)).not.toThrow()
})

test('every S905X5M product carries the front panel: it is a base package of the board, not a component', async () => {
  const { resolve: resolvePackages } = await import('../../src/rootfs/resolve.ts')
  const boardDir = join(root, 'boards/s905x5m/manifests')
  const names = products().filter(p => p.startsWith('s905x5m.'))
  expect(names.length).toBeGreaterThan(0)
  for (const name of names) {
    const p = product(name)
    expect(p.components, name).toBe('')
    const set = await resolvePackages({ board: 's905x5m', boardDir, features: p.features, init: p.init, storageLayout: p.storageLayout })
    expect(set, name).toContain('mica-bm201-front-panel')
  }
}, 30000)
