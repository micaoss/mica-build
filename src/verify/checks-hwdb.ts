// PLAN-086 S4: the static hardware database, asserted GONE -- and the udev
// rules it was removed from, asserted intact.
//
// The image ships udev, its rules, its runtime device state and the kernel
// module indexes. What it must not ship is the 22.9 MB static hardware database
// -- /usr/lib/udev/hwdb.bin, /etc/udev/hwdb.bin and the .hwdb sources under
// /usr/lib/udev/hwdb.d and /etc/udev/hwdb.d -- nor the machinery that rebuilds
// it, nor a rule that queries it.
//
// EVERY CHECK HERE IS A NEGATIVE, which is the shape of assertion that passes by
// finding nothing, so every one of them reports the size of the space it
// searched and refuses when that space is empty. A root with no udev in it at
// all satisfies "no hwdb ships" trivially and is not the fact anyone wants
// asserted; `packedRoot` refuses an empty unpack, and these are the per-check
// guards under it.
//
// THE FOURTH CHECK IS THE ONE THAT COULD NOT BE WRITTEN AS A NEGATIVE. Removing
// a query clause means editing a rule that usually does something else on the
// same line, and the failure mode of a token-level edit is taking a whole rule
// with it. The plan names the four categories that must survive -- permissions,
// symlinks, module loading and service activation -- and this asserts one
// concrete action per category, in the file that carries it, on the shipped
// image. rootfs/scripts/hwdb-remove.sh asserts a survivor table of its own at
// BUILD time and fails the build; this one reads the packed root and is
// deliberately an INDEPENDENT transcription, because a check that imported the
// build script's table would move with it and agree with itself.
//
// WHAT THIS FAMILY CANNOT SEE is whether those rules FIRE. A rule file that
// still holds `GROUP="tty"` is not the same claim as a booted system whose
// /dev/tty is group tty. That claim needs a running kernel and is recorded in
// mica:docs/task/RFCT-346.md against a booted guest; this is the static half.
//
// No matcher here is a substring of another's, and every one of the eight
// mentions hwdb, which no other conclusion in the register does.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { packedRoot } from './checks-root.ts'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { verdict } from './verdict.ts'

/** The compiled database's two homes: systemd-hwdb writes /etc, Debian's postinst /usr. */
const HWDB_BINARIES: readonly string[] = [
  '/usr/lib/udev/hwdb.bin',
  '/etc/udev/hwdb.bin',
]

/** The source trees it is compiled FROM, both of them. */
const HWDB_SOURCE_DIRS: readonly string[] = [
  '/usr/lib/udev/hwdb.d',
  '/etc/udev/hwdb.d',
]

/** The tool that compiles one. Shipping it with no sources is a trap, not a leftover. */
const HWDB_TOOL = '/usr/bin/systemd-hwdb'

/** Where a udev rule can live, in the order udev merges them. */
const RULE_DIRS: readonly string[] = ['/etc/udev/rules.d', '/usr/lib/udev/rules.d']

/** Where a unit file can live. */
const UNIT_DIRS: readonly string[] = ['/etc/systemd/system', '/usr/lib/systemd/system']

/** The unit that would rebuild the database, and whose conditions its absence ARMS. */
const HWDB_UNIT = 'systemd-hwdb-update.service'

/**
 * The clause that reads the database, and the private flag that records that it
 * did.
 *
 * Two patterns and not one, because the flag is the half that is easy to leave
 * behind: 60-evdev.rules sets `ENV{.HAVE_HWDB_PROPERTIES}="1"` in the same rule
 * as each import and gates `IMPORT{builtin}="keyboard"` on it, so an edit that
 * removed only the imports would leave that flag set unconditionally and turn a
 * dead code path back on. The `=="1"` CONSUMER is not matched here and is
 * expected to survive: nothing sets the property any more, so it never fires,
 * which is exactly what it does on a root whose hwdb.bin is missing.
 */
const HWDB_IMPORT = 'IMPORT{builtin}="hwdb'
const HWDB_FLAG_SET = 'ENV{.HAVE_HWDB_PROPERTIES}="'

/** Any builtin import at all -- the vocabulary a rules parser must still see. */
const ANY_IMPORT = /IMPORT\{builtin\}="/g

/**
 * The `hwdb` token as a udev rule would spell it, for scanning a unit.
 *
 * A unit refers to the machinery by unit name, not by path, so this is a
 * name search over the [Unit] directives that create a dependency or an
 * ordering. `After=` is included deliberately: systemd drops an ordering onto a
 * unit that does not exist without a word, so the difference between a root that
 * has no reference and one whose reference is merely ineffective is invisible at
 * runtime and visible only here.
 */
const UNIT_REFERENCE_KEYS: readonly string[] = [
  'After=', 'Before=', 'Wants=', 'Requires=', 'Requisite=', 'BindsTo=', 'PartOf=', 'Also=',
]

/** Every `.rules` file in the root, image-absolute, in merge order. */
function ruleFiles(root: string): string[] {
  const out: string[] = []
  for (const dir of RULE_DIRS) {
    let names: string[]
    try {
      names = readdirSync(join(root, dir))
    }
    catch {
      continue
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.rules')) continue
      out.push(`${dir}/${name}`)
    }
  }
  return out
}

/** Every unit file in the root, image-absolute. Not links: a link has no body. */
function unitFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(join(root, dir))
    }
    catch {
      return
    }
    for (const name of names) {
      const path = `${dir}/${name}`
      let st
      try {
        st = lstatSync(join(root, path))
      }
      catch {
        continue
      }
      if (st.isDirectory()) visit(path)
      else if (st.isFile()) out.push(path)
    }
  }
  for (const dir of UNIT_DIRS) visit(dir)
  return out
}

/** Every enablement link under the unit trees, image-absolute. */
function enablementLinks(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(join(root, dir))
    }
    catch {
      return
    }
    for (const name of names) {
      const path = `${dir}/${name}`
      let st
      try {
        st = lstatSync(join(root, path))
      }
      catch {
        continue
      }
      if (st.isDirectory()) {
        visit(path)
        continue
      }
      if (dir.endsWith('.wants') || dir.endsWith('.requires')) out.push(path)
    }
  }
  for (const dir of UNIT_DIRS) visit(dir)
  return out
}

/** A file's text, or '' when it cannot be read. */
function text(root: string, path: string): string {
  try {
    return readFileSync(join(root, path), 'utf8')
  }
  catch {
    return ''
  }
}

/** The bytes at an image path, following nothing; 0 for a path that is not there. */
function bytesAt(root: string, path: string): number {
  const walk = (p: string): number => {
    let st
    try {
      st = lstatSync(join(root, p))
    }
    catch {
      return 0
    }
    if (st.isDirectory())
      return readdirSync(join(root, p)).reduce((sum, n) => sum + walk(`${p}/${n}`), 0)

    return st.isFile() ? st.size : 0
  }
  return walk(path)
}

/**
 * One action per category the plan names, in the file that carries it.
 *
 * Every file here had a clause removed from it EXCEPT the last two, and those
 * two are why the list is not simply the edit's own inventory: a transform
 * pointed at the wrong file is a defect nothing in the edited set can see.
 * 80-drivers.rules is where module loading lives and 99-systemd.rules is where
 * device-driven service activation lives, and neither has ever held an hwdb
 * clause.
 */
interface Survivor {
  readonly file: string
  readonly token: string
  readonly category: string
}

const SURVIVORS: readonly Survivor[] = [
  { file: '50-udev-default.rules', token: 'GROUP="tty", MODE="0666"', category: 'permissions' },
  { file: '50-udev-default.rules', token: 'SUBSYSTEM=="block", GROUP="disk"', category: 'permissions' },
  { file: '50-udev-default.rules', token: 'OPTIONS+="static_node=', category: 'static device nodes' },
  { file: '50-udev-default.rules', token: 'IMPORT{builtin}="usb_id"', category: 'device identification' },
  { file: '50-udev-default.rules', token: 'IMPORT{builtin}="net_driver"', category: 'device identification' },
  { file: '60-input-id.rules', token: 'IMPORT{builtin}="input_id"', category: 'device identification' },
  { file: '60-serial.rules', token: 'SYMLINK+="serial/by-id/', category: 'symlinks' },
  { file: '60-serial.rules', token: 'SYMLINK+="serial/by-path/', category: 'symlinks' },
  { file: '60-persistent-storage.rules', token: 'SYMLINK+="disk/by-uuid/', category: 'symlinks' },
  { file: '71-seat.rules', token: 'TAG+="master-of-seat"', category: 'device tagging' },
  { file: '75-net-description.rules', token: 'IMPORT{builtin}="net_id"', category: 'network identity' },
  { file: '78-sound-card.rules', token: 'ENV{SOUND_INITIALIZED}="1"', category: 'device identification' },
  { file: '90-iocost.rules', token: 'RUN+="iocost apply', category: 'device configuration' },
  { file: '80-drivers.rules', token: 'RUN{builtin}+="kmod load"', category: 'module loading' },
  { file: '99-systemd.rules', token: 'TAG+="systemd"', category: 'service activation' },
]

export const HWDB_CHECKS: readonly CheckCase[] = [
  {
    // The data itself: both compiled locations, both source trees, and the tool.
    //
    // The tool is in the same conclusion rather than in one of its own because
    // it is the same decision: systemd-hwdb with no sources to compile and
    // nowhere writable to compile them into is a 68 KB binary whose only
    // reachable outcome is an error, and a root that kept it is one where the
    // removal was of the data and not of the feature.
    id: 'packed-hwdb-absent',
    shell: {
      pass: 'no static hwdb ships in the packed root',
      fail: 'a static hwdb ships in the packed root',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      // The space searched. udev has to BE here for "no hwdb" to be a statement
      // about a device-managing root rather than about an empty directory.
      const rules = ruleFiles(root)
      const udevd = ['/usr/lib/systemd/systemd-udevd', '/usr/bin/udevadm']
        .filter(p => existsSync(join(root, p)))
      if (rules.length === 0 || udevd.length === 0) {
        return [verdict('packed-hwdb-absent', false,
          `a static hwdb ships in the packed root: cannot be concluded -- this root holds `
          + `${rules.length} udev rule file(s) and ${udevd.length} of systemd-udevd/udevadm. `
          + `"No hardware database" is true of a root with no device management in it at all, `
          + `and that is not the fact PLAN-086 S4 asks for`)]
      }
      const found = [...HWDB_BINARIES, ...HWDB_SOURCE_DIRS, HWDB_TOOL]
        .filter(p => existsSync(join(root, p)))
      if (found.length > 0) {
        const sized = found.map(p => `${p} (${bytesAt(root, p)} bytes)`)
        return [verdict('packed-hwdb-absent', false,
          `a static hwdb ships in the packed root: ${sized.join(', ')}. The compiled database is `
          + `13.5 MB and its sources 9.3 MB, describing vendor names and input-device quirks for `
          + `hardware this device does not have and nothing mica runs reads`)]
      }
      // Anywhere at all, not only in the four known places: a source file that
      // moved would be shipped and invisible to a path list.
      const strays: string[] = []
      const sweep = (dir: string, depth: number): void => {
        if (depth > 6) return
        let names: string[]
        try {
          names = readdirSync(join(root, dir))
        }
        catch {
          return
        }
        for (const name of names) {
          const path = `${dir}/${name}`
          let st
          try {
            st = lstatSync(join(root, path))
          }
          catch {
            continue
          }
          if (st.isDirectory()) sweep(path, depth + 1)
          else if (name.endsWith('.hwdb') || name === 'hwdb.bin') strays.push(path)
        }
      }
      for (const dir of ['/usr/lib/udev', '/etc/udev', '/usr/share/hwdb.d', '/lib/udev'])
        if (existsSync(join(root, dir))) sweep(dir, 0)

      if (strays.length > 0) {
        return [verdict('packed-hwdb-absent', false,
          `a static hwdb ships in the packed root: ${strays.join(' ')} -- outside the four paths `
          + `PLAN-086 S4 names, which is how a database comes back without any of them existing`)]
      }
      return [verdict('packed-hwdb-absent', true,
        `no static hwdb ships in the packed root: none of ${[...HWDB_BINARIES, ...HWDB_SOURCE_DIRS, HWDB_TOOL].join(' ')} `
        + `exists and no .hwdb or hwdb.bin is anywhere under /usr/lib/udev or /etc/udev, in a root `
        + `that carries ${rules.length} udev rule file(s) and ${udevd.join(' ')}`)]
    },
  },

  {
    // The machinery, and the reason it is not merely dead weight.
    //
    // systemd-hwdb-update.service's conditions are an OR group that includes
    // `ConditionPathExists=|!/usr/lib/udev/hwdb.bin`. On a root that HAS the
    // database the unit is skipped; deleting the database is precisely what
    // makes it start running -- `systemd-hwdb update` against a read-only /usr,
    // on every boot, failing every time. So the removal above and this check
    // are one decision, and a root that did the first without the second is
    // worse than a root that did neither.
    id: 'packed-hwdb-update-machinery-absent',
    shell: {
      pass: 'nothing in the packed root rebuilds the hwdb',
      fail: 'hwdb update machinery survives in the packed root',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const units = unitFiles(root)
      const links = enablementLinks(root)
      // The walk has to have REACHED the unit trees, and the sharpest proof of
      // that is the one unit the removal edits: systemd-udevd.service is where
      // `After=systemd-sysusers.service systemd-hwdb-update.service` was
      // trimmed, so a scan that cannot see it is a scan whose conclusion about
      // hwdb references is about nothing. A bare count would pass on a root
      // holding fifty units and no udevd.
      if (!units.some(p => p.endsWith('/systemd-udevd.service'))) {
        return [verdict('packed-hwdb-update-machinery-absent', false,
          `hwdb update machinery survives in the packed root: cannot be concluded -- the walk over `
          + `${UNIT_DIRS.join(' and ')} found ${units.length} unit file(s) and systemd-udevd.service `
          + `is not among them. That unit is the one whose After= line this removal edits, so a walk `
          + `that misses it would report "nothing refers to hwdb" without having read the file that `
          + `did`)]
      }
      const unitPresent = units.filter(p => p.endsWith(`/${HWDB_UNIT}`))
      const linkPresent = links.filter(p => p.endsWith(`/${HWDB_UNIT}`))
      if (unitPresent.length > 0 || linkPresent.length > 0) {
        return [verdict('packed-hwdb-update-machinery-absent', false,
          `hwdb update machinery survives in the packed root: `
          + `${[...unitPresent, ...linkPresent].join(' ')}. Its conditions include `
          + `ConditionPathExists=|!/usr/lib/udev/hwdb.bin, so on a root with the database removed `
          + `it stops being skipped and runs \`systemd-hwdb update\` against a read-only /usr at `
          + `every boot`)]
      }
      // A reference from another unit. `After=` counts: systemd drops an
      // ordering onto a unit that does not exist in silence, so the reference
      // survives with no symptom and nothing else would ever report it.
      const referring: string[] = []
      for (const path of units) {
        for (const line of text(root, path).split('\n')) {
          const trimmed = line.trim()
          if (!UNIT_REFERENCE_KEYS.some(k => trimmed.startsWith(k))) continue
          if (trimmed.includes(HWDB_UNIT)) referring.push(`${path}: ${trimmed}`)
        }
      }
      if (referring.length > 0) {
        return [verdict('packed-hwdb-update-machinery-absent', false,
          `hwdb update machinery survives in the packed root: ${referring.join('; ')} names a unit `
          + `this root does not have. systemd drops such a directive without a word, so the only `
          + `place this is ever visible is here`)]
      }
      return [verdict('packed-hwdb-update-machinery-absent', true,
        `nothing in the packed root rebuilds the hwdb: ${HWDB_UNIT} is in neither of `
        + `${UNIT_DIRS.join(' or ')}, no .wants or .requires link names it, and none of the `
        + `${units.length} unit file(s) scanned refers to it through `
        + `${UNIT_REFERENCE_KEYS.join('/')}`)]
    },
  },

  {
    // The readers. A missing database does not make an IMPORT go away, it makes
    // it FAIL -- and 33 failing builtin calls per matching uevent is not what
    // "no active rule requires it" means.
    //
    // The non-vacuity guard here is the interesting one: it is not enough to
    // count rule FILES, because a parser that stopped recognising the clause
    // would report zero over a full directory. So the same scan counts builtin
    // imports of EVERY kind, and a root where that number is zero cannot
    // conclude anything -- the shipped rules are full of usb_id, path_id,
    // net_id, input_id and kmod.
    id: 'packed-udev-rules-query-no-hwdb',
    shell: {
      pass: 'no shipped udev rule reads the hwdb',
      fail: 'udev rules still read the hwdb',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const files = ruleFiles(root)
      let imports = 0
      const querying: string[] = []
      const flagging: string[] = []
      for (const path of files) {
        const body = text(root, path)
        imports += (body.match(ANY_IMPORT) ?? []).length
        if (body.includes(HWDB_IMPORT)) querying.push(path)
        if (body.includes(HWDB_FLAG_SET)) flagging.push(path)
      }
      if (files.length === 0 || imports === 0) {
        return [verdict('packed-udev-rules-query-no-hwdb', false,
          `udev rules still read the hwdb: cannot be concluded -- ${files.length} rule file(s) `
          + `were read and ${imports} IMPORT{builtin} clause(s) of any kind were found in them. `
          + `Zero imports over a populated directory means this scan is not seeing clauses at all, `
          + `and it would report "no hwdb query" over a root that queries it on every uevent`)]
      }
      if (querying.length > 0 || flagging.length > 0) {
        return [verdict('packed-udev-rules-query-no-hwdb', false,
          `udev rules still read the hwdb: ${querying.length} file(s) import from it `
          + `(${querying.join(' ')}) and ${flagging.length} set ENV{.HAVE_HWDB_PROPERTIES} `
          + `(${flagging.join(' ')}). With no database in the root each of those imports fails on `
          + `every matching uevent, and the flag one turns the keyboard builtin back on`)]
      }
      return [verdict('packed-udev-rules-query-no-hwdb', true,
        `no shipped udev rule reads the hwdb: ${files.length} rule file(s) under `
        + `${RULE_DIRS.join(' and ')} hold ${imports} IMPORT{builtin} clause(s) and not one of `
        + `them names hwdb, and none sets ENV{.HAVE_HWDB_PROPERTIES}`)]
    },
  },

  {
    // The actions that shared a line with a removed clause, and two that never
    // did.
    //
    // This is the check for the failure PLAN-086 S4 names in its own words --
    // "without deleting unrelated actions from the same udev rule". A
    // token-level edit that went wrong takes a whole rule, and every category
    // below is one the acceptance clause lists: permissions, symlinks, module
    // loading, service activation.
    id: 'packed-udev-actions-survived-hwdb-removal',
    shell: {
      pass: 'the udev actions beside the removed hwdb clauses are intact',
      fail: 'a udev action beside a removed hwdb clause is gone',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const missingFiles: string[] = []
      const missingTokens: string[] = []
      const seen = new Map<string, string>()
      for (const s of SURVIVORS) {
        const path = `/usr/lib/udev/rules.d/${s.file}`
        let body = seen.get(path)
        if (body === undefined) {
          if (!existsSync(join(root, path))) {
            if (!missingFiles.includes(path)) missingFiles.push(path)
            continue
          }
          body = text(root, path)
          seen.set(path, body)
        }
        if (!body.includes(s.token)) missingTokens.push(`${s.file} lost ${s.token} (${s.category})`)
      }
      if (missingFiles.length > 0) {
        return [verdict('packed-udev-actions-survived-hwdb-removal', false,
          `a udev action beside a removed hwdb clause is gone: ${missingFiles.join(' ')} is not in `
          + `the root at all. The hwdb removal edits rule files and never deletes one, so a missing `
          + `file is that edit having taken the whole thing`)]
      }
      if (missingTokens.length > 0) {
        return [verdict('packed-udev-actions-survived-hwdb-removal', false,
          `a udev action beside a removed hwdb clause is gone: ${missingTokens.join('; ')}. These `
          + `are the categories PLAN-086 S4 requires to survive the clause removal`)]
      }
      const categories = [...new Set(SURVIVORS.map(s => s.category))]
      return [verdict('packed-udev-actions-survived-hwdb-removal', true,
        `the udev actions beside the removed hwdb clauses are intact: ${SURVIVORS.length} action(s) `
        + `across ${seen.size} rule file(s), covering ${categories.join(', ')}`)]
    },
  },
]

/** Exported for the test: the survivor table has to be reachable to be mutated. */
export { SURVIVORS, HWDB_BINARIES, HWDB_SOURCE_DIRS, HWDB_TOOL, HWDB_UNIT, RULE_DIRS }
