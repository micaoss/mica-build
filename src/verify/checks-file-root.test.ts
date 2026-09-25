import { partitionOf } from '../image/file-layout.ts'
import { EVERY_FEATURE } from './product-conf.ts'
import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'file-root-check-')); work.push(root)
  mkdirSync(join(root, 'etc'))
  const file = (path: string, text: string | Uint8Array) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const checkResult = async (id: string) => (await ROOT_CHECKS.find(c => c.id === id)!.run({ board: loadBoard(boardEnvPath('uefi-x64')),
    product: EVERY_FEATURE, image: 'fixture', tools: NO_TOOLS, workDir: root, outDir: root, unpackRoot: async () => root }))[0]!
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

test('root component rejects kernel payload and retired updater binaries', async () => {
  const f = fixture()
  expect(await f.check('file-root-is-component')).toBe('pass')
  f.file('/usr/lib/modules/6.12/modules.dep', '')
  expect(await f.check('file-root-is-component')).toBe('fail')
  rmSync(join(f.root, 'usr/lib/modules'), { recursive: true })
  f.file('/usr/bin/rauc', 'obsolete')
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
  ['schema', (value: JsonObject) => { value.schema = 'mica/meta/v0' }],
  ['product', (value: JsonObject) => { value.product = [] }],
  ['product.vendor', (value: JsonObject) => { objectAt(value, 'product').vendor = false }],
  ['product.model', (value: JsonObject) => { objectAt(value, 'product').model = 1 }],
  ['update.source', (value: JsonObject) => { objectAt(value, 'update').source = false }],
  ['update.channel', (value: JsonObject) => { objectAt(value, 'update').channel = '  ' }],
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

test('DATA policy requires a whole var bind and rejects per-systemd-leaf mounts', async () => {
  const f = fixture()
  const board = loadBoard(boardEnvPath('uefi-x64'))
  f.file('/etc/fstab', `PARTUUID=${partitionOf(board.layout, 'data').guid} /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2\ntmpfs /tmp tmpfs size=128M,nr_inodes=32768 0 0\n`)
  for (const name of ['var-lib-mica', 'usr-local-lib-systemd-system', 'etc-containers-systemd'])
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
  f.file('/etc/systemd/system/etc-containers-systemd.mount', '[Unit]\nRequiresMountsFor=/mnt/data/state /mica/containers\n')
  f.file('/etc/containers/storage.conf', '[storage]\ngraphroot = "/mica/containers/storage"\nrunroot = "/run/containers/storage"\n')
  f.file('/etc/containers/containers.conf', '[engine]\nimage_copy_tmp_dir = "/mica/containers/tmp"\n[network]\nnetwork_config_dir = "/mica/containers/networks"\n')
  mkdirSync(join(f.root, 'etc/systemd/system/local-fs.target.wants'), { recursive: true })
  symlinkSync('/etc/systemd/system/mica-containers.mount', join(f.root, 'etc/systemd/system/local-fs.target.wants/mica-containers.mount'))
  expect(await f.check('file-root-container-policy')).toBe('pass')
  f.file('/etc/systemd/system/mica.mount', '[Mount]\nOptions=bind\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/etc/systemd/system/mica.mount', '[Mount]\nOptions=bind,private\n')
  f.file('/etc/systemd/system/etc-containers-systemd.mount', '[Unit]\nRequiresMountsFor=/mnt/data/state\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
  f.file('/etc/systemd/system/etc-containers-systemd.mount', '[Unit]\nRequiresMountsFor=/mnt/data/state /mica/containers\n')
  f.file('/etc/systemd/system/mica-containers.mount', '[Mount]\nWhat=/mnt/data/var/containers\nWhere=/mica/containers\nOptions=bind,private,nosuid,nodev\n')
  expect(await f.check('file-root-container-policy')).toBe('fail')
})

const NATIVE_ENDPOINT_CHECK = 'file-root-native-endpoints'
const NATIVE_PATHS = ['/usr/bin/micad', '/usr/bin/mica-apid', '/usr/bin/mica-deploy']

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
  expect(result.message).toContain('scannedFiles=3')
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
  expect(message).toContain('scannedFiles=3')
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

test('native scan includes only the three current first-party inputs', async () => {
  const f = fixture(), bytes = nativeFiles(f)
  f.file('/usr/bin/third-party', nativeElf('https://updates.example/v1/manifest.json'))
  const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
  expect(result.verdict, result.message).toBe('pass')
  expect(result.message).toContain('scannedFiles=3')
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
  expect(result.message).toContain('scannedFiles=3')
})

const EMBEDDED_UI_NON_ENDPOINTS = [
  'https://react.i18next.com/latest/usetranslation-hook',
  'https://tailwindcss.com',
  'http://www.w3.org/2000/svg',
  'https://react.dev/errors/',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  'http://localhost',
  'https://base-ui.com/production-error',
]

test.each(EMBEDDED_UI_NON_ENDPOINTS)('exact embedded UI literal %s is not an update or fleet endpoint', async (literal) => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/mica-apid', nativeElf(literal))
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
})

test.each(EMBEDDED_UI_NON_ENDPOINTS)('an endpoint beside the exact UI literal %s is still refused', async (literal) => {
  const f = fixture(); nativeFiles(f)
  const neighbor = `${literal}${literal.endsWith('/') ? '' : '/'}updates`
  f.file('/usr/bin/mica-apid', nativeElf(`${literal}\0${neighbor}`))
  await expectNativeRefusal(f, '/usr/bin/mica-apid', 'endpoint')
})

test.each(EMBEDDED_UI_NON_ENDPOINTS.flatMap(literal => ['/usr/bin/micad', '/usr/bin/mica-deploy'].map(path => [literal, path])))('the exact UI literal %s is not exempt in %s', async (literal, path) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, nativeElf(literal))
  await expectNativeRefusal(f, path, 'endpoint')
})

test('invalid UTF-8 after a bare scheme is not a network authority', async () => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/micad', Buffer.concat([nativeElf(), Buffer.from('https://'), Buffer.from([0xc0, 0xc0, 0])]))
  expect(await f.check(NATIVE_ENDPOINT_CHECK)).toBe('pass')
  f.file('/usr/bin/micad', Buffer.concat([nativeElf(), Buffer.from('https://updates.example/v1/manifest.json'), Buffer.from([0xc0, 0])]))
  await expectNativeRefusal(f, '/usr/bin/micad', 'endpoint')
})

test('replacement characters cannot truncate an endpoint into an exact UI exemption', async () => {
  const f = fixture(); nativeFiles(f)
  f.file('/usr/bin/mica-apid', nativeElf('https://react.dev/errors/\ufffdupdates'))
  await expectNativeRefusal(f, '/usr/bin/mica-apid', 'endpoint')
  f.file('/usr/bin/mica-apid', Buffer.concat([nativeElf('http://localhost'), Buffer.from('http://localhost'), Buffer.from([0xff]), Buffer.from('/updates')]))
  await expectNativeRefusal(f, '/usr/bin/mica-apid', 'endpoint')
})

// Attested in the x86_64 and aarch64 release binaries of micad, mica-apid and
// mica-deploy (mica-core 20260914-1212): each message with each text that actually follows
// it there.
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
  ['/usr/bin/mica-apid', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'mid > len'],
  ['/usr/bin/mica-apid', 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', 'DBUS_SYSTEM_BUS_ADDRESSunix:path=/var/run/dbus/system_bus_socketDBUS_SESSION_BUS_ADDRESSXDG_RUNTIME_DIRcalled `Result::unwrap()` on an `Err` value'],
  ['/usr/bin/mica-apid', 'Invalid member name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-member', 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface'],
  ['/usr/bin/mica-apid', 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface', 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error'],
  ['/usr/bin/mica-apid', 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error', 'org.freedesktop.DBusInvalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/mica-apid', 'Invalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'BusName::UniqueBusName::WellKnownOwnedErrorNameOwnedUniqueNameInvalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'],
  ['/usr/bin/mica-apid', 'Invalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', 'mid > len'],
  ['/usr/bin/mica-apid', RUSTLS_EOF, 'internal error: entered unreachable code'],
  ['/usr/bin/mica-apid', RUSTLS_EOF, 'is not valid for any names (according to its subjectAltName extension)'],
  ['/usr/bin/mica-apid', 'Node.js ES modules are not directly supported, see https://docs.rs/getrandom#nodejs-es-module-support', 'Errorinternal_codedescriptionunknown_code\0'],
  ['/usr/bin/mica-deploy', CLAP_BUG, ''],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'a Display implementation returned an error unexpectedly'],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'falseTryFromIntErrora Display implementation returned an error unexpectedly'],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'internal error: entered unreachable code'],
  ['/usr/bin/mica-deploy', CLAP_BUG, 'generationbytessha256struct Artifact with 2 elements'],
  ['/usr/bin/mica-deploy', RUSTLS_EOF, 'internal error: entered unreachable code'],
]

test.each(NATIVE_DIAGNOSTIC_CASES)('exact diagnostic and attested adjacent text in %s remain non-endpoints: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  for (const payload of [message, `${message}${adjacent}`]) {
    f.file(path, nativeElf(payload))
    const result = await f.checkResult(NATIVE_ENDPOINT_CHECK)
    expect(result.verdict, result.message).toBe('pass')
    expect(result.message).toContain('scannedFiles=3')
  }
})

test.each(NATIVE_DIAGNOSTIC_CASES)('changing a diagnostic URL in %s is refused: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, nativeElf(`${message}/updates${adjacent}`))
  await expectNativeRefusal(f, path, 'endpoint')
})

test.each(NATIVE_DIAGNOSTIC_CASES)('an unknown adjacent suffix in %s cannot use a known diagnostic prefix: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, nativeElf(`${message}X${adjacent}`))
  await expectNativeRefusal(f, path, 'endpoint')
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

// A diagnostic is exempt only in the binaries attested to carry it, message and following text alike.
const WRONG_BINARY_CASES = NATIVE_DIAGNOSTIC_CASES.flatMap(([, message, adjacent]) => NATIVE_PATHS
  .filter(other => !NATIVE_DIAGNOSTIC_CASES.some(([p, m, a]) => p === other && m === message && a === adjacent))
  .map(other => [other, message, adjacent] as [string, string, string]))
test.each(WRONG_BINARY_CASES.filter(([o, m, a], i) => WRONG_BINARY_CASES.findIndex(([o2, m2, a2]) => o2 === o && m2 === m && a2 === a) === i))('a diagnostic in the wrong native binary %s is refused: %s', async (other, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  f.file(other, nativeElf(`${message}${adjacent}`))
  await expectNativeRefusal(f, other, 'endpoint')
})

test.each(['/usr/bin/micad', '/usr/bin/mica-apid'])('the exact D-Bus introspection DTD in %s is a namespace only', async (path) => {
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

test.each(NATIVE_DIAGNOSTIC_CASES.filter(([, , adjacent]) => adjacent.includes(' ')))('a truncated adjacent token cannot excuse a changed URL in %s: %s', async (path, message, adjacent) => {
  const f = fixture(); nativeFiles(f)
  f.file(path, nativeElf(`${message}${adjacent.split(' ')[0]}`))
  await expectNativeRefusal(f, path, 'endpoint')
})

// The SSH server ships disabled: micad enables dropbear.service at runtime after
// writing /run/mica/dropbear.env, and its host key is made on STATE at first start.
function dropbearRoot(f: ReturnType<typeof fixture>): void {
  f.file('/etc/systemd/system/dropbear.service', '[Service]\nEnvironmentFile=/run/mica/dropbear.env\n[Install]\nWantedBy=multi-user.target\n')
  f.file('/usr/lib/systemd/system-preset/50-mica-dropbear.preset', 'disable dropbear.service\n')
}

test('dropbear ships disabled by its preset, with no key, identity or arguments in the image', async () => {
  const f = fixture(); dropbearRoot(f)
  const result = await f.checkResult('file-root-dropbear-disabled')
  expect(result.verdict, result.message).toBe('pass')
})

test.each([
  ['an enablement link', (f: ReturnType<typeof fixture>) => {
    mkdirSync(join(f.root, 'etc/systemd/system/multi-user.target.wants'), { recursive: true })
    symlinkSync('/etc/systemd/system/dropbear.service', join(f.root, 'etc/systemd/system/multi-user.target.wants/dropbear.service'))
  }, 'enable'],
  ['no preset', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'usr/lib/systemd/system-preset/50-mica-dropbear.preset')), 'preset'],
  ['an earlier enable rule', (f: ReturnType<typeof fixture>) => f.file('/usr/lib/systemd/system-preset/10-enable.preset', 'enable *\n'), 'preset'],
  ['no unit', (f: ReturnType<typeof fixture>) => rmSync(join(f.root, 'etc/systemd/system/dropbear.service')), 'dropbear.service'],
  ['a dropbear host key', (f: ReturnType<typeof fixture>) => f.file('/etc/dropbear/dropbear_ed25519_host_key', 'key'), '/etc/dropbear/dropbear_ed25519_host_key'],
  ['an OpenSSH host key', (f: ReturnType<typeof fixture>) => f.file('/etc/ssh/ssh_host_ed25519_key', 'key'), '/etc/ssh/ssh_host_ed25519_key'],
  ['a STATE identity', (f: ReturnType<typeof fixture>) => f.file('/mnt/data/state/ssh/dropbear_ed25519_host_key', 'key'), '/mnt/data/state'],
  ['runtime arguments', (f: ReturnType<typeof fixture>) => f.file('/run/mica/dropbear.env', 'DROPBEAR_ARGS="-p 22"\n'), '/run/mica/dropbear.env'],
])('dropbear with %s is refused', async (_shape, mutate, reason) => {
  const f = fixture(); dropbearRoot(f)
  mutate(f)
  const result = await f.checkResult('file-root-dropbear-disabled')
  expect(result.verdict, result.message).toBe('fail')
  expect(result.message).toContain(reason)
})
