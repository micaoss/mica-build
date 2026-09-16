// D-Bus image-contract tests driven from the failing side.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard, type Board } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { DBUS_CHECKS, policyFacts, policyTags, stripXmlComments } from './checks-dbus.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))
const uefi-x64 = loadBoard(boardEnvPath('uefi-x64'))
const MICAD_POLICY = '/usr/share/dbus-1/system.d/com.mica.micad.conf'
const MICAD_UNIT = '/usr/lib/systemd/system/micad.service'
const LEGACY_EXT_POLICY = '/usr/share/dbus-1/system.d/com.mica.ext.conf'
const BLUEZ_POLICY = '/usr/share/dbus-1/system.d/bluetooth.conf'

function checkNamed(id: string): CheckCase {
  const found = DBUS_CHECKS.find(c => c.id === id)
  if (found === undefined) throw new Error(`no D-Bus check registered as ${id}`)
  return found
}

async function verdictOf(fx: RootFixture, id: string): Promise<Verdict> {
  const got = await checkNamed(id).run(fx.ctx)
  expect(got.length).toBe(1)
  return (got[0] as CheckResult).verdict
}

async function messageOf(fx: RootFixture, id: string): Promise<string> {
  const got = await checkNamed(id).run(fx.ctx)
  return (got[0] as CheckResult).message
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

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true })
  writeFileSync(join(root, path), content)
}

describe('the healthy image', () => {
  test('every D-Bus check concludes on both boards and only bluez skips', async () => {
    for (const board of [cx3576, uefi-x64]) {
      const fx = packedRootFixture(board)
      try {
        for (const c of DBUS_CHECKS) {
          const got = await c.run(fx.ctx)
          const want = c.id === 'bluez-dbus-policy' && !board.radios?.includes('bluetooth')
            ? 'skip'
            : 'pass'
          expect(`${board.name}/${c.id}: ${got.map(result => result.verdict).join(',')}`)
            .toBe(`${board.name}/${c.id}: ${want}`)
        }
      }
      finally { fx.dispose() }
    }
  })
})

describe('the policy readers', () => {
  test('comments spanning lines are stripped without changing line count', () => {
    const text = '<busconfig>\n<!-- a\nb\nc -->\n<allow own="x"/>\n</busconfig>\n'
    const stripped = stripXmlComments(text)
    expect(stripped).not.toContain('<!-- a')
    expect(stripped).not.toContain('\nb\n')
    expect(stripped.split('\n').length).toBe(text.split('\n').length)
  })

  test('wrapped attributes are one tag and own_prefix is not own', () => {
    const tags = policyTags('<policy user="root"><allow\n own="com.mica.micad"/></policy>')
    expect(tags).toContain('<allow own="com.mica.micad"/>')
    const facts = policyFacts('<policy context="default"><allow own_prefix="com.mica"/></policy>',
      'com.mica.micad')
    expect(`${facts.ownRoot}/${facts.ownOther}`).toBe('0/0')
  })
})

describe('micad is a local root-owned management service', () => {
  test('both system bus units are required', async () => {
    const fx = await mutated('dbus-system-bus-present', root =>
      rmSync(join(root, '/usr/lib/systemd/system/dbus.socket')))
    try { expect(await verdictOf(fx, 'dbus-system-bus-present')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('the micad policy must ship and remain root-only in both directions', async () => {
    const missing = await mutated('micad-policy-ships', root => rmSync(join(root, MICAD_POLICY)))
    try { expect(await verdictOf(missing, 'micad-policy-ships')).toBe('fail') }
    finally { missing.dispose() }

    const defaultAllow = await mutated('micad-policy-no-default-allow', root =>
      rewrite(root, MICAD_POLICY, text => text.replace('</busconfig>',
        '<policy context="default"><allow receive_sender="com.mica.micad"/></policy></busconfig>')))
    try { expect(await verdictOf(defaultAllow, 'micad-policy-no-default-allow')).toBe('fail') }
    finally { defaultAllow.dispose() }

    const nonRootOwner = await mutated('micad-policy-own-root-only', root =>
      rewrite(root, MICAD_POLICY, text => text.replace('</busconfig>',
        '<policy user="nobody"><allow own="com.mica.micad"/></policy></busconfig>')))
    try { expect(await verdictOf(nonRootOwner, 'micad-policy-own-root-only')).toBe('fail') }
    finally { nonRootOwner.dispose() }
  })

  test('the policy name must match the unit', async () => {
    const fx = await mutated('micad-policy-names-the-owned-bus', root =>
      rewrite(root, MICAD_UNIT, text => text.replace('BusName=com.mica.micad', 'BusName=com.mica.other')))
    try { expect(await verdictOf(fx, 'micad-policy-names-the-owned-bus')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('even a narrow second policy exception is forbidden', async () => {
    const fx = await mutated('micad-policy-no-second-file-widens', root => write(
      root,
      '/etc/dbus-1/system.d/mqttd-exception.conf',
      '<busconfig><policy user="mica-mqttd">'
      + '<allow send_destination="com.mica.micad" send_member="GetState"/>'
      + '</policy></busconfig>\n',
    ))
    try {
      expect(await verdictOf(fx, 'micad-policy-no-second-file-widens')).toBe('fail')
      expect(await messageOf(fx, 'micad-policy-no-second-file-widens')).toContain('GetState')
    }
    finally { fx.dispose() }
  })
})

describe('application names require exact package grants', () => {
  test('the legacy com.mica.ext policy remains absent', async () => {
    const fx = await mutated('legacy-ext-policy-absent', root => write(
      root,
      LEGACY_EXT_POLICY,
      '<busconfig><policy context="default"><allow own_prefix="com.mica.ext"/></policy></busconfig>\n',
    ))
    try { expect(await verdictOf(fx, 'legacy-ext-policy-absent')).toBe('fail') }
    finally { fx.dispose() }
  })

  for (const prefix of ['com.mica', 'com.mica.sensor']) {
    test(`an own_prefix=${prefix} grant in any policy fails`, async () => {
      const fx = await mutated('mica-namespace-no-prefix-ownership', root => write(
        root,
        '/etc/dbus-1/system.d/unsafe-prefix.conf',
        `<busconfig><policy context="default"><allow own_prefix="${prefix}"/></policy></busconfig>\n`,
      ))
      try {
        expect(await verdictOf(fx, 'mica-namespace-no-prefix-ownership')).toBe('fail')
        expect(await messageOf(fx, 'mica-namespace-no-prefix-ownership')).toContain(prefix)
      }
      finally { fx.dispose() }
    })
  }

  test('a prefix example inside a comment is not a live grant', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      write(fx.root, '/etc/dbus-1/system.d/comment.conf',
        '<busconfig><!-- <allow own_prefix="com.mica"/> --></busconfig>\n')
      expect(await verdictOf(fx, 'mica-namespace-no-prefix-ownership')).toBe('pass')
    }
    finally { fx.dispose() }
  })
})

describe('bluez remains board-conditional', () => {
  test('the Bluetooth board requires its policy', async () => {
    const fx = await mutated('bluez-dbus-policy', root => rmSync(join(root, BLUEZ_POLICY)))
    try { expect(await verdictOf(fx, 'bluez-dbus-policy')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('the non-Bluetooth board skips the check', async () => {
    const fx = packedRootFixture(uefi-x64)
    try { expect(await verdictOf(fx, 'bluez-dbus-policy')).toBe('skip') }
    finally { fx.dispose() }
  })
})

describe('the packed root is read INSIDE the root, never against the host', () => {
  // RFCT-358's discriminating case for this file's readers: an ABSOLUTE symlink
  // whose target exists on the machine running the suite and not in the image.
  // Host resolution -- what `statSync(join(root, path))` did -- answers PASS on
  // it; resolving inside the root answers FAIL, which is the only true answer
  // about the image. A test that exercised only the new helper could not tell
  // the two implementations apart.

  test('dbus.service pointing at a host regular file is dbus.service MISSING', async () => {
    const unit = '/usr/lib/systemd/system/dbus.service'
    const fx = await mutated('dbus-system-bus-present', (root) => {
      rmSync(join(root, unit))
      symlinkSync('/proc/version', join(root, unit))
    })
    try {
      expect(await verdictOf(fx, 'dbus-system-bus-present')).toBe('fail')
      expect(await messageOf(fx, 'dbus-system-bus-present')).toContain('dbus.service')
    }
    finally {
      fx.dispose()
    }
  })
})
