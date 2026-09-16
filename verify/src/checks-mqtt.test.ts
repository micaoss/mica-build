// MQTT image-contract tests driven from the failing side.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard, type Board } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { MQTT_CHECKS, policyRuleLines } from './checks-mqtt.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))
const uefi-x64 = loadBoard(boardEnvPath('uefi-x64'))
const MQTTD_UNIT = '/usr/lib/systemd/system/mica-mqttd.service'
const MQTTD_WANTS = '/etc/systemd/system/multi-user.target.wants/mica-mqttd.service'
const BROKER_UNIT = '/usr/lib/systemd/system/mica-mqtt-broker.service'
const LEGACY_POLICY = '/usr/share/dbus-1/system.d/mica-mqttd.conf'
const APPLICATIONS_DIR = '/usr/lib/mica/mqtt-applications.d'

function checkNamed(id: string): CheckCase {
  const found = MQTT_CHECKS.find(c => c.id === id)
  if (found === undefined) throw new Error(`no MQTT check registered as ${id}`)
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

function applicationPolicy(name: string): string {
  return '<busconfig>\n'
    + '<policy user="mica-sensor">\n'
    + `<allow own="${name}"/>\n`
    + '</policy>\n'
    + '<policy user="mica-mqttd">\n'
    + `<allow send_destination="${name}" send_interface="com.mica.Item1" send_member="GetItems"/>\n`
    + `<allow receive_sender="${name}" receive_interface="com.mica.Item1" receive_member="ItemsChanged"/>\n`
    + '</policy>\n'
    + '<policy user="root">\n'
    + `<allow send_destination="${name}" send_interface="com.mica.Item1" send_member="GetItems"/>\n`
    + '</policy>\n</busconfig>\n'
}

describe('the healthy image', () => {
  test('every MQTT check passes on both boards', async () => {
    for (const board of [cx3576, uefi-x64]) {
      const fx = packedRootFixture(board)
      try {
        for (const c of MQTT_CHECKS) {
          const got = await c.run(fx.ctx)
          expect(`${board.name}/${c.id}: ${got.map(r => r.verdict).join(',')}`)
            .toBe(`${board.name}/${c.id}: pass`)
        }
      }
      finally {
        fx.dispose()
      }
    }
  })
})

describe('the bridge is installed, inert, and starts with an explicit identity', () => {
  test('a missing binary fails', async () => {
    const fx = await mutated('mqttd-bin', root => rmSync(join(root, '/usr/bin/mica-mqttd')))
    try { expect(await verdictOf(fx, 'mqttd-bin')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('an enablement symlink defeats mqtt.enabled', async () => {
    const fx = await mutated('mqttd-not-enabled', (root) => {
      mkdirSync(join(root, MQTTD_WANTS, '..'), { recursive: true })
      symlinkSync(MQTTD_UNIT, join(root, MQTTD_WANTS))
    })
    try { expect(await verdictOf(fx, 'mqttd-not-enabled')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('a dynamic bridge user fails because package policies need a stable identity', async () => {
    const fx = await mutated('mqttd-static-user', root =>
      rewrite(root, MQTTD_UNIT, text => text.replace('User=mica-mqttd\n', 'DynamicUser=yes\n')))
    try { expect(await verdictOf(fx, 'mqttd-static-user')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('the static identity must exist in passwd', async () => {
    const fx = await mutated('mqttd-user-in-passwd', root =>
      rewrite(root, '/etc/passwd', text => text.split('\n')
        .filter(line => !line.startsWith('mica-mqttd:')).join('\n')))
    try { expect(await verdictOf(fx, 'mqttd-user-in-passwd')).toBe('fail') }
    finally { fx.dispose() }
  })

  for (const edit of [
    (text: string): string => text.replace('ConditionPathExists=/run/mica/mqttd-device.env\n', ''),
    (text: string): string => text.replace('EnvironmentFile=/run/mica/mqttd-device.env\n', ''),
    (text: string): string => text.replace('--device-id ${MICA_MQTT_DEVICE_ID} ', ''),
  ]) {
    test('a missing runtime identity link fails closed', async () => {
      const fx = await mutated('mqttd-device-id-runtime-input', root => rewrite(root, MQTTD_UNIT, edit))
      try {
        expect(await verdictOf(fx, 'mqttd-device-id-runtime-input')).toBe('fail')
        expect(await messageOf(fx, 'mqttd-device-id-runtime-input')).toContain('must not be fetched from com.mica.micad')
      }
      finally { fx.dispose() }
    })
  }
})

describe('the MQTT/D-Bus boundary', () => {
  test('the old mqttd-to-micad policy must stay absent', async () => {
    const fx = await mutated('mqttd-legacy-policy-absent', root =>
      write(root, LEGACY_POLICY, applicationPolicy('com.mica.micad')))
    try { expect(await verdictOf(fx, 'mqttd-legacy-policy-absent')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('a policy in any fragment cannot grant mqttd a micad call or signal', async () => {
    const fx = await mutated('mqttd-zero-micad-access', root => write(
      root,
      '/etc/dbus-1/system.d/unsafe.conf',
      '<busconfig><policy user="mica-mqttd">'
      + '<allow send_destination="com.mica.micad" send_member="GetState"/>'
      + '</policy></busconfig>\n',
    ))
    try {
      expect(await verdictOf(fx, 'mqttd-zero-micad-access')).toBe('fail')
      expect(await messageOf(fx, 'mqttd-zero-micad-access')).toContain('GetState')
    }
    finally { fx.dispose() }
  })

  test('the enrollment directory must ship even when no applications are installed', async () => {
    const fx = await mutated('mqttd-applications-directory', root =>
      rmSync(join(root, APPLICATIONS_DIR), { recursive: true }))
    try { expect(await verdictOf(fx, 'mqttd-applications-directory')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('one exact application enrollment and package policy pair passes', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      const name = 'com.mica.sensor.abc123'
      write(fx.root, `${APPLICATIONS_DIR}/${name}`, '')
      write(fx.root, '/usr/share/dbus-1/system.d/com.mica.sensor.abc123.conf', applicationPolicy(name))
      expect(await verdictOf(fx, 'mqttd-exact-application-grants')).toBe('pass')
    }
    finally { fx.dispose() }
  })

  test('an enrollment without a policy fails', async () => {
    const fx = await mutated('mqttd-exact-application-grants', root =>
      write(root, `${APPLICATIONS_DIR}/com.mica.sensor.abc123`, ''))
    try {
      expect(await verdictOf(fx, 'mqttd-exact-application-grants')).toBe('fail')
      expect(await messageOf(fx, 'mqttd-exact-application-grants')).toContain('has no exact user-scoped ownership grant')
    }
    finally { fx.dispose() }
  })

  test('a policy that does not let the registry probe the application fails', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      const name = 'com.mica.sensor.abc123'
      write(fx.root, `${APPLICATIONS_DIR}/${name}`, '')
      write(
        fx.root,
        '/usr/share/dbus-1/system.d/com.mica.sensor.abc123.conf',
        applicationPolicy(name).replace(/<policy user="root">[\s\S]*?<\/policy>\n/, ''),
      )
      expect(await verdictOf(fx, 'mqttd-exact-application-grants')).toBe('fail')
      expect(await messageOf(fx, 'mqttd-exact-application-grants')).toContain('lacks a root GetItems grant')
    }
    finally { fx.dispose() }
  })

  test('an exact ownership grant in the default context still permits service spoofing', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      const name = 'com.mica.sensor.abc123'
      write(fx.root, `${APPLICATIONS_DIR}/${name}`, '')
      write(
        fx.root,
        '/usr/share/dbus-1/system.d/com.mica.sensor.abc123.conf',
        applicationPolicy(name).replace('<policy user="mica-sensor">', '<policy context="default">'),
      )
      expect(await verdictOf(fx, 'mqttd-exact-application-grants')).toBe('fail')
      expect(await messageOf(fx, 'mqttd-exact-application-grants')).toContain(
        'is not scoped to one explicit user',
      )
    }
    finally { fx.dispose() }
  })

  test('a grant without an enrollment fails', async () => {
    const fx = await mutated('mqttd-exact-application-grants', root => write(
      root,
      '/usr/share/dbus-1/system.d/com.mica.sensor.conf',
      applicationPolicy('com.mica.sensor.abc123'),
    ))
    try {
      expect(await verdictOf(fx, 'mqttd-exact-application-grants')).toBe('fail')
      expect(await messageOf(fx, 'mqttd-exact-application-grants')).toContain('unenrolled grant')
    }
    finally { fx.dispose() }
  })

  test('wildcard and micad enrollments both fail', async () => {
    for (const name of ['com.mica.sensor.*', 'com.mica.micad']) {
      const fx = await mutated('mqttd-exact-application-grants', root =>
        write(root, `${APPLICATIONS_DIR}/${name}`, ''))
      try { expect(await verdictOf(fx, 'mqttd-exact-application-grants')).toBe('fail') }
      finally { fx.dispose() }
    }
  })

  test('XML comments do not become live policy rules', () => {
    const lines = policyRuleLines(
      '<busconfig><!-- <allow send_destination="com.mica.micad"/> -->'
      + '<policy user="mica-mqttd"><allow send_destination="com.mica.sensor"/></policy></busconfig>',
    )
    expect(lines.filter(line => line.includes('send_destination')).length).toBe(1)
  })
})

describe('broker configuration and identity', () => {
  test('a hardcoded broker host fails', async () => {
    const fx = await mutated('mqttd-broker-from-environment', root =>
      rewrite(root, MQTTD_UNIT, text => text.replace('${MICA_MQTT_BROKER_HOST}', 'mqtt.invalid')))
    try { expect(await verdictOf(fx, 'mqttd-broker-from-environment')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('the operator broker file remains optional and state-backed', async () => {
    const fx = await mutated('mqttd-envfile-on-state', root =>
      rewrite(root, MQTTD_UNIT, text => text.replace('EnvironmentFile=-/var/lib/mica/mqttd.env',
        'EnvironmentFile=/var/lib/mica/mqttd.env')))
    try { expect(await verdictOf(fx, 'mqttd-envfile-on-state')).toBe('fail') }
    finally { fx.dispose() }
  })

  test('the broker remains installed and its account remains static', async () => {
    const missing = await mutated('mqtt-broker-unit', root => rmSync(join(root, BROKER_UNIT)))
    try { expect(await verdictOf(missing, 'mqtt-broker-unit')).toBe('fail') }
    finally { missing.dispose() }

    const dynamic = await mutated('mqtt-broker-static-user', root =>
      rewrite(root, BROKER_UNIT, text => text.replace('User=mica-mqtt-broker', 'DynamicUser=yes')))
    try { expect(await verdictOf(dynamic, 'mqtt-broker-static-user')).toBe('fail') }
    finally { dynamic.dispose() }
  })
})
