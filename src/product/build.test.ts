// src/product/build.ts without a build: the command line (the name, the mode, the stamp and the generation),
// the EFI target of an architecture, and the receipt's shape over the tree's own files.
import { describe, expect, test } from 'bun:test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packArchive } from '../image/component-archive.ts'
import { canonicalJson, componentId } from '../image/components.ts'
import { Signer } from '../shared/update-envelope.ts'
import { efiTarget, kernelReleaseRefusal, parseArgs, ProductBuildError, receipt, releaseNotes, reuseRoot, rootfsInputs, seedCoreSet, toolArch } from './build.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('the command line', () => {
  test('the name alone builds; --verify verifies; --version and --release carry a stamp and an optional generation', () => {
    expect(parseArgs(['p'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: '', generation: 2 })
    expect(parseArgs(['p', '--generation', '3'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: '', generation: 3 })
    expect(parseArgs(['p', '--verify'])).toEqual({ name: 'p', mode: 'verify', release: '', stamp: '', generation: 2 })
    expect(parseArgs(['p', '--version', 'v1'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: 'v1', generation: 2 })
    expect(parseArgs(['p', '--version', 'v1', '--generation', '7'])).toEqual({ name: 'p', mode: 'build', release: '', stamp: 'v1', generation: 7 })
    expect(parseArgs(['p', '--release', '20260923-1200'])).toEqual({ name: 'p', mode: 'build', release: '20260923-1200', stamp: '20260923-1200', generation: 2 })
    expect(parseArgs(['p', '--release', '20260923-1200', '--generation', '5'])).toMatchObject({ release: '20260923-1200', generation: 5 })
  })
  test('the refusals: no name, a bad mode, a missing stamp, a generation below 2, a release name out of form', () => {
    for (const [argv, fragment] of [
      [[], 'usage'], [['p', '--bogus'], 'usage'], [['p', '--verify', 'x'], 'usage'], [['p', '--version'], 'usage'], [['p', 'extra'], 'usage'],
      [['p', '--version', 'v', '--generation', '1'], 'a decimal of at least 2'], [['p', '--generation', '1'], 'a decimal of at least 2'],
      [['p', '--generation'], 'a decimal of at least 2'], [['p', '--generation', '3', '--verify'], 'a decimal of at least 2'], [['p', '--version', 'v', '--generation', 'x'], 'a decimal of at least 2'],
      [['p', '--release', 'v', '--gen', '3'], 'a decimal of at least 2'], [['p', '--release', 'v1'], 'YYYYMMDD-HHMM'],
      [['p', '--release', '20260923-1200', '--reuse', 'p.20260922-0900'], 'a decimal of at least 2'],
    ] as [string[], string][]) {
      expect(() => parseArgs(argv)).toThrow(ProductBuildError)
      expect(() => parseArgs(argv)).toThrow(fragment)
    }
  })
})

describe('the EFI target', () => {
  test('amd64 is x64, arm64 is aa64, anything else is refused', () => {
    expect(efiTarget('amd64')).toBe('x64')
    expect(efiTarget('arm64')).toBe('aa64')
    expect(() => efiTarget('riscv64')).toThrow('no EFI architecture for riscv64')
  })
})

describe('the receipt', () => {
  const board = join(REPO_ROOT, '_out/boards/uefi-x64'), signing = join(REPO_ROOT, 'meta')
  const ready = existsSync(join(board, 'kernel/kernel.release')) && existsSync(join(signing, 'updates/public.key'))
  test.skipIf(!ready)('lists the product files, every lock, the board and kernel facts, the certificates, then the tree, release, version and generation', () => {
    const text = receipt({ name: 'uefi-x64.dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '', version: 'v-test', generation: 3 })
    const lines = text.split('\n')
    expect(lines.at(-1)).toBe('')
    expect(lines.slice(-5, -1)).toEqual([expect.stringMatching(/^tree [0-9a-f]{40}( dirty)?$/), 'release none', 'version v-test', 'generation 3'])
    expect(lines.filter(l => / boards\/uefi-x64\/products\/dev\//.test(l)).length).toBeGreaterThan(0)
    expect(lines.filter(l => / locks\/pins\//.test(l)).length).toBeGreaterThan(0)
    expect(lines.some(l => /^[0-9a-f]{64} {2}_out\/boards\/uefi-x64\/board\.env$/.test(l))).toBe(true)
    expect(lines.some(l => /^[0-9a-f]{64} {2}meta\/updates\/public\.key$/.test(l))).toBe(true)
    expect(lines.every(l => l === '' || /^[0-9a-f]{64} {2}/.test(l) || /^(tree|release|version|generation) /.test(l))).toBe(true)
    expect(receipt({ name: 'uefi-x64.dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '20260923-1200', version: '20260923-1200', generation: 2 })).toContain('\nrelease 20260923-1200\nversion 20260923-1200\ngeneration 2\n')
    expect(receipt({ name: 'uefi-x64.dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '', version: 'v-test', generation: 3, seedCoreSet: 'a'.repeat(64) })).toContain(`\nseed-core-set ${'a'.repeat(64)}\ntree `)
    expect(receipt({ name: 'uefi-x64.dev', boardDir: board, kernelDirectory: join(board, 'kernel'), signing, release: '', version: 'v-test', generation: 3, previousRoot: 'b'.repeat(64) })).toContain(`\nprevious-root ${'b'.repeat(64)}\ntree `)
  })
})

describe('a published seed core set', () => {
  const vector = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/fixtures/component-contracts/set.json'), 'utf8')) as { publicKey: string, envelope: string, setId: string }
  test('is taken by its id when the updates key signed it, it is of the product\'s architecture and it selects for the product', () => {
    expect(seedCoreSet(vector.envelope, vector.publicKey, { name: 'p', arch: 'amd64', features: ['micad', 'ui', 'ssh'] })).toBe(vector.setId)
  })
  test('is refused under another key, for another architecture, or when a feature\'s need is not selected', () => {
    expect(() => seedCoreSet(vector.envelope, Buffer.alloc(32, 1).toString('base64'), { name: 'p', arch: 'amd64', features: ['micad'] })).toThrow('untrusted metadata key')
    expect(() => seedCoreSet(vector.envelope, vector.publicKey, { name: 'p', arch: 'arm64', features: ['micad'] })).toThrow('is for amd64, and p runs on arm64')
    expect(() => seedCoreSet(vector.envelope, vector.publicKey, { name: 'p', arch: 'amd64', features: ['ui'] })).toThrow('p: ')
    expect(seedCoreSet(vector.envelope, vector.publicKey, { name: 'p', arch: 'amd64', features: ['micad'] }, { level: 1, provides: { 'mica-podman': '6.1.4-7' } })).toBe(vector.setId)
    expect(() => seedCoreSet(vector.envelope, vector.publicKey, { name: 'p', arch: 'amd64', features: ['micad'] }, { level: 1, provides: { 'mica-podman': '6.1.4-5' } }))
      .toThrow('p: a selected core component\'s root requirement does not hold')
  })
})

describe('the FIT tools architecture', () => {
  // An ELF64 little-endian header whose e_machine is the given number: all toolArch reads.
  const elf = (machine: number) => {
    const b = Buffer.alloc(64)
    b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b.writeUInt16LE(machine, 18)
    return b
  }
  const file = (bytes: Buffer) => {
    const path = join(mkdtempSync(join(tmpdir(), 'fit-tools-')), 'tool')
    writeFileSync(path, bytes)
    return path
  }
  test('x86-64 is amd64 and AArch64 is arm64', () => {
    expect(toolArch(file(elf(62)))).toBe('amd64')
    expect(toolArch(file(elf(183)))).toBe('arm64')
  })
  test('anything else is refused', () => {
    expect(() => toolArch(file(elf(40)))).toThrow('unsupported ELF machine 40')
    expect(() => toolArch(file(Buffer.from('#!/bin/sh\n')))).toThrow('not a little-endian 64-bit ELF')
  })
})

describe('the release notes', () => {
  test('a wifi product keeps the label key until one is set; BLE sets the network only; every micad product, no fallback DNS and a password-gated factory reset', () => {
    const wifi = releaseNotes('20261022-1200', 'cx3576.full', 'cx3576', 'prod', 'micad ui ssh containers wifi bluetooth', 'required', 'openssh', 'docker')
    expect(wifi).toStartWith('# Mica OS 20261022-1200\n\nProduct cx3576.full (board cx3576, profile prod), development channel.\n\n')
    expect(wifi).toContain('- No fallback DNS: a site whose router hands out no DNS resolves nothing.\n')
    expect(wifi).toContain('- The factory access point is on: SSID `mica-XXXX` and the key printed on the device\'s label')
    expect(wifi).toContain('until a key is set on the console\'s Wi-Fi page (`wifi.ap.psk`); claiming the device does not change it')
    expect(wifi).not.toContain('the claim sets')
    expect(wifi).toContain('- BLE provisioning sets up the network and nothing else')
    expect(wifi).toContain('- A factory reset asks for the administrator password')
    expect(wifi).toContain('- Claiming the device asks for its device code, printed on its label.\n')
    expect(wifi).toContain('- SSH server: OpenSSH.\n')
    expect(wifi).toContain('- Container engine: Docker, with `docker compose`.\n')
    const wired = releaseNotes('20261022-1200', 'uefi-x64.full', 'uefi-x64', 'prod', 'micad ui ssh containers', 'off', 'dropbear', 'podman')
    expect(wired).toContain('No fallback DNS')
    expect(wired).toContain('factory reset asks for the administrator password')
    expect(wired).not.toContain('access point')
    expect(wired).not.toContain('BLE')
    expect(wired).toContain('- Claiming the device does not ask for its device code.\n')
    expect(wired).not.toContain('asks for its device code')
    expect(wired).toContain('- SSH server: Dropbear.\n')
    expect(wired).toContain('- Container engine: Podman.\n')
    expect(releaseNotes('r', 'x.basic', 'x', 'prod', '', 'off', '', '')).toBe('# Mica OS r\n\nProduct x.basic (board x, profile prod), development channel.\n')
  })
})

test('the root\'s inputs digest follows what it packs and how it is signed, not its root hash or sizes', () => {
  const content = `${'a'.repeat(64)}\n`, cert = Buffer.from('certificate')
  const env = 'VERITY_ROOT_HASH=1\nVERITY_SALT=01\nVERITY_HASH_ALGO=sha256\nVERITY_DATA_BLOCK_SIZE=4096\nVERITY_HASH_BLOCK_SIZE=4096\nIMAGE_BYTES=8192\n'
  const d = rootfsInputs(content, env, cert, 1)
  expect(d).toMatch(/^[0-9a-f]{64}$/)
  expect(rootfsInputs(content, env.replace('VERITY_ROOT_HASH=1', 'VERITY_ROOT_HASH=2').replace('IMAGE_BYTES=8192', 'IMAGE_BYTES=12288'), cert, 1)).toBe(d)
  for (const other of [rootfsInputs(`${'b'.repeat(64)}\n`, env, cert, 1), rootfsInputs(content, env.replace('VERITY_SALT=01', 'VERITY_SALT=02'), cert, 1),
    rootfsInputs(content, env, Buffer.from('another'), 1), rootfsInputs(content, env, cert, 2)]) expect(other).not.toBe(d)
})

describe('the kernel release a product ships', () => {
  const fixture = (expect: string | undefined, releases: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-release-')), board = join(dir, 'boards/x')
    Bun.spawnSync(['mkdir', '-p', board, join(dir, 'deployments')])
    if (expect !== undefined) writeFileSync(join(board, 'bsp.env'), `KERNEL_CONFIG=x\nKERNEL_EXPECT=${expect}\n`)
    const docs = releases.map((release, i) => {
      const file = join(dir, 'deployments', `${i + 2}.json`)
      writeFileSync(file, JSON.stringify({ schema: 'mica/deployment/v1', payload: Buffer.from(JSON.stringify({ kernel: { release } })).toString('base64') }))
      return file
    })
    return { board, docs }
  }
  test('passes when every deployment carries the release bsp.env expects', () => {
    const f = fixture('6.1.190', ['6.1.190', '6.1.190'])
    expect(kernelReleaseRefusal(f.board, f.docs)).toBeUndefined()
  })
  test('refuses a stale board kernel, naming both releases and the rebuild', () => {
    const f = fixture('6.1.190', ['6.1.190', '6.1.115'])
    const r = kernelReleaseRefusal(f.board, f.docs) ?? ''
    expect(r).toContain('carries kernel 6.1.115')
    expect(r).toContain('expects 6.1.190')
    expect(r).toContain('make x-kernel, then make board-fetch BOARD=x')
  })
  test('reads a board.env KERNEL_EXPECT where the board has no bsp.env', () => {
    const f = fixture(undefined, ['6.12.115'])
    writeFileSync(join(f.board, 'board.env'), 'MICA_ARCH=amd64\nKERNEL_EXPECT=6.12.115\n')
    expect(kernelReleaseRefusal(f.board, f.docs)).toBeUndefined()
    writeFileSync(join(f.board, 'board.env'), 'MICA_ARCH=amd64\nKERNEL_EXPECT=6.12.114\n')
    expect(kernelReleaseRefusal(f.board, f.docs)).toContain('board.env expects 6.12.114')
  })
  test('refuses a board with no KERNEL_EXPECT and a product with no deployment', () => {
    const none = fixture(undefined, ['6.12.115'])
    expect(kernelReleaseRefusal(none.board, none.docs)).toContain('names no KERNEL_EXPECT')
    const empty = fixture('6.12.115', [])
    expect(kernelReleaseRefusal(empty.board, empty.docs)).toContain('no deployment document')
  })
})

test('the previous release\'s root ships in place of the one packed here when their inputs digests match, and only then', () => {
  const work = mkdtempSync(join(tmpdir(), 'mica-reuse-root-'))
  const object = (file: string, fill: number, bytes = 100) => {
    const data = Buffer.alloc(bytes, fill)
    mkdirSync(join(work, file, '..'), { recursive: true })
    writeFileSync(join(work, file), data)
    return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  }
  // The previous release's full archive, of a root packed before.
  const d = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/fixtures/component-contracts/deployment.json'), 'utf8'))
  d.kernel.boot.artifact = object('kernel/boot.efi', 1)
  d.kernel.support.image = object('kernel/support.img', 2, d.kernel.support.image.bytes)
  d.kernel.support.signature = object('kernel/support.roothash.p7s', 3)
  d.rootfs.content.image = object('root/rootfs.img', 4, d.rootfs.content.image.bytes)
  d.rootfs.content.signature = object('root/rootfs.roothash.p7s', 5)
  d.kernel.id = componentId(d.kernel)
  d.rootfs.id = componentId(d.rootfs)
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
  const previous = join(work, 'previous-release')
  mkdirSync(previous)
  packArchive(JSON.stringify(signer.sign(JSON.parse(canonicalJson(d)))), join(work, 'kernel'), join(work, 'root'), [signer.publicKey], join(previous, 'update.micaupd'))
  // This build: a root packed here, differing only in its stamp, and its inputs digest.
  const out = join(work, 'out'), inputs = 'c'.repeat(64)
  const packed = () => {
    mkdirSync(join(out, 'root'), { recursive: true })
    writeFileSync(join(out, 'root/rootfs.img'), 'packed here')
    writeFileSync(join(out, 'root/rootfs.json'), '{"id":"packed"}')
    writeFileSync(join(out, 'rootfs-inputs.txt'), `${inputs}\n`)
  }
  packed()
  expect(reuseRoot(out, join(work, 'none'), signer.publicKey)).toContain('no previous rootfs inputs digest')
  writeFileSync(join(previous, 'rootfs-inputs.txt'), `${'d'.repeat(64)}\n`)
  expect(reuseRoot(out, previous, signer.publicKey)).toContain('differs from the previous release\'s')
  expect(readFileSync(join(out, 'root/rootfs.img'), 'utf8')).toBe('packed here')
  writeFileSync(join(previous, 'rootfs-inputs.txt'), `${inputs}\n`)
  expect(reuseRoot(out, previous, signer.publicKey)).toContain(`its root ${d.rootfs.id} ships`)
  expect(readFileSync(join(out, 'root/rootfs.img'))).toEqual(readFileSync(join(work, 'root/rootfs.img')))
  expect(readFileSync(join(out, 'root/rootfs.roothash.p7s'))).toEqual(readFileSync(join(work, 'root/rootfs.roothash.p7s')))
  expect(readFileSync(join(out, 'root/rootfs.json'), 'utf8')).toBe(canonicalJson(d.rootfs))
  expect(readdirSync(out).sort()).toEqual(['root', 'rootfs-inputs.txt'])
  // An archive signed by another key is refused, and the packed root stays.
  packed()
  expect(() => reuseRoot(out, previous, new Signer(generateKeyPairSync('ed25519').privateKey, false).publicKey)).toThrow()
  expect(readFileSync(join(out, 'root/rootfs.img'), 'utf8')).toBe('packed here')
})
