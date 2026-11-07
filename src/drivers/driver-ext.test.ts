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
import { build, DRIVER_EXT_SCHEMA, vermagic } from './driver-ext.ts'

mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.driver-ext-test.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))
const openssl = (...args: string[]) => Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(WORK)}:/w:ro`,
  '--entrypoint', 'openssl', fromRef('mica-build-env:base', inputs()), ...args], { stdout: 'pipe', stderr: 'pipe' })
const RELEASE = '6.12.114-mica'
const KERNEL_ID = 'a'.repeat(64)

function kdk(): string {
  mkdirSync(join(WORK, 'kdk-tree'))
  writeFileSync(join(WORK, 'kdk-tree/kdk.env'), `KERNEL_RELEASE=${RELEASE}\nBUILD_IMAGE=unused\nBUILD_PLATFORM=linux/amd64\nKERNEL_MAKE_ENV=\n`)
  expect(Bun.spawnSync(['tar', '-cf', join(WORK, 'kdk.tar'), '-C', join(WORK, 'kdk-tree'), 'kdk.env']).exitCode).toBe(0)
  return join(WORK, 'kdk.tar')
}

const module = (release: string) => Buffer.from(`\x7fELF module\0name=hello\0vermagic=${release} SMP preempt mod_unload \0`)

test('vermagic reads the release a module was built for', () => {
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
  const d = await build({ kdk: tar, modules: join(WORK, 'mods'), firmware: join(WORK, 'fw'), name: 'hello', version: '1.0', kernelId: KERNEL_ID, signing, out: join(WORK, 'ext') })
  expect(d['schema']).toBe(DRIVER_EXT_SCHEMA)
  expect(d['kernel']).toEqual({ id: KERNEL_ID, release: RELEASE })
  expect((d['modules'] as { path: string }[]).map(m => m.path)).toEqual(['updates/mica-ext/hello/sub/hello.ko'])
  expect((d['firmware'] as { path: string }[]).map(m => m.path)).toEqual(['firmware/hello.bin'])
  expect(JSON.parse(readFileSync(join(WORK, 'ext/ext.json'), 'utf8'))).toEqual(d)

  // The root hash signature carries the signer's certificate and chains to the owner CA.
  const ca = '/w/owner/owner-ca.cert.pem'
  const roothash = openssl('cms', '-verify', '-binary', '-inform', 'DER', '-in', '/w/ext/ext.roothash.p7s', '-content', '/w/ext/ext.roothash', '-CAfile', ca, '-purpose', 'any', '-out', '/dev/null')
  expect(roothash.exitCode).toBe(0)
  expect(readFileSync(join(WORK, 'ext/ext.roothash'), 'utf8')).toBe((d['content'] as { rootHash: string }).rootHash)

  // The module inside the image carries its own chained signature.
  const tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [WORK] })
  try { await tb.must(['unsquashfs', '-no-progress', '-d', join(WORK, 'unpacked'), join(WORK, 'ext/ext.img')]) }
  finally { await tb.close() }
  const signed = readFileSync(join(WORK, 'unpacked/updates/mica-ext/hello/sub/hello.ko'))
  const signature = moduleSignature(signed)!
  writeFileSync(join(WORK, 'sig.p7s'), signature)
  writeFileSync(join(WORK, 'content'), signed.subarray(0, signed.length - signature.length - 12 - MODULE_SIGNATURE_MAGIC.length))
  expect(openssl('cms', '-verify', '-binary', '-inform', 'DER', '-in', '/w/sig.p7s', '-content', '/w/content', '-CAfile', ca, '-purpose', 'any', '-out', '/dev/null').exitCode).toBe(0)
  expect(readFileSync(join(WORK, 'unpacked/firmware/hello.bin'), 'utf8')).toBe('firmware')
}, 600000)

test('a module built for another kernel is refused', async () => {
  mkdirSync(join(WORK, 'other'))
  writeFileSync(join(WORK, 'other/hello.ko'), module('6.1.190-mica'))
  await expect(build({ kdk: join(WORK, 'kdk.tar'), modules: join(WORK, 'other'), name: 'hello', version: '1.0', kernelId: KERNEL_ID,
    signing: { key: join(WORK, 'owner/signer.key.pem'), certificate: join(WORK, 'owner/signer.cert.pem') }, out: join(WORK, 'ext2') })).rejects.toThrow('not 6.12.114-mica')
}, 600000)
