import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packComponent, packSupport, describeRoot, COMPONENT_TOOLS } from './component-build.ts'
import { componentId } from './components.ts'
import { REPO_ROOT } from './paths.ts'
import { Toolbox } from './toolbox.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from './testing.ts'

let scratch: string
let tb: Toolbox
let signing: { key: string, certificate: string }

beforeAll(async () => {
  scratch = mkdtempSync(join(REPO_ROOT, '.tmp/components-'))
  tb = await Toolbox.open(COMPONENT_TOOLS, { mounts: [scratch] })
  signing = { key: join(scratch, 'key.pem'), certificate: join(scratch, 'cert.pem') }
  await tb.must(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=component-test', '-keyout', signing.key, '-out', signing.certificate])
  for (const path of ['root/usr/lib/modules', 'root/usr/lib/firmware', 'root/etc', 'support/lib/modules/6.12.1']) {
    mkdirSync(join(scratch, path), { recursive: true })
  }
  writeFileSync(join(scratch, 'root/etc/os-release'), 'ID=mica\nVERSION_ID=one\n')
  for (const index of ['modules.dep', 'modules.builtin', 'modules.order']) {
    writeFileSync(join(scratch, 'support/lib/modules/6.12.1', index), '')
  }
  await tb.must(['tar', '-C', join(scratch, 'support'), '-cf', join(scratch, 'modules.tar'), 'lib'])
}, OPEN_TIMEOUT_MS)

afterAll(async () => {
  if (tb) await tb.close()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}, TOOL_TIMEOUT_MS)

test('independent root and support producers retain identical unchanged component bytes', async () => {
  const support = await packSupport(join(scratch, 'modules.tar'), '6.12.1', undefined, join(scratch, 'kernel-one'), signing, tb)
  const root = await packComponent(join(scratch, 'root'), join(scratch, 'root-one'), 'rootfs', signing, tb)
  const first = describeRoot('amd64', 'one', root)
  expect(first.id).toBe(componentId(first))
  expect(root.image.bytes % 4096).toBe(0)
  expect(root.image.bytes).toBeLessThan(1048576)
  writeFileSync(join(scratch, 'root/etc/os-release'), 'ID=mica\nVERSION_ID=two\n')
  const changed = await packComponent(join(scratch, 'root'), join(scratch, 'root-two'), 'rootfs', signing, tb)
  expect(changed.image.sha256).not.toBe(root.image.sha256)
  const unchanged = await packSupport(join(scratch, 'modules.tar'), '6.12.1', undefined, join(scratch, 'kernel-two'), signing, tb)
  expect(unchanged).toEqual(support)
  expect(readFileSync(join(scratch, 'kernel-one/support.img'))).toEqual(readFileSync(join(scratch, 'kernel-two/support.img')))
  await tb.must(['veritysetup', 'verify', join(scratch, 'root-one/rootfs.img'), join(scratch, 'root-one/rootfs.img'), root.rootHash,
    '--no-superblock', '--data-blocks', String(root.verity.dataBlocks), '--hash-offset', String(root.verity.hashOffset), '--salt', root.verity.salt])
}, 60000)

test('refuse mismatched module release, stale output, and kernel data inside a userspace root', async () => {
  await expect(packSupport(join(scratch, 'modules.tar'), '6.12.2', undefined, join(scratch, 'wrong'), signing, tb)).rejects.toThrow('module release')
  await expect(packComponent(join(scratch, 'root'), join(scratch, 'root-one'), 'rootfs', signing, tb)).rejects.toThrow('exists')
  mkdirSync(join(scratch, 'root/usr/lib/modules/6.12.1'))
  await expect(packComponent(join(scratch, 'root'), join(scratch, 'invalid-root'), 'rootfs', signing, tb)).rejects.toThrow('kernel support')
}, 30000)
