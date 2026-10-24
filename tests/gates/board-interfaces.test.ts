// The board interface declarations: every board's package ships /usr/share/mica/board/interfaces.json
// (package/overlay/usr/share/mica/board/interfaces.json), the physical network interfaces micad and the console
// read, in panel order, or `discover` for a generic board. Until micad's own `micad board check <file>` lands
// with its consumer, this is the check: the file's contract (version 1, the keys and values below, unknown keys
// refused), and a Wi-Fi interface is declared exactly when board.env's BOARD_FEATURES names wifi (the radio's
// package). The cross-check against the device tree source (the enabled Ethernet MACs and CAN controllers) needs
// the kernel tree, where the board's .dts is a commit: common/kernel/dts-interfaces-check.py, which a board's
// kernel verify hook runs; its rules are tested here on fixtures.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const FILE = 'package/overlay/usr/share/mica/board/interfaces.json'

const KINDS = ['ethernet', 'wifi', 'can']
const BANDS = ['2.4', '5', '6']
/** The keys each kind may carry beyond name, kind, label and hidden. */
const KIND_KEYS: Record<string, string[]> = { ethernet: ['role', 'speedMbps'], wifi: ['role', 'ap', 'bands'], can: ['fd'] }

type Interface = { name: string, kind: string, label: string, role?: string, speedMbps?: number, ap?: boolean, bands?: string[], fd?: boolean, hidden?: boolean }

/** The contract's faults in a declaration's text; [] when it holds. */
export function faults(text: string): string[] {
  let d: unknown
  try { d = JSON.parse(text) }
  catch (e) { return [`not JSON: ${(e as Error).message}`] }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return ['not an object']
  const o = d as Record<string, unknown>
  if (o['version'] !== 1) return [`version is ${JSON.stringify(o['version'])}, not 1`]
  if ('discover' in o) {
    const extra = Object.keys(o).filter(k => k !== 'version' && k !== 'discover')
    return [...(o['discover'] === true ? [] : ['discover is not true']), ...extra.map(k => `unknown key ${k} beside discover`)]
  }
  const out = Object.keys(o).filter(k => k !== 'version' && k !== 'interfaces').map(k => `unknown key ${k}`)
  if (!Array.isArray(o['interfaces']) || o['interfaces'].length === 0) return [...out, 'interfaces is no non-empty list (a generic board declares discover)']
  const names = new Set<string>()
  for (const [i, raw] of (o['interfaces'] as unknown[]).entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { out.push(`interfaces[${i}] is not an object`); continue }
    const x = raw as Record<string, unknown>, at = `interfaces[${i}]`
    if (typeof x['name'] !== 'string' || !/^[a-z][a-z0-9]{0,14}$/.test(x['name'])) out.push(`${at}: name ${JSON.stringify(x['name'])} is no interface name`)
    else if (names.has(x['name'])) out.push(`${at}: name ${x['name']} is declared twice`)
    else names.add(x['name'])
    const kind = typeof x['kind'] === 'string' && KINDS.includes(x['kind']) ? x['kind'] : ''
    if (kind === '') { out.push(`${at}: kind ${JSON.stringify(x['kind'])} is not ${KINDS.join(', ')}`); continue }
    if (typeof x['label'] !== 'string' || x['label'].length === 0 || [...x['label']].length > 16) out.push(`${at}: label ${JSON.stringify(x['label'])} is not 1 to 16 characters`)
    for (const k of Object.keys(x).filter(k => !['name', 'kind', 'label', 'hidden', ...KIND_KEYS[kind]!].includes(k))) out.push(`${at}: ${k} is no key of a ${kind} interface`)
    if ('role' in x && x['role'] !== 'uplink' && x['role'] !== 'internal') out.push(`${at}: role ${JSON.stringify(x['role'])} is not uplink or internal`)
    if ('speedMbps' in x && !(Number.isInteger(x['speedMbps']) && (x['speedMbps'] as number) > 0)) out.push(`${at}: speedMbps is no positive integer`)
    for (const k of ['ap', 'fd', 'hidden']) if (k in x && typeof x[k] !== 'boolean') out.push(`${at}: ${k} is not a boolean`)
    if ('bands' in x) {
      const b = x['bands']
      if (!Array.isArray(b) || b.length === 0 || b.some(v => !BANDS.includes(v as string)) || new Set(b).size !== b.length)
        out.push(`${at}: bands ${JSON.stringify(b)} is no non-empty list of distinct ${BANDS.join(', ')}`)
    }
  }
  return out
}

/** The Wi-Fi fault of one board's interfaces against its BOARD_FEATURES; [] when they agree. */
export function featureFaults(interfaces: Interface[], features: string[]): string[] {
  const wifi = interfaces.filter(i => i.kind === 'wifi').length
  return (wifi > 0) === features.includes('wifi') ? [] : [`BOARD_FEATURES ${features.includes('wifi') ? 'names' : 'does not name'} wifi and ${wifi} Wi-Fi interface(s) are declared`]
}

const boards = readdirSync(join(REPO_ROOT, 'boards'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()

test.each(boards)('%s declares its interfaces, and its Wi-Fi agrees with its BOARD_FEATURES', (board) => {
  const dir = join(REPO_ROOT, 'boards', board), path = join(dir, FILE)
  expect(existsSync(path), `boards/${board}/${FILE} is missing`).toBe(true)
  const text = readFileSync(path, 'utf8')
  expect(faults(text)).toEqual([])
  const d = JSON.parse(text) as { discover?: boolean, interfaces?: Interface[] }
  if (d.discover === true) return
  const env = readFileSync(join(dir, 'board.env'), 'utf8')
  const features = (/^BOARD_FEATURES="([^"]*)"/m.exec(env)?.[1] ?? '').split(/\s+/).filter(f => f !== '')
  expect(featureFaults(d.interfaces!, features)).toEqual([])
})

test('the contract refuses what is not version 1, unknown keys, keys of another kind, bad values', () => {
  const one = (i: object) => JSON.stringify({ version: 1, interfaces: [i] })
  expect(faults('{"version":1,"discover":true}')).toEqual([])
  expect(faults(one({ name: 'eth0', kind: 'ethernet', label: 'LAN1', role: 'uplink', speedMbps: 1000 }))).toEqual([])
  expect(faults(one({ name: 'wlan0', kind: 'wifi', label: 'Wi-Fi', ap: true, bands: ['2.4', '5'], hidden: false }))).toEqual([])
  expect(faults('{"version":2,"discover":true}')).toEqual(['version is 2, not 1'])
  expect(faults('{"version":1,"discover":true,"interfaces":[]}')).toEqual(['unknown key interfaces beside discover'])
  expect(faults('{"version":1,"interfaces":[]}')).toEqual(['interfaces is no non-empty list (a generic board declares discover)'])
  expect(faults(one({ name: 'eth0', kind: 'ethernet', label: 'LAN1', mtu: 1500 }))).toEqual(['interfaces[0]: mtu is no key of a ethernet interface'])
  expect(faults(one({ name: 'can0', kind: 'can', label: 'CAN', role: 'uplink' }))).toEqual(['interfaces[0]: role is no key of a can interface'])
  expect(faults(one({ name: 'eth0', kind: 'ethernet', label: 'a label of 17 chr' }))).toEqual(['interfaces[0]: label "a label of 17 chr" is not 1 to 16 characters'])
  expect(faults(one({ name: 'eth0', kind: 'usb', label: 'USB' }))).toEqual(['interfaces[0]: kind "usb" is not ethernet, wifi, can'])
  expect(faults(one({ name: 'wlan0', kind: 'wifi', label: 'Wi-Fi', bands: ['2.4', '2.4'] }))).toEqual(['interfaces[0]: bands ["2.4","2.4"] is no non-empty list of distinct 2.4, 5, 6'])
  expect(faults(one({ name: 'eth0', kind: 'ethernet', label: 'LAN', role: 'wan', speedMbps: 0 }))).toEqual(['interfaces[0]: role "wan" is not uplink or internal', 'interfaces[0]: speedMbps is no positive integer'])
  expect(faults(JSON.stringify({ version: 1, interfaces: [{ name: 'eth0', kind: 'ethernet', label: 'A' }, { name: 'eth0', kind: 'ethernet', label: 'B' }] }))).toEqual(['interfaces[1]: name eth0 is declared twice'])
})

const tmp = mkdtempSync(join(tmpdir(), 'board-interfaces.'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** common/kernel/dts-interfaces-check.py over a DTS and a declaration: its exit code and its stderr. */
function dtsCheck(dts: string, interfaces: Interface[]): [number, string] {
  writeFileSync(join(tmp, 'board.dts'), dts)
  writeFileSync(join(tmp, 'interfaces.json'), JSON.stringify({ version: 1, interfaces }))
  const r = Bun.spawnSync(['python3', join(REPO_ROOT, 'common/kernel/dts-interfaces-check.py'), join(tmp, 'board.dts'), join(tmp, 'interfaces.json')], { stdout: 'pipe', stderr: 'pipe' })
  return [r.exitCode, r.stderr.toString().replaceAll(`${join(tmp, 'interfaces.json')}: `, '')]
}

test('the DTS cross-check: an enabled MAC or CAN controller without its interface, a radio without its feature', () => {
  const dts = '&gmac0 {\n\tstatus = "okay";\n};\n&gmac1 {\n\tstatus = "disabled";\n};\n&can1 {\n\tstatus = "okay";\n};\n'
  const eth: Interface = { name: 'eth0', kind: 'ethernet', label: 'LAN' }, can: Interface = { name: 'can0', kind: 'can', label: 'CAN' }
  expect(dtsCheck(dts, [eth, can])).toEqual([0, ''])
  expect(dtsCheck(dts, [can])).toEqual([1, 'error: the DTS enables 1 Ethernet MAC(s) (gmac0) and 0 Ethernet interface(s) are declared\n'])
  expect(dtsCheck(dts, [eth])).toEqual([1, 'error: the DTS enables 1 CAN controller(s) (can1) and 0 CAN interface(s) are declared\n'])
  expect(featureFaults([eth, can], ['wifi'])).toEqual(['BOARD_FEATURES names wifi and 0 Wi-Fi interface(s) are declared'])
})
