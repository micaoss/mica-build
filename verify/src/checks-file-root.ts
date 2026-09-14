import { readFileSync, readdirSync } from 'node:fs'
import type { CheckCase } from './checks.ts'
import { ANY_UNITS, entry, linkTargetInRoot, packedRoot, pathInRoot, regularFileInRoot, wantsLink } from './checks-root.ts'
import { presetFor, wantsLinksNaming } from './unit-state.ts'
import { verdict } from './verdict.ts'

// Each required path with the product feature that ships it; none means the floor.
const REQUIRED_FEATURES: Record<string, readonly string[]> = { '/usr/bin/micad': ['micad'], '/usr/bin/apid': ['micad'] }
const required = ['/usr/lib/systemd/systemd', '/usr/bin/micad', '/usr/bin/apid', '/usr/bin/mica-deploy',
  '/usr/lib/mica/mica-health', '/usr/lib/mica/mica-boot-failure', '/usr/lib/mica/mica-data-layout',
  '/usr/lib/mica/mica-seed-state', '/usr/lib/mica/mica-seed-var', '/usr/share/mica/manifest.tsv', '/usr/share/mica/release-identity.env']

const META_ROOT = '/usr/share/mica/meta'
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
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return problem(keyPath(path, key), 'required key is missing')
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return problem(keyPath(path, key), 'unknown key')
  }
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
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
      const token = match[0]
      const parent = stack.at(-1)
      if (token === '{' || token === '[') {
        const path = parent === undefined ? 'manifest'
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
    exactObject(root.update, 'update', ['source', 'channel', 'policy', 'checkIntervalMinutes']),
    exactObject(root.http, 'http', ['credentialHosts']),
    exactObject(root.fleet, 'fleet', ['enabled', 'url']),
  ]) {
    if (issue !== undefined) return problem(MANIFEST_PATH, `${issue.path}: ${issue.reason}`)
  }

  const product = root.product as Record<string, unknown>
  const update = root.update as Record<string, unknown>
  const http = root.http as Record<string, unknown>
  const fleet = root.fleet as Record<string, unknown>
  if (root.schema !== 'mica/meta/v1') return problem(MANIFEST_PATH, 'schema: must equal mica/meta/v1')
  if (typeof product.vendor !== 'string') return problem(MANIFEST_PATH, 'product.vendor: must be a string')
  if (typeof product.model !== 'string') return problem(MANIFEST_PATH, 'product.model: must be a string')
  if (update.source !== null && typeof update.source !== 'string') return problem(MANIFEST_PATH, 'update.source: must be a string or null')
  if (typeof update.channel !== 'string') return problem(MANIFEST_PATH, 'update.channel: must be a string')
  if (update.channel.trim() === '') return problem(MANIFEST_PATH, 'update.channel: must not be empty')
  if (!['off', 'check', 'auto'].includes(update.policy as string)) {
    return problem(MANIFEST_PATH, 'update.policy: must be one of off, check, or auto')
  }
  if (typeof update.checkIntervalMinutes !== 'number' || intervalSource === undefined
    || !/^(0|[1-9][0-9]*)$/.test(intervalSource)) {
    return problem(MANIFEST_PATH, 'update.checkIntervalMinutes: must be a non-negative integer')
  }
  if (BigInt(intervalSource) > 18446744073709551615n) {
    return problem(MANIFEST_PATH, 'update.checkIntervalMinutes: must fit the unsigned 64-bit range')
  }
  if (!Array.isArray(http.credentialHosts)) return problem(MANIFEST_PATH, 'http.credentialHosts: must be an array')
  for (let index = 0; index < http.credentialHosts.length; index += 1) {
    if (typeof http.credentialHosts[index] !== 'string') {
      return problem(MANIFEST_PATH, `http.credentialHosts[${index}]: must be a string`)
    }
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
  for (const name of top) {
    if (name !== 'updates' && name !== 'GENERATED') return problem(`${META_ROOT}/${name}`, 'unexpected entry')
  }

  if (entry(root, `${META_ROOT}/updates`)?.isDirectory() !== true) {
    return problem(`${META_ROOT}/updates`, 'must be a regular non-symlink directory')
  }
  let updates: string[]
  try {
    updates = readdirSync(pathInRoot(root, `${META_ROOT}/updates`, false)).sort()
  }
  catch {
    return problem(`${META_ROOT}/updates`, 'cannot read the required directory')
  }
  for (const name of updates) {
    if (name !== 'manifest.json') return problem(`${META_ROOT}/updates/${name}`, 'unexpected entry')
  }
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
    if (/BEGIN [^\r\n]*PRIVATE KEY|"privateKey"|"private_key"/.test(bytes.toString('latin1'))) {
      return problem(path, 'contains private key material')
    }
  }
  const manifestProblem = validateManifest(files[0]![1])
  if (manifestProblem !== undefined) return manifestProblem

  const byteCount = files.reduce((total, file) => total + file[1].byteLength, 0)
  if (files.length === 0 || byteCount === 0) throw new Error(`${META_ROOT} scan was empty and cannot establish public metadata safety`)
  return { files: paths, bytes: byteCount }
}

interface NativeDiagnostic { readonly text: string, readonly following: readonly string[] }

// Exact source diagnostics and complete following text observed in the signed
// sample. Following text establishes the URL boundary; it is not part of the URL.
const DBUS_DIAGNOSTICS: readonly NativeDiagnostic[] = [
  { text: 'Invalid address. See https://dbus.freedesktop.org/doc/dbus-specification.html#addresses', following: ['mid > len', 'DBUS_SYSTEM_BUS_ADDRESSunix:path=/var/run/dbus/system_bus_socketDBUS_SESSION_BUS_ADDRESSXDG_RUNTIME_DIRtracing::span::activecalled `Result::unwrap()` on an `Err` value'] },
  { text: 'Invalid member name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-member', following: ['Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface'] },
  { text: 'Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error', following: ['org.freedesktop.DBusInvalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'] },
  { text: 'Invalid unique name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', following: ['BusName::UniqueBusName::WellKnownOwnedErrorNameOwnedUniqueNameInvalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'] },
  { text: 'Invalid bus name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', following: ['mid > len'] },
]

const RUSTLS_EOF = 'peer closed connection without sending TLS close_notify: https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof'

// apid is micad reached by another name (mica-apid ships /usr/bin/apid -> micad),
// so micad carries both former sets; checked against the rebuilt release binaries.
const NATIVE_DIAGNOSTICS: Readonly<Record<string, readonly NativeDiagnostic[]>> = {
  '/usr/bin/micad': [
    ...DBUS_DIAGNOSTICS,
    { text: 'Invalid interface name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface', following: ['Invalid well-known name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus'] },
    { text: 'Invalid well-known name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-bus', following: ['Invalid error name. See https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-error'] },
    { text: RUSTLS_EOF, following: ['internal error: entered unreachable code', 'is not valid for any names (according to its subjectAltName extension)'] },
    { text: 'Node.js ES modules are not directly supported, see https://docs.rs/getrandom#nodejs-es-module-support', following: ['Errorinternal_codedescriptionunknown_code\0'] },
  ],
  '/usr/bin/mica-deploy': [
    { text: 'Fatal internal error. Please consider filing a bug report at https://github.com/clap-rs/clap/issues', following: ['a Display implementation returned an error unexpectedly', 'falseTryFromIntErrora Display implementation returned an error unexpectedly', 'internal error: entered unreachable code'] },
    { text: RUSTLS_EOF, following: ['internal error: entered unreachable code'] },
  ],
}

// Exact embedded-source attribution is recorded in the native endpoint plan.
// Complete D-Bus/UI namespaces and UI diagnostic locations, scoped by binary.
const NATIVE_NON_ENDPOINTS: Readonly<Record<string, ReadonlySet<string>>> = {
  '/usr/bin/micad': new Set([
    'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd',
    'https://react.i18next.com/latest/usetranslation-hook',
    'https://tailwindcss.com',
    'http://www.w3.org/2000/svg',
    'https://react.dev/errors/',
    'http://www.w3.org/1998/Math/MathML',
    'http://www.w3.org/1999/xlink',
    'http://www.w3.org/XML/1998/namespace',
    'http://localhost',
    'https://base-ui.com/production-error',
  ]),
}

export const ROOT_CHECKS: readonly CheckCase[] = [
  ...required.map(path => ({ id: `file-root-required:${path}`, ...(REQUIRED_FEATURES[path] ? { features: REQUIRED_FEATURES[path] } : {}), shell: { pass: `required ${path}` },
    run: async ctx => [verdict(`file-root-required:${path}`, regularFileInRoot(await packedRoot(ctx), path), `required ${path}`)] } satisfies CheckCase)),
  {
    id: 'file-root-is-component', shell: { pass: 'root owns only user space' },
    run: async ctx => {
      const root = await packedRoot(ctx)
      const forbidden = ['/usr/bin/rauc', '/usr/bin/rauc-update', '/usr/bin/rauc-verify', '/etc/rauc', '/usr/bin/grub-editenv', '/usr/bin/fw_printenv', '/usr/bin/fw_setenv', '/etc/fw_env.config']
      const empty = ['/usr/lib/modules', '/usr/lib/firmware', '/boot'].every(path => {
        const st = entry(root, path)
        return st === undefined || (st.isDirectory() && readdirSync(pathInRoot(root, path)).length === 0)
      })
      return [verdict('file-root-is-component', empty && forbidden.every(p => entry(root, p) === undefined), 'root owns only user space')]
    },
  },
  {
    id: 'file-root-data-policy', shell: { pass: 'DATA owns bounded writable var and protected state' },
    run: async ctx => {
      const root = await packedRoot(ctx), read = (p: string) => readFileSync(pathInRoot(root, p), 'utf8')
      const lines = read('/etc/fstab').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().split(/\s+/))
      const obsolete = ['var-lib', 'var-cache', 'var-log', 'var-tmp', 'var-lib-systemd-timesync',
        'var-lib-systemd-network', 'var-lib-systemd-timers', 'var-lib-systemd-linger']
        .some(name => entry(root, `/etc/systemd/system/${name}.mount`) !== undefined)
      // The Quadlet bind exists only with the engine; a product without containers has no such unit.
      const binds = ['var-lib-mica', 'usr-local-lib-systemd-system', ...(ctx.product.features.has('containers') ? ['etc-containers-systemd'] : [])]
      const varUnit = entry(root, '/etc/systemd/system/var.mount')?.isFile()
        ? read('/etc/systemd/system/var.mount') : ''
      const ok = lines.length === 2 && lines.some(l => l.join(' ') === `PARTUUID=${ctx.board.get('DATA_GUID')?.toLowerCase()} /mnt/data ext4 noatime,prjquota,x-systemd.growfs 0 2`)
        && lines.some(l => l[0] === 'tmpfs' && l[1] === '/tmp' && l[3]?.includes('size=128M') && l[3]?.includes('nr_inodes=32768'))
        && !obsolete && /^What=\/mnt\/data\/var$/m.test(varUnit) && /^Where=\/var$/m.test(varUnit)
        && /^Options=bind,private,nosuid,nodev$/m.test(varUnit)
        && regularFileInRoot(root, '/etc/systemd/system/mica-seed-var.service')
        && binds.every(name => /^What=\/mnt\/data\/state\//m.test(read(`/etc/systemd/system/${name}.mount`)))
      return [verdict('file-root-data-policy', ok, 'DATA owns bounded writable var and protected state')]
    },
  },
  {
    id: 'file-root-container-policy', features: ['containers'], shell: { pass: 'container storage uses an independent DATA bind' },
    run: async ctx => {
      const root = await packedRoot(ctx)
      const read = (p: string) => regularFileInRoot(root, p) ? readFileSync(pathInRoot(root, p), 'utf8') : ''
      const unit = read('/etc/systemd/system/mica-containers.mount')
      const parent = read('/etc/systemd/system/mica.mount')
      const storage = read('/etc/containers/storage.conf')
      const network = read('/etc/containers/containers.conf')
      const quadlet = read('/etc/systemd/system/etc-containers-systemd.mount')
      const ok = /^What=\/mnt\/data\/containers$/m.test(unit) && /^Where=\/mica\/containers$/m.test(unit)
        && /^Options=bind,private,nosuid,nodev$/m.test(unit)
        && /^Options=bind,private$/m.test(parent)
        && /^Requires=.*\bmica-data-layout\.service\b.*\bmica\.mount$/m.test(unit)
        && /^After=.*\bmica-data-layout\.service\b.*\bmica\.mount$/m.test(unit)
        && wantsLink(root, ANY_UNITS, 'mica-containers.mount') !== undefined
        && /^RequiresMountsFor=.*\/mica\/containers(?: |$)/m.test(quadlet)
        && /^graphroot = "\/mica\/containers\/storage"$/m.test(storage)
        && /^runroot = "\/run\/containers\/storage"$/m.test(storage)
        && /^image_copy_tmp_dir = "\/mica\/containers\/tmp"$/m.test(network)
        && /^network_config_dir = "\/mica\/containers\/networks"$/m.test(network)
      return [verdict('file-root-container-policy', ok, 'container storage uses an independent DATA bind')]
    },
  },
  {
    id: 'file-root-identity', shell: { pass: 'machine identity is created on DATA before services' },
    run: async ctx => {
      const root = await packedRoot(ctx)
      const id = entry(root, '/etc/machine-id')
      return [verdict('file-root-identity', id?.isFile() === true && id.size === 0
        && pathInRoot(root, '/var/lib/dbus/machine-id') === pathInRoot(root, '/etc/machine-id')
        && linkTargetInRoot(root, '/var/lib/systemd/random-seed') === '/mnt/data/state/random-seed'
        && entry(root, '/usr/lib/systemd/system/mica-machine-id.service') === undefined, 'machine identity is created on DATA before services')]
    },
  },
  {
    id: 'file-root-health', shell: { pass: 'native health confirmation and failure handling are enabled' },
    run: async ctx => {
      const root = await packedRoot(ctx), read = (p: string) => readFileSync(pathInRoot(root, p), 'utf8')
      const service = read('/usr/lib/systemd/system/mica-health.service')
      return [verdict('file-root-health', wantsLink(root, ANY_UNITS, 'mica-health.service') !== undefined
        && service.includes('OnFailure=mica-boot-failure.service')
        && read('/usr/lib/mica/mica-health').includes('mica-deploy confirm')
        && read('/usr/lib/mica/mica-boot-failure').includes('mica-deploy fail-boot'), 'native health confirmation and failure handling are enabled')]
    },
  },
  {
    // micad owns the SSH server: it writes /run/mica/dropbear.env and enables the
    // unit at runtime; the host key is made on STATE at the first start. So the
    // image carries the unit, no enablement, a disabling preset, and no key,
    // identity or arguments a whole fleet would share.
    id: 'file-root-dropbear-disabled', shell: { pass: 'dropbear ships disabled with no host key or arguments' },
    run: async ctx => {
      const root = await packedRoot(ctx)
      const fail = (reason: string) => [verdict('file-root-dropbear-disabled', false, reason)]
      if (!regularFileInRoot(root, '/etc/systemd/system/dropbear.service')) return fail('/etc/systemd/system/dropbear.service is not in the image')
      const links = wantsLinksNaming(root, 'dropbear.service')
      if (links.length > 0) return fail(`${links.join(' ')} enable(s) dropbear.service in the image; micad enables it at runtime`)
      const rule = presetFor(root, 'dropbear.service')
      if (rule?.verb !== 'disable') return fail(rule === undefined ? 'no preset rule matches dropbear.service, and an unmatched unit presets to enable' : `the first preset rule for dropbear.service is '${rule.verb} ${rule.pattern}' in ${rule.file}`)
      const keys = ['/etc/dropbear', '/etc/ssh'].flatMap((dir) => {
        if (entry(root, dir)?.isDirectory() !== true) return []
        return readdirSync(pathInRoot(root, dir)).filter(name => /host_key|^ssh_host_/.test(name)).map(name => `${dir}/${name}`)
      })
      if (keys.length > 0) return fail(`${keys.join(' ')}: a host key in a signed root is one private key the whole fleet shares`)
      for (const path of ['/mnt/data/state', '/run/mica/dropbear.env']) {
        if (entry(root, path) !== undefined) return fail(`${path} is in the image; the device identity and dropbear's arguments exist only at runtime`)
      }
      return [verdict('file-root-dropbear-disabled', true, 'dropbear ships disabled with no host key or arguments')]
    },
  },
  {
    id: 'file-root-public-defaults', shell: { pass: 'baked defaults contain no metadata anchors or private keys' },
    run: async ctx => {
      const result = inspectPublicMeta(await packedRoot(ctx))
      if ('reason' in result) return [publicMetaRefusal(result)]
      return [verdict('file-root-public-defaults', true,
        `${PUBLIC_DEFAULTS_FACT}; scannedFiles=${result.files.length}; scannedBytes=${result.bytes}; examinedPaths=${result.files.join(',')}`)]
    },
  },
  {
    id: 'file-root-native-endpoints', shell: { pass: 'native binaries contain no default update or fleet endpoints' },
    run: async ctx => {
      const root = await packedRoot(ctx)
      if (entry(root, '/')?.isDirectory() !== true) throw new Error(`${root} is not an actual unpacked-image directory`)
      // The native binaries the product ships: micad (and apid, its link) with the micad feature, mica-deploy always.
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
      if (paths.includes('/usr/bin/micad') && (entry(root, '/usr/bin/apid')?.isSymbolicLink() !== true || linkTargetInRoot(root, '/usr/bin/apid') !== 'micad')) {
        return result(false, '/usr/bin/apid: must be the symlink apid -> micad')
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
          || (bytes[4] !== 1 && bytes[4] !== 2) || (bytes[5] !== 1 && bytes[5] !== 2) || bytes[6] !== 1) {
          return result(false, `${path}: must contain a complete ELF executable header`)
        }
        const word = (offset: number) => bytes[5] === 1 ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset)
        const version = bytes[5] === 1 ? bytes.readUInt32LE(20) : bytes.readUInt32BE(20)
        if ((word(16) !== 2 && word(16) !== 3) || version !== 1 || word(headerSize === 64 ? 52 : 40) !== headerSize) {
          return result(false, `${path}: must contain a complete ELF executable header`)
        }
        examined.push(path)
        byteCount += bytes.byteLength
        // Invalid UTF-8 cannot start an authority. Keep later replacement characters
        // in the candidate so a suffix cannot be truncated into an exact exemption.
        const text = bytes.toString('utf8')
        const literals = text.matchAll(/(?:https?|wss?|mqtts?):\/\/[^\x00-\x20\x7f"'<>`{}\\/\ufffd][^\x00-\x20\x7f"'<>`{}\\]*/gi)
        for (const literal of literals) {
          if (NATIVE_NON_ENDPOINTS[path]?.has(literal[0])) continue
          const diagnostic = NATIVE_DIAGNOSTICS[path]?.some(({ text: source, following }) => {
            const offset = source.indexOf('https://'), url = source.slice(offset)
            const start = literal.index - offset
            return start >= 0 && text.slice(start, literal.index + url.length) === source
              && (literal[0] === url || following.some(next => {
                const token = next.match(/^[^\x00-\x20\x7f"'<>`{}\\]*/)?.[0]
                return literal[0] === url + token
                  && text.slice(literal.index + url.length, literal.index + url.length + next.length) === next
              }))
          })
          if (!diagnostic) {
            endpoints.push(path)
            break
          }
        }
      }
      if (endpoints.length !== 0) return result(false, `${endpoints.join(',')}: contains a compiled network endpoint literal`)
      return result(true, 'native binaries contain no default update or fleet endpoints')
    },
  },
]
