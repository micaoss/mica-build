// The MQTT bridge and broker: in the image, startable, and INERT.
//
// Board-unconditional -- 16 conclusions on each shipped board, measured
// 2026-08-26 -- so not batch 3 as scoped; and `mqttd: <path> is a regular file`
// looks like `sq_regular` but is check_mqttd's own prose with a `mqttd: `
// prefix, so not batch 2a either.
//
// Each half of the family is a defect the wiring actually had: the crate, the
// unit and the protocol tests were all green while the bridge was absent from
// the image entirely, and when it was added the unit's `DynamicUser=yes` could
// not be named by any `<policy user=>` and its ExecStart hardcoded a broker host
// into a read-only squashfs. None of that is visible from the code side.
// Inertness is the load-bearing half: `mqtt.enabled` is a master switch that
// seeds false for every profile and micad starts both units from it, so an
// enablement symlink baked into the image is the one thing that switch cannot
// override, and the root is a read-only verity squashfs so nothing on the device
// can remove it.
//
// Application access is positive and package-owned: a regular file named for
// one exact `com.mica.<class>[.<suffix>]` service enrolls it, and a package policy
// grants the static bridge user only that destination's Item1 members. There is
// no micad exception and no prefix-wide ownership policy.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { entry, packedRoot } from './checks-root.ts'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { verdict } from './verdict.ts'

const MQTTD_BIN = '/usr/bin/mica-mqttd'
const MQTTD_UNIT = '/usr/lib/systemd/system/mica-mqttd.service'
const LEGACY_MQTTD_POLICY = '/usr/share/dbus-1/system.d/mica-mqttd.conf'
const APPLICATIONS_DIR = '/usr/lib/mica/mqtt-applications.d'
const DEVICE_ID_ENV = '/run/mica/mqttd-device.env'
const MQTTD_WANTS = '/etc/systemd/system/multi-user.target.wants/mica-mqttd.service'
const BROKER_BIN = '/usr/bin/mica-mqtt-broker'
const BROKER_UNIT = '/usr/lib/systemd/system/mica-mqtt-broker.service'
const BROKER_WANTS = '/etc/systemd/system/multi-user.target.wants/mica-mqtt-broker.service'
const POLICY_DIRS = ['/etc/dbus-1/system.d', '/usr/share/dbus-1/system.d'] as const

/** `${prefix}: ${path} is a regular file`, as check_mqttd and check_mqtt_broker say it. */
function prefixedRegularFile(id: string, prefix: string, path: string, why: string): CheckCase {
  return {
    id,
    shell: {
      pass: `${prefix}: ${path} is a regular file`,
      fail: `${prefix}: ${path} is missing or not a regular file`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const st = entry(await packedRoot(ctx), path)
      const ok = st !== undefined && st.isFile()
      return [verdict(
        id,
        ok,
        ok
          ? `${prefix}: ${path} is a regular file`
          : `${prefix}: ${path} is missing or not a regular file, ${why}`,
      )]
    },
  }
}

/** The last `Key=` value in a unit, which is what `sed -n 's/^Key=//p' | tail -n1` takes. */
function unitValues(root: string, unit: string, key: string): string[] {
  const st = entry(root, unit)
  if (st === undefined) return []
  return readFileSync(join(root, unit), 'utf8')
    .split('\n')
    .filter(l => l.startsWith(`${key}=`))
    .map(l => l.slice(key.length + 1))
}

function unitValue(root: string, unit: string, key: string): string {
  const hits = unitValues(root, unit, key)
  return hits[hits.length - 1] ?? ''
}

/**
 * The whole `ExecStart=` value, continuation lines folded in.
 *
 * `sed -n '/^ExecStart=/,/[^\\]$/p' | tr -d '\\\n'`: from the ExecStart line to
 * the first line not ending in a backslash, with the backslashes and newlines
 * removed. A unit that wraps its command line would otherwise be read as its
 * first fragment, and the `${MICA_MQTT_BROKER_HOST}` reference is usually in the
 * middle of it.
 */
function execStart(root: string, unit: string): string {
  const st = entry(root, unit)
  if (st === undefined) return ''
  const lines = readFileSync(join(root, unit), 'utf8').split('\n')
  const out: string[] = []
  let inExec = false
  for (const line of lines) {
    if (!inExec && !line.startsWith('ExecStart=')) continue
    inExec = true
    out.push(line)
    if (!line.endsWith('\\')) break
  }
  return out.join('').replace(/\\/g, '')
}

/** `/etc/passwd` as the oracle's awk reads it: name, uid, gid, shell. */
interface Account {
  readonly name: string
  readonly uid: string
  readonly gid: string
  readonly shell: string
}

function accounts(root: string): Account[] {
  const st = entry(root, '/etc/passwd')
  if (st === undefined) return []
  return readFileSync(join(root, '/etc/passwd'), 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map((l) => {
      const f = l.split(':')
      return { name: f[0] ?? '', uid: f[2] ?? '', gid: f[3] ?? '', shell: f[6] ?? '' }
    })
}

interface IdentityPolicyRule {
  readonly path: string
  readonly tag: string
}

/** D-Bus groups that apply to `user`, as both names and numeric gids. */
function identityGroups(root: string, user: string): Set<string> {
  const account = accounts(root).find(candidate => candidate.name === user)
  const groups = new Set<string>()
  if (account !== undefined) groups.add(account.gid)
  try {
    for (const line of readFileSync(join(root, '/etc/group'), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      const [name = '', , gid = '', members = ''] = line.split(':')
      const listed = members.split(',').includes(user)
      if (listed || (account !== undefined && gid === account.gid)) {
        groups.add(name)
        groups.add(gid)
      }
    }
  }
  catch {
    // The separate passwd/group existence checks explain a malformed image.
  }
  return groups
}

/**
 * Every allow on com.mica.micad that can apply to the bridge identity, across
 * both policy directories. Looking only at mica-mqttd.conf would miss a grant
 * added by a second package -- dbus-daemon unions all of the files. Default,
 * mandatory and at-console blocks are treated conservatively as applicable;
 * an image check cannot prove the runtime console classification will keep a
 * network daemon out of either at-console branch.
 */
function identityPolicyRules(root: string, user: string): IdentityPolicyRule[] {
  const account = accounts(root).find(candidate => candidate.name === user)
  const userSelectors = new Set([user, ...(account === undefined ? [] : [account.uid]), '*'])
  const groupSelectors = identityGroups(root, user)
  groupSelectors.add('*')
  const found: IdentityPolicyRule[] = []

  for (const dir of POLICY_DIRS) {
    let names: string[]
    try {
      names = readdirSync(join(root, dir)).sort()
    }
    catch {
      continue
    }
    for (const name of names) {
      const path = `${dir}/${name}`
      let text: string
      try {
        text = readFileSync(join(root, path), 'utf8')
      }
      catch {
        continue
      }
      let applies = false
      for (const tag of policyRuleLines(text)) {
        if (tag.startsWith('<policy')) {
          const policyUser = tag.match(/\buser="([^"]*)"/)?.[1]
          const policyGroup = tag.match(/\bgroup="([^"]*)"/)?.[1]
          const context = tag.match(/\bcontext="([^"]*)"/)?.[1]
          const atConsole = tag.match(/\bat_console="([^"]*)"/)?.[1]
          applies = context === 'default'
            || context === 'mandatory'
            || atConsole !== undefined
            || (policyUser !== undefined && userSelectors.has(policyUser))
            || (policyGroup !== undefined && groupSelectors.has(policyGroup))
          continue
        }
        if (tag.startsWith('</policy')) {
          applies = false
          continue
        }
        if (applies && tag.startsWith('<allow')) found.push({ path, tag })
      }
    }
  }
  return found
}

function exactApplicationName(name: string): boolean {
  return /^com\.mica\.[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(name)
    && name !== 'com.mica.micad'
}

function enrolledApplications(root: string): { names: Set<string>, invalid: string[] } {
  const names = new Set<string>()
  const invalid: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(join(root, APPLICATIONS_DIR)).sort()
  }
  catch {
    return { names, invalid }
  }
  for (const name of entries) {
    const st = entry(root, `${APPLICATIONS_DIR}/${name}`)
    if (st?.isFile() !== true || !exactApplicationName(name)) invalid.push(name)
    else names.add(name)
  }
  return { names, invalid }
}

interface OwnershipGrant {
  readonly name: string
  readonly path: string
  readonly user: string | undefined
  readonly tag: string
}

function exactOwnershipGrants(root: string): OwnershipGrant[] {
  const grants: OwnershipGrant[] = []
  for (const dir of POLICY_DIRS) {
    let entries: string[]
    try {
      entries = readdirSync(join(root, dir)).sort()
    }
    catch {
      continue
    }
    for (const entryName of entries) {
      const path = `${dir}/${entryName}`
      if (entry(root, path)?.isFile() !== true) continue
      let policyUser: string | undefined
      for (const tag of policyRuleLines(readFileSync(join(root, path), 'utf8'))) {
        if (tag.startsWith('<policy')) {
          policyUser = tag.match(/\buser="([^"]*)"/)?.[1]
          continue
        }
        if (tag.startsWith('</policy')) {
          policyUser = undefined
          continue
        }
        const owned = tag.match(/^<allow\b[^>]*\bown="([^"]*)"/)?.[1]
        if (owned !== undefined) grants.push({ name: owned, path, user: policyUser, tag })
      }
    }
  }
  return grants
}

/**
 * The policy file with comments removed and one XML tag per line.
 *
 * `dbus_policy_rules_only | tr '\n' ' ' | sed 's/</\n</g'` -- comments first,
 * because a commented-out rule must not become a rule when the tags are split.
 * `<!-- ... -->` may span lines, which is why this tracks the open state across
 * the whole file rather than stripping per line.
 */
export function policyRuleLines(text: string): string[] {
  let out = ''
  let inComment = false
  for (const line of text.split('\n')) {
    let rest = line
    for (;;) {
      if (inComment) {
        const close = rest.indexOf('-->')
        if (close === -1) { rest = ''; break }
        rest = rest.slice(close + 3)
        inComment = false
      }
      else {
        const open = rest.indexOf('<!--')
        if (open === -1) { out += rest; rest = ''; break }
        out += rest.slice(0, open)
        rest = rest.slice(open + 4)
        inComment = true
      }
    }
    out += ' '
  }
  return out.replace(/</g, '\n<').split('\n').map(l => l.trim()).filter(l => l !== '')
}

// check_mqttd

const MQTTD_CHECKS: readonly CheckCase[] = [
  prefixedRegularFile('mqttd-bin', 'mqttd', MQTTD_BIN,
    'so the MQTT bridge is not in this image at all — the crate builds and its '
    + 'protocol tests pass either way'),
  prefixedRegularFile('mqttd-unit', 'mqttd', MQTTD_UNIT,
    'so the MQTT bridge is not in this image at all — the crate builds and its '
    + 'protocol tests pass either way'),

  {
    id: 'mqttd-legacy-policy-absent',
    shell: {
      pass: 'mqttd: the legacy micad exception policy is absent',
      fail: 'mqttd: the legacy micad exception policy still exists',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const present = entry(await packedRoot(ctx), LEGACY_MQTTD_POLICY) !== undefined
      return [verdict(
        'mqttd-legacy-policy-absent',
        !present,
        present
          ? `mqttd: the legacy micad exception policy still exists at ${LEGACY_MQTTD_POLICY}; the `
            + 'bridge must receive no com.mica.micad calls or signals'
          : `mqttd: the legacy micad exception policy is absent (${LEGACY_MQTTD_POLICY}); application `
            + 'packages own their exact Item1 grants',
      )]
    },
  },

  {
    id: 'mqttd-applications-directory',
    shell: {
      pass: `mqttd: ${APPLICATIONS_DIR} is a directory`,
      fail: `mqttd: ${APPLICATIONS_DIR} is missing or not a directory`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const ok = entry(await packedRoot(ctx), APPLICATIONS_DIR)?.isDirectory() === true
      return [verdict(
        'mqttd-applications-directory',
        ok,
        ok
          ? `mqttd: ${APPLICATIONS_DIR} is a directory for exact package-owned enrollments`
          : `mqttd: ${APPLICATIONS_DIR} is missing or not a directory, so no application package can `
            + 'make its explicit MQTT enrollment visible to the bridge',
      )]
    },
  },

  {
    // NOT enabled. An enablement symlink baked into the image is the one thing
    // `mqtt.enabled` cannot override, and the root is read-only so nobody can
    // remove it on the device.
    id: 'mqttd-not-enabled',
    shell: {
      pass: 'mqttd: the bridge is NOT enabled in the image (',
      fail: 'so the bridge starts at boot regardless of mqtt.enabled',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      // `[ ! -e ] && [ ! -L ]`, and NOT either alone: a wants symlink points at
      // an ABSOLUTE path under /usr/lib, which resolves to nothing whenever
      // ROOT is an unpacked tree rather than /. -e follows the link and would
      // call a present-but-dangling symlink absent -- passing this check on
      // exactly the image that failed it. lstat answers what is AT the path.
      const present = entry(await packedRoot(ctx), MQTTD_WANTS) !== undefined
      return [verdict(
        'mqttd-not-enabled',
        !present,
        present
          ? `mqttd: ${MQTTD_WANTS} exists, so the bridge starts at boot regardless of mqtt.enabled `
            + `— publishing against a broker the same switch has not started, which is the 30s retry `
            + `loop this work exists to end. The root filesystem is a read-only verity squashfs, so `
            + `nobody can disable it on the device`
          : `mqttd: the bridge is NOT enabled in the image (${MQTTD_WANTS} absent); micad starts it `
            + `when mqtt.enabled becomes true and not before`,
      )]
    },
  },

  {
    // A STATIC identity. This is the one that silently breaks the grant:
    // dbus-daemon resolves `<policy user=>` when it READS the file at startup,
    // before any dynamic user for the unit exists, so the grant would load and
    // match nothing -- and the bridge connects to the broker and publishes
    // nothing, with no error at the point of cause.
    id: 'mqttd-static-user',
    shell: {
      pass: "mqttd: the unit runs as the static user '",
      fail: "mqttd: the unit sets User='",
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const user = unitValue(root, MQTTD_UNIT, 'User')
      const dynamic = unitValue(root, MQTTD_UNIT, 'DynamicUser')
      const ok = user !== '' && (dynamic === '' ? 'no' : dynamic) !== 'yes'
      return [verdict(
        'mqttd-static-user',
        ok,
        ok
          ? `mqttd: the unit runs as the static user '${user}', an identity a <policy user=> can resolve`
          : `mqttd: the unit sets User='${user}' DynamicUser='${dynamic}'. dbus-daemon resolves `
            + `<policy user=> when it reads each application package's policy, before any dynamic user `
            + `for the unit exists, so every exact Item1 grant would load and match nothing`,
      )]
    },
  },

  {
    // The identity has to EXIST in the image, or systemd cannot start the unit
    // and dbus-daemon cannot resolve the rule. Both failures are at boot, on
    // the device.
    id: 'mqttd-user-in-passwd',
    shell: {
      pass: "' exists in the image's /etc/passwd (",
      fail: 'and no such account is in ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const user = unitValue(root, MQTTD_UNIT, 'User')
      const found = accounts(root).find(a => a.name === user)
      const ok = user !== '' && found !== undefined
      return [verdict(
        'mqttd-user-in-passwd',
        ok,
        ok && found !== undefined
          ? `mqttd: '${user}' exists in the image's /etc/passwd (uid ${found.uid}, gid ${found.gid}, `
            + `shell ${found.shell})`
          : `mqttd: the unit runs as '${user}' and no such account is in ${root}/etc/passwd. systemd `
            + `refuses to start the unit and dbus-daemon drops the policy rule; both failures are at `
            + `boot, on the device`,
      )]
    },
  },

  {
    id: 'mqttd-device-id-runtime-input',
    shell: {
      pass: 'mqttd: device identity is a mandatory /run input and an explicit argument',
      fail: 'mqttd: device identity is not isolated as the mandatory runtime input',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const conditions = unitValues(root, MQTTD_UNIT, 'ConditionPathExists')
      const envfiles = unitValues(root, MQTTD_UNIT, 'EnvironmentFile')
      const exec = execStart(root, MQTTD_UNIT)
      const ok = conditions.includes(DEVICE_ID_ENV)
        && envfiles.includes(DEVICE_ID_ENV)
        && !envfiles.includes(`-${DEVICE_ID_ENV}`)
        && exec.includes('--device-id ${MICA_MQTT_DEVICE_ID}')
      return [verdict(
        'mqttd-device-id-runtime-input',
        ok,
        ok
          ? `mqttd: device identity is a mandatory /run input and an explicit argument (${DEVICE_ID_ENV})`
          : `mqttd: device identity is not isolated as the mandatory runtime input ${DEVICE_ID_ENV}: `
            + `ConditionPathExists=[${conditions.join(' ')}] EnvironmentFile=[${envfiles.join(' ')}] `
            + `ExecStart=[${exec}]. It must not be fetched from com.mica.micad`,
      )]
    },
  },

  {
    id: 'mqttd-zero-micad-access',
    shell: {
      pass: 'mqttd: no D-Bus policy grants the bridge access to com.mica.micad',
      fail: 'mqttd: D-Bus policy still grants the bridge access to com.mica.micad',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const user = unitValue(root, MQTTD_UNIT, 'User')
      const rules = identityPolicyRules(root, user).filter(rule =>
        rule.tag.includes('send_destination="com.mica.micad"')
        || rule.tag.includes('receive_sender="com.mica.micad"'))
      return [verdict(
        'mqttd-zero-micad-access',
        rules.length === 0,
        rules.length === 0
          ? 'mqttd: no D-Bus policy grants the bridge calls to or signals from com.mica.micad'
          : `mqttd: D-Bus policy still grants the bridge access to com.mica.micad: `
            + rules.map(rule => `${rule.path} [${rule.tag}]`).join(' '),
      )]
    },
  },

  {
    id: 'mqttd-exact-application-grants',
    shell: {
      pass: 'mqttd: every enrollment and Item1 grant names the same exact application service',
      fail: 'mqttd: application enrollment and Item1 grants are not exact and paired',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const user = unitValue(root, MQTTD_UNIT, 'User')
      const enrollment = enrolledApplications(root)
      const ownership = exactOwnershipGrants(root)
      const applicationRules = identityPolicyRules(root, user).filter((rule) => {
        const endpoint = rule.tag.match(/(?:send_destination|receive_sender)="([^"]*)"/)?.[1]
        return endpoint === '*'
          || endpoint?.startsWith('com.mica') === true
          || rule.tag.includes('send_interface="com.mica.Item1"')
          || rule.tag.includes('receive_interface="com.mica.Item1"')
      })
      const granted = new Map<string, Set<string>>()
      const invalid = [...enrollment.invalid.map(name => `invalid enrollment ${name}`)]
      for (const rule of applicationRules) {
        const endpoint = rule.tag.match(/(?:send_destination|receive_sender)="([^"]*)"/)?.[1] ?? ''
        const member = rule.tag.match(/(?:send|receive)_member="([^"]*)"/)?.[1] ?? ''
        const direction = rule.tag.includes('send_destination=') ? 'send' : 'receive'
        const interfaceName = rule.tag.match(/(?:send|receive)_interface="([^"]*)"/)?.[1] ?? ''
        const allowedMember = direction === 'send'
          ? member === 'GetItems' || member === 'SetValue'
          : member === 'ItemsChanged'
        if (!exactApplicationName(endpoint) || interfaceName !== 'com.mica.Item1' || !allowedMember) {
          invalid.push(`${rule.path} [${rule.tag}]`)
          continue
        }
        const members = granted.get(endpoint) ?? new Set<string>()
        members.add(`${direction}:${member}`)
        granted.set(endpoint, members)
        if (!enrollment.names.has(endpoint)) invalid.push(`unenrolled grant ${endpoint} in ${rule.path}`)
      }
      // micad's registry probes every com.mica.* service with GetItems as root,
      // and the stock system bus denies method calls by default with no root
      // exemption. A package that grants only the bridge is published to MQTT
      // and reported non-conforming by the registry on every boot.
      const registryGrants = identityPolicyRules(root, 'root').filter((rule) => {
        const interfaceName = rule.tag.match(/\bsend_interface="([^"]*)"/)?.[1]
        const member = rule.tag.match(/\bsend_member="([^"]*)"/)?.[1]
        return (interfaceName === undefined || interfaceName === 'com.mica.Item1')
          && (member === undefined || member === 'GetItems')
      })
      for (const name of enrollment.names) {
        if (!registryGrants.some(rule => rule.tag.includes(`send_destination="${name}"`))) {
          invalid.push(`enrollment ${name} lacks a root GetItems grant for the micad registry`)
        }
        const ownerGrants = ownership.filter(grant => grant.name === name)
        if (ownerGrants.length === 0) {
          invalid.push(`enrollment ${name} has no exact user-scoped ownership grant`)
        }
        else {
          for (const grant of ownerGrants) {
            if (grant.user === undefined || grant.user === '' || grant.user === '*') {
              invalid.push(
                `ownership grant ${name} in ${grant.path} is not scoped to one explicit user [${grant.tag}]`,
              )
            }
          }
        }
        const members = granted.get(name)
        if (members?.has('send:GetItems') !== true || members.has('receive:ItemsChanged') !== true) {
          invalid.push(`enrollment ${name} lacks GetItems and ItemsChanged grants`)
        }
      }
      return [verdict(
        'mqttd-exact-application-grants',
        invalid.length === 0,
        invalid.length === 0
          ? `mqttd: every enrollment and Item1 grant names the same exact application service `
            + `(${enrollment.names.size} enrolled)`
          : `mqttd: application enrollment and Item1 grants are not exact and paired: ${invalid.join('; ')}`,
      )]
    },
  },

  {
    // The broker must be configurable WITHOUT reflashing. The root is an
    // immutable squashfs and `systemctl edit` has nowhere to write, so a
    // literal address here is the same address on every device flashed with
    // this image, unchangeable.
    id: 'mqttd-broker-from-environment',
    shell: {
      pass: 'mqttd: ExecStart takes the broker from the environment',
      fail: 'mqttd: ExecStart does not reference',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const exec = execStart(await packedRoot(ctx), MQTTD_UNIT)
      const ok = exec.includes('${MICA_MQTT_BROKER_HOST}')
      return [verdict(
        'mqttd-broker-from-environment',
        ok,
        ok
          ? 'mqttd: ExecStart takes the broker from the environment, so the address is not baked into '
            + 'the verity root'
          : `mqttd: ExecStart does not reference \${MICA_MQTT_BROKER_HOST}: [${exec}]. The root `
            + `filesystem is read-only and systemctl edit has nowhere to write, so a literal broker `
            + `address here is the same address on every device flashed with this image, unchangeable`,
      )]
    },
  },

  {
    // ...and the file it reads that from has to be on writable, persistent
    // storage, which on this appliance means a STATE-backed bind. OPTIONAL
    // (leading '-'), or an unconfigured device fails to start the unit, which
    // is a worse default than running unconfigured.
    //
    // Three failure sentences, and they share nothing but `EnvironmentFile` --
    // which the shadow family's PASS line also carries. A fail matcher is only
    // ever tried against FAIL lines, so the list below is exact and the overlap
    // is not reachable.
    id: 'mqttd-envfile-on-state',
    shell: {
      pass: 'mqttd: EnvironmentFile=',
      fail: [
        'mqttd: the unit has no EnvironmentFile= line at all',
        "is not optional (no leading '-')",
        'which no .mount unit in the image mounts',
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const envfile = unitValues(root, MQTTD_UNIT, 'EnvironmentFile')
        .find(value => value.startsWith('-')) ?? ''
      if (envfile === '') {
        return [verdict('mqttd-envfile-on-state', false,
          `mqttd: the unit has no EnvironmentFile= line at all, so ${MQTTD_UNIT}'s Environment= `
          + `defaults are the only configuration and the broker cannot be changed on the device at all`)]
      }
      const path = envfile.replace(/^-/, '')
      if (path === envfile) {
        return [verdict('mqttd-envfile-on-state', false,
          `mqttd: EnvironmentFile=${envfile} is not optional (no leading '-'). A device whose operator `
          + `has not written that file fails to start the unit, which is a worse default than running `
          + `unconfigured`)]
      }
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '/'
      const mount = mountUnitFor(root, dir)
      if (mount === undefined) {
        return [verdict('mqttd-envfile-on-state', false,
          `mqttd: EnvironmentFile=${envfile} sits under ${dir}, which no .mount unit in the image `
          + `mounts. That path is inside the read-only verity squashfs, so the operator cannot write `
          + `it and the broker stays whatever the image was built with`)]
      }
      return [verdict('mqttd-envfile-on-state', true,
        `mqttd: EnvironmentFile=${envfile} sits under ${dir}, a bind mounted by `
        + `${mount.name} (What=${mount.what}), so a broker configured on the device survives a reboot `
        + `and an A/B update`)]
    },
  },
]

/** `grep -rl "^Where=${dir}$" /etc/systemd/system`, taking the first hit. */
function mountUnitFor(root: string, dir: string): { name: string, what: string } | undefined {
  let names: string[]
  try {
    names = readdirSync(join(root, '/etc/systemd/system')).sort()
  }
  catch {
    return undefined
  }
  for (const name of names) {
    const path = `/etc/systemd/system/${name}`
    if (entry(root, path)?.isFile() !== true) continue
    const text = readFileSync(join(root, path), 'utf8')
    if (!text.split('\n').some(l => l === `Where=${dir}`)) continue
    const what = text.split('\n').filter(l => l.startsWith('What=')).map(l => l.slice(5))
    return { name, what: what[what.length - 1] ?? '' }
  }
  return undefined
}

// check_mqtt_broker

const BROKER_CHECKS: readonly CheckCase[] = [
  prefixedRegularFile('mqtt-broker-bin', 'mqtt-broker', BROKER_BIN,
    'so mqtt.enabled has nothing to start. The bridge then publishes at a broker that is not in the '
    + 'image and retries forever, which is the noise this work exists to end'),
  prefixedRegularFile('mqtt-broker-unit', 'mqtt-broker', BROKER_UNIT,
    'so mqtt.enabled has nothing to start. The bridge then publishes at a broker that is not in the '
    + 'image and retries forever, which is the noise this work exists to end'),

  {
    // The unit carries [Install] information deliberately, and the image
    // deliberately does not act on it: a broker enabled in the image would be
    // listening from early boot, before anything had consulted the switch.
    //
    // There is no policy file in this set and that is not an omission. The
    // broker speaks no D-Bus at all -- it reads one file micad renders into /run
    // and listens on a TCP socket -- so it has nothing to be granted.
    id: 'mqtt-broker-not-enabled',
    shell: {
      pass: 'mqtt-broker: the broker is NOT enabled in the image (',
      fail: 'so the broker listens from early boot',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const present = entry(await packedRoot(ctx), BROKER_WANTS) !== undefined
      return [verdict(
        'mqtt-broker-not-enabled',
        !present,
        present
          ? `mqtt-broker: ${BROKER_WANTS} exists, so the broker listens from early boot on every `
            + `device flashed with this image, before anything consulted mqtt.enabled — and micad owns `
            + `the lifecycle, so the switch it is meant to obey is the one thing that cannot turn it `
            + `off. The root filesystem is a read-only verity squashfs, so systemctl disable has `
            + `nowhere to write on the device`
          : `mqtt-broker: the broker is NOT enabled in the image (${BROKER_WANTS} absent); micad owns `
            + `the lifecycle and starts it from mqtt.enabled`,
      )]
    },
  },

  {
    // A STATIC identity, for a DIFFERENT reason than the bridge's: a dynamic
    // uid is allocated at start and gone at stop, so
    // /var/lib/mica/mqtt-broker-users.toml would be left owned by a number that
    // names nobody on the next boot.
    id: 'mqtt-broker-static-user',
    shell: {
      pass: "mqtt-broker: the unit runs as the static user '",
      fail: "mqtt-broker: the unit sets User='",
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const user = unitValue(root, BROKER_UNIT, 'User')
      const dynamic = unitValue(root, BROKER_UNIT, 'DynamicUser')
      const ok = user !== '' && (dynamic === '' ? 'no' : dynamic) !== 'yes'
      return [verdict(
        'mqtt-broker-static-user',
        ok,
        ok
          ? `mqtt-broker: the unit runs as the static user '${user}', an identity a credentials file `
            + `on STATE can be owned by`
          : `mqtt-broker: the unit sets User='${user}' DynamicUser='${dynamic}'. A dynamic uid is `
            + `allocated at start and gone at stop, so /var/lib/mica/mqtt-broker-users.toml would be `
            + `left owned by a number that names nobody on the next boot, and the only way to keep `
            + `the credentials readable would be to make them readable by everyone`,
      )]
    },
  },

  {
    id: 'mqtt-broker-user-in-passwd',
    shell: {
      pass: "mqtt-broker: the account '",
      fail: 'and no account of that name is in ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const user = unitValue(root, BROKER_UNIT, 'User')
      const found = accounts(root).find(a => a.name === user)
      const ok = user !== '' && found !== undefined
      return [verdict(
        'mqtt-broker-user-in-passwd',
        ok,
        ok && found !== undefined
          ? `mqtt-broker: the account '${user}' is present in the image (uid ${found.uid}, gid `
            + `${found.gid}, shell ${found.shell})`
          : `mqtt-broker: the unit runs as '${user}' and no account of that name is in `
            + `${root}/etc/passwd. systemd refuses to start the unit, so turning mqtt.enabled on `
            + `brings up a bridge and no broker, and the failure is at boot on the device`,
      )]
    },
  },
]

// Every MQTT check needs the mqtt feature: a product without it ships neither the bridge nor the broker.
export const MQTT_CHECKS: readonly CheckCase[] = [...MQTTD_CHECKS, ...BROKER_CHECKS].map(c => ({ ...c, features: ['mqtt'] }))
