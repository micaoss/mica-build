import { partitionOf } from '../image/file-layout.ts'
import { SECRET_MIN_BYTES, secretBytes, SOURCES } from '../product/device-code.ts'
import { readFileSync, readdirSync } from 'node:fs'
import type { Board } from './board.ts'
import type { CheckCase } from './checks.ts'
import { ANY_UNITS, entry, linkTargetInRoot, packedRoot, pathInRoot, regularFileInRoot, wantsLink } from './checks-root.ts'
import { presetFor, wantsLinksNaming } from './unit-state.ts'
import { verdict } from './verdict.ts'

// Each required path with the product feature that ships it; none means the floor.
const REQUIRED_FEATURES: Record<string, readonly string[]> = { '/usr/bin/micad': ['micad'], '/usr/bin/mica-apid': ['micad'], '/usr/bin/mica-update': ['micad'] }
// Each required path of one init; none means either.
const REQUIRED_INIT: Record<string, 'systemd' | 'openrc'> = { '/usr/lib/systemd/systemd': 'systemd', '/usr/sbin/openrc-init': 'openrc' }
const required = ['/usr/lib/systemd/systemd', '/usr/sbin/openrc-init', '/usr/bin/micad', '/usr/bin/mica-apid', '/usr/bin/mica-update', '/usr/bin/mica-deploy',
  '/usr/lib/mica/mica-health', '/usr/lib/mica/mica-boot-failure', '/usr/lib/mica/mica-data-layout',
  '/usr/lib/mica/mica-seed-state', '/usr/lib/mica/mica-seed-var', '/usr/share/mica/manifest.tsv']

const META_ROOT = '/usr/share/mica/meta'
const DEVICE_CODE_CONF = '/usr/share/mica/device-code.conf'
const AP_SECRET = '/usr/share/mica/ap-secret'
const MANIFEST_PATH = `${META_ROOT}/updates/manifest.json`
const MARKER_PATH = `${META_ROOT}/GENERATED`
const PUBLIC_DEFAULTS_FACT = 'baked defaults contain no metadata anchors or private keys'

interface MetaProblem { readonly path: string, readonly reason: string }
interface MetaEvidence { readonly files: readonly string[], readonly bytes: number }

function problem(path: string, reason: string): MetaProblem {
  return { path, reason }
}

function publicMetaRefusal(issue: MetaProblem) {
  return verdict('file-root-public-defaults', false, `${PUBLIC_DEFAULTS_FACT}: ${issue.path}: ${issue.reason}`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keyPath(path: string, key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? `${path}.${key}` : `${path}.${JSON.stringify(key)}`
}

function exactObject(value: unknown, path: string, keys: readonly string[]): MetaProblem | undefined {
  if (!isObject(value)) return problem(path, 'must be an object')
  for (const key of keys)
    if (!Object.hasOwn(value, key)) return problem(keyPath(path, key), 'required key is missing')

  for (const key of Object.keys(value))
    if (!keys.includes(key)) return problem(keyPath(path, key), 'unknown key')

  return undefined
}

interface JsonFrame {
  readonly path: string
  readonly keys?: Set<string>
  key: string
  needsKey: boolean
  index: number
}

type JsonParseWithSource = (
  text: string,
  reviver: (this: unknown, key: string, value: unknown, context?: { readonly source?: string }) => unknown,
) => unknown

function duplicateMember(text: string): MetaProblem | undefined {
  // JSON.parse keeps only the last value, so track decoded object keys first.
  const stack: JsonFrame[] = []
  try {
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g)) {
      const token = match[0]
      const parent = stack.at(-1)
      if (token === '{' || token === '[') {
        const path = parent === undefined
          ? 'manifest'
          : parent.keys === undefined ? `${parent.path}[${parent.index}]` : keyPath(parent.path, parent.key)
        stack.push({ path, ...(token === '{' ? { keys: new Set<string>() } : {}), key: '', needsKey: true, index: 0 })
      }
      else if (token === '}' || token === ']') {
        stack.pop()
      }
      else if (token === ',' && parent !== undefined) {
        parent.needsKey = true
        parent.index += 1
      }
      else if (token.startsWith('"') && parent?.keys !== undefined && parent.needsKey) {
        const key = JSON.parse(token) as string
        if (parent.keys.has(key)) return problem(keyPath(parent.path, key), 'duplicate key')
        parent.keys.add(key)
        parent.key = key
        parent.needsKey = false
      }
    }
  }
  catch {
    return problem('document', 'invalid JSON')
  }
  return undefined
}

function validateManifest(bytes: Buffer): MetaProblem | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  }
  catch {
    return problem(MANIFEST_PATH, 'document has invalid UTF-8')
  }
  const duplicate = duplicateMember(text)
  if (duplicate !== undefined) return problem(MANIFEST_PATH, `${duplicate.path}: ${duplicate.reason}`)

  let intervalSource: string | undefined
  let document: unknown
  try {
    // The raw token retains the full u64 value that a JavaScript number cannot.
    const parseWithSource = JSON.parse as unknown as JsonParseWithSource
    document = parseWithSource(text, (key, value, context) => {
      if (key === 'checkIntervalMinutes' && typeof value === 'number') intervalSource = context?.source
      return value
    })
  }
  catch {
    return problem(MANIFEST_PATH, 'document is invalid JSON')
  }

  const rootProblem = exactObject(document, 'manifest', ['schema', 'product', 'update', 'http', 'fleet'])
  if (rootProblem !== undefined) return problem(MANIFEST_PATH, `${rootProblem.path}: ${rootProblem.reason}`)
  const root = document as Record<string, unknown>
  for (const issue of [
    exactObject(root.product, 'product', ['vendor', 'model']),
    exactObject(root.update, 'update', ['source', 'policy', 'checkIntervalMinutes']),
    exactObject(root.http, 'http', ['credentialHosts']),
    exactObject(root.fleet, 'fleet', ['enabled', 'url']),
  ])
    if (issue !== undefined) return problem(MANIFEST_PATH, `${issue.path}: ${issue.reason}`)

  const product = root.product as Record<string, unknown>
  const update = root.update as Record<string, unknown>
  const http = root.http as Record<string, unknown>
  const fleet = root.fleet as Record<string, unknown>
  if (root.schema !== 'mica/meta/v1') return problem(MANIFEST_PATH, 'schema: must equal mica/meta/v1')
  if (typeof product.vendor !== 'string') return problem(MANIFEST_PATH, 'product.vendor: must be a string')
  if (typeof product.model !== 'string') return problem(MANIFEST_PATH, 'product.model: must be a string')
  if (update.source !== null && typeof update.source !== 'string') return problem(MANIFEST_PATH, 'update.source: must be a string or null')
  if (!['off', 'check', 'auto'].includes(update.policy as string))
    return problem(MANIFEST_PATH, 'update.policy: must be one of off, check, or auto')

  if (typeof update.checkIntervalMinutes !== 'number' || intervalSource === undefined
    || !/^(0|[1-9][0-9]*)$/.test(intervalSource))
    return problem(MANIFEST_PATH, 'update.checkIntervalMinutes: must be a non-negative integer')

  if (BigInt(intervalSource) > 18446744073709551615n)
    return problem(MANIFEST_PATH, 'update.checkIntervalMinutes: must fit the unsigned 64-bit range')

  if (!Array.isArray(http.credentialHosts)) return problem(MANIFEST_PATH, 'http.credentialHosts: must be an array')
  for (let index = 0; index < http.credentialHosts.length; index += 1) {
    if (typeof http.credentialHosts[index] !== 'string')
      return problem(MANIFEST_PATH, `http.credentialHosts[${index}]: must be a string`)
  }
  if (typeof fleet.enabled !== 'boolean') return problem(MANIFEST_PATH, 'fleet.enabled: must be a boolean')
  if (fleet.url !== null && typeof fleet.url !== 'string') return problem(MANIFEST_PATH, 'fleet.url: must be a string or null')
  return undefined
}

function inspectPublicMeta(root: string): MetaProblem | MetaEvidence {
  if (entry(root, '/')?.isDirectory() !== true) throw new Error(`${root} is not an actual unpacked-image directory`)
  const meta = entry(root, META_ROOT)
  if (meta === undefined) throw new Error(`${META_ROOT} is missing from the unpacked image, so no public metadata was scanned`)
  if (!meta.isDirectory()) return problem(META_ROOT, 'must be a regular non-symlink directory')

  const directory = pathInRoot(root, META_ROOT, false)
  let top: string[]
  try {
    top = readdirSync(directory).sort()
  }
  catch {
    return problem(META_ROOT, 'cannot read the required directory')
  }
  for (const name of top)
    if (name !== 'updates' && name !== 'GENERATED') return problem(`${META_ROOT}/${name}`, 'unexpected entry')

  if (entry(root, `${META_ROOT}/updates`)?.isDirectory() !== true)
    return problem(`${META_ROOT}/updates`, 'must be a regular non-symlink directory')

  let updates: string[]
  try {
    updates = readdirSync(pathInRoot(root, `${META_ROOT}/updates`, false)).sort()
  }
  catch {
    return problem(`${META_ROOT}/updates`, 'cannot read the required directory')
  }
  for (const name of updates)
    if (name !== 'manifest.json') return problem(`${META_ROOT}/updates/${name}`, 'unexpected entry')

  const manifest = entry(root, MANIFEST_PATH)
  if (manifest?.isFile() !== true) return problem(MANIFEST_PATH, 'must be a regular non-symlink file')
  if (manifest.size === 0) return problem(MANIFEST_PATH, 'required file is empty')

  const marker = entry(root, MARKER_PATH)
  if (marker !== undefined && !marker.isFile()) return problem(MARKER_PATH, 'must be a regular non-symlink file')
  const paths = marker === undefined ? [MANIFEST_PATH] : [MANIFEST_PATH, MARKER_PATH]
  const files: Array<readonly [string, Buffer]> = []
  for (const path of paths) {
    try {
      files.push([path, readFileSync(pathInRoot(root, path, false))])
    }
    catch {
      return problem(path, 'cannot read the regular file')
    }
  }
  for (const [path, bytes] of files) {
    if (/BEGIN [^\r\n]*PRIVATE KEY|"privateKey"|"private_key"/.test(bytes.toString('latin1')))
      return problem(path, 'contains private key material')
  }
  const manifestProblem = validateManifest(files[0]![1])
  if (manifestProblem !== undefined) return manifestProblem

  const byteCount = files.reduce((total, file) => total + file[1].byteLength, 0)
  if (files.length === 0 || byteCount === 0) throw new Error(`${META_ROOT} scan was empty and cannot establish public metadata safety`)
  return { files: paths, bytes: byteCount }
}

// The diagnostics a binary carries, each whole: the sentence and the documentation URL it ends in. A literal
// that starts with the URL right after its sentence names no network location of its own as long as what follows
// the URL in the same literal is not another URL (the build lays other strings out there, which differ by build
// and architecture). Each URL has a path, so nothing laid out after it can change its host.
const DBUS_DIAGNOSTICS: readonly string[] = [
  'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses',
  'Invalid member name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-member',
  'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error',
  'Invalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus',
  'Invalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus',
]

const RUSTLS_EOF = 'peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof'

// mica-apid is micad under another name: /usr/bin/mica-apid is a link to micad, so
// the one executable carries both daemons' diagnostics.
const NATIVE_DIAGNOSTICS: Readonly<Record<string, readonly string[]>> = {
  '/usr/bin/micad': [
    ...DBUS_DIAGNOSTICS,
    'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface',
    'Invalid well-known name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus',
    RUSTLS_EOF,
    'Node.js ES modules are not directly supported, see https://docs.rs/getrandom#nodejs-es-module-support',
  ],
  '/usr/bin/mica-deploy': [
    'Fatal internal error. Please consider filing a bug report at https://github.com/clap-rs/clap/issues',
    RUSTLS_EOF,
  ],
}

// Complete D-Bus namespaces, scoped by binary; the console is files of mica-apid-ui, not part of a binary.
const NATIVE_NON_ENDPOINTS: Readonly<Record<string, ReadonlySet<string>>> = {
  '/usr/bin/micad': new Set([
    'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd',
    // A reserved name (RFC 2606): the placeholder URI of the HTTP stack, never dialled.
    'http://invalid',
  ]),
}

// The DATA line the board package renders into fstab (common/board/render.sh): a gpt board's DATA partition, grown
// and checked, and a ubi board's UBI volume data, which nothing grows or checks.
const dataLine = (board: Board) => board.layout === undefined
  ? 'ubi0:data /mnt/data ubifs noatime 0 0'
  : `PARTUUID=${partitionOf(board.layout, 'data').guid} /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2`

// The HTTP stack's scheme and version strings, laid out together, which the pattern reads with whatever follows
// them as one literal whose authority is `HTTP`: the same rule as a diagnostic's URL.
const HTTP_VERSIONS = 'https://HTTP/0.9HTTP/1.0HTTP/1.1HTTP/2.0HTTP/3.0'

/** Whether `literal` is `url` followed by nothing that is another URL. */
const urlThenNoUrl = (literal: string, url: string) => literal.startsWith(url) && !literal.slice(url.length).includes('://')

export const ROOT_CHECKS: readonly CheckCase[] = [
  ...required.map(path => ({ id: `file-root-required:${path}`, ...(REQUIRED_FEATURES[path] ? { features: REQUIRED_FEATURES[path] } : {}), ...(REQUIRED_INIT[path] ? { init: REQUIRED_INIT[path] } : {}), shell: { pass: `required ${path}` },
    run: async ctx => [verdict(`file-root-required:${path}`, regularFileInRoot(await packedRoot(ctx), path), `required ${path}`)] } satisfies CheckCase)),
  {
    id: 'file-root-is-component', shell: { pass: 'root owns only user space' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const forbidden = ['/usr/bin/rauc', '/usr/bin/rauc-update', '/usr/bin/rauc-verify', '/etc/rauc', '/usr/bin/grub-editenv', '/usr/bin/fw_printenv', '/usr/bin/fw_setenv', '/etc/fw_env.config']
      const empty = ['/usr/lib/modules', '/usr/lib/firmware', '/boot'].every((path) => {
        const st = entry(root, path)
        return st === undefined || (st.isDirectory() && readdirSync(pathInRoot(root, path)).length === 0)
      })
      return [verdict('file-root-is-component', empty && forbidden.every(p => entry(root, p) === undefined), 'root owns only user space')]
    },
  },
  {
    id: 'file-root-data-policy', init: 'systemd', shell: { pass: 'DATA owns bounded writable var and protected state' },
    run: async (ctx) => {
      const root = await packedRoot(ctx), read = (p: string) => readFileSync(pathInRoot(root, p), 'utf8')
      const lines = read('/etc/fstab').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/))
      const obsolete = ['var-lib', 'var-cache', 'var-log', 'var-tmp', 'var-lib-systemd-timesync',
        'var-lib-systemd-network', 'var-lib-systemd-timers', 'var-lib-systemd-linger']
        .some(name => entry(root, `/etc/systemd/system/${name}.mount`) !== undefined)
      const binds = ['var-lib-mica', 'usr-local-lib-systemd-system']
      const varUnit = entry(root, '/etc/systemd/system/var.mount')?.isFile()
        ? read('/etc/systemd/system/var.mount')
        : ''
      const ok = lines.length === 2 && lines.some(l => l.join(' ') === dataLine(ctx.board))
        && lines.some(l => l[0] === 'tmpfs' && l[1] === '/tmp' && l[3]?.includes('size=128M') && l[3]?.includes('nr_inodes=32768'))
        && !obsolete && /^What=\/mnt\/data\/var$/m.test(varUnit) && /^Where=\/var$/m.test(varUnit)
        && /^Options=bind,private,nosuid,nodev$/m.test(varUnit)
        && regularFileInRoot(root, '/etc/systemd/system/mica-seed-var.service')
        && binds.every(name => /^What=\/mnt\/data\/state\//m.test(read(`/etc/systemd/system/${name}.mount`)))
      return [verdict('file-root-data-policy', ok, 'DATA owns bounded writable var and protected state')]
    },
  },
  {
    id: 'file-root-data-policy-openrc', init: 'openrc', shell: { pass: 'DATA is mounted, grown where its board grows it, and bound over var by mica-openrc' },
    run: async (ctx) => {
      const root = await packedRoot(ctx), read = (p: string) => (regularFileInRoot(root, p) ? readFileSync(pathInRoot(root, p), 'utf8') : '')
      const lines = read('/etc/fstab').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/))
      const layout = read('/etc/conf.d/mica-data-layout')
      const mounts = read('/etc/init.d/mica-mounts')
      const ok = lines.length === 2 && lines.some(l => l.join(' ') === dataLine(ctx.board))
        && lines.some(l => l[0] === 'tmpfs' && l[1] === '/tmp' && l[3]?.includes('size=128M') && l[3]?.includes('nr_inodes=32768'))
        && (ctx.board.layout === undefined
          ? layout === ''
          : layout.includes(`grow_system_uuid=${partitionOf(ctx.board.layout, 'system').guid}\n`) && layout.includes(`grow_disk_uuid=${ctx.board.layout.diskGuid}\n`))
        && mounts.includes('bind /mnt/data/var /var nosuid,nodev') && mounts.includes('bind /mnt/data/state/mica /var/lib/mica')
        && ['mica-data-layout', 'mica-mounts'].every(s => linkTargetInRoot(root, `/etc/runlevels/boot/${s}`) === `/etc/init.d/${s}`)
      return [verdict('file-root-data-policy-openrc', ok, 'DATA is mounted, grown where its board grows it, and bound over var by mica-openrc')]
    },
  },
  {
    id: 'file-root-container-policy', features: ['containers'], shell: { pass: 'container storage uses an independent DATA bind' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const read = (p: string) => regularFileInRoot(root, p) ? readFileSync(pathInRoot(root, p), 'utf8') : ''
      const storage = read('/etc/containers/storage.conf')
      const network = read('/etc/containers/containers.conf')
      // The bind of DATA's containers directory, and the engine started only once it is there: systemd's mount
      // units and the RequiresMountsFor of mica-containerd (dockerd on docker), or OpenRC's mica-mounts and the
      // script's need. A docker product's storage is daemon.json's (checks-engine.ts docker-engine-data-root-on-data).
      const docker = ctx.product.engine === 'docker'
      let bound: boolean
      if (ctx.product.init === 'openrc') {
        const mounts = read('/etc/init.d/mica-mounts')
        bound = mounts.includes('bind /mnt/data/containers /mica/containers nosuid,nodev')
          && /^\s*need .*\bmica-mounts\b/m.test(read(docker ? '/etc/init.d/docker' : '/etc/init.d/mica-containerd'))
      }
      else {
        const unit = read('/etc/systemd/system/mica-containers.mount')
        const parent = read('/etc/systemd/system/mica.mount')
        bound = /^What=\/mnt\/data\/containers$/m.test(unit) && /^Where=\/mica\/containers$/m.test(unit)
          && /^Options=bind,private,nosuid,nodev$/m.test(unit)
          && /^Options=bind,private$/m.test(parent)
          && /^Requires=.*\bmica-data-layout\.service\b.*\bmica\.mount$/m.test(unit)
          && /^After=.*\bmica-data-layout\.service\b.*\bmica\.mount$/m.test(unit)
          && wantsLink(root, ANY_UNITS, 'mica-containers.mount') !== undefined
          && /^RequiresMountsFor=.*\/mica\/containers(?: |$)/m.test(read(docker ? '/usr/lib/systemd/system/docker.service' : '/usr/lib/systemd/system/mica-containerd.service'))
      }
      const podmanStorage = /^graphroot = "\/mica\/containers\/storage"$/m.test(storage)
        && /^runroot = "\/run\/containers\/storage"$/m.test(storage)
        && /^image_copy_tmp_dir = "\/mica\/containers\/tmp"$/m.test(network)
        && /^network_config_dir = "\/mica\/containers\/networks"$/m.test(network)
      const ok = bound && (docker || podmanStorage)
      return [verdict('file-root-container-policy', ok, 'container storage uses an independent DATA bind')]
    },
  },
  {
    id: 'file-root-identity', shell: { pass: 'machine identity is created on DATA before services' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const id = entry(root, '/etc/machine-id')
      return [verdict('file-root-identity', id?.isFile() === true && id.size === 0
        && pathInRoot(root, '/var/lib/dbus/machine-id') === pathInRoot(root, '/etc/machine-id')
        && (ctx.product.init !== 'systemd' || linkTargetInRoot(root, '/var/lib/systemd/random-seed') === '/mnt/data/state/random-seed')
        && entry(root, '/usr/lib/systemd/system/mica-machine-id.service') === undefined, 'machine identity is created on DATA before services')]
    },
  },
  {
    // /etc/hosts is the Base's link to /run/mica/hosts (the root is read-only, micad rewrites the file), written at
    // every boot by mica-hosts: mica-hosts.service under systemd, mica-mounts under OpenRC.
    id: 'file-root-hosts', shell: { pass: '/etc/hosts links to /run/mica/hosts, written at boot by mica-hosts' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const read = (p: string) => regularFileInRoot(root, p) ? readFileSync(pathInRoot(root, p), 'utf8') : ''
      const written = ctx.product.init === 'openrc'
        ? read('/etc/init.d/mica-mounts').includes('/usr/lib/mica/mica-hosts')
        : /^ExecStart=\/usr\/lib\/mica\/mica-hosts$/m.test(read('/etc/systemd/system/mica-hosts.service'))
          && wantsLink(root, ANY_UNITS, 'mica-hosts.service') !== undefined
      return [verdict('file-root-hosts', linkTargetInRoot(root, '/etc/hosts') === '../run/mica/hosts'
        && regularFileInRoot(root, '/usr/lib/mica/mica-hosts') && written, '/etc/hosts links to /run/mica/hosts, written at boot by mica-hosts')]
    },
  },
  {
    // The one source micad reads the device code from (src/product/device-code.ts), which the label prints.
    id: 'file-root-device-code', shell: { pass: `${DEVICE_CODE_CONF} names the source of the device code` },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const text = regularFileInRoot(root, DEVICE_CODE_CONF) ? readFileSync(pathInRoot(root, DEVICE_CODE_CONF), 'utf8') : undefined
      const source = /^source=([a-z-]+)\n$/.exec(text ?? '')?.[1] ?? ''
      return [(SOURCES as readonly string[]).includes(source)
        ? verdict('file-root-device-code', true, `${DEVICE_CODE_CONF} names the source of the device code: ${source}`)
        : verdict('file-root-device-code', false, text === undefined
            ? `${DEVICE_CODE_CONF} is not a regular file in the image; micad reads no device code, so the label matches nothing`
            : `${DEVICE_CODE_CONF} is not one line source=<${SOURCES.join('|')}>: ${JSON.stringify(text.slice(0, 80))}`)]
    },
  },
  {
    // The product secret the factory access-point key is derived under: present, root's alone, long enough for micad
    // to use. On a factory image the mode and owner are the ones squashfs carries, as factory-shadow-mode reads them.
    id: 'file-root-ap-secret', features: ['wifi'], shell: { pass: 'is the product\'s access-point secret, 0600 root:root' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const fail = (reason: string) => [verdict('file-root-ap-secret', false, `${AP_SECRET} ${reason}; micad derives no factory access-point key and falls back to a random one the label does not show`)]
      const st = entry(root, AP_SECRET)
      if (st === undefined || !st.isFile()) return fail('is not a regular file in the image')
      let mode = (st.mode & 0o7777).toString(8), owner = `${st.uid}:${st.gid}`
      if (ctx.packedRootfs !== undefined) {
        const listing = await ctx.tools.run(['unsquashfs', '-lln', ctx.packedRootfs, AP_SECRET.slice(1)], { context: `reading packed metadata for ${AP_SECRET}` })
        const match = /^(-[rwxSt-]{9})\s+(\d+)\/(\d+)\s+/.exec(listing.stdout.split('\n').find(l => l.endsWith(`squashfs-root${AP_SECRET}`)) ?? '')
        mode = match?.[1] === '-rw-------' ? '600' : (match?.[1] ?? 'none')
        owner = match === null ? 'none' : `${match[2]}:${match[3]}`
      }
      if (mode !== '600' || owner !== '0:0') return fail(`is mode ${mode} owner ${owner}, expected 600 and 0:0`)
      try { secretBytes(readFileSync(pathInRoot(root, AP_SECRET)), AP_SECRET) }
      catch { return fail(`holds fewer than ${SECRET_MIN_BYTES} bytes`) }
      return [verdict('file-root-ap-secret', true, `${AP_SECRET} is the product's access-point secret, 0600 root:root`)]
    },
  },
  {
    id: 'file-root-health', shell: { pass: 'native health confirmation and failure handling are enabled' },
    run: async (ctx) => {
      const root = await packedRoot(ctx), read = (p: string) => readFileSync(pathInRoot(root, p), 'utf8')
      // Under OpenRC the gate is mica-openrc's mica-health, last in the default runlevel, running the failure itself.
      const gate = ctx.product.init === 'openrc'
        ? linkTargetInRoot(root, '/etc/runlevels/default/mica-health') === '/etc/init.d/mica-health'
        && read('/etc/init.d/mica-health').includes('/usr/lib/mica/mica-boot-failure')
        : wantsLink(root, ANY_UNITS, 'mica-health.service') !== undefined
          && read('/usr/lib/systemd/system/mica-health.service').includes('OnFailure=mica-boot-failure.service')
      return [verdict('file-root-health', gate
        && read('/usr/lib/mica/mica-health').includes('mica-deploy confirm')
        && read('/usr/lib/mica/mica-boot-failure').includes('mica-deploy fail-boot'), 'native health confirmation and failure handling are enabled')]
    },
  },
  {
    // The gate fails a boot over a command it cannot find (`have X || fail`), and that is a fact about the
    // composed root, so it is checked here rather than found by a reboot loop on a device: core 0.0.5 dropped
    // /usr/bin/mica-apid while Base's gate still probed it. A probe inside `if requires <member>` binds only
    // when /etc/mica/health.conf requires that member, or names it `if-installed=`: whether the component is installed
    // is a fact about the device (micad comes with the core set), so the root must carry its probe either way. One the
    // gate tolerates (`|| return 0`) binds nothing.
    id: 'file-root-health-commands', shell: { pass: 'every command the health gate requires is in the root' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const read = (p: string) => {
        try {
          return readFileSync(pathInRoot(root, p), 'utf8')
        }
        catch {
          return ''
        }
      }
      const required = new Set(read('/etc/mica/health.conf').split('\n').flatMap(l => /^(?:require|if-installed)=(\S+)$/.exec(l.trim())?.slice(1) ?? []))
      const lines = read('/usr/lib/mica/mica-health').split('\n'), needed = new Map<string, string>()
      let member: string | undefined
      for (const [i, line] of lines.entries()) {
        const block = /^if requires (\S+); then$/.exec(line)
        if (block) { member = block[1]; continue }
        if (/^fi\b/.test(line)) { member = undefined; continue }
        const probe = /\bhave ([A-Za-z0-9._+-]+)\s*\|\|\s*(.*)$/.exec(line)
        if (!probe) continue
        const consequence = (probe[2] || lines.slice(i + 1).find(l => l.trim() !== '') || '').trim()
        if (consequence.startsWith('fail') && (member === undefined || required.has(member))) needed.set(probe[1]!, member === undefined ? 'always' : `member ${member}`)
      }
      if (needed.size === 0) return [verdict('file-root-health-commands', false, '/usr/lib/mica/mica-health requires no command, so this check would pass over a gate it never read')]
      const dirs = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']
      const missing = [...needed].filter(([cmd]) => !dirs.some(d => regularFileInRoot(root, `${d}/${cmd}`)))
      return [verdict('file-root-health-commands', missing.length === 0, missing.length === 0
        ? `every command the health gate requires is in the root: ${[...needed.keys()].sort().join(', ')}`
        : `the health gate fails every boot: not on the root's PATH: ${missing.map(([cmd, why]) => `${cmd} (${why})`).join(', ')}`)]
    },
  },
  {
    // One SSH server per root, the product's SSH_SERVER's: mica-ssh (dropbear) or mica-openssh (OpenSSH), which
    // conflict with each other; a product without ssh carries neither.
    id: 'file-root-ssh-package', shell: { pass: 'the SSH server package is the product\'s' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const inventory = regularFileInRoot(root, '/usr/share/mica/manifest.tsv') ? readFileSync(pathInRoot(root, '/usr/share/mica/manifest.tsv'), 'utf8') : ''
      const installed = ['mica-ssh', 'mica-openssh'].filter(p => inventory.split('\n').some(l => l.split('\t')[0] === p))
      const want = ctx.product.ssh === '' ? [] : [ctx.product.ssh === 'openssh' ? 'mica-openssh' : 'mica-ssh']
      const ok = installed.join(' ') === want.join(' ')
      return [verdict('file-root-ssh-package', ok, ok
        ? `the SSH server package is the product's: ${want.join('') || 'none, the product has no ssh'}`
        : `the SSH server packages installed are ${installed.join(' ') || 'none'}, and the product (SSH_SERVER=${ctx.product.ssh || '<no ssh>'}) takes ${want.join('') || 'none'}`)]
    },
  },
  {
    // The init starts the SSH server at boot as micad last configured it, so SSH does not wait for micad: micad writes
    // /var/lib/mica/ssh/sshd.env on DATA, and mica-sshd.service, enabled in the image, skips its start unless that file
    // says SSH_ENABLED=yes; under OpenRC mica-sshd-boot, in the default runlevel, starts mica-sshd the same way. The host
    // key is made on STATE at the first start. So the image carries the boot path, and no key, identity or arguments a
    // whole fleet would share. dropbear.service, mica-ssh's same server under its former name, stays disabled.
    id: 'file-root-ssh-boot', shell: { pass: 'the SSH server starts at boot as configured, with no host key or arguments' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      const fail = (reason: string) => [verdict('file-root-ssh-boot', false, reason)]
      if (!ctx.product.features.has('ssh')) return [verdict('file-root-ssh-boot', true, 'the SSH server starts at boot as configured, with no host key or arguments: the product has no ssh')]
      if (ctx.product.init === 'openrc') {
        if (!regularFileInRoot(root, '/etc/init.d/mica-sshd')) return fail('/etc/init.d/mica-sshd is not in the image')
        if (linkTargetInRoot(root, '/etc/runlevels/default/mica-sshd-boot') !== '/etc/init.d/mica-sshd-boot' || !regularFileInRoot(root, '/etc/init.d/mica-sshd-boot'))
          return fail('mica-sshd-boot is not in the default runlevel; SSH would wait for micad')
        const runlevels = entry(root, '/etc/runlevels')?.isDirectory() === true ? readdirSync(pathInRoot(root, '/etc/runlevels')) : []
        const linked = runlevels.filter(level => entry(root, `/etc/runlevels/${level}/mica-sshd`) !== undefined)
        if (linked.length > 0) return fail(`mica-sshd is in the ${linked.join(' ')} runlevel(s); SSH turned off would fail its start at every boot`)
      }
      else {
        const unit = '/etc/systemd/system/mica-sshd.service'
        if (!regularFileInRoot(root, unit)) return fail(`${unit} is not in the image`)
        if (!readFileSync(pathInRoot(root, unit), 'utf8').split('\n').some(l => l.startsWith('ExecCondition=') && l.includes('SSH_ENABLED')))
          return fail(`${unit} has no ExecCondition on SSH_ENABLED; it would start at boot with SSH turned off`)
        if (!wantsLinksNaming(root, 'mica-sshd.service').includes('/etc/systemd/system/multi-user.target.wants/mica-sshd.service'))
          return fail('mica-sshd.service is not enabled in the image; SSH would wait for micad')
        const rule = presetFor(root, 'mica-sshd.service')
        if (rule?.verb !== 'enable') return fail(rule === undefined ? 'no preset rule matches mica-sshd.service' : `the first preset rule for mica-sshd.service is '${rule.verb} ${rule.pattern}' in ${rule.file}`)
        if (ctx.product.ssh === 'dropbear') {
          if (!regularFileInRoot(root, '/etc/systemd/system/dropbear.service')) return fail('/etc/systemd/system/dropbear.service is not in the image')
          const links = wantsLinksNaming(root, 'dropbear.service')
          if (links.length > 0) return fail(`${links.join(' ')} enable(s) dropbear.service, a second server on the same port`)
          const old = presetFor(root, 'dropbear.service')
          if (old?.verb !== 'disable') return fail(old === undefined ? 'no preset rule matches dropbear.service, and an unmatched unit presets to enable' : `the first preset rule for dropbear.service is '${old.verb} ${old.pattern}' in ${old.file}`)
        }
      }
      const keys = ['/etc/dropbear', '/etc/ssh'].flatMap((dir) => {
        if (entry(root, dir)?.isDirectory() !== true) return []
        return readdirSync(pathInRoot(root, dir)).filter(name => /host_key|^ssh_host_/.test(name)).map(name => `${dir}/${name}`)
      })
      if (keys.length > 0) return fail(`${keys.join(' ')}: a host key in a signed root is one private key the whole fleet shares`)
      for (const path of ['/mnt/data/state', '/var/lib/mica/ssh', '/run/mica/dropbear.env'])
        if (entry(root, path) !== undefined) return fail(`${path} is in the image; the device identity and the SSH server's arguments exist only at runtime`)

      return [verdict('file-root-ssh-boot', true, `the SSH server starts at boot as configured, with no host key or arguments: ${ctx.product.ssh}`)]
    },
  },
  {
    id: 'file-root-public-defaults', shell: { pass: 'baked defaults contain no metadata anchors or private keys' },
    run: async (ctx) => {
      const result = inspectPublicMeta(await packedRoot(ctx))
      if ('reason' in result) return [publicMetaRefusal(result)]
      return [verdict('file-root-public-defaults', true,
        `${PUBLIC_DEFAULTS_FACT}; scannedFiles=${result.files.length}; scannedBytes=${result.bytes}; examinedPaths=${result.files.join(',')}`)]
    },
  },
  {
    id: 'file-root-native-endpoints', shell: { pass: 'native binaries contain no default update or fleet endpoints' },
    run: async (ctx) => {
      const root = await packedRoot(ctx)
      if (entry(root, '/')?.isDirectory() !== true) throw new Error(`${root} is not an actual unpacked-image directory`)
      // The native binaries the product ships: micad (apid is its link) with the micad feature, mica-deploy always.
      const paths = ['/usr/bin/micad', '/usr/bin/mica-deploy'].filter(p => (REQUIRED_FEATURES[p] ?? []).every(f => ctx.product.features.has(f)))
      const examined: string[] = [], endpoints: string[] = []
      let byteCount = 0
      const result = (ok: boolean, reason: string) => [verdict('file-root-native-endpoints', ok,
        `${reason}; scannedFiles=${examined.length}; scannedBytes=${byteCount}; examinedPaths=${examined.join(',')}`)]
      for (const parent of ['/usr', '/usr/bin']) {
        const directory = entry(root, parent)
        if (directory === undefined) return result(false, `/usr/bin/micad: required directory ${parent} is missing`)
        if (!directory.isDirectory()) return result(false, `/usr/bin/micad: ${parent} must be a regular non-symlink directory`)
      }
      for (const path of paths) {
        const file = entry(root, path)
        if (file === undefined) return result(false, `${path}: required native input is missing`)
        if (!file.isFile()) return result(false, `${path}: must be a regular non-symlink file`)
        if (file.size === 0) return result(false, `${path}: required native input is empty`)
        let bytes: Buffer
        try {
          bytes = readFileSync(pathInRoot(root, path, false))
        }
        catch {
          return result(false, `${path}: cannot read the regular file`)
        }
        // Identify a complete ELF executable header before counting bytes as scanned.
        const headerSize = bytes[4] === 2 ? 64 : 52
        if (bytes.length < headerSize || bytes.readUInt32BE(0) !== 0x7f454c46
          || (bytes[4] !== 1 && bytes[4] !== 2) || (bytes[5] !== 1 && bytes[5] !== 2) || bytes[6] !== 1)
          return result(false, `${path}: must contain a complete ELF executable header`)

        const word = (offset: number) => bytes[5] === 1 ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset)
        const version = bytes[5] === 1 ? bytes.readUInt32LE(20) : bytes.readUInt32BE(20)
        if ((word(16) !== 2 && word(16) !== 3) || version !== 1 || word(headerSize === 64 ? 52 : 40) !== headerSize)
          return result(false, `${path}: must contain a complete ELF executable header`)

        examined.push(path)
        byteCount += bytes.byteLength
        // Invalid UTF-8 cannot start an authority. Keep later replacement characters
        // in the candidate so a suffix cannot be truncated into an exact exemption.
        const text = bytes.toString('utf8')
        const literals = text.matchAll(/(?:https?|wss?|mqtts?):\/\/[^\x00-\x20\x7f"'<>`{}\\/\ufffd][^\x00-\x20\x7f"'<>`{}\\]*/gi)
        for (const literal of literals) {
          if (NATIVE_NON_ENDPOINTS[path]?.has(literal[0])) continue
          if (path === '/usr/bin/micad' && urlThenNoUrl(literal[0], HTTP_VERSIONS)) continue
          const diagnostic = NATIVE_DIAGNOSTICS[path]?.some((source) => {
            const offset = source.indexOf('https://')
            return literal.index >= offset && text.slice(literal.index - offset, literal.index) === source.slice(0, offset)
              && urlThenNoUrl(literal[0], source.slice(offset))
          })
          if (!diagnostic) {
            endpoints.push(path)
            break
          }
        }
      }
      if (endpoints.length !== 0) return result(false, `${endpoints.join(',')}: contains a compiled network endpoint literal`)
      for (const link of ['/usr/bin/mica-apid', '/usr/bin/mica-update']) {
        if (paths.includes('/usr/bin/micad') && linkTargetInRoot(root, link) !== 'micad')
          return result(false, `${link}: must be a link to micad, the one management executable`)
      }
      return result(true, 'native binaries contain no default update or fleet endpoints')
    },
  },
]
