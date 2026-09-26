// The composer's decisions that need no pool, no board bundle and no docker: the cache bridge to the stages
// driver, the argument list the driver is handed, the Base root rows and the preset lines. The cache contract
// was tests/gates/rootfs-reproducibility-test.sh's Python reading rootfs/build.sh (deleted 2026-09-23); the
// refusal it proved by running the shell is proved here by running the composer up to that refusal.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { baseRootRows, BuildError, cacheArgs, compose, driverArgNames, driverArgs, driverCommand, presets } from './build.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('the cache bridge', () => {
  test('0 and unset build from cache, 1 builds cold, anything else is refused by name', () => {
    expect(cacheArgs(undefined)).toEqual([])
    expect(cacheArgs('0')).toEqual([])
    expect(cacheArgs('1')).toEqual(['--no-cache'])
    for (const invalid of ['', '2', 'true', 'yes']) {
      expect(() => cacheArgs(invalid)).toThrow(BuildError)
      expect(() => cacheArgs(invalid)).toThrow(`MICA_ROOTFS_NO_CACHE is '${invalid}'; it must be exactly 0 or 1`)
    }
  })

  test('the composer refuses an invalid MICA_ROOTFS_NO_CACHE before it reads a product', async () => {
    for (const invalid of ['', '2', 'true']) {
      const env = { MICA_PRODUCT: 'no-such-product', MICA_ROOTFS_NO_CACHE: invalid }
      await expect(compose(env)).rejects.toThrow('it must be exactly 0 or 1')
    }
  })

  test('the switch reaches the driver ahead of the composition arguments', () => {
    expect(driverCommand(['--no-cache'], ['--board', 'b'])).toEqual(['build-rootfs', '--no-cache', '--board', 'b'])
    expect(driverCommand([], ['--board', 'b'])).toEqual(['build-rootfs', '--board', 'b'])
  })
})

describe('the retired switches', () => {
  test('each is refused by name, before anything else', async () => {
    for (const retired of ['MICA_BOARD', 'MICA_PROFILE', 'WITH_MICAD', 'WITH_CONTAINERS', 'MICA_ROOTFS_WITHOUT', 'MICA_ROOTFS_COMPONENTS', 'MICA_META_DIR'])
      await expect(compose({ MICA_PRODUCT: 'uefi-x64-dev', [retired]: 'x' })).rejects.toThrow(`${retired} is set. It no longer selects anything`)
  })

  test('no product is a refusal naming the products', async () => {
    await expect(compose({})).rejects.toThrow('MICA_PRODUCT is not set. A root is composed for a product; the products are: ')
  })
})

describe('what the driver is handed', () => {
  test('every --arg the composer supplies is named, and the pinned images travel as --arg', () => {
    const args = driverArgs({ board: 'uefi-x64', platform: 'linux/amd64', dest: '/d', builder: 'default', fromArgs: ['--arg', 'MICA_IMAGE_BUILD_BASE=ghcr.io/x@sha256:0'], baseRootfsImage: 'ghcr.io/y@sha256:1', arch: 'amd64', radios: 'wifi bluetooth', profile: 'dev', veritySalt: '00', squashfsTime: '1577836800', squashfsCompression: 'xz', product: 'uefi-x64-dev' })
    expect(args.slice(0, 10)).toEqual(['--board', 'uefi-x64', '--platform', 'linux/amd64', '--context', REPO_ROOT, '--dest', '/d', '--builder', 'default'])
    expect(args).toContain('MICA_IMAGE_BUILD_BASE=ghcr.io/x@sha256:0')
    expect(args).toContain('MICA_RADIOS=wifi bluetooth')
    expect(args).toContain('COMPOSE_DIR=_out/products/uefi-x64-dev/build/compose')
    // The board's root compression reaches the pack stage (mica:docs/plan/20260926-0930-mini-images-on-128-mb.md).
    expect(args).toContain('SQUASHFS_COMPRESSION=xz')
    expect(args.filter(a => a === '--source-date-epoch')).toHaveLength(1)
    expect(args).not.toContain('--without')
    expect(args.some(a => a.startsWith('VERITY_UUID='))).toBe(false)
    expect(driverArgNames()).toEqual(['MICA_IMAGE_BASE_ROOTFS', 'MICA_ARCH', 'MICA_RADIOS', 'MICA_BOARD', 'MICA_PROFILE', 'VERITY_SALT', 'SQUASHFS_TIME', 'SQUASHFS_COMPRESSION', 'SOURCE_DATE_EPOCH', 'COMPOSE_DIR'])
  })
})

describe('the Base root rows', () => {
  test('a source row selected for a root consumer is kept; one pinned only for later stages is not', () => {
    const d = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'build-test.'))
    try {
      mkdirSync(join(d, 'locks'))
      writeFileSync(join(d, 'packages.tsv'), '# name\tconsumers\nlibc6\tmica-system\nlibfoo\tupstream-podman\nlibbar\tupstream-podman,mica-system\n')
      writeFileSync(join(d, 'locks/upstream.lock'), [
        'source\tlibc6\tamd64\t2.41-1\taaaa\thttps://x/libc6_amd64.deb',
        'source\tlibc6\tarm64\t2.41-1\tbbbb\thttps://x/libc6_arm64.deb',
        'source\tlibfoo\tall\t1\tcccc\thttps://x/libfoo.deb',
        'source\tlibbar\tall\t2\tdddd\thttps://x/libbar.deb',
        'source\tlibzzz\tamd64\t3\teeee\thttps://x/libzzz.deb',
        'git\tsomething\telse',
      ].map(l => `${l}\n`).join(''))
      expect(baseRootRows(d, 'amd64')).toEqual([
        'libbar\t2\tall\tdddd\thttps://x/libbar.deb\tupstream-podman,mica-system',
        'libc6\t2.41-1\tamd64\taaaa\thttps://x/libc6_amd64.deb\tmica-system',
      ])
      expect(baseRootRows(d, 'arm64')).toEqual([
        'libbar\t2\tall\tdddd\thttps://x/libbar.deb\tupstream-podman,mica-system',
        'libc6\t2.41-1\tarm64\tbbbb\thttps://x/libc6_arm64.deb\tmica-system',
      ])
    }
    finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('the presets', () => {
  test('every unit of rootfs/packages/presets.json is disabled once, sorted', () => {
    const system = presets('system'), user = presets('user')
    expect(system.length).toBeGreaterThan(0)
    expect(system).toEqual([...new Set(system)].sort())
    expect(system.every(l => l.startsWith('disable '))).toBe(true)
    expect(user).toContain('disable mpris-proxy.service')
  })
})
