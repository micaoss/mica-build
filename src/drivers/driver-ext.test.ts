// driver-ext build: an owner's modules for one kernel, packed and signed so that both the modules and the image's
// root hash verify against the owner's enrolled CA alone; a module built for another kernel is refused.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inputs, resolve as fromRef } from '../locks/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'
import { COMPONENT_TOOLS } from '../image/component-build.ts'
import { Toolbox } from '../image/toolbox.ts'
import { MODULE_SIGNATURE_MAGIC, moduleSignature } from '../image/module-signing.ts'
import { init } from './driver-key.ts'
import { build, DESCRIPTOR_SCHEMA, MANIFEST_SCHEMA, moduleName, vermagic } from './driver-ext.ts'

mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.driver-ext-test.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))
const openssl = (...args: string[]) => Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(WORK)}:/w:ro`,
  '--entrypoint', 'openssl', fromRef('mica-build-env:base', inputs()), ...args], { stdout: 'pipe', stderr: 'pipe' })
const RELEASE = '6.12.114-mica'
const KERNEL_ID = 'a'.repeat(64)

function kdk(): string {
  mkdirSync(join(WORK, 'kdk-tree'))
  writeFileSync(join(WORK, 'kdk-tree/kdk.env'), `KERNEL_RELEASE=${RELEASE}\nKERNEL_ARCH=amd64\nBUILD_IMAGE=unused\nBUILD_PLATFORM=linux/amd64\nKERNEL_MAKE_ENV=\n`)
  expect(Bun.spawnSync(['tar', '-cf', join(WORK, 'kdk.tar'), '-C', join(WORK, 'kdk-tree'), 'kdk.env']).exitCode).toBe(0)
  return join(WORK, 'kdk.tar')
}

// JSON with every object's keys sorted, as the contract's reader re-serializes it.
const sortKeys = (v: unknown): unknown => Array.isArray(v)
  ? v.map(sortKeys)
  : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]))
    : v

const module = (release: string) => Buffer.from(`\x7fELF module\0name=hello\0vermagic=${release} SMP preempt mod_unload \0`)

test('vermagic reads the release a module was built for; kmod names a module by its file', () => {
  expect(moduleName('sub/r8125-x.ko')).toBe('r8125_x')
  expect(vermagic(module(RELEASE))).toBe(`${RELEASE} SMP preempt mod_unload `)
  expect(vermagic(Buffer.from('no modinfo'))).toBeUndefined()
})

test('an extension of owner-signed modules verifies against the owner CA alone', async () => {
  const owner = init(join(WORK, 'owner'), 'Test owner')
  const signing = { key: join(owner, 'signer.key.pem'), certificate: join(owner, 'signer.cert.pem') }
  mkdirSync(join(WORK, 'mods/sub'), { recursive: true })
  writeFileSync(join(WORK, 'mods/sub/hello.ko'), module(RELEASE))
  mkdirSync(join(WORK, 'fw'))
  writeFileSync(join(WORK, 'fw/hello.bin'), 'firmware')
  const tar = kdk()
  const { descriptor: d, manifest } = await build({ kdk: tar, modules: join(WORK, 'mods'), firmware: join(WORK, 'fw'), load: ['hello'], options: { hello: 'debug=1' },
    name: 'hello', version: '1.0', kernelId: KERNEL_ID, signing, out: join(WORK, 'ext') })
  // The contract's documents (mica-core mica_deploy::driver_ext): canonical, the manifest agreeing with the descriptor.
  expect(Object.keys(d).sort()).toEqual(['arch', 'content', 'kernel', 'name', 'schema', 'version'])
  expect(d).toMatchObject({ schema: DESCRIPTOR_SCHEMA, name: 'hello', version: '1.0', arch: 'amd64', kernel: KERNEL_ID })
  expect(manifest).toEqual({ schema: MANIFEST_SCHEMA, name: 'hello', version: '1.0', arch: 'amd64', kernel: KERNEL_ID, kernelRelease: RELEASE,
    modules: ['sub/hello.ko'], load: ['hello'], options: { hello: 'debug=1' }, firmware: ['hello.bin'] })
  expect(readFileSync(join(WORK, 'ext/ext.json'), 'utf8')).toBe(JSON.stringify(sortKeys(d)))

  // The root hash signature carries the signer's certificate and chains to the owner CA.
  const ca = '/w/owner/owner-ca.cert.pem'
  const roothash = openssl('cms', '-verify', '-binary', '-inform', 'DER', '-in', '/w/ext/ext.roothash.p7s', '-content', '/w/ext/ext.roothash', '-CAfile', ca, '-purpose', 'any', '-out', '/dev/null')
  expect(roothash.exitCode).toBe(0)
  expect(readFileSync(join(WORK, 'ext/ext.roothash'), 'utf8')).toBe((d['content'] as { rootHash: string }).rootHash)

  // The module inside the image carries its own chained signature.
  const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [WORK] })
  try { await tb.must(['unsquashfs', '-no-progress', '-d', join(WORK, 'unpacked'), join(WORK, 'ext/ext.img')]) }
  finally { await tb.close() }
  const signed = readFileSync(join(WORK, `unpacked/modules/${RELEASE}/updates/mica-ext/hello/sub/hello.ko`))
  const signature = moduleSignature(signed)!
  writeFileSync(join(WORK, 'sig.p7s'), signature)
  writeFileSync(join(WORK, 'content'), signed.subarray(0, signed.length - signature.length - 12 - MODULE_SIGNATURE_MAGIC.length))
  expect(openssl('cms', '-verify', '-binary', '-inform', 'DER', '-in', '/w/sig.p7s', '-content', '/w/content', '-CAfile', ca, '-purpose', 'any', '-out', '/dev/null').exitCode).toBe(0)
  expect(readFileSync(join(WORK, 'unpacked/firmware/hello.bin'), 'utf8')).toBe('firmware')
  expect(JSON.parse(readFileSync(join(WORK, 'unpacked/manifest.json'), 'utf8'))).toEqual(manifest)
  expect(readFileSync(join(WORK, 'unpacked/manifest.json'), 'utf8')).toBe(JSON.stringify(sortKeys(manifest)))
}, 600000)

test('the contract\'s limits are the builder\'s', async () => {
  const signing = { key: join(WORK, 'owner/signer.key.pem'), certificate: join(WORK, 'owner/signer.cert.pem') }
  const base = { kdk: join(WORK, 'kdk.tar'), modules: join(WORK, 'mods'), kernelId: KERNEL_ID, signing }
  await expect(build({ ...base, name: 'Hello', version: '1.0', out: join(WORK, 'x1') })).rejects.toThrow('lowercase')
  await expect(build({ ...base, name: 'hello', version: '1.0-rc1', out: join(WORK, 'x2') })).rejects.toThrow('dotted numbers')
  await expect(build({ ...base, name: 'hello', version: '1.0', load: ['other'], out: join(WORK, 'x3') })).rejects.toThrow('not a module of this extension')
}, 600000)

test('a module built for another kernel is refused', async () => {
  mkdirSync(join(WORK, 'other'))
  writeFileSync(join(WORK, 'other/hello.ko'), module('6.1.190-mica'))
  await expect(build({ kdk: join(WORK, 'kdk.tar'), modules: join(WORK, 'other'), name: 'hello', version: '1.0', kernelId: KERNEL_ID,
    signing: { key: join(WORK, 'owner/signer.key.pem'), certificate: join(WORK, 'owner/signer.cert.pem') }, out: join(WORK, 'ext2') })).rejects.toThrow('not 6.12.114-mica')
}, 600000)
