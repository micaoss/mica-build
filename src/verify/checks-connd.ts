// Batch 4a: the connd contract, the Wi-Fi userland, and micad's networkd namespace.
//
// Twenty-two conclusions on cx3576 and four on uefi-x64: one contract read,
// nineteen assertions it feeds (all of them behind
// `board_has_radio wifi`), and the two namespace conclusions that run on every
// board.
//
// Every path, prefix and unit name the Wi-Fi assertions compare against is read
// out of `micad:micad/src/reconciler/` -- the pinned micad source, checked out
// by `src/pool/micad-pool.ts --source` into _out/src/mica-core -- rather than restated here, exactly as the
// oracle reads it. Reading those sources is in scope under the Scope
// section -- "No change to ... `micad/` Rust sources" -- while changing them is
// not, and nothing here writes. A reconciler that renders into a directory the
// image does not provide, or drives a unit the image does not install, fails on
// the device and nowhere else.
//
// The extractor itself rotted once, which is why there is no fallback. The
// oracle records it: the sweep marker was read with a regex over
// `file_name.contains("...")`, network.rs was refactored to an anchored
// `is_mica_managed()`, the regex stopped matching and the marker became "". The
// collision test `case "${n}" in *"${MICA_SWEEP}"*)` then became `**` and matched
// every filename, and the nineteen assertions fell back through
// `${STA_UNIT:-wpa_supplicant@.service}` and passed against the verifier's own
// restatement of a contract it had failed to read.
//
// So there is no `?? 'wpa_supplicant@.service'` anywhere here: an unread contract
// makes the group fail rather than substitute, the sweep is a prefix matched with
// an anchor, and the `.network` suffix is asserted rather than assumed. The
// register matchers are generated at module load for the same reason, so when
// the read fails the generated matcher is the degenerate string the oracle
// prints and the two sides stay comparable.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from './board.ts'
import { boardsWhere, hasRadio } from './board-scope.ts'
import { unitValue } from './checks-engine.ts'
import {
  entry,
  ETC_UNITS,
  linkTargetInRoot,
  packedRoot,
  pathInRoot,
  regularFileInRoot,
  statInRoot,
  wantsLink,
} from './checks-root.ts'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { REPO_ROOT } from './paths.ts'
import { skipped, verdict } from './verdict.ts'

/**
 * Where the reconcilers are read from.
 *
 * `MICA_VERIFY_RECONCILER_DIR` exists so a test can point this at a MUTATED copy
 * and watch the read fail -- without it the rot recorded above could not be
 * driven, only waited for. The oracle honours the same variable and
 * `the image fixture contract` is its one caller.
 */
export const RECONCILER_DIR: string = process.env['MICA_VERIFY_RECONCILER_DIR']
  ?? join(REPO_ROOT, '_out', 'src', 'mica-core', 'crates', 'micad', 'src', 'reconciler')

export interface ConndContract {
  readonly staDir: string
  readonly apDir: string
  readonly staUnit: string
  readonly apUnit: string
  readonly staConf: string
  readonly apConf: string
  readonly staPrefix: string
  readonly apPrefix: string
  readonly sweep: string
  /**
   * EVERY suffix the sweep predicate accepts, in source order.
   *
   * A LIST and not one string, because the predicate is a disjunction: micad
   * renders `.netdev` files as well as `.network` ones and sweeps both under
   * the same prefix. Reading only the first would describe a NARROWER sweep
   * than the code performs, and the collision check below would then let a
   * shipped `50-mica-*.netdev` through as clear while the reconciler deletes it
   * on the first pass.
   */
  readonly sweepSuffixes: readonly string[]
  /** Every field non-empty AND `.network` among the suffixes swept. */
  readonly read: boolean
}

function sourceLines(dir: string, file: string): string[] {
  try {
    return readFileSync(join(dir, file), 'utf8').split('\n')
  }
  catch {
    return []
  }
}

/** `awk 'NR == 1'` over a `sed -n ... p` -- the FIRST match, or the empty string. */
function firstCapture(lines: readonly string[], pattern: RegExp): string {
  for (const line of lines) {
    const m = pattern.exec(line)
    if (m?.[1] !== undefined) return m[1]
  }
  return ''
}

/**
 * EVERY capture of a `/g` pattern, across every line, in order.
 *
 * `firstCapture` cannot answer this and cannot be made to: its patterns are
 * anchored with a leading `.*`, which is greedy, so on a line carrying two
 * `ends_with` calls it captures the LAST one and reports it as the first. That
 * is not a hypothetical -- it is how a disjunctive sweep predicate came to be
 * read as sweeping only `.netdev`.
 */
function allCaptures(lines: readonly string[], pattern: RegExp): string[] {
  const found: string[] = []
  for (const line of lines) {
    for (const m of line.matchAll(pattern))
      if (m[1] !== undefined) found.push(m[1])
  }
  return found
}

/** `const NAME: &str = "...";` at the start of a line. */
function micadConst(dir: string, file: string, name: string): string {
  return firstCapture(sourceLines(dir, file), new RegExp(`^const ${name}: &str = "(.*)";$`))
}

/** The unit TEMPLATE behind `format!("x@{interface}.service")`. */
function micadUnitTemplate(dir: string, file: string): string {
  const stem = firstCapture(sourceLines(dir, file), /^ *format!\("(.*)@\{interface\}\.service"\)$/)
  return stem === '' ? '' : `${stem}@.service`
}

/** The rendered configuration file name, still carrying `{interface}`. */
function micadConfigName(dir: string, file: string): string {
  return firstCapture(sourceLines(dir, file), /^ *format!\("([^"]*\{interface\}[^"]*\.conf)"\)$/)
}

/**
 * The contract, or a record of having failed to read it.
 *
 * `read` is the oracle's own ten-way conjunction: every field non-empty
 * AND the sweep suffix exactly `.network`. The suffix is compared rather than
 * merely required to be present, because a marker read out of a `starts_with`
 * whose `ends_with` had changed would describe a wider sweep than the code
 * performs -- and the collision test below would then delete files network.rs
 * would never touch.
 */
export function readConndContract(dir: string): ConndContract {
  const staDir = micadConst(dir, 'wifi_client.rs', 'DEFAULT_CONFIG_DIR')
  const apDir = micadConst(dir, 'wifi_ap.rs', 'DEFAULT_CONFIG_DIR')
  const staUnit = micadUnitTemplate(dir, 'wifi_client.rs')
  const apUnit = micadUnitTemplate(dir, 'wifi_ap.rs')
  const staConf = micadConfigName(dir, 'wifi_client.rs')
  const apConf = micadConfigName(dir, 'wifi_ap.rs')
  const staPrefix = micadConst(dir, 'wifi_client.rs', 'NETWORKD_PREFIX')
  const apPrefix = micadConst(dir, 'wifi_ap.rs', 'NETWORKD_PREFIX')
  const network = sourceLines(dir, 'network.rs')
  const sweep = firstCapture(network, /.*file_name\.starts_with\("([^"]*)"\).*/)
  const sweepSuffixes = allCaptures(network, /file_name\.ends_with\("([^"]*)"\)/g)
  const read = [staDir, apDir, staUnit, apUnit, staConf, apConf, staPrefix, apPrefix, sweep]
    .every(v => v !== '') && sweepSuffixes.includes('.network')
  return {
    staDir, apDir, staUnit, apUnit, staConf, apConf, staPrefix, apPrefix, sweep, sweepSuffixes, read,
  }
}

/**
 * The contract, read ONCE for this process, exactly as the oracle reads it once
 * per run. The matchers below are generated from it.
 */
export const CONTRACT: ConndContract = readConndContract(RECONCILER_DIR)

const hasWifi = (board: Board): boolean => hasRadio(board, 'wifi')
const WIFI_BOARDS = boardsWhere(hasWifi)
const NO_WIFI_BOARDS = boardsWhere(b => !hasWifi(b))

// the contract read itself

function contractMessage(c: ConndContract): string {
  return c.read
    ? `read the connd contract out of micad: ${c.staUnit} <- ${c.staDir}/${c.staConf}, ${c.apUnit} <- `
    + `${c.apDir}/${c.apConf}, networkd prefixes '${c.staPrefix}'/'${c.apPrefix}', sweep `
    + `'${c.sweep}'*'${c.sweepSuffixes.join('\'|\'')}'`
    : `could not read the connd contract out of ${RECONCILER_DIR}: dirs '${c.staDir}'/'${c.apDir}', `
      + `units '${c.staUnit}'/'${c.apUnit}', configs '${c.staConf}'/'${c.apConf}', prefixes `
      + `'${c.staPrefix}'/'${c.apPrefix}', sweep '${c.sweep}'+'${c.sweepSuffixes.join('\'|\'')}'. Every `
      + `connd assertion `
      + `below compares against these. They no longer fall back to hardcoded defaults, so they FAIL `
      + `from here on rather than passing against the verifier's own restatement of a contract it `
      + `could not read — see the empty-marker rot recorded above the extractor`
}

const CONTRACT_CHECK: CheckCase = {
  id: 'connd-contract-read',
  shell: {
    pass: 'read the connd contract out of micad: ',
    fail: 'could not read the connd contract out of ',
  },
  run: async (): Promise<readonly CheckResult[]> => {
    // Re-read rather than reuse CONTRACT: the value the matchers were built
    // from is what the oracle would print, and this is the check that says
    // whether that read succeeded. Reading it again costs three small files and
    // makes the check about the sources rather than about module-load order.
    const contract = readConndContract(RECONCILER_DIR)
    return [verdict('connd-contract-read', contract.read, contractMessage(contract))]
  },
}

// the Wi-Fi userland, on the boards that declare a radio

/** `sq_regular`, scoped to the Wi-Fi boards. */
function wifiRegularFile(id: string, path: string): CheckCase {
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: { pass: `${path} is a regular file`, fail: `${path} missing or not a regular file` },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const st = entry(await packedRoot(ctx), path)
      const ok = st !== undefined && st.isFile()
      return [verdict(id, ok, ok ? `${path} is a regular file` : `${path} missing or not a regular file`)]
    },
  }
}

/**
 * `check_execstart`: the unit's command line and the reconciler's render
 * path are ONE contract.
 *
 * BOTH systemd instance specifiers are accepted -- `%i` escaped and `%I`
 * unescaped. For a plain interface name they are the same string, and which one
 * the packager chose is not this repo's business. Measured on the real images:
 * hostapd@.service uses `%i` and wpa_supplicant@.service uses `%I`, so a port
 * that accepted only one would fail one of the two on a correct image.
 */
function execStartCheck(input: { id: string, what: string, unit: string, dir: string, name: string }): CheckCase {
  const { id, what, dir, name } = input
  const unit = `/usr/lib/systemd/system/${input.unit}`
  const base = input.unit
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: {
      pass: `${what}: ${base} reads `,
      fail: [
        `${what}: ${unit} is not in the image, so micad would drive a unit that does not exist`,
        `${what}: ${base}'s ExecStart does not name `,
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (!regularFileInRoot(root, unit)) {
        return [verdict(id, false,
          `${what}: ${unit} is not in the image, so micad would drive a unit that does not exist`)]
      }
      const execLines = readFileSync(pathInRoot(root, unit), 'utf8').split('\n').filter(l => l.includes('ExecStart='))
      for (const spec of ['%i', '%I']) {
        const want = `${dir}/${name.replaceAll('{interface}', spec)}`
        if (execLines.some(l => l.includes(want))) {
          return [verdict(id, true,
            `${what}: ${base} reads ${want}, which is exactly what the reconciler renders`)]
        }
      }
      return [verdict(id, false,
        `${what}: ${base}'s ExecStart does not name ${dir}/${name} (with %i or %I); it is `
        + `'${execLines.join(' ')} '. The unit and the reconciler disagree about the config path, so `
        + `the daemon starts against a file nothing writes`)]
    },
  }
}

/** micad owns the template's lifecycle: a statically enabled instance would race it. */
function notStaticallyEnabled(id: string, unit: string): CheckCase {
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: {
      pass: `${unit} is installed but NOT statically enabled (micad owns the lifecycle)`,
      fail: `${unit} is statically enabled in the image;`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const enabled = wantsLink(root, ['/etc/systemd/system', '/usr/lib/systemd/system'], unit) !== undefined
      return [verdict(
        id,
        !enabled,
        enabled
          ? `${unit} is statically enabled in the image; micad owns that lifecycle and would race the `
          + `image's own instance`
          : `${unit} is installed but NOT statically enabled (micad owns the lifecycle)`,
      )]
    },
  }
}

/**
 * The packages' own non-templated units: MASKED, not merely disabled.
 *
 * Masking is the only form that also blocks the D-Bus activation path
 * wpasupplicant ships
 * (/usr/share/dbus-1/system-services/fi.w1.wpa_supplicant1.service). On Mica OS the
 * mask lives inside the signed read-only root, so it cannot be undone on device.
 */
function maskedCheck(unit: string): CheckCase {
  const id = `wifi-masked-${unit}`
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: {
      pass: `${unit} is masked (-> /dev/null);`,
      fail: `${unit} is not masked (it is '`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      // `readlink`, not `readlink -f`: the RAW target. A mask is the literal
      // string /dev/null, and resolving the link would answer about the device
      // node rather than about the unit.
      const dest = linkTargetInRoot(root, `/etc/systemd/system/${unit}`) ?? ''
      const ok = dest === '/dev/null'
      return [verdict(
        id,
        ok,
        ok
          ? `${unit} is masked (-> /dev/null); it cannot start and fight micad for the radio`
          : `${unit} is not masked (it is '${dest === '' ? 'not a symlink to /dev/null' : dest}'). The `
            + `package enables it, and it starts a second daemon on the same radio against a config `
            + `micad never writes while micad's own instance still reports healthy`,
      )]
    },
  }
}

/** ...and the package postinst's enablement symlink is gone with it. */
function noPostinstWants(unit: string): CheckCase {
  const id = `wifi-no-postinst-wants-${unit}`
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: {
      pass: `${unit} carries no enablement symlink from the package postinst`,
      fail: `${unit} still carries the package's *.wants enablement symlink`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const enabled = wantsLink(root, ['/etc/systemd/system', '/usr/lib/systemd/system'], unit) !== undefined
      return [verdict(
        id,
        !enabled,
        enabled
          ? `${unit} still carries the package's *.wants enablement symlink`
          : `${unit} carries no enablement symlink from the package postinst`,
      )]
    },
  }
}

/** `${where#/}` with every `/` turned into `-`, plus `.mount` -- the oracle's own escape. */
export function mountUnitFor(where: string): string {
  return `${where.replace(/^\//, '').replaceAll('/', '-')}.mount`
}

/**
 * A reconciler render target: bound, from STATE, and ENABLED.
 *
 * The Mica OS root is a read-only dm-verity squashfs, so a reconciler rendering into
 * a read-only path fails on the device and nowhere else. The BACKING is
 * asserted, not just that the directory exists -- and the enablement separately,
 * because M4 shipped units that were installed and never enabled.
 */
function renderTargetBind(id: string, where: string): CheckCase {
  const unit = mountUnitFor(where)
  const unitPath = `/etc/systemd/system/${unit}`
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: {
      pass: `${where} is a STATE-backed bind via ${unit} (`,
      fail: [
        `${where} is a reconciler render target but ${unit} does not exist;`,
        `${unit} does not mount ${where} (its Where= is '`,
        `${unit} is not backed by STATE (What= must be under /mnt/data/state); a tmpfs or nothing at all`,
        `${unit} exists but is not enabled; ${where} would stay on the read-only squashfs`,
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (!regularFileInRoot(root, unitPath)) {
        return [verdict(id, false,
          `${where} is a reconciler render target but ${unit} does not exist; on the read-only verity `
          + `root the render would fail on device and nowhere else`)]
      }
      const lines = readFileSync(pathInRoot(root, unitPath), 'utf8').split('\n')
      // `grep -qx "Where=${where}"` -- the WHOLE line.
      if (!lines.includes(`Where=${where}`)) {
        return [verdict(id, false,
          `${unit} does not mount ${where} (its Where= is '${unitValue(root, unitPath, 'Where=')}')`)]
      }
      if (!lines.some(l => /^What=\/mnt\/data\/state\//.test(l))) {
        return [verdict(id, false,
          `${unit} is not backed by STATE (What= must be under /mnt/data/state); a tmpfs or nothing at all `
          + `would lose every configured network on reboot`)]
      }
      if (wantsLink(root, ETC_UNITS, unit) === undefined) {
        return [verdict(id, false,
          `${unit} exists but is not enabled; ${where} would stay on the read-only squashfs`)]
      }
      return [verdict(id, true,
        `${where} is a STATE-backed bind via ${unit} (${unitValue(root, unitPath, 'What=')}), so the `
        + `reconciler can write there and the result survives an A/B update`)]
    },
  }
}

/**
 * The bind SOURCE, which mount(8) does not create -- and its MODE.
 *
 * mica-seed-state is the only thing that runs early enough, and the assertion is
 * in two halves because the seed creates both directories from ONE loop: the
 * loop does `mkdir -p` and `chmod 0700` under /mnt/data/state, and THIS directory's
 * name is one of the loop's items. Either half alone would pass for a script
 * that created the other directory twice.
 *
 * 0700 because both directories hold a pre-shared key in the clear once a device
 * is configured -- the supplicant config carries every network's PSK and the
 * hostapd config carries the AP key.
 */
function seedStateCreates(id: string, where: string): CheckCase {
  const unit = mountUnitFor(where)
  const unitPath = `/etc/systemd/system/${unit}`
  const seed = '/usr/lib/mica/mica-seed-state'
  return {
    id,
    boards: WIFI_BOARDS,
    features: ['wifi'],
    shell: {
      pass: ` at 0700 before ${unit} is attempted`,
      fail: `; the bind would have no source on first boot and ${where} would stay read-only`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const src = unitValue(root, unitPath, 'What=')
      const base = src === '' ? 'none' : (src.split('/').at(-1) ?? '')
      const text = regularFileInRoot(root, seed) ? readFileSync(pathInRoot(root, seed), 'utf8') : undefined
      const loopItems = text === undefined
        ? []
        : text.split('\n')
            .flatMap(l => /^for name in (.*); do ensure_dir "\$name" 0700; done$/.exec(l)?.[1]?.split(' ') ?? [])
      const ok = src !== '' && text !== undefined
        && text.includes('state=/mnt/data/state')
        && text.includes('mkdir -p "$state/$1"')
        && text.includes('chmod "$2" "$state/$1"')
        && text.includes('[ ! -L "$state/$1" ]')
        && loopItems.includes(base)
      return [verdict(
        id,
        ok,
        ok
          ? `mica-seed-state creates ${src} at 0700 before ${unit} is attempted`
          : `mica-seed-state does not create ${src} (0700); the bind would have no source on first boot `
            + `and ${where} would stay read-only`,
      )]
    },
  }
}

const DNSMASQ_CHECK: CheckCase = {
  // The AP's DHCP server is systemd-networkd's own DHCPServer=yes. dnsmasq would
  // be a second package and a second lifecycle for a job already done -- and a
  // second DHCP server on the same link is a conflict, not a fallback.
  id: 'wifi-no-dnsmasq',
  boards: WIFI_BOARDS,
  shell: {
    pass: 'no dnsmasq in the image (the AP\'s DHCP server is systemd-networkd\'s own DHCPServer=yes)',
    fail: 'dnsmasq ships in the image;',
  },
  run: async (ctx): Promise<readonly CheckResult[]> => {
    const root = await packedRoot(ctx)
    // `[ -e ]`, which FOLLOWS a link -- so a dangling /usr/sbin/dnsmasq reads as
    // absent here. Reproduced rather than tightened: the oracle's answer is the
    // one the two sides must agree on.
    const present = statInRoot(root, '/usr/sbin/dnsmasq') !== undefined
    return [verdict(
      'wifi-no-dnsmasq',
      !present,
      present
        ? 'dnsmasq ships in the image; the provisioning AP hands out addresses through '
        + 'systemd-networkd\'s DHCPServer=yes and a second DHCP server on the same link is a '
        + 'conflict, not a fallback'
        : 'no dnsmasq in the image (the AP\'s DHCP server is systemd-networkd\'s own DHCPServer=yes)',
    )]
  },
}

// the regulatory database, and the one path by which this kernel can read it

/**
 * Where the reload lives, spelled once.
 *
 * The unit is `mica-wifi` payload, installed into /etc/systemd/system with a
 * multi-user.target.wants link beside it, because the image root is an
 * immutable dm-verity squashfs and nothing runs `systemctl enable` on it.
 */
const REGDB_UNIT = 'mica-regdb-reload.service'

/**
 * The half that packaging alone does not buy, and the reason it is a separate
 * conclusion from the file being present.
 *
 * cfg80211 is built into every board kernel here and these boards carry no
 * initramfs, so `regulatory_init_db()` -- a late_initcall when cfg80211 is not
 * a module -- asks the firmware loader for `regulatory.db` before the root is
 * mounted. Measured on cx3576 hardware 2026-09-08: the request at 7.668 s, the
 * root at 7.681 s. `regdb_fw_cb()` then writes `ERR_PTR(-ENODATA)` into the
 * file-scope `regdb` pointer and `query_regdb_file()` returns it forever
 * without asking again; registering a wiphy re-applies the domain cfg80211
 * already has and does not re-read anything (net/wireless/reg.c). So a root
 * that ships the database and nothing else ships a file the kernel will not
 * look at again -- which is indistinguishable, from the file's side, from a
 * root where it works.
 */
const REGDB_RELOAD_ENABLED: CheckCase = {
  id: 'wifi-regdb-reload-enabled',
  boards: WIFI_BOARDS,
  features: ['wifi'],
  shell: {
    pass: `${REGDB_UNIT} is in the image and enabled at multi-user.target`,
    fail: [
      `${REGDB_UNIT} is not in the image`,
      `${REGDB_UNIT} is in the image but nothing wants it`,
    ],
  },
  run: async (ctx): Promise<readonly CheckResult[]> => {
    const root = await packedRoot(ctx)
    const unit = `/etc/systemd/system/${REGDB_UNIT}`
    if (!regularFileInRoot(root, unit)) {
      return [verdict('wifi-regdb-reload-enabled', false,
        `${REGDB_UNIT} is not in the image at ${unit}, so nothing sends the NL80211_CMD_RELOAD_REGDB `
        + `that is the only path in this kernel that clears the boot-time -ENODATA and reads the `
        + `database`)]
    }
    const link = wantsLink(root, ['/etc/systemd/system', '/usr/lib/systemd/system'], REGDB_UNIT)
    return [verdict(
      'wifi-regdb-reload-enabled',
      link !== undefined,
      link !== undefined
        ? `${REGDB_UNIT} is in the image and enabled at multi-user.target (${link})`
        : `${REGDB_UNIT} is in the image but nothing wants it, so it never runs. The root is an `
          + `immutable dm-verity squashfs and no maintainer script can enable a unit on it: the `
          + `wants link is package payload or it does not exist`,
    )]
  },
}

/**
 * ...and the program that unit runs is in the image.
 *
 * Its own conclusion rather than a clause of the one above, because the two
 * fail for unrelated reasons with unrelated repairs -- a unit nothing wants is
 * a packaging link, an ExecStart naming a binary the root does not carry is a
 * missing Depends -- and because an enabled unit whose ExecStart is absent
 * fails at boot with the database sitting in the image the whole time.
 */
const REGDB_RELOAD_TOOL: CheckCase = {
  id: 'wifi-regdb-reload-tool',
  boards: WIFI_BOARDS,
  features: ['wifi'],
  shell: {
    pass: `${REGDB_UNIT} runs `,
    fail: [
      `${REGDB_UNIT} declares no ExecStart`,
      `, which the image does not carry`,
    ],
  },
  run: async (ctx): Promise<readonly CheckResult[]> => {
    const root = await packedRoot(ctx)
    const unit = `/etc/systemd/system/${REGDB_UNIT}`
    const text = regularFileInRoot(root, unit) ? readFileSync(pathInRoot(root, unit), 'utf8') : ''
    // The first token after `ExecStart=`, with systemd's `-`/`@`/`:`/`+`/`!`
    // prefixes stripped: the executable the unit would run.
    const exec = text.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('ExecStart='))
      .map(l => l.slice('ExecStart='.length).trim().replace(/^[-@:+!]+/, '').split(/\s+/)[0])
      .filter((p): p is string => p !== undefined && p.startsWith('/'))
    if (exec.length === 0) {
      return [verdict('wifi-regdb-reload-tool', false,
        `${REGDB_UNIT} declares no ExecStart with an absolute program, so what it would run when it `
        + `is started cannot be read off the image`)]
    }
    const missing = exec.filter(p => !regularFileInRoot(root, p))
    return [verdict(
      'wifi-regdb-reload-tool',
      missing.length === 0,
      missing.length === 0
        ? `${REGDB_UNIT} runs ${exec.join(', ')}, and the image carries it`
        : `${REGDB_UNIT} runs ${missing.join(', ')}, which the image does not carry. The unit is `
          + `enabled and the database is packaged, so nothing else here goes red and the load `
          + `simply never happens`,
    )]
  },
}

/**
 * The group SKIP, on a board that declares no Wi-Fi.
 *
 * ONE shell line covers all nineteen assertions above, so it needs a register
 * entry of its own -- scoped to the complement of the same derived predicate the
 * nineteen are scoped by, computed from the shipped definitions at module load.
 */
const WIFI_SKIPPED: CheckCase = {
  id: 'wifi-userland-skipped',
  boards: NO_WIFI_BOARDS,
  shell: { skip: 'the Wi-Fi userland (hostapd, wpa_supplicant, their unit templates,' },
  run: async (ctx): Promise<readonly CheckResult[]> => [skipped(
    'wifi-userland-skipped',
    `the Wi-Fi userland (hostapd, wpa_supplicant, their unit templates, the ExecStart/render-path `
    + `contract, the masking of the packages' own units, the STATE-backed binds for the two config `
    + `directories, the absence of dnsmasq, and the regulatory database with the unit that loads `
    + `it): ${ctx.board.name} declares no wifi in BOARD_RADIOS, `
    + `so there is no radio for a station or an access point to run on and the image ships neither daemon`,
  )],
}

// the image's networkd namespace, on EVERY board

const NETWORK_DIRS = [
  '/etc/systemd/network', '/usr/lib/systemd/network', '/run/systemd/network',
] as const

/** The BASENAMES of every `*.network` under the three trees, deduplicated and sorted. */
function imageNetworkFiles(root: string): string[] {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    }
    catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      // Followed, as the oracle's stat follows -- but inside the root, so a
      // link out of the tree is a dangling entry rather than a host directory
      // this walk would collect .network names from.
      const isDir = statInRoot(root, full.slice(root.length))?.isDirectory() === true
      if (isDir) {
        walk(full)
        continue
      }
      if (name.endsWith('.network')) names.add(name)
    }
  }
  for (const d of NETWORK_DIRS) {
    let at: string
    try {
      at = pathInRoot(root, d)
    }
    catch {
      continue
    }
    walk(at)
  }
  return [...names].sort()
}

const NAMESPACE_CHECK: CheckCase = {
  // network.rs DELETES every file matching its own prefix that it did not
  // render, and the two Wi-Fi reconcilers deliberately sit outside that pattern.
  // An image file in either namespace would be swept away, or would SHADOW a
  // reconciler's unit, on the device and nowhere else.
  id: 'networkd-namespace-clear',
  shell: {
    pass: 'the image\'s networkd namespace is clear of micad\'s:',
    fail: [
      'the image\'s networkd namespace check did not run:',
      'the image\'s networkd namespace is empty:',
      'the image\'s networkd namespace collides with a reconciler-owned one:',
    ],
  },
  run: async (ctx): Promise<readonly CheckResult[]> => {
    const id = 'networkd-namespace-clear'
    const contract = readConndContract(RECONCILER_DIR)
    if (!contract.read) {
      return [verdict(id, false,
        `the image's networkd namespace check did not run: the connd contract is unread, so there is `
        + `no namespace to compare against. It previously ran anyway with an empty marker, which made `
        + `its glob match every filename and reported eight collisions that could not happen`)]
    }
    const root = await packedRoot(ctx)
    const files = imageNetworkFiles(root)
    const collisions: string[] = []
    for (const n of files) {
      // ANCHORED, matching is_mica_managed(). The unanchored `*marker*` this
      // replaced is what turned an empty marker into eight false positives.
      if (n.startsWith(contract.sweep) && contract.sweepSuffixes.some(x => n.endsWith(x)))
        collisions.push(` ${n}(swept-by-network.rs)`)

      else if (n.startsWith(contract.staPrefix)) collisions.push(` ${n}(station-namespace)`)
      else if (n.startsWith(contract.apPrefix)) collisions.push(` ${n}(ap-namespace)`)
    }
    if (files.length === 0) {
      return [verdict(id, false,
        `the image's networkd namespace is empty: it ships no .network file at all, so this check `
        + `would pass vacuously`)]
    }
    if (collisions.length === 0) {
      return [verdict(id, true,
        `the image's networkd namespace is clear of micad's: none of (${files.join(' ')} ) falls in a `
        + `reconciler-owned namespace ('${contract.sweep}'*'${contract.sweepSuffixes.join('\'|\'')}', `
        + `'${contract.staPrefix}', '${contract.apPrefix}')`)]
    }
    return [verdict(id, false,
      `the image's networkd namespace collides with a reconciler-owned one:${collisions.join('')}. A `
      + `(swept-by-network.rs) file is DELETED on the reconciler's first pass — it renders `
      + `${contract.sweep}*{${contract.sweepSuffixes.join(',')}} and removes every other file matching `
      + `that shape. A `
      + `(station-namespace) or (ap-namespace) file instead SHADOWS the unit a WiFi reconciler renders `
      + `for that interface, since networkd applies the first match in lexical order`)]
  },
}

const DHCP_DEFAULT = '80-dhcp.network'

const SORT_ORDER_CHECK: CheckCase = {
  // networkd applies the FIRST matching unit in lexical order across its
  // directories, so the image's fallback has to sort BEFORE the reconcilers'
  // units. Compared as STRINGS, not assumed from the numbers.
  //
  // Each prefix is compared with the image's file INDEPENDENTLY: the two
  // reconciler prefixes have no ordering requirement between themselves (they
  // never match the same interface), so requiring the three to be sorted as one
  // list would be a check about the wrong property.
  id: 'networkd-fallback-sorts-first',
  shell: {
    pass: ` sorts before both '`,
    fail: ` does not sort before:`,
  },
  run: async (): Promise<readonly CheckResult[]> => {
    const id = 'networkd-fallback-sorts-first'
    const contract = readConndContract(RECONCILER_DIR)
    const bad: string[] = []
    for (const prefix of [contract.staPrefix, contract.apPrefix]) {
      if (prefix === '') {
        bad.push(' <unreadable>')
        continue
      }
      // `printf '%s\n' A B | LC_ALL=C sort | head -1` -- a BYTE comparison, which
      // is what networkd's own ordering is and what `localeCompare` is not.
      if ([DHCP_DEFAULT, prefix].sort()[0] !== DHCP_DEFAULT) bad.push(` ${prefix}`)
    }
    return [verdict(
      id,
      bad.length === 0,
      bad.length === 0
        ? `${DHCP_DEFAULT} sorts before both '${contract.staPrefix}' and '${contract.apPrefix}', so a `
        + `reconciler-rendered unit is never shadowed by the image's fallback`
        : `${DHCP_DEFAULT} does not sort before:${bad.join('')}; networkd applies the first match in `
          + `lexical order, so the image's fallback would win over the unit micad rendered for that interface`,
    )]
  },
}

// the register entries, generated from the contract

export const CONND_CHECKS: readonly CheckCase[] = [
  CONTRACT_CHECK,
  wifiRegularFile('wifi-hostapd-binary', '/usr/sbin/hostapd'),
  wifiRegularFile('wifi-supplicant-binary', '/usr/sbin/wpa_supplicant'),
  wifiRegularFile('wifi-station-unit', `/usr/lib/systemd/system/${CONTRACT.staUnit}`),
  wifiRegularFile('wifi-ap-unit', `/usr/lib/systemd/system/${CONTRACT.apUnit}`),
  execStartCheck({
    id: 'wifi-station-execstart',
    what: 'station',
    unit: CONTRACT.staUnit,
    dir: CONTRACT.staDir,
    name: CONTRACT.staConf,
  }),
  execStartCheck({
    id: 'wifi-ap-execstart',
    what: 'access point',
    unit: CONTRACT.apUnit,
    dir: CONTRACT.apDir,
    name: CONTRACT.apConf,
  }),
  notStaticallyEnabled('wifi-station-template-not-enabled', CONTRACT.staUnit),
  notStaticallyEnabled('wifi-ap-template-not-enabled', CONTRACT.apUnit),
  ...['hostapd.service', 'wpa_supplicant.service', 'dbus-fi.w1.wpa_supplicant1.service']
    .flatMap(u => [maskedCheck(u), noPostinstWants(u)]),
  renderTargetBind('wifi-station-config-bind', CONTRACT.staDir),
  seedStateCreates('wifi-station-config-seeded', CONTRACT.staDir),
  renderTargetBind('wifi-ap-config-bind', CONTRACT.apDir),
  seedStateCreates('wifi-ap-config-seeded', CONTRACT.apDir),
  DNSMASQ_CHECK,
  REGDB_RELOAD_ENABLED,
  REGDB_RELOAD_TOOL,
  WIFI_SKIPPED,
  NAMESPACE_CHECK,
  SORT_ORDER_CHECK,
]
