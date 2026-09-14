// The D-Bus policies: the system bus, micad's local root-only management name,
// the absence of namespace-wide application grants, and bluez's policy.
//
// Eleven conclusions on each board, one of them a SKIP on x64. Everything here
// reads the unpacked root and nothing else.
//
// A policy parser and not a grep. A D-Bus rule routinely spans several source
// lines, so a line-oriented reader sees the bus name and the member on different
// lines and concludes the grant names no member -- the dangerous direction,
// because it turns a correctly scoped grant into a reported hazard whose obvious
// repair is to stop scoping it. So both of the oracle's readers are ported as readers:
// `stripComments` is `dbus_policy_rules_only`, an awk state machine over
// `<!--`/`-->` that spans lines and preserves line structure; `policyTags` is
// `dbus_policy_tags`, the same text reflowed to one XML tag per line,
// which is what makes a per-line scoped/member judgement sound; `policyFacts` is
// the awk , rules collected per <policy> block, because a rule's block
// decides who it applies to.
//
// The bus name is read, never written down. `com.mica.micad` appears nowhere here
// as the name being checked: the oracle reads it out of micad.service's
// `BusName=` so that a policy for a name nothing owns fails rather than
// sails through. Restating it would put the constant back in two places.

import { readFileSync, readdirSync } from 'node:fs'
import type { Board } from './board.ts'
import { hasRadio } from './board-scope.ts'
import { packedRoot, pathInRoot, regularFileInRoot } from './checks-root.ts'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { skipped, verdict } from './verdict.ts'

const MICAD_POLICY_PATH = '/usr/share/dbus-1/system.d/com.mica.micad.conf'
const LEGACY_EXT_POLICY_PATH = '/usr/share/dbus-1/system.d/com.mica.ext.conf'
const MICAD_UNIT = '/usr/lib/systemd/system/micad.service'
const POLICY_DIRS = ['/etc/dbus-1/system.d', '/usr/share/dbus-1/system.d'] as const

// reading a file the way the oracle's shell reads one

/**
 * `cat "${ROOT}${path}" 2>/dev/null || true` -- the empty string when absent.
 *
 * `pathInRoot` and not `join`: the path is resolved INSIDE the root, so a
 * policy file reached through an absolute symlink is the image's policy and
 * never the host's. The throw it makes on an unresolvable path lands in the
 * catch this reader already has, which is where absence is already answered.
 */
function readOrEmpty(root: string, path: string): string {
  try {
    return readFileSync(pathInRoot(root, path), 'utf8')
  }
  catch {
    return ''
  }
}

/**
 * `dbus_policy_rules_only`: XML comments removed.
 *
 * The state machine is the oracle's, transcribed: `incomment` persists ACROSS
 * lines, an unterminated `<!--` swallows the rest of the file, and every input
 * line still produces exactly one output line. That last property is not
 * incidental -- `check_ext_policy` runs `grep -Eo` over the result and the
 * micad parse splits it on `<policy`, and both would read differently if the
 * stripper joined lines.
 */
export function stripXmlComments(text: string): string {
  let inComment = false
  const out: string[] = []
  for (const raw of text.split('\n')) {
    let line = raw
    let kept = ''
    while (line.length > 0) {
      if (inComment) {
        const close = line.indexOf('-->')
        if (close === -1) {
          line = ''
          break
        }
        line = line.slice(close + 3)
        inComment = false
      }
      else {
        const open = line.indexOf('<!--')
        if (open === -1) {
          kept += line
          line = ''
          break
        }
        kept += line.slice(0, open)
        line = line.slice(open + 4)
        inComment = true
      }
    }
    out.push(kept)
  }
  return out.join('\n')
}

/**
 * `dbus_policy_tags`: the rules, reflowed to one XML tag per line.
 *
 * `tr '\n' ' ' | sed 's|>|>\n|g'` then a trim and a whitespace collapse, then
 * `grep .` to drop what is left empty. The trailing newline `tr` produces
 * becomes a final space, and the split leaves a tail after the last `>`; both
 * end up empty and are dropped, exactly as `grep .` drops them.
 */
export function policyTags(text: string): string[] {
  const joined = stripXmlComments(text).replaceAll('\n', ' ')
  return joined
    .split(/(?<=>)/)
    .map(s => s.replace(/^\s*/, '').replace(/\s+/g, ' '))
    .filter(s => s !== '')
}

// the micad policy, parsed per <policy> BLOCK

export interface PolicyFacts {
  /** `<allow>` rules in a default-context block naming the bus in either direction. */
  readonly defaultAllows: number
  /** `allow own="<bus>"` under `<policy user="root">`. */
  readonly ownRoot: number
  /** ...and anywhere else. */
  readonly ownOther: number
  /** Every `com.mica.*` name any rule mentions, sorted and deduplicated. */
  readonly names: readonly string[]
}

/** `attrval`: the value of `key="..."`, or the empty string. */
function attrValue(tag: string, key: string): string {
  const at = tag.indexOf(`${key}="`)
  if (at === -1) return ''
  const rest = tag.slice(at + key.length + 2)
  const close = rest.indexOf('"')
  return close === -1 ? '' : rest.slice(0, close)
}

/**
 * The awk , transcribed.
 *
 * `doc` is built as `doc " " out` per line -- so lines are joined by a SPACE
 * and not by a newline, which is what lets a rule wrapped across three source
 * lines be read as one tag. Then the whole document is split on `<policy`, each
 * segment's attributes are what precede its first `>`, and its body is
 * truncated at `</policy>`.
 *
 * A token counts as a rule only when it begins `allow` or `deny` followed by
 * WHITESPACE, which is the oracle's `/^allow[ \t]/`: `<allowance ...>` is not a
 * rule and neither is a bare `<allow>` with no attributes.
 */
export function policyFacts(text: string, bus: string): PolicyFacts {
  const doc = stripXmlComments(text).split('\n').map(l => ` ${l}`).join('')
  const names = new Set<string>()
  let defaultAllows = 0
  let ownRoot = 0
  let ownOther = 0

  const segments = doc.split('<policy')
  for (const segment of segments.slice(1)) {
    const gt = segment.indexOf('>')
    const attrs = gt >= 0 ? segment.slice(0, gt) : segment
    let body = gt >= 0 ? segment.slice(gt + 1) : ''
    const end = body.indexOf('</policy>')
    if (end >= 0) body = body.slice(0, end)
    const isDefault = attrs.includes('context="default"')
    const isRoot = attrs.includes('user="root"')

    for (const token of body.split('<')) {
      let kind: 'allow' | 'deny'
      if (/^allow[ \t]/.test(token)) kind = 'allow'
      else if (/^deny[ \t]/.test(token)) kind = 'deny'
      else continue
      const close = token.indexOf('>')
      const tag = close >= 0 ? token.slice(0, close) : token
      const own = attrValue(tag, 'own')
      const send = attrValue(tag, 'send_destination')
      const receive = attrValue(tag, 'receive_sender')
      for (const v of [own, send, receive]) {
        if (/^com\.mica\./.test(v)) names.add(v)
      }
      if (kind === 'allow' && isDefault && (send === bus || receive === bus)) defaultAllows += 1
      if (kind === 'allow' && own === bus && own !== '') {
        if (isRoot) ownRoot += 1
        else ownOther += 1
      }
    }
  }
  // `tr ' ' '\n' | grep -v '^$' | sort -u`: the awk's own iteration order is
  // unspecified, and the shell sorts it before comparing. Sorted here for the
  // same reason -- a set compared as a string has to have one spelling.
  return { defaultAllows, ownRoot, ownOther, names: [...names].sort() }
}

/**
 * The oracle's `sed -n` for `BusName=`, with `tr -d '\r'` and `tail -n1` after it.
 *
 * The LAST such line, not the first: systemd itself takes the last assignment
 * of a key in a unit file, and a unit carrying two would otherwise be judged
 * against a value it does not use.
 */
export function micadBusName(root: string): string {
  const lines = readOrEmpty(root, MICAD_UNIT).split('\n')
    .filter(l => l.startsWith('BusName='))
    .map(l => l.slice('BusName='.length).replace(/^[ \t]*/, '').replaceAll('\r', ''))
  return lines.at(-1) ?? ''
}

// the second-policy-file search

export interface SecondFile {
  readonly path: string
  /** The rule lines that name the bus WITHOUT being both scoped and per-member. */
  readonly unscoped: string[]
}

/**
 * Every OTHER policy file that mentions the bus name, and how it mentions it.
 *
 * The oracle walks /etc/dbus-1/system.d before /usr/share/dbus-1/system.d and
 * takes each directory's entries in shell-glob order, which is lexical; the
 * blessed file is excluded by name rather than by directory, because a second
 * file in /usr/share is exactly as dangerous as one in /etc.
 *
 * micad is a local management service. Its own policy is the only policy file
 * allowed to mention its exact name; mqttd and application packages receive no
 * exception, even when a second rule looks narrow.
 */
export function secondPolicyFiles(root: string, bus: string): SecondFile[] {
  const found: SecondFile[] = []
  if (bus === '') return found
  for (const dir of POLICY_DIRS) {
    let entries: string[]
    try {
      entries = readdirSync(pathInRoot(root, dir)).sort()
    }
    catch {
      continue
    }
    for (const name of entries) {
      const path = `${dir}/${name}`
      if (path === MICAD_POLICY_PATH) continue
      // `[ -f "${f}" ]` -- the glob's own entries, so a directory is skipped.
      if (!regularFileInRoot(root, path)) continue
      const tags = policyTags(readOrEmpty(root, path))
      if (!tags.some(t => t.includes(bus))) continue
      const unscoped = tags.filter(tag => tag.includes(bus))
      found.push({ path, unscoped })
    }
  }
  return found
}

// the checks

const MICAD_CHECKS: readonly CheckCase[] = [
  {
    // The system bus itself. Two files, one conclusion: apid, micad and bluez
    // all address each other over it, so either one missing is the same fault.
    id: 'dbus-system-bus-present',
    shell: {
      pass: 'the D-Bus system bus (dbus.service + dbus.socket) is present',
      fail: 'dbus.service and/or dbus.socket missing',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const ok = regularFileInRoot(root, '/usr/lib/systemd/system/dbus.service')
        && regularFileInRoot(root, '/usr/lib/systemd/system/dbus.socket')
      return [verdict(
        'dbus-system-bus-present',
        ok,
        ok
          ? 'the D-Bus system bus (dbus.service + dbus.socket) is present, so bus-activated services can run'
          : 'dbus.service and/or dbus.socket missing; apid, micad and bluez all address each other '
            + 'over the system bus',
      )]
    },
  },

  {
    // WHERE the policy is, not merely that a policy exists. dbus-daemon reads
    // system-bus policy from this directory and /etc/dbus-1/system.d; a policy
    // dropped anywhere else is not a stricter policy, it is NO policy.
    //
    // The test is on the file's CONTENT being non-empty, because that is what
    // `[ -n "$(cat ...)" ]` asks: a zero-byte file at the right path passes
    // every "is it there" check and governs nothing.
    id: 'micad-policy-ships',
    features: ['micad'],
    shell: {
      pass: `${MICAD_POLICY_PATH} ships and is readable`,
      fail: `${MICAD_POLICY_PATH} is missing or empty`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const text = readOrEmpty(await packedRoot(ctx), MICAD_POLICY_PATH)
      const ok = text !== ''
      return [verdict(
        'micad-policy-ships',
        ok,
        ok
          ? `${MICAD_POLICY_PATH} ships and is readable, i.e. the micad bus policy is where dbus-daemon `
            + `actually looks for it`
          : `${MICAD_POLICY_PATH} is missing or empty. dbus-daemon reads system-bus policy from this `
            + `directory; with nothing here the base system.conf decides alone, and every local uid `
            + `can call Reboot, SetSettings and SetTransientRootPassword`,
      )]
    },
  },

  {
    // BOTH directions. send_destination is the obvious half; receive_sender is
    // the half that is easy to leave open, because SettingsChanged broadcasts
    // the settings VALUE -- a uid that may not call anything can still
    // subscribe and read access.webAdmin.password_hash.
    id: 'micad-policy-no-default-allow',
    features: ['micad'],
    shell: {
      pass: 'no <policy context="default"> allows send_destination= or receive_sender= for ',
      fail: 'default-context allow rule(s) for ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const bus = micadBusName(root)
      const facts = policyFacts(readOrEmpty(root, MICAD_POLICY_PATH), bus)
      const ok = facts.defaultAllows === 0
      return [verdict(
        'micad-policy-no-default-allow',
        ok,
        ok
          ? `no <policy context="default"> allows send_destination= or receive_sender= for `
            + `${bus === '' ? 'the micad bus name' : bus}, so neither calling it nor listening to its `
            + `signals is open to every local uid`
          : `the micad D-Bus policy has ${facts.defaultAllows} default-context allow rule(s) for `
            + `${bus === '' ? 'the micad bus name' : bus}: any local uid can call `
            + `Reboot/SetSettings/SetTransientRootPassword and/or subscribe to SettingsChanged, which `
            + `carries settings values including access.webAdmin.password_hash`,
      )]
    },
  },

  {
    // own= is what lets micad take the name at all. At least once under root and
    // nowhere else: zero under root would mean micad cannot own its own name,
    // and one anywhere else would let an unprivileged process take it FIRST.
    id: 'micad-policy-own-root-only',
    features: ['micad'],
    shell: {
      pass: 'appears only under <policy user="root">',
      fail: 'time(s) under <policy user="root"> and ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const bus = micadBusName(root)
      const facts = policyFacts(readOrEmpty(root, MICAD_POLICY_PATH), bus)
      const ok = facts.ownRoot !== 0 && facts.ownOther === 0
      return [verdict(
        'micad-policy-own-root-only',
        ok,
        ok
          ? `allow own="${bus}" appears only under <policy user="root">`
          : `allow own= for '${bus}' appears ${facts.ownRoot} time(s) under <policy user="root"> and `
            + `${facts.ownOther} time(s) elsewhere; it must appear at least once under root and nowhere `
            + `else, or an unprivileged process could take the name before micad does`,
      )]
    },
  },

  {
    // The typo that is invisible by inspection: a deny naming com.mica.micadx
    // denies nothing, and the default-context check above would still report
    // zero allows while the real name sat wide open.
    id: 'micad-policy-names-the-owned-bus',
    features: ['micad'],
    shell: {
      pass: 'the policy names exactly the bus micad.service declares (BusName=',
      fail: 'policy/unit bus-name mismatch: ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const bus = micadBusName(root)
      const facts = policyFacts(readOrEmpty(root, MICAD_POLICY_PATH), bus)
      const mentioned = facts.names.join(' ')
      const ok = bus !== '' && mentioned === bus
      return [verdict(
        'micad-policy-names-the-owned-bus',
        ok,
        ok
          ? `the policy names exactly the bus micad.service declares (BusName=${bus}); it is not a `
            + `policy for a name nothing owns`
          : `policy/unit bus-name mismatch: micad.service declares BusName='${bus}' but the policy `
            + `mentions '${mentioned}'. A policy naming anything else guards a name nothing owns while `
            + `the real one is governed by system.conf alone`,
      )]
    },
  },

  {
    // One policy file. A narrow-looking second exception is still a management
    // export and therefore a boundary violation.
    id: 'micad-policy-no-second-file-widens',
    features: ['micad'],
    shell: {
      pass: ' is the ONLY file under ',
      fail: 'a second D-Bus policy file mentions ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const bus = micadBusName(root)
      const others = secondPolicyFiles(root, bus)
      const id = 'micad-policy-no-second-file-widens'
      if (others.length > 0) {
        const detail = others.map(f => ` ${f.path} [${f.unscoped.join(' ')} ]`).join('')
        return [verdict(id, false,
          `a second D-Bus policy file mentions ${bus === '' ? 'the micad bus name' : bus}:${detail}. `
          + 'micad is local management only, so even a per-member identity exception is forbidden')]
      }
      return [verdict(id, true,
        `${MICAD_POLICY_PATH} is the ONLY file under /etc/dbus-1/system.d or /usr/share/dbus-1/system.d `
        + `that mentions ${bus === '' ? 'the micad bus name' : bus}; no second policy can override the `
        + `root-only restriction`)]
    },
  },
]

function micaPrefixGrants(root: string): string[] {
  const found: string[] = []
  for (const dir of POLICY_DIRS) {
    let entries: string[]
    try {
      entries = readdirSync(pathInRoot(root, dir)).sort()
    }
    catch {
      continue
    }
    for (const name of entries) {
      const path = `${dir}/${name}`
      if (!regularFileInRoot(root, path)) continue
      for (const tag of policyTags(readOrEmpty(root, path))) {
        const prefix = tag.match(/\bown_prefix="([^"]*)"/)?.[1]
        if (prefix === 'com.mica' || prefix?.startsWith('com.mica.') === true) {
          found.push(`${path} [${tag}]`)
        }
      }
    }
  }
  return found
}

const NAMESPACE_CHECKS: readonly CheckCase[] = [
  {
    id: 'legacy-ext-policy-absent',
    shell: {
      pass: 'the legacy com.mica.ext prefix policy is absent',
      fail: 'the legacy com.mica.ext prefix policy still exists',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const present = regularFileInRoot(await packedRoot(ctx), LEGACY_EXT_POLICY_PATH)
      return [verdict(
        'legacy-ext-policy-absent',
        !present,
        present
          ? `the legacy com.mica.ext prefix policy still exists at ${LEGACY_EXT_POLICY_PATH}`
          : `the legacy com.mica.ext prefix policy is absent (${LEGACY_EXT_POLICY_PATH})`,
      )]
    },
  },
  {
    id: 'mica-namespace-no-prefix-ownership',
    shell: {
      pass: 'no D-Bus policy grants prefix ownership inside com.mica',
      fail: 'a D-Bus policy grants prefix ownership inside com.mica',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const grants = micaPrefixGrants(await packedRoot(ctx))
      return [verdict(
        'mica-namespace-no-prefix-ownership',
        grants.length === 0,
        grants.length === 0
          ? 'no D-Bus policy grants prefix ownership inside com.mica; application names require exact package grants'
          : `a D-Bus policy grants prefix ownership inside com.mica: ${grants.join(' ')}`,
      )]
    },
  },
]

// bluez's policy -- the verification contract. Board-conditional.

const hasBluetooth = (board: Board): boolean => hasRadio(board, 'bluetooth')

const BLUEZ_POLICY_PATHS = [
  '/usr/share/dbus-1/system.d/bluetooth.conf',
  '/etc/dbus-1/system.d/bluetooth.conf',
] as const

const BLUEZ_CHECKS: readonly CheckCase[] = [
  {
    // BOTH directories are accepted, and that is not laxity. bluez's policy
    // moved from /etc/dbus-1/system.d to /usr/share/dbus-1/system.d between
    // bookworm and trixie -- the general relocation of VENDOR policy out of
    // /etc, which is reserved for the admin's overrides. dbus-daemon reads
    // both, so asserting only the new path would make this refuse a correct
    // bookworm image.
    //
    // ONE entry owns both directions AND the skip: the oracle's `if !
    // board_has_radio` / `elif` / `else` is one three-way branch printing
    // exactly one line per board, so a separate `-skipped` entry would have
    // nothing left to claim on the board that skips.
    id: 'bluez-dbus-policy',
    features: ['bluetooth'],
    shell: {
      pass: 'bluez ships a D-Bus policy (in /usr/share/dbus-1/system.d or /etc/dbus-1/system.d)',
      fail: 'no bluetooth.conf in either dbus policy directory',
      skip: "bluez's D-Bus policy (",
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const { board } = ctx
      if (!hasBluetooth(board)) {
        return [skipped('bluez-dbus-policy',
          `bluez's D-Bus policy (${board.name} declares no bluetooth in BOARD_RADIOS): there is no `
          + `bluetoothd in the image to own org.bluez, so a policy granting the name would guard nothing`)]
      }
      const root = await packedRoot(ctx)
      const ok = BLUEZ_POLICY_PATHS.some(p => regularFileInRoot(root, p))
      return [verdict(
        'bluez-dbus-policy',
        ok,
        ok
          ? 'bluez ships a D-Bus policy (in /usr/share/dbus-1/system.d or /etc/dbus-1/system.d); '
            + 'without it bluetoothd cannot own org.bluez'
          : 'no bluetooth.conf in either dbus policy directory; bluetoothd cannot take org.bluez and '
            + 'every Bluetooth feature fails at runtime',
      )]
    },
  },
]

/**
 * The register's D-Bus batch.
 *
 * Only `bluez-dbus-policy` is board-conditional, and it is deliberately NOT
 * scoped by `boards:`: it applies everywhere and answers `skipped()` where the
 * board declares no controller, because the oracle's three-way branch prints
 * exactly ONE line for it on every board. `boards:` scoping is for the families
 * that print N lines on the board with the hardware and one group SKIP on the
 * board without; this is not one of them, and scoping it to the Bluetooth
 * boards would leave x64's SKIP line unclaimed forever.
 */
export const DBUS_CHECKS: readonly CheckCase[] = [
  ...MICAD_CHECKS,
  ...NAMESPACE_CHECKS,
  ...BLUEZ_CHECKS,
]
