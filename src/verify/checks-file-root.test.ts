import { partitionOf } from '../image/file-layout.ts'
import { EVERY_FEATURE } from './product-conf.ts'
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadBoard } from './board.ts'
import { NO_TOOLS } from './checks-fixture.ts'
import { ROOT_CHECKS } from './checks-file-root.ts'
import { pathInRoot, regularFileInRoot } from './checks-root.ts'
import { boardEnvPath, REPO_ROOT } from './paths.ts'

type JsonObject = Record<string, unknown>

const CURRENT_MANIFEST = await Bun.file(join(REPO_ROOT, 'meta.example/updates/manifest.json')).text()
const MARKER = 'DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n'

const work: string[] = []
afterEach(() => { for (const p of work.splice(0)) rmSync(p, { recursive: true, force: true }) })
function fixture(init: 'systemd' | 'openrc' = 'systemd', board = 'uefi-x64', engine: 'podman' | 'docker' = 'podman', ssh: 'dropbear' | 'openssh' = 'dropbear') {
  const root = mkdtempSync(join(tmpdir(), 'file-root-check-')); work.push(root)
  mkdirSync(join(root, 'etc'))
  const file = (path: string, text: string | Uint8Array) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const checkResult = async (id: string) => (await ROOT_CHECKS.find(c => c.id === id)!.run({ board: loadBoard(boardEnvPath(board)),
    product: { ...EVERY_FEATURE, init, engine, ssh }, image: 'fixture', tools: NO_TOOLS, workDir: root, outDir: root, unpackRoot: async () => root }))[0]!
  const check = async (id: string) => (await checkResult(id)).verdict
  return { root, file, check, checkResult }
}

function manifest(): JsonObject {
  return JSON.parse(CURRENT_MANIFEST) as JsonObject
}

function objectAt(value: JsonObject, key: string): JsonObject {
  return value[key] as JsonObject
}

function publicDefaults(f: ReturnType<typeof fixture>, marker?: string): void {
  f.file('/usr/share/mica/meta/updates/manifest.json', CURRENT_MANIFEST)
  if (marker !== undefined) f.file('/usr/share/mica/meta/GENERATED', marker)
}

function writeManifest(f: ReturnType<typeof fixture>, value: unknown): void {
  f.file('/usr/share/mica/meta/updates/manifest.json', `${JSON.stringify(value, null, 2)}\n`)
}

async function expectPublicRefusal(f: ReturnType<typeof fixture>, expected: string): Promise<string> {
  const result = await f.checkResult('file-root-public-defaults')
  expect(result.verdict, result.message).toBe('fail')
  expect(result.message).toContain(expected)
  return result.message
}

test('root component rejects kernel payload and updater binaries', async () => {
  const f = fixture()
  expect(await f.check('file-root-is-component')).toBe('pass')
  f.file('/usr/lib/modules/6.12/modules.dep', '')
  expect(await f.check('file-root-is-component')).toBe('fail')
  rmSync(join(f.root, 'usr/lib/modules'), { recursive: true })
  f.file('/usr/bin/rauc', 'x')
  expect(await f.check('file-root-is-component')).toBe('fail')
})

test('public defaults refuse baked anchors, private material and extra files', async () => {
  const f = fixture(), path = '/usr/share/mica/meta/updates/manifest.json'
  f.file(path, CURRENT_MANIFEST)
  expect(await f.check('file-root-public-defaults')).toBe('pass')
  const trusted = manifest(); trusted.trust = {}
  writeManifest(f, trusted)
  expect(await f.check('file-root-public-defaults')).toBe('fail')
  const privateValue = manifest(); privateValue.privateKey = 'forbidden'
  writeManifest(f, privateValue)
  expect(await f.check('file-root-public-defaults')).toBe('fail')
  f.file(path, CURRENT_MANIFEST); f.file('/usr/share/mica/meta/updates/private.pem', 'fixture')
  expect(await f.check('file-root-public-defaults')).toBe('fail')
})

test.each([undefined, MARKER, ''])('public defaults accept the current fixture with marker=%s and report non-vacuous evidence', async (marker) => {
  const f = fixture()
  publicDefaults(f, marker)
  const result = await f.checkResult('file-root-public-defaults')
  expect(result.verdict, result.message).toBe('pass')
  expect(result.message).toContain(`scannedFiles=${marker === undefined ? 1 : 2}`)
  expect(result.message).toMatch(/scannedBytes=[1-9][0-9]*/)
  expect(result.message).toContain('/usr/share/mica/meta/updates/manifest.json')
  if (marker !== undefined) expect(result.message).toContain('/usr/share/mica/meta/GENERATED')
})

test.each([
  ['updates/manifest.json', '-----BEGIN PRIVATE KEY-----\nDO_NOT_ECHO_PRIVATE_BYTES\n'],
  ['updates/manifest.json', '{"privateKey":"DO_NOT_ECHO_PRIVATE_BYTES"}'],
  ['updates/manifest.json', '{"private_key":"DO_NOT_ECHO_PRIVATE_BYTES"}'],
  ['GENERATED', '-----BEGIN OPENSSH PRIVATE KEY-----\nDO_NOT_ECHO_PRIVATE_BYTES\n'],
  ['GENERATED', '{"privateKey":"DO_NOT_ECHO_PRIVATE_BYTES"}'],
  ['GENERATED', '{"private_key":"DO_NOT_ECHO_PRIVATE_BYTES"}'],
])('private material detector refuses %s without leaking its bytes', async (relative, content) => {
  const f = fixture(); publicDefaults(f)
  f.file(`/usr/share/mica/meta/${relative}`, content)
  const message = await expectPublicRefusal(f, `/usr/share/mica/meta/${relative}`)
  expect(message).toContain('private key material')
  expect(message).not.toContain('DO_NOT_ECHO_PRIVATE_BYTES')
})

test.each([
  ['manifest', (value: JsonObject) => { value.unexpected = 'DO_NOT_ECHO_UNKNOWN' }],
  ['product', (value: JsonObject) => { objectAt(value, 'product').unexpected = 'DO_NOT_ECHO_UNKNOWN' }],
  ['update', (value: JsonObject) => { objectAt(value, 'update').unexpected = 'DO_NOT_ECHO_UNKNOWN' }],
  ['http', (value: JsonObject) => { objectAt(value, 'http').unexpected = 'DO_NOT_ECHO_UNKNOWN' }],
  ['fleet', (value: JsonObject) => { objectAt(value, 'fleet').unexpected = 'DO_NOT_ECHO_UNKNOWN' }],
])('unknown %s member is refused without leaking its value', async (path, mutate) => {
  const f = fixture(), value = manifest()
  mutate(value); writeManifest(f, value)
  const message = await expectPublicRefusal(f, `${path}.unexpected`)
  expect(message).not.toContain('DO_NOT_ECHO_UNKNOWN')
})

test.each([
  ['schema', (value: JsonObject) => { delete value.schema }],
  ['product.vendor', (value: JsonObject) => { delete objectAt(value, 'product').vendor }],
  ['update.source', (value: JsonObject) => { delete objectAt(value, 'update').source }],
  ['http.credentialHosts', (value: JsonObject) => { delete objectAt(value, 'http').credentialHosts }],
  ['fleet.url', (value: JsonObject) => { delete objectAt(value, 'fleet').url }],
])('missing required member %s is refused', async (path, mutate) => {
  const f = fixture(), value = manifest()
  mutate(value); writeManifest(f, value)
  await expectPublicRefusal(f, path)
})

test.each([
  ['product', (value: JsonObject) => { value.product = [] }],
  ['product.vendor', (value: JsonObject) => { objectAt(value, 'product').vendor = false }],
  ['product.model', (value: JsonObject) => { objectAt(value, 'product').model = 1 }],
  ['update.source', (value: JsonObject) => { objectAt(value, 'update').source = false }],
  ['update.channel', (value: JsonObject) => { objectAt(value, 'update').channel = 'stable' }],
  ['schema', (value: JsonObject) => { value.schema = 'mica/meta/v2' }],
  ['update.policy', (value: JsonObject) => { objectAt(value, 'update').policy = 'download' }],
  ['http.credentialHosts', (value: JsonObject) => { objectAt(value, 'http').credentialHosts = [false] }],
  ['fleet.enabled', (value: JsonObject) => { objectAt(value, 'fleet').enabled = 'false' }],
  ['fleet.url', (value: JsonObject) => { objectAt(value, 'fleet').url = false }],
])('type or current value violation at %s is refused', async (path, mutate) => {
  const f = fixture(), value = manifest()
  mutate(value); writeManifest(f, value)
  await expectPublicRefusal(f, path)
})

test.each(['off', 'check', 'auto'])('current update policy %s is accepted', async (policy) => {
  const f = fixture(), value = manifest()
  objectAt(value, 'update').policy = policy; writeManifest(f, value)
  expect(await f.check('file-root-public-defaults')).toBe('pass')
})

test.each(['0', '18446744073709551615'])('checkIntervalMinutes=%s is inside the full u64 range', async (literal) => {
  const f = fixture()
  f.file('/usr/share/mica/meta/updates/manifest.json', CURRENT_MANIFEST.replace('1440', literal))
  expect(await f.check('file-root-public-defaults')).toBe('pass')
})

test.each([
  ['-1', 'non-negative integer'],
  ['1.5', 'non-negative integer'],
  ['1e3', 'non-negative integer'],
  ['18446744073709551616', 'unsigned 64-bit range'],
])('checkIntervalMinutes=%s is outside the current u64 contract', async (literal, reason) => {
  const f = fixture()
  f.file('/usr/share/mica/meta/updates/manifest.json', CURRENT_MANIFEST.replace('1440', literal))
  const message = await expectPublicRefusal(f, 'update.checkIntervalMinutes')
  expect(message).toContain(reason)
})

test.each([
  ['schema', '"schema":', '"schema":"DO_NOT_ECHO_DUPLICATE",'],
  ['schema', '"schema":', '"\\u0073chema":"DO_NOT_ECHO_DUPLICATE",'],
  ['product.vendor', '"vendor":', '"vendor":"DO_NOT_ECHO_DUPLICATE",'],
  ['update.policy', '"policy":', '"\\u0070olicy":"DO_NOT_ECHO_DUPLICATE",'],
])('duplicate decoded member at %s is refused', async (path, key, duplicate) => {
  const f = fixture()
  f.file('/usr/share/mica/meta/updates/manifest.json', JSON.stringify(manifest()).replace(key, `${duplicate}${key}`))
  const message = await expectPublicRefusal(f, path)
  expect(message).toContain('duplicate key')
  expect(message).not.toContain('DO_NOT_ECHO_DUPLICATE')
})

test('malformed UTF-8 is refused without substitution or a byte dump', async () => {
  const f = fixture(), parts = CURRENT_MANIFEST.split('example')
  expect(parts).toHaveLength(2)
  f.file('/usr/share/mica/meta/updates/manifest.json', Buffer.concat([
    Buffer.from(parts[0]!), Buffer.from([0xff]), Buffer.from('DO_NOT_ECHO_BINARY'), Buffer.from(parts[1]!),
  ]))
  const message = await expectPublicRefusal(f, '/usr/share/mica/meta/updates/manifest.json')
  expect(message).toContain('invalid UTF-8')
  expect(message).not.toContain('DO_NOT_ECHO_BINARY')
})

test('malformed JSON is refused without dumping its bytes', async () => {
  const f = fixture()
  f.file('/usr/share/mica/meta/updates/manifest.json', '{"schema":"DO_NOT_ECHO_JSON"')
  const message = await expectPublicRefusal(f, 'invalid JSON')
  expect(message).not.toContain('DO_NOT_ECHO_JSON')
})

test.each([
  ['missing updates directory', (_f: ReturnType<typeof fixture>) => {}, 'updates'],
  ['missing manifest', (f: ReturnType<typeof fixture>) => { mkdirSync(join(f.root, 'usr/share/mica/meta/updates'), { recursive: true }) }, 'manifest.json'],
  ['empty manifest', (f: ReturnType<typeof fixture>) => { f.file('/usr/share/mica/meta/updates/manifest.json', '') }, 'empty'],
])('%s is refused', async (_name, arrange, expected) => {
  const f = fixture()
  mkdirSync(join(f.root, 'usr/share/mica/meta'), { recursive: true })
  arrange(f)
  await expectPublicRefusal(f, expected)
})

test('an absent public metadata directory throws instead of reporting a vacuous pass', async () => {
  const f = fixture()
  await expect(f.checkResult('file-root-public-defaults')).rejects.toThrow('/usr/share/mica/meta is missing')
})

test('a non-directory public metadata entry is refused before scanning', async () => {
  const f = fixture(); f.file('/usr/share/mica/meta', 'not a directory\n')
  await expectPublicRefusal(f, '/usr/share/mica/meta')
})

test.each([
  ['root extra file', '/usr/share/mica/meta/extra.json'],
  ['nested extra file', '/usr/share/mica/meta/updates/extra.json'],
])('%s is refused by path', async (_name, path) => {
  const f = fixture(); publicDefaults(f); f.file(path, 'extra\n')
  await expectPublicRefusal(f, path)
})

test('a permitted name with a special file type is refused before it is read', async () => {
  const f = fixture(); publicDefaults(f)
  const special = join(f.root, 'usr/share/mica/meta/GENERATED')
  const made = spawnSync('mkfifo', [special], { encoding: 'utf8' })
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0)
  await expectPublicRefusal(f, '/usr/share/mica/meta/GENERATED')
})

test.each(['updates/manifest.json', 'GENERATED'])('%s cannot be a symlink', async (relative) => {
  const f = fixture(); publicDefaults(f)
  const target = join(f.root, 'safe-target')
  writeFileSync(target, relative === 'GENERATED' ? MARKER : CURRENT_MANIFEST)
  rmSync(join(f.root, 'usr/share/mica/meta', relative), { force: true })
  symlinkSync(target, join(f.root, 'usr/share/mica/meta', relative))
  await expectPublicRefusal(f, `/usr/share/mica/meta/${relative}`)
})

test.each(['meta', 'updates'])('required %s directory cannot be a symlink', async (name) => {
  const f = fixture()
  const target = mkdtempSync(join(tmpdir(), `file-root-${name}-target-`)); work.push(target)
  const targetMeta = name === 'meta' ? target : join(target, 'meta')
  mkdirSync(join(targetMeta, 'updates'), { recursive: true })
  writeFileSync(join(targetMeta, 'updates/manifest.json'), CURRENT_MANIFEST)
  if (name === 'meta') {
    mkdirSync(join(f.root, 'usr/share/mica'), { recursive: true })
    symlinkSync(targetMeta, join(f.root, 'usr/share/mica/meta'))
  }
  else {
    mkdirSync(join(f.root, 'usr/share/mica/meta'), { recursive: true })
    symlinkSync(join(targetMeta, 'updates'), join(f.root, 'usr/share/mica/meta/updates'))
  }
  await expectPublicRefusal(f, name === 'meta' ? '/usr/share/mica/meta' : '/usr/share/mica/meta/updates')
})

test('a planted image path component cannot escape to a valid host tree', async () => {
  const f = fixture()
  const host = mkdtempSync(join(tmpdir(), 'file-root-host-meta-')); work.push(host)
  mkdirSync(join(host, 'meta/updates'), { recursive: true })
  writeFileSync(join(host, 'meta/updates/manifest.json'), CURRENT_MANIFEST)
  writeFileSync(join(host, 'meta/GENERATED'), '-----BEGIN PRIVATE KEY-----\nHOST_SECRET_SENTINEL\n')
  mkdirSync(join(f.root, 'usr/share'), { recursive: true })
  symlinkSync(host, join(f.root, 'usr/share/mica'))
  await expect(f.checkResult('file-root-public-defaults')).rejects.toThrow('/usr/share/mica/meta')
})

test('identity accepts the shipped relative D-Bus link and refuses a baked machine ID', async () => {
  const f = fixture()
  f.file('/etc/machine-id', '')
  mkdirSync(join(f.root, 'var/lib/dbus'), { recursive: true })
  mkdirSync(join(f.root, 'var/lib/systemd'), { recursive: true })
  symlinkSync('../../../etc/machine-id', join(f.root, 'var/lib/dbus/machine-id'))
  symlinkSync('/mnt/data/state/random-seed', join(f.root, 'var/lib/systemd/random-seed'))
  expect(await f.check('file-root-identity')).toBe('pass')
  f.file('/etc/machine-id', 'a'.repeat(32))
  expect(await f.check('file-root-identity')).toBe('fail')
})

test('/etc/hosts links to /run/mica/hosts, and mica-hosts writes it at boot under either init', async () => {
  const f = fixture()
  symlinkSync('../run/mica/hosts', join(f.root, 'etc/hosts'))
  f.file('/usr/lib/mica/mica-hosts', '#!/bin/sh\n')
  f.file('/etc/systemd/system/mica-hosts.service', '[Service]\nExecStart=/usr/lib/mica/mica-hosts\n')
  expect(await f.check('file-root-hosts')).toBe('fail')
  mkdirSync(join(f.root, 'etc/systemd/system/sysinit.target.wants'), { recursive: true })
  symlinkSync('/etc/systemd/system/mica-hosts.service', join(f.root, 'etc/systemd/system/sysinit.target.wants/mica-hosts.service'))
  expect(await f.check('file-root-hosts')).toBe('pass')
  rmSync(join(f.root, 'etc/hosts'))
  f.file('/etc/hosts', '127.0.1.1 mica\n')
  expect(await f.check('file-root-hosts')).toBe('fail')
  const o = fixture('openrc')
  symlinkSync('../run/mica/hosts', join(o.root, 'etc/hosts'))
  o.file('/usr/lib/mica/mica-hosts', '#!/bin/sh\n')
  o.file('/etc/init.d/mica-mounts', 'start() {\n    hostname -F /etc/hostname\n}\n')
  expect(await o.check('file-root-hosts')).toBe('fail')
  o.file('/etc/init.d/mica-mounts', 'start() {\n    hostname -F /etc/hostname &&\n        /usr/lib/mica/mica-hosts\n}\n')
  expect(await o.check('file-root-hosts')).toBe('pass')
})

test('the device code source is one line naming a source micad reads', async () => {
  const f = fixture()
  expect(await f.check('file-root-device-code')).toBe('fail')
  f.file('/usr/share/mica/device-code.conf', 'source=emmc-cid\n')
  expect(await f.check('file-root-device-code')).toBe('pass')
  f.file('/usr/share/mica/device-code.conf', 'source=cpu-serial\n')
  expect(await f.check('file-root-device-code')).toBe('fail')
  f.file('/usr/share/mica/device-code.conf', 'source=mac\nsource=dmi-uuid\n')
  expect(await f.check('file-root-device-code')).toBe('fail')
})

test('the access-point secret is 0600 root:root and at least 32 bytes, in the tree and as squashfs packs it', async () => {
  const f = fixture()
  expect(await f.check('file-root-ap-secret')).toBe('fail')
  f.file('/usr/share/mica/ap-secret', `${'k'.repeat(32)}\n`)
  chownSync(join(f.root, 'usr/share/mica/ap-secret'), 0, 0)
  chmodSync(join(f.root, 'usr/share/mica/ap-secret'), 0o644)
  expect((await f.checkResult('file-root-ap-secret')).message).toContain('is mode 644 owner 0:0')
  chmodSync(join(f.root, 'usr/share/mica/ap-secret'), 0o600)
  expect(await f.check('file-root-ap-secret')).toBe('pass')
  chownSync(join(f.root, 'usr/share/mica/ap-secret'), 1000, 1000)
  expect(await f.check('file-root-ap-secret')).toBe('fail')
  // A factory image: the mode and owner squashfs carries, whatever unpacking left.
  const packed = (line: string) => ROOT_CHECKS.find(c => c.id === 'file-root-ap-secret')!.run({ board: loadBoard(boardEnvPath('cx3576')), product: { ...EVERY_FEATURE }, image: 'fixture',
    packedRootfs: '/image/rootfs.squashfs', workDir: f.root, outDir: f.root, unpackRoot: async () => f.root,
    tools: { ...NO_TOOLS, run: async (argv: readonly string[]) => ({ argv, code: 0, stdout: `${line} squashfs-root/usr/share/mica/ap-secret\n`, stderr: '' }) } as typeof NO_TOOLS })
  expect((await packed('-rw------- 0/0 33 2026-10-21 00:00'))[0]!.verdict).toBe('pass')
  expect((await packed('-rw-r--r-- 0/0 33 2026-10-21 00:00'))[0]!.verdict).toBe('fail')
  chownSync(join(f.root, 'usr/share/mica/ap-secret'), 0, 0)
  f.file('/usr/share/mica/ap-secret', `${'k'.repeat(31)}\n`)
  chmodSync(join(f.root, 'usr/share/mica/ap-secret'), 0o600)
  expect((await f.checkResult('file-root-ap-secret')).message).toContain('holds fewer than 32 bytes')
})

test('OpenRC\'s DATA policy: a gpt board\'s DATA partition grown by its identities, a ubi board\'s UBI volume grown by nothing', async () => {
  const seed = (f: ReturnType<typeof fixture>, dataLine: string, layout?: string) => {
    f.file('/etc/fstab', `${dataLine}\ntmpfs /tmp tmpfs noatime,size=128M,nr_inodes=32768 0 0\n`)
    if (layout !== undefined) f.file('/etc/conf.d/mica-data-layout', layout)
    f.file('/etc/init.d/mica-mounts', 'bind /mnt/data/var /var nosuid,nodev &&\n    bind /mnt/data/state/mica /var/lib/mica\n')
    mkdirSync(join(f.root, 'etc/runlevels/boot'), { recursive: true })
    for (const s of ['mica-data-layout', 'mica-mounts']) symlinkSync(`/etc/init.d/${s}`, join(f.root, `etc/runlevels/boot/${s}`))
  }
  const gpt = loadBoard(boardEnvPath('uefi-x64')).layout!
  const grow = `grow_system_uuid=${partitionOf(gpt, 'system').guid}\ngrow_disk_uuid=${gpt.diskGuid}\n`
  const gptLine = `PARTUUID=${partitionOf(gpt, 'data').guid} /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2`
  const ubiLine = 'ubi0:data /mnt/data ubifs noatime 0 0'
  for (const [board, line, layout, verdict] of [
    ['uefi-x64', gptLine, grow, 'pass'], ['uefi-x64', gptLine, undefined, 'fail'], ['uefi-x64', ubiLine, grow, 'fail'],
    ['qemu-armhf', ubiLine, undefined, 'pass'], ['qemu-armhf', ubiLine, grow, 'fail'], ['qemu-armhf', gptLine, undefined, 'fail'],
  ] as const) {
    const f = fixture('openrc', board)
    seed(f, line, layout)
    expect([board, line, layout, await f.check('file-root-data-policy-openrc')]).toEqual([board, line, layout, verdict])
  }
})

test('DATA policy requires a whole var bind and rejects per-systemd-leaf mounts', async () => {
  const f = fixture()
  const board = loadBoard(boardEnvPath('uefi-x64'))
  f.file('/etc/fstab', `PARTUUID=${partitionOf(board.layout!, 'data').guid} /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2\ntmpfs /tmp tmpfs size=128M,nr_inodes=32768 0 0\n`)
  for (const name of ['var-lib-mica', 'usr-local-lib-systemd-system'])
    f.file(`/etc/systemd/system/${name}.mount`, '[Mount]\nWhat=/mnt/data/state/example\n')

  f.file('/etc/systemd/system/var.mount', '[Mount]\nWhat=/mnt/data/var\nWhere=/var\nOptions=bind,private,nosuid,nodev\n')
  f.file('/etc/systemd/system/mica-seed-var.service', '[Service]\nExecStart=/usr/lib/mica/mica-seed-var\n')
  expect(await f.check('file-root-data-policy')).toBe('pass')
  f.file('/etc/systemd/system/var-lib-systemd-timesync.mount', '[Mount]\nWhat=/mnt/data/state/timesync\n')
  expect(await f.check('file-root-data-policy')).toBe('fail')
  rmSync(join(f.root, 'etc/systemd/system/var-lib-systemd-timesync.mount'))
  f.file('/etc/systemd/system/var.mount', '[Mount]\nWhat=/mnt/system/var\nWhere=/var\nOptions=bind\n')
  expect(await f.check('file-root-data-policy')).toBe('fail')
})

test('image symlinks resolve inside the image, including absolute and parent links', () => {
  const f = fixture()
  f.file('/usr/share/value', 'image')
  symlinkSync('/usr/share', join(f.root, 'etc/absolute'))
  symlinkSync('../usr/share', join(f.root, 'relative'))
  expect(pathInRoot(f.root, '/etc/absolute/value')).toBe(join(f.root, 'usr/share/value'))
  expect(regularFileInRoot(f.root, '/relative/value')).toBe(true)
  symlinkSync('/proc/version', join(f.root, 'etc/host'))
  expect(regularFileInRoot(f.root, '/etc/host')).toBe(false)
  symlinkSync('/etc/cycle', join(f.root, 'etc/cycle'))
  expect(regularFileInRoot(f.root, '/etc/cycle')).toBe(false)
})

test('container storage requires its own enabled bind outside var', async () => {
  const f = fixture()
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/etc/systemd/system/mica-containers.mount', '[Unit]\nRequires=mica-data-layout.service mica.mount\nAfter=mica-data-layout.service mica.mount\n[Mount]\nWhat=/mnt/data/containers\nWhere=/mica/containers\nOptions=bind,private,nosuid,nodev\n')
  f.file('/etc/systemd/system/mica.mount', '[Mount]\nOptions=bind,private\n')
  f.file('/usr/lib/systemd/system/mica-containerd.service', '[Unit]\nRequiresMountsFor=/var/lib/mica /mica/containers\n')
  f.file('/etc/containers/storage.conf', '[storage]\ngraphroot = "/mica/containers/storage"\nrunroot = "/run/containers/storage"\n')
  f.file('/etc/containers/containers.conf', '[engine]\nimage_copy_tmp_dir = "/mica/containers/tmp"\n[network]\nnetwork_config_dir = "/mica/containers/networks"\n')
  mkdirSync(join(f.root, 'etc/systemd/system/local-fs.target.wants'), { recursive: true })
  symlinkSync('/etc/systemd/system/mica-containers.mount', join(f.root, 'etc/systemd/system/local-fs.target.wants/mica-containers.mount'))
  expect(await f.check('file-root-container-policy')).toBe('pass')
  f.file('/etc/systemd/system/mica.mount', '[Mount]\nOptions=bind\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/etc/systemd/system/mica.mount', '[Mount]\nOptions=bind,private\n')
  f.file('/usr/lib/systemd/system/mica-containerd.service', '[Unit]\nRequiresMountsFor=/var/lib/mica\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/usr/lib/systemd/system/mica-containerd.service', '[Unit]\nRequiresMountsFor=/var/lib/mica /mica/containers\n')
  f.file('/etc/systemd/system/mica-containers.mount', '[Mount]\nWhat=/mnt/data/var/containers\nWhere=/mica/containers\nOptions=bind,private,nosuid,nodev\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
})

test('on OpenRC, mica-mounts binds container storage and mica-containerd needs it', async () => {
  const f = fixture('openrc')
  f.file('/etc/containers/storage.conf', '[storage]\ngraphroot = "/mica/containers/storage"\nrunroot = "/run/containers/storage"\n')
  f.file('/etc/containers/containers.conf', '[engine]\nimage_copy_tmp_dir = "/mica/containers/tmp"\n[network]\nnetwork_config_dir = "/mica/containers/networks"\n')
  f.file('/etc/init.d/mica-mounts', 'start() {\n    bind /mnt/data/containers /mica/containers nosuid,nodev\n}\n')
  f.file('/etc/init.d/mica-containerd', 'depend() {\n    need mica-mounts\n}\n')
  expect(await f.check('file-root-container-policy')).toBe('pass')
  f.file('/etc/init.d/mica-containerd', 'depend() {\n    use logger\n}\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/etc/init.d/mica-containerd', 'depend() {\n    need mica-mounts\n}\n')
  f.file('/etc/init.d/mica-mounts', 'start() {\n    bind /mnt/data/mica /mica\n}\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
})

test('on docker, the same bind, and dockerd started only once it is there; no podman storage is asked for', async () => {
  const f = fixture('systemd', 'uefi-x64', 'docker')
  f.file('/etc/systemd/system/mica-containers.mount', '[Unit]\nRequires=mica-data-layout.service mica.mount\nAfter=mica-data-layout.service mica.mount\n[Mount]\nWhat=/mnt/data/containers\nWhere=/mica/containers\nOptions=bind,private,nosuid,nodev\n')
  f.file('/etc/systemd/system/mica.mount', '[Mount]\nOptions=bind,private\n')
  mkdirSync(join(f.root, 'etc/systemd/system/local-fs.target.wants'), { recursive: true })
  symlinkSync('/etc/systemd/system/mica-containers.mount', join(f.root, 'etc/systemd/system/local-fs.target.wants/mica-containers.mount'))
  f.file('/usr/lib/systemd/system/docker.service', '[Unit]\nAfter=micad.service\nRequiresMountsFor=/var/lib/mica\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/usr/lib/systemd/system/docker.service', '[Unit]\nAfter=micad.service\nRequiresMountsFor=/mica/containers\n')
  expect(await f.check('file-root-container-policy')).toBe('pass')
  const o = fixture('openrc', 'uefi-x64', 'docker')
  o.file('/etc/init.d/mica-mounts', 'start() {\n    bind /mnt/data/containers /mica/containers nosuid,nodev\n}\n')
  o.file('/etc/init.d/docker', 'depend() {\n    after micad\n}\n')
  expect(await o.check('file-root-container-policy')).toBe('fail')
  o.file('/etc/init.d/docker', 'depend() {\n    need mica-mounts\n    after micad\n}\n')
  expect(await o.check('file-root-container-policy')).toBe('pass')
})

const NATIVE_ENDPOINT_CHECK = 'file-root-native-endpoints'
const NATIVE_PATHS = ['/usr/bin/micad', '/usr/bin/mica-deploy']

function nativeElf(payload = 'clean native fixture'): Buffer {
  // ELF64 executable with one loadable segment; no toolchain or execution needed.
  const bytes = Buffer.alloc(120 + Buffer.byteLength(payload) + 1)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  bytes.writeUInt16LE(2, 16)
  bytes.writeUInt16LE(62, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeBigUInt64LE(0x400078n, 24)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(64, 52)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64)
  bytes.writeUInt32LE(5, 68)
  bytes.writeBigUInt64LE(0x400000n, 80)
  bytes.writeBigUInt64LE(0x400000n, 88)
  bytes.writeBigUInt64LE(BigInt(bytes.length), 96)
  bytes.writeBigUInt64LE(BigInt(bytes.length), 104)
  bytes.writeBigUInt64LE(4096n, 112)
  bytes.write(payload, 120)
  return bytes
}

function nativeFiles(f: ReturnType<typeof fixture>): number {
  let bytes = 0
  for (const path of NATIVE_PATHS) {
    const content = nativeElf(`clean ${path}`)
    f.file(path, content)
    bytes += content.byteLength
  }
  for (const link of ['/usr/bin/mica-apid', '/usr/bin/mica-update']) {
    rmSync(join(f.root, link), { force: true })
    symlinkSync('micad', join(f.root, link))
  }
  return bytes
}

async function expectNativeRefusal(f: ReturnType<typeof fixture>, path: string, reason: string): Promise<string> {
  const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
  expect(result.verdict, result.message).toBe('fail')
  expect(result.message).toContain(path)
  expect(result.message).toContain(reason)
  return result.message
}

test('native endpoint check requires every clean ELF and reports exact scan evidence', async () => {
  const f = fixture(), bytes = nativeFiles(f)
  const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
  expect(result.verdict, result.message).toBe('pass')
  expect(result.message).toContain('scannedFiles=2')
  expect(result.message).toContain(`scannedBytes=${bytes}`)
  expect(result.message).toContain(`examinedPaths=${NATIVE_PATHS.join(',')}`)
})

test.each([
  'https://updates.example/v1/manifest.json',
  'https://fleet.example/v1/register',
])('configured %s stays valid while the identical literal inside an ELF fails', async (url) => {
  const f = fixture(); nativeFiles(f)
  const configured = manifest()
  objectAt(configured, 'update').source = url
  writeManifest(f, configured)
  f.file('/mica/config/updates.json', JSON.stringify({ source: { url } }))
  expect(await f.check('file-root-public-defaults')).toBe('pass')
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
  f.file('/usr/bin/micad', nativeElf(url))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
})

test.each(NATIVE_PATHS)('compiled endpoint in %s is found in raw non-UTF-8 bytes without leaking content', async (path) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, Buffer.concat([nativeElf(), Buffer.from([0xff, 0x00]),
    Buffer.from('https://user:DO_NOT_ECHO_ENDPOINT@updates.example/v1/manifest.json?token=DO_NOT_ECHO_TOKEN'),
    Buffer.from([0x00, 0xfe])]))
  const message = await expectNativeRefusal(f, path, 'endpoint')
  expect(message).not.toContain('DO_NOT_ECHO_ENDPOINT')
  expect(message).not.toContain('DO_NOT_ECHO_TOKEN')
  expect(message).not.toContain('https://')
  expect(message).toContain('scannedFiles=2')
  expect(message).toMatch(/scannedBytes=[1-9][0-9]*/)
  expect(message).toContain(`examinedPaths=${NATIVE_PATHS.join(',')}`)
})

test.each([
  'http://localhost/updates/manifest.json',
  'https://127.0.0.1:9443/fleet/register',
  'http://[::1]/v1/manifest.json',
  'HTTPS://UPDATES.EXAMPLE/v1/manifest.json',
  'wss://fleet.example/v1/device',
  'ws://fleet.example/v1/device',
  'mqtts://fleet.example:8883/devices',
  'mqtt://fleet.example:1883/devices',
  'https://control.example/v1/register',
  'https://\u66f4\u65b0.example/v1/manifest.json',
])('native endpoint check does not exempt network location %s', async (url) => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/micad', nativeElf(url))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
})

test('native scan includes only the two current first-party inputs', async () => {
  const f = fixture(), bytes = nativeFiles(f)
  f.file('/usr/bin/third-party', nativeElf('https://updates.example/v1/manifest.json'))
  const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
  expect(result.verdict, result.message).toBe('pass')
  expect(result.message).toContain('scannedFiles=2')
  expect(result.message).toContain(`scannedBytes=${bytes}`)
  expect(result.message).not.toContain('third-party')
})

test.each(NATIVE_PATHS)('missing native input %s fails instead of scanning a subset', async (path) => {
  const f = fixture(); nativeFiles(f)
  rmSync(join(f.root, path))
  await expectNativeRefusal(f, path, 'missing')
})

test('no native inputs cannot produce a zero-work pass', async () => {
  const f = fixture()
  await expectNativeRefusal(f, '/usr/bin/micad', 'missing')
})

test.each(NATIVE_PATHS)('empty native input %s is refused', async (path) => {
  const f = fixture(); nativeFiles(f); f.file(path, '')
  await expectNativeRefusal(f, path, 'empty')
})

test.each(NATIVE_PATHS)('non-ELF native input %s is refused', async (path) => {
  const f = fixture(); nativeFiles(f); f.file(path, '#!/bin/sh\nexit 0\n')
  await expectNativeRefusal(f, path, 'ELF')
})

test('ELF magic alone cannot count as an examined native executable', async () => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/micad', Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  await expectNativeRefusal(f, '/usr/bin/micad', 'ELF')
})

test.each(NATIVE_PATHS)('native input %s cannot be a symlink to a clean ELF', async (path) => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/clean-target', nativeElf())
  rmSync(join(f.root, path))
  symlinkSync('clean-target', join(f.root, path))
  await expectNativeRefusal(f, path, 'non-symlink')
})

test('native special file is refused before reading can block', async () => {
  const f = fixture(); nativeFiles(f)
  const path = '/usr/bin/micad'
  rmSync(join(f.root, path))
  const made = spawnSync('mkfifo', [join(f.root, path)], { encoding: 'utf8', timeout: 5000 })
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0)
  await expectNativeRefusal(f, path, 'regular')
})

test('native directory is refused before reading', async () => {
  const f = fixture(); nativeFiles(f)
  rmSync(join(f.root, 'usr/bin/mica-deploy'))
  mkdirSync(join(f.root, 'usr/bin/mica-deploy'))
  await expectNativeRefusal(f, '/usr/bin/mica-deploy', 'regular')
})

test.each(['usr', 'usr/bin'])('native parent %s cannot redirect the scan outside the unpacked image', async (parent) => {
  const f = fixture(), host = fixture()
  nativeFiles(host)
  mkdirSync(dirname(join(f.root, parent)), { recursive: true })
  symlinkSync(join(host.root, parent), join(f.root, parent))
  await expectNativeRefusal(f, '/usr/bin/micad', 'non-symlink')
})

test('an unpacked-root symlink cannot pass native input verification', async () => {
  const f = fixture(), host = fixture(); nativeFiles(host)
  const link = join(f.root, 'root-link')
  symlinkSync(host.root, link)
  const check = ROOT_CHECKS.find(c => c.id === NATIVE_ENDPOINT_CHECK)!
  await expect(check.run({ board: loadBoard(boardEnvPath('uefi-x64')), image: 'fixture', tools: NO_TOOLS,
    product: EVERY_FEATURE, workDir: f.root, outDir: f.root, unpackRoot: async () => link })).rejects.toThrow('unpacked-image directory')
})

test('native scheme fragments and relative API routes do not name a network location', async () => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/micad', nativeElf('https://\0http://\0ws://\0wss://\0mqtt://\0mqtts://\0/api/v1/update'))
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
})

test.each([
  ['class', (bytes: Buffer) => { bytes[4] = 0 }],
  ['byte order', (bytes: Buffer) => { bytes[5] = 0 }],
  ['ident version', (bytes: Buffer) => { bytes[6] = 0 }],
  ['object type', (bytes: Buffer) => { bytes.writeUInt16LE(1, 16) }],
  ['header version', (bytes: Buffer) => { bytes.writeUInt32LE(0, 20) }],
  ['header size', (bytes: Buffer) => { bytes.writeUInt16LE(0, 52) }],
])('native ELF with invalid %s cannot be counted as scanned', async (_field, mutate) => {
  const f = fixture(); nativeFiles(f)
  const bytes = nativeElf(); mutate(bytes)
  f.file('/usr/bin/micad', bytes)
  const message = await expectNativeRefusal(f, '/usr/bin/micad', 'ELF')
  expect(message).toContain('scannedFiles=0; scannedBytes=0; examinedPaths=')
})

test('native endpoint check accepts a position-independent ELF executable', async () => {
  const f = fixture(); nativeFiles(f)
  const bytes = nativeElf(); bytes.writeUInt16LE(3, 16)
  f.file('/usr/bin/micad', bytes)
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
})

test('native endpoint check reads big-endian ELF headers correctly', async () => {
  const f = fixture(); nativeFiles(f)
  const bytes = nativeElf(); bytes[5] = 2
  for (const offset of [16, 18, 52, 54, 56, 58, 60, 62]) bytes.writeUInt16BE(bytes.readUInt16LE(offset), offset)
  for (const offset of [20, 48, 64, 68]) bytes.writeUInt32BE(bytes.readUInt32LE(offset), offset)
  for (const offset of [24, 32, 40, 72, 80, 88, 96, 104, 112]) bytes.writeBigUInt64BE(bytes.readBigUInt64LE(offset), offset)
  f.file('/usr/bin/micad', bytes)
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
})

test('native endpoint check accepts a complete ELF32 executable', async () => {
  const f = fixture(); nativeFiles(f)
  const bytes = Buffer.alloc(85)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1])
  bytes.writeUInt16LE(2, 16)
  bytes.writeUInt16LE(3, 18)
  bytes.writeUInt32LE(1, 20)
  bytes.writeUInt32LE(0x400054, 24)
  bytes.writeUInt32LE(52, 28)
  bytes.writeUInt16LE(52, 40)
  bytes.writeUInt16LE(32, 42)
  bytes.writeUInt16LE(1, 44)
  bytes.writeUInt32LE(1, 52)
  bytes.writeUInt32LE(0x400000, 60)
  bytes.writeUInt32LE(0x400000, 64)
  bytes.writeUInt32LE(bytes.length, 68)
  bytes.writeUInt32LE(bytes.length, 72)
  bytes.writeUInt32LE(5, 76)
  bytes.writeUInt32LE(4096, 80)
  bytes[84] = 0xc3
  f.file('/usr/bin/micad', bytes)
  const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
  expect(result.verdict, result.message).toBe('pass')
  expect(result.message).toContain('scannedFiles=2')
})

// The console is mica-apid-ui's files, not part of a binary: its literals are exempt nowhere.
test.each(['https://tailwindcss.com', 'http://localhost', 'https://react.dev/errors/'].flatMap(literal => NATIVE_PATHS.map(path => [literal, path])))('the UI literal %s is not exempt in %s', async (literal, path) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, nativeElf(literal))
  await expectNativeRefusal(f, path, 'endpoint')
})

test('mica-apid and mica-update are links to micad, never second executables', async () => {
  for (const link of ['/usr/bin/mica-apid', '/usr/bin/mica-update']) {
    const f = fixture(); nativeFiles(f)
    expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
    rmSync(join(f.root, link))
    f.file(link, nativeElf('clean second'))
    await expectNativeRefusal(f, link, 'must be a link to micad')
  }
})

test('invalid UTF-8 after a bare scheme is not a network authority', async () => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/micad', Buffer.concat([nativeElf(), Buffer.from('https://'), Buffer.from([0xc0, 0xc0, 0])]))
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
  f.file('/usr/bin/micad', Buffer.concat([nativeElf(), Buffer.from('https://updates.example/v1/manifest.json'), Buffer.from([0xc0, 0])]))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
})

test('replacement characters cannot truncate an endpoint into an exact exemption', async () => {
  const f = fixture(); nativeFiles(f)
  const dtd = 'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd'
  f.file('/usr/bin/micad', nativeElf(`${dtd}\ufffdupdates`))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
  f.file('/usr/bin/micad', Buffer.concat([nativeElf(dtd), Buffer.from(dtd), Buffer.from([0xff]), Buffer.from('/updates')]))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
})

// Observed in the release binaries of micad (which carries apid) and mica-deploy: each message with a text that
// follows it there.
const RUSTLS_EOF = 'peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof'
const CLAP_BUG = 'Fatal internal error. Please consider filing a bug report at https://github.com/clap-rs/clap/issues'
const NATIVE_DIAGNOSTIC_CASES: Array<[string, string, string]> = [
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'mid > len'],
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'DBUS_SYSTEM_BUS_ADDRESSunix:path=/var/run/dbus/system_bus_socketDBUS_SESSION_BUS_ADDRESSXDG_RUNTIME_DIRcalled `Result::unwrap()` on an `Err` value'],
  ['/usr/bin/micad', 'Invalid member name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-member', 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface'],
  ['/usr/bin/micad', 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface', 'Invalid well-known name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/micad', 'Invalid well-known name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error'],
  ['/usr/bin/micad', 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error', 'org.freedesktop.DBusInvalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/micad', 'Invalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'BusName::UniqueBusName::WellKnownOwnedErrorNameOwnedUniqueNameInvalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/micad', 'Invalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'mid > len'],
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'mid > len'],
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'DBUS_SYSTEM_BUS_ADDRESSunix:path=/var/run/dbus/system_bus_socketDBUS_SESSION_BUS_ADDRESSXDG_RUNTIME_DIRcalled `Result::unwrap()` on an `Err` value'],
  ['/usr/bin/micad', 'Invalid member name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-member', 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface'],
  ['/usr/bin/micad', 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface', 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error'],
  ['/usr/bin/micad', 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error', 'org.freedesktop.DBusInvalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/micad', 'Invalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'BusName::UniqueBusName::WellKnownOwnedErrorNameOwnedUniqueNameInvalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/micad', 'Invalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'mid > len'],
  ['/usr/bin/micad', RUSTLS_EOF, 'internal error: entered unreachable code'],
  ['/usr/bin/micad', RUSTLS_EOF, 'is not valid for any names (according to its subjectAltName extension)'],
  ['/usr/bin/micad', 'Node.js ES modules are not directly supported, see https://docs.rs/getrandom#nodejs-es-module-support', 'Errorinternal_codedescriptionunknown_code\0'],
  ['/usr/bin/mica-deploy', CLAP_BUG, ''],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'a Display implementation returned an error unexpectedly'],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'falseTryFromIntErrora Display implementation returned an error unexpectedly'],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'internal error: entered unreachable code'],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'generationbytessha256struct Artifact with 2 elements'],
  ['/usr/bin/mica-deploy', RUSTLS_EOF, 'internal error: entered unreachable code'],
  // The stripped binaries: without symbol tables the strings sit closer together.
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'called `Result::unwrap()` on an `Err` value'],
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'DBUS_SYSTEM_BUS_ADDRESSunix:path=/var/run/dbus/system_bus_socketDBUS_SESSION_BUS_ADDRESSXDG_RUNTIME_DIRtracing::span::activemid > len'],
  ['/usr/bin/mica-deploy', CLAP_BUG, '0123456789abcdefInvalidCrlNumberInvalidKeyUpdateEmptyTicketValueIllegalEmptyList1 element in map'],
  // mica-core 0.0.11 (amd64, arm64, armhf).
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'org.freedesktop.DBus.PropertiesMissing OK server GUID!'],
  ['/usr/bin/micad', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'org.freedesktop.DBus.Properties\0'],
  ['/usr/bin/micad', 'Invalid well-known name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'mid > len'],
  ['/usr/bin/micad', 'Invalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'Invalid signature'],
]

// The HTTP stack's scheme and version strings with the names each build lays out after them, read as one literal.
test.each([
  'https://HTTP/0.9HTTP/1.0HTTP/1.1HTTP/2.0HTTP/3.0if-matchif-rangeCanceledShutdownInternalConflictdroppingapid-tmpoperatordnsNamesnotAfterfailuresnextStepobservedUiStatusversionsMqttAuthApiErrorsnapshotsectionstrailersMICAUPD1+',
  'https://HTTP/0.9HTTP/1.0HTTP/1.1HTTP/2.0HTTP/3.0if-matchif-rangeCanceledShutdownInternalConflictdroppingapid-tmpoperatordnsNamesnotAfterfailuresnextStepobservedUiStatusversionsMqttAuthApiErrorsnapshotsectionstrailersMICAUPD1uploadedaccepted\ufffd',
])('the HTTP version strings in micad are no endpoint, and hide none: %s', async (literal) => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/micad', nativeElf(literal))
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
  f.file('/usr/bin/micad', nativeElf(`${literal}https://updates.example/v1/manifest.json`))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
})

test.each(NATIVE_DIAGNOSTIC_CASES)('a known diagnostic URL in %s passes whatever the build lays out after it: %s', async (path, message) => {
  const f = fixture(); nativeFiles(f)
  for (const after of ['X', '/updates', 'unknownLayoutOfAnotherBuild', '#fragment.example']) {
    f.file(path, nativeElf(`${message}${after}`))
    const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
    expect(result.verdict, result.message).toBe('pass')
  }
})

test.each(NATIVE_DIAGNOSTIC_CASES)('an unknown URL right after a known diagnostic URL in %s is refused: %s', async (path, message) => {
  const f = fixture(); nativeFiles(f)
  for (const url of ['https://updates.example/v1/manifest.json', 'mqtts://fleet.example:8883', 'wss://ctl.example/']) {
    for (const between of ['', 'X', '/updates']) {
      f.file(path, nativeElf(`${message}${between}${url}`))
      await expectNativeRefusal(f, path, 'endpoint')
    }
  }
})

test.each(NATIVE_DIAGNOSTIC_CASES)('exact diagnostic and attested adjacent text in %s remain non-endpoints: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  for (const payload of [message, `${message}${adjacent}`]) {
    f.file(path, nativeElf(payload))
    const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
    expect(result.verdict, result.message).toBe('pass')
    expect(result.message).toContain('scannedFiles=2')
  }
})

test.each(NATIVE_DIAGNOSTIC_CASES)('an unattributed standalone URL in %s cannot use diagnostic exemptions: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, nativeElf(`${message.slice(message.indexOf('https://'))}${adjacent}`))
  await expectNativeRefusal(f, path, 'endpoint')
})

test.each(NATIVE_DIAGNOSTIC_CASES)('an injected endpoint adjacent to a diagnostic in %s is refused: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  for (const separator of ['', '\0']) {
    f.file(path, nativeElf(`${message}${adjacent}${separator}https://updates.example/v1/manifest.json`))
    await expectNativeRefusal(f, path, 'endpoint')
  }
})

// A diagnostic is exempt only in the binaries attested to carry it.
const WRONG_BINARY_CASES = NATIVE_DIAGNOSTIC_CASES.flatMap(([, message, adjacent]) => NATIVE_PATHS
  .filter(other => !NATIVE_DIAGNOSTIC_CASES.some(([p, m]) => p === other && m === message))
  .map(other => [other, message, adjacent] as [string, string, string]))
test.each(WRONG_BINARY_CASES.filter(([o, m, a], i) => WRONG_BINARY_CASES.findIndex(([o2, m2, a2]) => o2 === o && m2 === m && a2 === a) === i))('a diagnostic in the wrong native binary %s is refused: %s', async (other, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  f.file(other, nativeElf(`${message}${adjacent}`))
  await expectNativeRefusal(f, other, 'endpoint')
})

test.each(['/usr/bin/micad'])('the exact D-Bus introspection DTD in %s is a namespace only', async (path) => {
  const f = fixture(); nativeFiles(f)
  const dtd = 'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd'
  f.file(path, nativeElf(dtd))
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
  f.file(path, nativeElf(`${dtd}/updates`))
  await expectNativeRefusal(f, path, 'endpoint')
  nativeFiles(f)
  f.file('/usr/bin/mica-deploy', nativeElf(dtd))
  await expectNativeRefusal(f, '/usr/bin/mica-deploy', 'endpoint')
})

// The SSH server starts at boot as micad last configured it: mica-sshd.service is enabled in the image and skips its
// start unless /var/lib/mica/ssh/sshd.env says SSH_ENABLED=yes (mica-ssh's dropbear.service, its former name, stays
// disabled); under OpenRC mica-sshd-boot starts mica-sshd. Its host key is made on STATE at first start.
function sshRoot(f: ReturnType<typeof fixture>, ssh: 'dropbear' | 'openssh' = 'dropbear'): void {
  f.file('/etc/systemd/system/mica-sshd.service', '[Service]\nEnvironmentFile=-/var/lib/mica/ssh/sshd.env\nExecCondition=/bin/sh -c \'test "${SSH_ENABLED}" = yes\'\n[Install]\nWantedBy=multi-user.target\n')
  f.file('/usr/lib/systemd/system-preset/50-mica-sshd.preset', 'enable mica-sshd.service\n')
  mkdirSync(join(f.root, 'etc/systemd/system/multi-user.target.wants'), { recursive: true })
  symlinkSync('/etc/systemd/system/mica-sshd.service', join(f.root, 'etc/systemd/system/multi-user.target.wants/mica-sshd.service'))
  if (ssh === 'openssh') return
  f.file('/etc/systemd/system/dropbear.service', '[Service]\nEnvironmentFile=/run/mica/dropbear.env\n[Install]\nWantedBy=multi-user.target\n')
  f.file('/usr/lib/systemd/system-preset/50-mica-dropbear.preset', 'disable dropbear.service\n')
}

function sshOpenrcRoot(f: ReturnType<typeof fixture>): void {
  f.file('/etc/init.d/mica-sshd', '#!/sbin/openrc-run\n')
  f.file('/etc/init.d/mica-sshd-boot', '#!/sbin/openrc-run\n')
  mkdirSync(join(f.root, 'etc/runlevels/default'), { recursive: true })
  symlinkSync('/etc/init.d/mica-sshd-boot', join(f.root, 'etc/runlevels/default/mica-sshd-boot'))
}

test.each(['dropbear', 'openssh'] as const)('%s starts at boot as configured, with no key, identity or arguments in the image', async (ssh) => {
  const f = fixture('systemd', 'uefi-x64', 'podman', ssh); sshRoot(f, ssh)
  const result = await f.checkResult('file-root-ssh-boot')
  expect(result.verdict, result.message).toBe('pass')
})

test.each([
  ['an enablement link of dropbear', (f: ReturnType<typeof fixture>) => {
    symlinkSync('/etc/systemd/system/dropbear.service', join(f.root, 'etc/systemd/system/multi-user.target.wants/dropbear.service'))
  }, 'enable(s) dropbear.service'],
  ['no enablement link of mica-sshd', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'etc/systemd/system/multi-user.target.wants/mica-sshd.service')), 'mica-sshd.service is not enabled'],
  ['a disabling mica-sshd preset', (f: ReturnType<typeof fixture>) => f.file('/usr/lib/systemd/system-preset/50-mica-sshd.preset', 'disable mica-sshd.service\n'), 'mica-sshd.service'],
  ['no ExecCondition', (f: ReturnType<typeof fixture>) => f.file('/etc/systemd/system/mica-sshd.service', '[Service]\n[Install]\nWantedBy=multi-user.target\n'), 'ExecCondition'],
  ['no dropbear preset', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'usr/lib/systemd/system-preset/50-mica-dropbear.preset')), 'preset'],
  ['an earlier enable rule', (f: ReturnType<typeof fixture>) => f.file('/usr/lib/systemd/system-preset/10-enable.preset', 'enable *\n'), 'dropbear.service'],
  ['no unit', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'etc/systemd/system/dropbear.service')), 'dropbear.service'],
  ['no mica-sshd unit', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'etc/systemd/system/mica-sshd.service')), 'mica-sshd.service is not in the image'],
  ['a dropbear host key', (f: ReturnType<typeof fixture>) => f.file('/etc/dropbear/dropbear_ed25519_host_key', 'key'), '/etc/dropbear/dropbear_ed25519_host_key'],
  ['an OpenSSH host key', (f: ReturnType<typeof fixture>) => f.file('/etc/ssh/ssh_host_ed25519_key', 'key'), '/etc/ssh/ssh_host_ed25519_key'],
  ['a STATE identity', (f: ReturnType<typeof fixture>) => f.file('/mnt/data/state/ssh/dropbear_ed25519_host_key', 'key'), '/mnt/data/state'],
  ['runtime arguments', (f: ReturnType<typeof fixture>) => f.file('/run/mica/dropbear.env', 'DROPBEAR_ARGS="-p 22"\n'), '/run/mica/dropbear.env'],
  ['saved SSH settings', (f: ReturnType<typeof fixture>) => f.file('/var/lib/mica/ssh/sshd.env', 'SSH_ENABLED=yes\n'), '/var/lib/mica/ssh'],
])('the SSH server with %s is refused', async (_shape, mutate, reason) => {
  const f = fixture(); sshRoot(f)
  mutate(f)
  const result = await f.checkResult('file-root-ssh-boot')
  expect(result.verdict, result.message).toBe('fail')
  expect(result.message).toContain(reason)
})

test('an OpenSSH product is held to mica-sshd.service\'s preset all the same', async () => {
  const f = fixture('systemd', 'uefi-x64', 'podman', 'openssh'); sshRoot(f, 'openssh')
  rmSync(join(f.root, 'usr/lib/systemd/system-preset/50-mica-sshd.preset'))
  const result = await f.checkResult('file-root-ssh-boot')
  expect(result.verdict, result.message).toBe('fail')
  expect(result.message).toContain('mica-sshd.service')
})

test('an OpenRC root starts SSH at boot through mica-sshd-boot', async () => {
  const f = fixture('openrc'); sshOpenrcRoot(f)
  const result = await f.checkResult('file-root-ssh-boot')
  expect(result.verdict, result.message).toBe('pass')
})

test.each([
  ['no mica-sshd-boot in the default runlevel', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'etc/runlevels/default/mica-sshd-boot')), 'mica-sshd-boot'],
  ['mica-sshd in a runlevel', (f: ReturnType<typeof fixture>) => symlinkSync('/etc/init.d/mica-sshd', join(f.root, 'etc/runlevels/default/mica-sshd')), 'mica-sshd is in the default runlevel'],
  ['no mica-sshd script', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'etc/init.d/mica-sshd')), '/etc/init.d/mica-sshd'],
])('an OpenRC root with %s is refused', async (_shape, mutate, reason) => {
  const f = fixture('openrc'); sshOpenrcRoot(f)
  mutate(f)
  const result = await f.checkResult('file-root-ssh-boot')
  expect(result.verdict, result.message).toBe('fail')
  expect(result.message).toContain(reason)
})

// One SSH server per root, the product's: the inventory names exactly its package, or neither without ssh.
function inventory(f: ReturnType<typeof fixture>, packages: string[]): void {
  f.file('/usr/share/mica/manifest.tsv', ['#package\tversion\tarchitecture', ...packages.map(p => `${p}\t0.0.1-1\tamd64`), ''].join('\n'))
}

test.each([
  ['dropbear', ['mica-system', 'mica-ssh'], 'pass', 'mica-ssh'],
  ['openssh', ['mica-system', 'mica-openssh'], 'pass', 'mica-openssh'],
  ['openssh', ['mica-system', 'mica-ssh'], 'fail', 'SSH_SERVER=openssh'],
  ['dropbear', ['mica-system', 'mica-ssh', 'mica-openssh'], 'fail', 'mica-ssh mica-openssh'],
  ['dropbear', ['mica-system'], 'fail', 'none'],
] as const)('SSH_SERVER=%s with %j installed: %s', async (ssh, packages, want, fragment) => {
  const f = fixture('systemd', 'uefi-x64', 'podman', ssh); inventory(f, [...packages])
  const result = await f.checkResult('file-root-ssh-package')
  expect(result.verdict, result.message).toBe(want)
  expect(result.message).toContain(fragment)
})

// The gate's own probes, in the shape mica-system-base's mica-health writes them.
const HEALTH_GATE = [
  'have() { command -v "$1" >/dev/null 2>&1; }',
  'micad_call() {',
  '    have dbus-send || return 0',
  '}',
  'have mica-deploy || fail "mica-deploy is not installed"',
  'if requires micad; then',
  '    have dbus-send ||',
  '        fail "required member micad: dbus-send is not in this image"',
  'fi',
  'if requires apid; then',
  '    have mica-apid ||',
  '        fail "required member apid: no mica-apid binary in this image"',
  'fi',
  '',
].join('\n')

function healthGate(f: ReturnType<typeof fixture>, require: readonly string[]): void {
  f.file('/usr/lib/mica/mica-health', HEALTH_GATE)
  f.file('/etc/mica/health.conf', require.map(m => `require=${m}\n`).join(''))
  for (const p of ['/usr/bin/micad', '/usr/bin/mica-deploy', '/usr/bin/dbus-send']) f.file(p, 'x')
  symlinkSync('micad', join(f.root, '/usr/bin/mica-apid'))
}

test('every command the health gate requires of its required members is in the root', async () => {
  const f = fixture(); healthGate(f, ['boot-settled', 'micad', 'apid'])
  const pass = await f.checkResult('file-root-health-commands')
  expect(pass.verdict, pass.message).toBe('pass')
  expect(pass.message).toContain('dbus-send, mica-apid, mica-deploy')
  rmSync(join(f.root, '/usr/bin/micad'))
  const dangling = await f.checkResult('file-root-health-commands')
  expect(dangling.verdict).toBe('fail')
  expect(dangling.message).toContain('mica-apid (member apid)')
})

test('an optional component binds its probe as a required member does', async () => {
  const f = fixture(); healthGate(f, ['init'])
  f.file('/etc/mica/health.conf', 'require=init\nif-installed=micad\n')
  rmSync(join(f.root, '/usr/bin/dbus-send'))
  const result = await f.checkResult('file-root-health-commands')
  expect(result.verdict).toBe('fail')
  expect(result.message).toContain('dbus-send (member micad)')
})

test('a member the conf does not require asks nothing of the root, and a tolerated probe is no requirement', async () => {
  const f = fixture(); healthGate(f, ['micad'])
  rmSync(join(f.root, '/usr/bin/mica-apid'))
  expect(await f.check('file-root-health-commands')).toBe('pass')
  const g = fixture(); healthGate(g, ['apid'])
  rmSync(join(g.root, '/usr/bin/dbus-send'))
  expect(await g.check('file-root-health-commands')).toBe('pass')
  rmSync(join(g.root, '/usr/bin/mica-deploy'))
  const top = await g.checkResult('file-root-health-commands')
  expect(top.verdict).toBe('fail')
  expect(top.message).toContain('mica-deploy (always)')
})

test('a gate that names no command is refused, not passed', async () => {
  const f = fixture(); healthGate(f, ['apid'])
  f.file('/usr/lib/mica/mica-health', '#!/bin/sh\nexit 0\n')
  expect(await f.check('file-root-health-commands')).toBe('fail')
})
