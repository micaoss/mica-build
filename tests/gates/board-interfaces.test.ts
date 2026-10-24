// The board interface declarations: every board's package ships /usr/share/mica/board/interfaces.json
// (package/overlay/usr/share/mica/board/interfaces.json), the physical network interfaces micad and the console
// read, in panel order, or `discover` for a generic board. Until micad's own `micad board check <file>` lands
// with its consumer, this is the check: the file's contract (version 1, the keys and values below, unknown keys
// refused) and, where the board's DTS source is in this tree (boards/<board>/kernel/dts/*.dts), a cross-check
// against it:
//   - every Ethernet MAC the DTS enables (`&gmac<n>` / `&ethmac` with status "okay") is declared; a NIC on PCIe
//     or USB has no DTS node, so more declared Ethernet ports than enabled MACs is fine;
//   - the CAN controllers the DTS enables are exactly the declared CAN interfaces;
//   - a Wi-Fi interface is declared exactly when board.env's BOARD_FEATURES names wifi (the radio's package).
// A board with no DTS source here (a compiled .dtb, or none) is checked against the contract only.
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

/** The labels of the `&<label> { ... }` nodes of a DTS whose own body sets status = "okay". */
export function enabledNodes(dts: string): string[] {
  const out: string[] = []
  for (const m of dts.matchAll(/^&([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\};/gm))
    if (/^\s*status\s*=\s*"okay"\s*;/m.test(m[2]!)) out.push(m[1]!)
  return out
}

/** The cross-check's faults for one board: its interfaces against its DTS sources and its BOARD_FEATURES. */
export function crossFaults(interfaces: Interface[], dtsSources: string[], features: string[]): string[] {
  const out: string[] = []
  const enabled = dtsSources.flatMap(enabledNodes)
  const count = (kind: string) => interfaces.filter(i => i.kind === kind).length
  const macs = enabled.filter(l => /^(gmac\d*|ethmac\d*)$/.test(l)), cans = enabled.filter(l => /^can\d+$/.test(l))
  if (count('ethernet') < macs.length) out.push(`the DTS enables ${macs.length} Ethernet MAC(s) (${macs.join(' ')}) and ${count('ethernet')} Ethernet interface(s) are declared`)
  if (count('can') !== cans.length) out.push(`the DTS enables ${cans.length} CAN controller(s) (${cans.join(' ') || 'none'}) and ${count('can')} CAN interface(s) are declared`)
  if ((count('wifi') > 0) !== features.includes('wifi')) out.push(`BOARD_FEATURES ${features.includes('wifi') ? 'names' : 'does not name'} wifi and ${count('wifi')} Wi-Fi interface(s) are declared`)
  return out
}

const boards = readdirSync(join(REPO_ROOT, 'boards'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()

test.each(boards)('%s declares its interfaces, and they agree with its DTS source where it is here', (board) => {
  const dir = join(REPO_ROOT, 'boards', board), path = join(dir, FILE)
  expect(existsSync(path), `boards/${board}/${FILE} is missing`).toBe(true)
  const text = readFileSync(path, 'utf8')
  expect(faults(text)).toEqual([])
  const d = JSON.parse(text) as { discover?: boolean, interfaces?: Interface[] }
  if (d.discover === true) return
  const dts = join(dir, 'kernel/dts')
  const sources = existsSync(dts) ? readdirSync(dts).filter(f => f.endsWith('.dts')).sort().map(f => readFileSync(join(dts, f), 'utf8')) : []
  if (sources.length === 0) {
    console.log(`board-interfaces: ${board}: no DTS source in this tree; checked against the contract only`)
    return
  }
  const env = readFileSync(join(dir, 'board.env'), 'utf8')
  const features = (/^BOARD_FEATURES="([^"]*)"/m.exec(env)?.[1] ?? '').split(/\s+/).filter(f => f !== '')
  expect(crossFaults(d.interfaces!, sources, features)).toEqual([])
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

test('the cross-check: an enabled MAC or CAN controller without its interface, a radio without its feature', () => {
  const dts = '&gmac0 {\n\tstatus = "okay";\n};\n&gmac1 {\n\tstatus = "disabled";\n};\n&can1 {\n\tstatus = "okay";\n};\n'
  expect(enabledNodes(dts)).toEqual(['gmac0', 'can1'])
  const eth: Interface = { name: 'eth0', kind: 'ethernet', label: 'LAN' }, can: Interface = { name: 'can0', kind: 'can', label: 'CAN' }
  expect(crossFaults([eth, can], [dts], [])).toEqual([])
  expect(crossFaults([can], [dts], [])).toEqual(['the DTS enables 1 Ethernet MAC(s) (gmac0) and 0 Ethernet interface(s) are declared'])
  expect(crossFaults([eth], [dts], [])).toEqual(['the DTS enables 1 CAN controller(s) (can1) and 0 CAN interface(s) are declared'])
  expect(crossFaults([eth, can], [dts], ['wifi'])).toEqual(['BOARD_FEATURES names wifi and 0 Wi-Fi interface(s) are declared'])
})
