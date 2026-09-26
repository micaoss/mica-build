// The connd contract and the Wi-Fi userland, driven from the failing side.
//
// The contract read is driven against MUTATED
// COPIES of the micad sources, which is what `MICA_VERIFY_RECONCILER_DIR` exists
// for: without it the rot the oracle records could not be driven, only waited
// for. The image-side assertions are driven against a mutated packed root.
//
// The edits are the shapes the failures took:
//
//   - a reconciler refactored from `contains` to `starts_with`, which is what
//     silently emptied the sweep marker. With an empty marker the collision
//     glob was `**` and matched every filename; here the group FAILS instead of
//     substituting a default, and a case asserts exactly that.
//   - a unit template whose ExecStart names a config path the reconciler does
//     not render. The daemon starts against a file nothing writes, on the
//     device and nowhere else.
//   - hostapd.service DISABLED rather than MASKED. Disabling does not block the
//     D-Bus activation path wpasupplicant ships, so a second daemon still comes
//     up on the same radio while micad's own instance reports healthy.
//   - a render target bound from a tmpfs, which loses every configured network
//     on reboot and reports nothing.

import { describe, expect, test } from 'bun:test'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBoard, type Board } from './board.ts'
import { boardsWhere, hasRadio, SHIPPED } from './board-scope.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import {
  CONND_CHECKS,
  CONTRACT,
  mountUnitFor,
  readConndContract,
  RECONCILER_DIR,
} from './checks-connd.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))
const uefiX64 = loadBoard(boardEnvPath('uefi-x64'))

const WANTS = '/etc/systemd/system/local-fs.target.wants'
const STA_UNIT_PATH = `/usr/lib/systemd/system/${CONTRACT.staUnit}`
const AP_UNIT_PATH = `/usr/lib/systemd/system/${CONTRACT.apUnit}`
const SEED_STATE = '/usr/lib/mica/mica-seed-state'

function checkNamed(id: string): CheckCase {
  const found = CONND_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no connd check is registered as '${id}'. Registered: `
      + CONND_CHECKS.map(c => c.id).join(', '))
  }
  return found
}

async function only(fx: RootFixture, id: string): Promise<CheckResult> {
  const got = await checkNamed(id).run(fx.ctx)
  expect(got.length).toBe(1)
  return got[0] as CheckResult
}

async function verdictOf(fx: RootFixture, id: string): Promise<Verdict> {
  return (await only(fx, id)).verdict
}

async function messageOf(fx: RootFixture, id: string): Promise<string> {
  return (await only(fx, id)).message
}

async function mutated(id: string, mutate: (root: string) => void, board: Board = cx3576): Promise<RootFixture> {
  const fx = packedRootFixture(board)
  expect(await verdictOf(fx, id)).toBe('pass')
  mutate(fx.root)
  return fx
}

function rewrite(root: string, path: string, edit: (text: string) => string): void {
  writeFileSync(join(root, path), edit(readFileSync(join(root, path), 'utf8')))
}

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), text)
}

/**
 * A COPY of the real reconcilers, for the extractor to be driven against.
 *
 * A copy and not a fabrication: the rot this guards against is a REFACTOR of the
 * shipped code, so what has to be edited is the shipped code's own text. A
 * synthetic wifi_client.rs would prove the extractor reads the file this test
 * wrote.
 */
function reconcilerCopy(edit: (file: string, text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-reconciler-'))
  cpSync(RECONCILER_DIR, dir, { recursive: true })
  for (const f of ['wifi_client.rs', 'wifi_ap.rs', 'network.rs']) {
    const path = join(dir, f)
    writeFileSync(path, edit(f, readFileSync(path, 'utf8')))
  }
  return dir
}

describe('the contract, read out of the shipped reconcilers', () => {
  test('every field is read, and none is written down here', () => {
    // The values are ASSERTED, because a reader that returned empty strings
    // would satisfy "it read something" and would then make the whole group
    // fail with a message nobody could tell from a real defect.
    const c = readConndContract(RECONCILER_DIR)
    expect(c.read).toBe(true)
    expect(c.staDir).toBe('/etc/wpa_supplicant')
    expect(c.apDir).toBe('/etc/hostapd')
    expect(c.staUnit).toBe('wpa_supplicant@.service')
    expect(c.apUnit).toBe('hostapd@.service')
    expect(c.staConf).toBe('wpa_supplicant-{interface}.conf')
    expect(c.apConf).toBe('{interface}.conf')
    expect(c.staPrefix).toBe('90-wifi-client-')
    expect(c.apPrefix).toBe('90-wifi-ap-')
    expect(c.sweep).toBe('50-mica-')
    // BOTH suffixes: the reconciler renders `.netdev` units for VLAN, bridge
    // and WireGuard interfaces and sweeps them under the same `50-mica-` prefix,
    // so a contract naming only `.network` would describe half the namespace.
    expect(c.sweepSuffixes).toEqual(['.network', '.netdev'])
  })

  test('the READ of a directory with no reconcilers in it fails, it does not substitute', async () => {
    // The rot, in its purest form. The oracle records that nineteen assertions
    // went green against the verifier's own restatement of a contract it had
    // just failed to read; there is no `?? 'wpa_supplicant@.service'` anywhere
    // in the port, and this is what says so.
    const empty = mkdtempSync(join(tmpdir(), 'mica-no-reconciler-'))
    try {
      const c = readConndContract(empty)
      expect(c.read).toBe(false)
      expect(`${c.staUnit}|${c.apUnit}|${c.sweep}`).toBe('||')
    }
    finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('a refactor from starts_with to contains empties the marker, and the read FAILS', async () => {
    // This is the exact change that happened: network.rs was rewritten to an
    // anchored is_mica_managed() and the verifier's regex stopped matching. Run
    // in reverse here -- take the anchor away -- because the direction that
    // matters is "the extractor no longer finds it".
    const dir = reconcilerCopy((f, t) =>
      f === 'network.rs' ? t.replace(/file_name\.starts_with\("[^"]*"\)/, 'is_mica_prefixed(file_name)') : t)
    try {
      const c = readConndContract(dir)
      expect(c.sweep).toBe('')
      expect(c.read).toBe(false)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a starts_with that LOST its ends_with is refused, not narrowed to a guess', async () => {
    // A marker read out of a starts_with whose ends_with had changed describes a
    // WIDER sweep than the code performs -- so `.network` is required to be
    // AMONG the suffixes rather than merely for some suffix to have been read.
    const dir = reconcilerCopy((f, t) =>
      f === 'network.rs' ? t.replace('.ends_with(".network")', '.ends_with(".conf")') : t)
    try {
      const c = readConndContract(dir)
      expect(c.sweepSuffixes).toEqual(['.conf', '.netdev'])
      expect(c.read).toBe(false)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a renamed unit template is READ, not compared against a remembered name', async () => {
    const dir = reconcilerCopy((f, t) =>
      f === 'wifi_client.rs' ? t.replace('wpa_supplicant@{interface}.service', 'supplicant@{interface}.service') : t)
    try {
      expect(readConndContract(dir).staUnit).toBe('supplicant@.service')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a missing NETWORKD_PREFIX makes the read fail rather than defaulting', async () => {
    const dir = reconcilerCopy((f, t) =>
      f === 'wifi_ap.rs' ? t.replace(/^const NETWORKD_PREFIX.*$/m, '') : t)
    try {
      const c = readConndContract(dir)
      expect(c.apPrefix).toBe('')
      expect(c.read).toBe(false)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the contract check reports the read it made, on both boards', async () => {
    for (const board of [cx3576, uefiX64]) {
      const fx = packedRootFixture(board)
      try {
        const got = await only(fx, 'connd-contract-read')
        expect(got.verdict).toBe('pass')
        expect(got.message).toContain('sweep \'50-mica-\'*\'.network\'')
      }
      finally {
        fx.dispose()
      }
    }
  })
})

describe('the healthy image', () => {
  test('the Wi-Fi userland concludes on the radio board and SKIPS on the other', async () => {
    for (const board of [cx3576, uefiX64]) {
      const fx = packedRootFixture(board)
      try {
        for (const c of CONND_CHECKS) {
          if (c.boards !== undefined && !c.boards.includes(board.name)) continue
          const got = await c.run(fx.ctx)
          const want = c.id === 'wifi-userland-skipped' ? 'skip' : 'pass'
          expect(`${board.name}/${c.id}: ${got.map(r => r.verdict).join(',')}`)
            .toBe(`${board.name}/${c.id}: ${want}`)
        }
      }
      finally {
        fx.dispose()
      }
    }
  })

  test('the Wi-Fi scopes are COMPLEMENTS, derived from the shipped definitions', () => {
    const withRadio = boardsWhere(b => hasRadio(b, 'wifi'))
    const without = boardsWhere(b => !hasRadio(b, 'wifi'))
    const scoped = CONND_CHECKS.filter(c => c.boards !== undefined && c.id !== 'wifi-userland-skipped')
    expect(scoped.length).toBe(21)
    for (const c of scoped) expect(`${c.id}: ${[...(c.boards ?? [])].sort()}`).toBe(`${c.id}: ${[...withRadio].sort()}`)
    expect([...(checkNamed('wifi-userland-skipped').boards ?? [])].sort()).toEqual([...without].sort())
    expect([...withRadio, ...without].sort()).toEqual(SHIPPED.map(b => b.name).sort())
  })

  test('the two namespace checks are board-UNCONDITIONAL', () => {
    // network.rs sweeps on every board, radio or not, so an image .network file
    // in its namespace is deleted on a board with no Wi-Fi too.
    for (const id of ['connd-contract-read', 'networkd-namespace-clear', 'networkd-fallback-sorts-first'])
      expect(`${id}: ${checkNamed(id).boards}`).toBe(`${id}: undefined`)
  })
})

describe('the daemons and their unit templates', () => {
  test('a missing supplicant binary fails', async () => {
    const fx = await mutated('wifi-supplicant-binary', root => rmSync(join(root, '/usr/sbin/wpa_supplicant')))
    try {
      expect(await messageOf(fx, 'wifi-supplicant-binary'))
        .toContain('/usr/sbin/wpa_supplicant missing or not a regular file')
    }
    finally {
      fx.dispose()
    }
  })

  test('a unit template that became a SYMLINK fails: sq_regular pairs -f with !-L', async () => {
    const fx = await mutated('wifi-station-unit', (root) => {
      const body = readFileSync(join(root, STA_UNIT_PATH), 'utf8')
      rmSync(join(root, STA_UNIT_PATH))
      write(root, '/usr/lib/systemd/system/supplicant@.service', body)
      symlinkSync('/usr/lib/systemd/system/supplicant@.service', join(root, STA_UNIT_PATH))
    })
    try {
      expect(await verdictOf(fx, 'wifi-station-unit')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('an ExecStart naming a path the reconciler does not render fails', async () => {
    const fx = await mutated('wifi-station-execstart',
      root => rewrite(root, STA_UNIT_PATH, t => t.replace('/etc/wpa_supplicant/', '/run/wpa_supplicant/')))
    try {
      expect(await verdictOf(fx, 'wifi-station-execstart')).toBe('fail')
      const message = await messageOf(fx, 'wifi-station-execstart')
      expect(message).toContain('station: wpa_supplicant@.service\'s ExecStart does not name')
      expect(message).toContain('the daemon starts against a file nothing writes')
    }
    finally {
      fx.dispose()
    }
  })

  test('BOTH instance specifiers are accepted -- %i and %I are the same string here', async () => {
    // The fixture ships the station with %I and the access point with %i,
    // because that is what the two real images carry. Swapping each in turn
    // must leave both green: which specifier the packager chose is not this
    // repo's business, and a port accepting one would fail a correct image.
    const fx = packedRootFixture(cx3576)
    try {
      rewrite(fx.root, STA_UNIT_PATH, t => t.replaceAll('%I', '%i'))
      rewrite(fx.root, AP_UNIT_PATH, t => t.replaceAll('%i', '%I'))
      expect(await verdictOf(fx, 'wifi-station-execstart')).toBe('pass')
      expect(await verdictOf(fx, 'wifi-ap-execstart')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a template unit absent fails the ExecStart check on its own branch', async () => {
    const fx = await mutated('wifi-ap-execstart', root => rmSync(join(root, AP_UNIT_PATH)))
    try {
      expect(await messageOf(fx, 'wifi-ap-execstart'))
        .toContain('so micad would drive a unit that does not exist')
    }
    finally {
      fx.dispose()
    }
  })

  test('a STATICALLY ENABLED template instance fails: it would race micad', async () => {
    const fx = await mutated('wifi-station-template-not-enabled', (root) => {
      mkdirSync(join(root, '/etc/systemd/system/multi-user.target.wants'), { recursive: true })
      symlinkSync(STA_UNIT_PATH, join(root, '/etc/systemd/system/multi-user.target.wants', CONTRACT.staUnit))
    })
    try {
      expect(await verdictOf(fx, 'wifi-station-template-not-enabled')).toBe('fail')
      expect(await messageOf(fx, 'wifi-station-template-not-enabled'))
        .toContain('micad owns that lifecycle and would race the image\'s own instance')
    }
    finally {
      fx.dispose()
    }
  })

  test('the VENDOR tree is searched for that enablement too', async () => {
    const fx = await mutated('wifi-ap-template-not-enabled', (root) => {
      mkdirSync(join(root, '/usr/lib/systemd/system/multi-user.target.wants'), { recursive: true })
      symlinkSync(AP_UNIT_PATH, join(root, '/usr/lib/systemd/system/multi-user.target.wants', CONTRACT.apUnit))
    })
    try {
      expect(await verdictOf(fx, 'wifi-ap-template-not-enabled')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('no second daemon unit is startable: none ships, or it is MASKED', () => {
  test('the fixture ships none, and the verdict says so', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'wifi-masked-hostapd.service')).toBe('pass')
      expect(await messageOf(fx, 'wifi-masked-hostapd.service')).toContain('no hostapd.service ships')
    }
    finally {
      fx.dispose()
    }
  })

  test('a vendor unit left startable fails', async () => {
    const fx = await mutated('wifi-masked-wpa_supplicant.service',
      root => writeFileSync(join(root, '/usr/lib/systemd/system/wpa_supplicant.service'), '[Service]\nExecStart=/usr/sbin/wpa_supplicant\n'))
    try {
      expect(await verdictOf(fx, 'wifi-masked-wpa_supplicant.service')).toBe('fail')
      expect(await messageOf(fx, 'wifi-masked-wpa_supplicant.service'))
        .toContain('it is \'not a symlink to /dev/null\'')
    }
    finally {
      fx.dispose()
    }
  })

  test('the same unit masked passes', async () => {
    const fx = await mutated('wifi-masked-wpa_supplicant.service', (root) => {
      writeFileSync(join(root, '/usr/lib/systemd/system/wpa_supplicant.service'), '[Service]\nExecStart=/usr/sbin/wpa_supplicant\n')
      symlinkSync('/dev/null', join(root, '/etc/systemd/system/wpa_supplicant.service'))
    })
    try {
      expect(await verdictOf(fx, 'wifi-masked-wpa_supplicant.service')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a mask pointed somewhere ELSE fails, and the target is printed', async () => {
    const fx = await mutated('wifi-masked-hostapd.service', root => symlinkSync('/usr/lib/systemd/system/hostapd.service',
      join(root, '/etc/systemd/system/hostapd.service')))
    try {
      expect(await verdictOf(fx, 'wifi-masked-hostapd.service')).toBe('fail')
      expect(await messageOf(fx, 'wifi-masked-hostapd.service'))
        .toContain('it is \'/usr/lib/systemd/system/hostapd.service\'')
    }
    finally {
      fx.dispose()
    }
  })

  test('the D-BUS ACTIVATION unit is in the set, not only the two daemons', async () => {
    const fx = await mutated('wifi-masked-dbus-fi.w1.wpa_supplicant1.service',
      root => writeFileSync(join(root, '/usr/lib/systemd/system/dbus-fi.w1.wpa_supplicant1.service'), '[Service]\n'))
    try {
      expect(await verdictOf(fx, 'wifi-masked-dbus-fi.w1.wpa_supplicant1.service')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('a leftover postinst *.wants entry fails, separately from the mask', async () => {
    // Two distinct ways a daemon comes up; a check that folded them together would report one failure for two
    // different repairs.
    const fx = await mutated('wifi-no-postinst-wants-hostapd.service', (root) => {
      mkdirSync(join(root, '/etc/systemd/system/multi-user.target.wants'), { recursive: true })
      symlinkSync('/usr/lib/systemd/system/hostapd.service',
        join(root, '/etc/systemd/system/multi-user.target.wants/hostapd.service'))
    })
    try {
      expect(await verdictOf(fx, 'wifi-no-postinst-wants-hostapd.service')).toBe('fail')
      // ...and the unit itself still ships nowhere, which is what makes the two separable.
      expect(await verdictOf(fx, 'wifi-masked-hostapd.service')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the render targets are writable, on STATE, and enabled', () => {
  test('the mount unit absent fails, naming the read-only verity root', async () => {
    const fx = await mutated('wifi-station-config-bind',
      root => rmSync(join(root, '/etc/systemd/system', mountUnitFor(CONTRACT.staDir))))
    try {
      expect(await messageOf(fx, 'wifi-station-config-bind'))
        .toContain('the render would fail on device and nowhere else')
    }
    finally {
      fx.dispose()
    }
  })

  test('a bind on a TMPFS fails: every configured network is lost on reboot', async () => {
    const unit = `/etc/systemd/system/${mountUnitFor(CONTRACT.apDir)}`
    const fx = await mutated('wifi-ap-config-bind',
      root => rewrite(root, unit, t => t.replace('What=/mnt/data/state/hostapd', 'What=/run/hostapd')))
    try {
      expect(await verdictOf(fx, 'wifi-ap-config-bind')).toBe('fail')
      expect(await messageOf(fx, 'wifi-ap-config-bind'))
        .toContain('a tmpfs or nothing at all would lose every configured network on reboot')
    }
    finally {
      fx.dispose()
    }
  })

  test('a RETARGETED Where= fails, and its actual value is printed', async () => {
    const unit = `/etc/systemd/system/${mountUnitFor(CONTRACT.staDir)}`
    const fx = await mutated('wifi-station-config-bind',
      root => rewrite(root, unit, t => t.replace('Where=/etc/wpa_supplicant', 'Where=/etc/wpa_supplicant.d')))
    try {
      expect(await messageOf(fx, 'wifi-station-config-bind'))
        .toContain('its Where= is \'/etc/wpa_supplicant.d\'')
    }
    finally {
      fx.dispose()
    }
  })

  test('a bind installed and NOT ENABLED fails', async () => {
    const fx = await mutated('wifi-ap-config-bind',
      root => rmSync(join(root, WANTS, mountUnitFor(CONTRACT.apDir))))
    try {
      expect(await messageOf(fx, 'wifi-ap-config-bind'))
        .toContain('would stay on the read-only squashfs')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the bind sources are seeded, at 0700', () => {
  test('a seed whose loop lost THIS directory fails, though it still creates the other', async () => {
    // The two halves are what makes this sound: the seed creates both from one
    // loop, so a script that created the other twice would satisfy either half
    // alone.
    const fx = await mutated('wifi-ap-config-seeded',
      root => rewrite(root, SEED_STATE, t => t.replace('wpa_supplicant hostapd; do', 'wpa_supplicant; do')))
    try {
      expect(await verdictOf(fx, 'wifi-ap-config-seeded')).toBe('fail')
      expect(await messageOf(fx, 'wifi-ap-config-seeded'))
        .toContain('the bind would have no source on first boot')
      // ...and the station's half is still green, which is the point.
      expect(await verdictOf(fx, 'wifi-station-config-seeded')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a seed that creates the directories at 0755 fails: both hold a PSK in the clear', async () => {
    const fx = await mutated('wifi-station-config-seeded',
      root => rewrite(root, SEED_STATE, t => t.replace('ensure_dir "$name" 0700', 'ensure_dir "$name" 0755')))
    try {
      expect(await verdictOf(fx, 'wifi-station-config-seeded')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('a seed that chmods but never mkdirs fails', async () => {
    const fx = await mutated('wifi-station-config-seeded',
      root => rewrite(root, SEED_STATE, t => t.replace('mkdir -p "$state/$1"', 'test -d "$state/$1"')))
    try {
      expect(await verdictOf(fx, 'wifi-station-config-seeded')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('the seed script absent fails both halves', async () => {
    const fx = await mutated('wifi-ap-config-seeded', root => rmSync(join(root, SEED_STATE)))
    try {
      expect(await verdictOf(fx, 'wifi-ap-config-seeded')).toBe('fail')
      expect(await verdictOf(fx, 'wifi-station-config-seeded')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the regulatory database and the unit that loads it', () => {
  // The three halves fail independently and are three conclusions for that
  // reason: the file can be there with nothing to read it, the unit can be
  // there with nothing to want it, and the unit can be wanted with its program
  // absent. Each of those is a green run for the other two.

  test('a database with no unit to load it: the file is there and unread', async () => {
    const fx = await mutated('wifi-regdb-reload-enabled',
      root => rmSync(join(root, '/etc/systemd/system/mica-regdb-reload.service')))
    try {
      expect(await messageOf(fx, 'wifi-regdb-reload-enabled')).toContain('is not in the image at')
      // This is the shape that packaging alone produces, and the file check is
      // green throughout it.
    }
    finally {
      fx.dispose()
    }
  })

  test('a unit nothing wants never runs, and the root cannot be enabled on device', async () => {
    const fx = await mutated('wifi-regdb-reload-enabled',
      root => rmSync(join(root, '/etc/systemd/system/multi-user.target.wants/mica-regdb-reload.service')))
    try {
      const message = await messageOf(fx, 'wifi-regdb-reload-enabled')
      expect(message).toContain('nothing wants it')
      expect(message).toContain('immutable dm-verity squashfs')
      expect(await verdictOf(fx, 'wifi-regdb-reload-tool')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('an enabled unit whose program the image does not carry', async () => {
    // The missing-Depends shape. Nothing else here goes red: the database is
    // packaged, the unit is present and enabled, and the load never happens.
    const fx = await mutated('wifi-regdb-reload-tool', root => rmSync(join(root, '/usr/sbin/iw')))
    try {
      const message = await messageOf(fx, 'wifi-regdb-reload-tool')
      expect(message).toContain('/usr/sbin/iw, which the image does not carry')
      expect(await verdictOf(fx, 'wifi-regdb-reload-enabled')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a unit whose ExecStart was emptied is red, not green about nothing', async () => {
    const fx = await mutated('wifi-regdb-reload-tool',
      root => rewrite(root, '/etc/systemd/system/mica-regdb-reload.service',
        t => t.replace('ExecStart=/usr/sbin/iw reg reload', 'ExecStart=')))
    try {
      expect(await messageOf(fx, 'wifi-regdb-reload-tool')).toContain('declares no ExecStart')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the AP hands out addresses through networkd, not a second daemon', () => {
  test('dnsmasq in the image fails, and the message calls it a conflict', async () => {
    const fx = await mutated('wifi-no-dnsmasq', root => write(root, '/usr/sbin/dnsmasq', 'x\n'))
    try {
      expect(await verdictOf(fx, 'wifi-no-dnsmasq')).toBe('fail')
      expect(await messageOf(fx, 'wifi-no-dnsmasq'))
        .toContain('a second DHCP server on the same link is a conflict, not a fallback')
    }
    finally {
      fx.dispose()
    }
  })

  test('a DANGLING /usr/sbin/dnsmasq reads as ABSENT -- reproduced, not tightened', async () => {
    // `[ -e ]` FOLLOWS a link, so a symlink to nothing is absent to the oracle.
    // A port that lstat-ed here would be stricter than the verifier it replaces
    // and would diverge on exactly the image where the difference shows.
    const fx = packedRootFixture(cx3576)
    try {
      symlinkSync('/usr/sbin/dnsmasq-real', join(fx.root, '/usr/sbin/dnsmasq'))
      expect(await verdictOf(fx, 'wifi-no-dnsmasq')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the image\'s networkd namespace', () => {
  test('a file in the SWEEP namespace fails, and is labelled as deleted on first pass', async () => {
    const fx = await mutated('networkd-namespace-clear',
      root => write(root, `/etc/systemd/network/${CONTRACT.sweep}eth0.network`, '[Match]\nName=eth0\n'))
    try {
      expect(await verdictOf(fx, 'networkd-namespace-clear')).toBe('fail')
      const message = await messageOf(fx, 'networkd-namespace-clear')
      expect(message).toContain('50-mica-eth0.network(swept-by-network.rs)')
      expect(message).toContain('DELETED on the reconciler\'s first pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a file in the STATION namespace fails, and is labelled as a shadow', async () => {
    const fx = await mutated('networkd-namespace-clear',
      root => write(root, `/usr/lib/systemd/network/${CONTRACT.staPrefix}wlan0.network`, '[Match]\n'))
    try {
      expect(await messageOf(fx, 'networkd-namespace-clear'))
        .toContain('90-wifi-client-wlan0.network(station-namespace)')
    }
    finally {
      fx.dispose()
    }
  })

  test('a file in the AP namespace fails too, from the /run tree', async () => {
    const fx = await mutated('networkd-namespace-clear',
      root => write(root, `/run/systemd/network/${CONTRACT.apPrefix}ap0.network`, '[Match]\n'))
    try {
      expect(await messageOf(fx, 'networkd-namespace-clear'))
        .toContain('90-wifi-ap-ap0.network(ap-namespace)')
    }
    finally {
      fx.dispose()
    }
  })

  test('the sweep test is ANCHORED: a file merely CONTAINING the marker is clear', async () => {
    // The unanchored `*marker*` is what turned an empty marker into eight false
    // positives, and the repair for a false positive is to loosen the check.
    const fx = packedRootFixture(cx3576)
    try {
      write(fx.root, '/etc/systemd/network/10-eth-50-mica-legacy.network', '[Match]\n')
      expect(await verdictOf(fx, 'networkd-namespace-clear')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a file with the sweep PREFIX but the wrong suffix is clear', async () => {
    // is_mica_managed() is starts_with AND ends_with. network.rs would not touch
    // `50-mica-notes.txt`, so neither does this.
    const fx = packedRootFixture(cx3576)
    try {
      write(fx.root, '/etc/systemd/network/50-mica-eth0.network.bak', '[Match]\n')
      expect(await verdictOf(fx, 'networkd-namespace-clear')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('an image with NO .network file at all fails as VACUOUS, not as clear', async () => {
    // A clear namespace and an empty one are the same answer to `is anything
    // colliding?` and different answers to `did this check read anything?`.
    const fx = await mutated('networkd-namespace-clear',
      root => rmSync(join(root, '/etc/systemd/network'), { recursive: true, force: true }))
    try {
      expect(await verdictOf(fx, 'networkd-namespace-clear')).toBe('fail')
      expect(await messageOf(fx, 'networkd-namespace-clear'))
        .toContain('so this check would pass vacuously')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the image\'s fallback sorts first', () => {
  test('the shipped prefixes sort after 80-dhcp.network, on both boards', async () => {
    for (const board of [cx3576, uefiX64]) {
      const fx = packedRootFixture(board)
      try {
        const got = await only(fx, 'networkd-fallback-sorts-first')
        expect(got.verdict).toBe('pass')
        expect(got.message).toContain('80-dhcp.network sorts before both \'90-wifi-client-\' and \'90-wifi-ap-\'')
      }
      finally {
        fx.dispose()
      }
    }
  })

  test('a prefix that sorts FIRST fails, and it is named', () => {
    // Driven through the reader rather than the check, because the value comes
    // from micad's sources and not from the image: a `70-` prefix would let the
    // image's fallback win over the unit micad rendered for that interface.
    const dir = reconcilerCopy((f, t) =>
      f === 'wifi_ap.rs' ? t.replace('"90-wifi-ap-"', '"70-wifi-ap-"') : t)
    try {
      const c = readConndContract(dir)
      expect(c.apPrefix).toBe('70-wifi-ap-')
      expect(['80-dhcp.network', c.apPrefix].sort()[0]).not.toBe('80-dhcp.network')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the group SKIP', () => {
  test('a board with no radio skips, and the message names every assertion it covers', async () => {
    const fx = packedRootFixture(uefiX64)
    try {
      const got = await only(fx, 'wifi-userland-skipped')
      expect(got.verdict).toBe('skip')
      expect(got.message).toContain('uefi-x64 declares no wifi in BOARD_RADIOS')
      expect(got.message).toContain('the image ships neither daemon')
    }
    finally {
      fx.dispose()
    }
  })

  test('a controller-less board that ships hostapd ANYWAY still skips', async () => {
    // The skip is about the BOARD's declaration, not about the image. Answering
    // `pass` here would claim the oracle's SKIP line and compare a pass to a skip.
    const fx = packedRootFixture(uefiX64)
    try {
      write(fx.root, '/usr/sbin/hostapd', 'x\n')
      expect(await verdictOf(fx, 'wifi-userland-skipped')).toBe('skip')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the seed script is READ inside the root, not off the host', () => {
  // RFCT-358. The regdb case above drives the PRESENCE half of host
  // resolution; this drives the READ half, which is the half that survived
  // RFCT-355: a check whose presence test resolved in the root while its
  // `readFileSync(join(root, path))` still resolved on the host would report
  // the host's bytes as the image's.
  //
  // The planted host file is a byte-for-byte COPY of the image's own seed
  // script, so it satisfies every clause of the check. The only difference
  // between passing and failing here is which filesystem the path resolved
  // against.

  test('a seed script that is an absolute symlink to an identical host file fails', async () => {
    const seed = '/usr/lib/mica/mica-seed-state'
    const host = mkdtempSync(join(tmpdir(), 'mica-host-probe-'))
    const planted = join(host, 'mica-seed-state')
    const fx = await mutated('wifi-ap-config-seeded', (root) => {
      copyFileSync(join(root, seed), planted)
      rmSync(join(root, seed))
      symlinkSync(planted, join(root, seed))
    })
    try {
      expect(await verdictOf(fx, 'wifi-ap-config-seeded')).toBe('fail')
      expect(await verdictOf(fx, 'wifi-station-config-seeded')).toBe('fail')
    }
    finally {
      fx.dispose()
      rmSync(host, { recursive: true, force: true })
    }
  })
})
