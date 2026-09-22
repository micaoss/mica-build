// /etc/shadow lives in RAM, and the image ships no usable credential.
//
// Board-unconditional: 19 conclusions on each shipped board, measured
// 2026-08-26. `/etc/shadow is a symlink to /run/mica/shadow` is written inline
// rather than through `sq_symlink`, so it carries a parenthetical batch 2a's
// matcher would not have found.
//
// mica:docs/design/access.md 4.2 supports exactly one credential on the console: a
// transient root password. The only path pam_unix reads it from on Mica OS is
// /etc/shadow, which is inside the dm-verity squashfs and unwritable by
// construction, so it is a symlink onto /run -- a tmpfs systemd mounts before
// any unit starts -- and mica-shadow-reconcile builds the file there from
// /usr/share/factory/etc/shadow on every boot. The password is therefore
// transient by construction and not by protocol: the memory is gone at the next
// boot and nothing has to remember to clear it.
//
// The checks prove that from the artifact: the link exists and names
// /run/mica/shadow, and nothing in the image satisfies either end of it, or PAM
// would read a file byte-identical on every device in the fleet; the reconciler
// runs BEFORE every reader and each unit it orders against is in the image,
// because systemd drops an ordering against an absent unit silently; it reads
// the FACTORY copy and not the previous boot's; and the factory copy carries no
// usable hash for any account.
//
// Two oracle checks disagree about an empty password field and both are ported
// as they are. `factory-shadow-locked` treats an empty field as locked, its awk
// being `$2 !~ /^[!*]/ && $2 != ""`; `factory-shadow-accounts-locked`
// treats it as the worst case, passwordless login rather than a
// locked marker. The second is right and the first would pass an image the
// second fails. Recorded here and in the M4d report as a finding about
// the verification contract.

import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { entry, packedRoot } from './checks-root.ts'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { verdict } from './verdict.ts'

const SHADOW = '/etc/shadow'
const SHADOW_LINK_TARGET = '/run/mica/shadow'
const FACTORY_SHADOW = '/usr/share/factory/etc/shadow'
const REC_UNIT = '/etc/systemd/system/mica-shadow-reconcile.service'
const REC_SCRIPT = '/usr/lib/mica/mica-shadow-reconcile'
const SEED_STATE = '/usr/lib/mica/mica-seed-state'

/** What `stat -c %F` says, in the same three words the oracle compares against. */
function shadowType(root: string): 'symbolic link' | 'regular file' | 'absent' | 'other' {
  const st = entry(root, SHADOW)
  if (st === undefined) return 'absent'
  if (st.isSymbolicLink()) return 'symbolic link'
  if (st.isFile()) return 'regular file'
  return 'other'
}

/** `readlink`, or the empty string -- which is what `|| true` leaves. */
function shadowDest(root: string): string {
  try {
    return readlinkSync(join(root, SHADOW))
  }
  catch {
    return ''
  }
}

/** The account names in /etc/passwd, in file order. */
function passwdNames(root: string): string[] {
  if (entry(root, '/etc/passwd') === undefined) return []
  return readFileSync(join(root, '/etc/passwd'), 'utf8')
    .split('\n')
    .map(l => l.split(':')[0] ?? '')
    .filter(n => n !== '')
}

/** The non-empty lines of the factory template. `grep -c .` counts these. */
function factoryLines(root: string): string[] {
  if (entry(root, FACTORY_SHADOW) === undefined) return []
  return readFileSync(join(root, FACTORY_SHADOW), 'utf8').split('\n').filter(l => l !== '')
}

/** The password field of the FIRST entry for `user`, or undefined. */
function factoryHash(root: string, user: string): string | undefined {
  const line = factoryLines(root).find(l => l.startsWith(`${user}:`))
  return line === undefined ? undefined : (line.split(':')[1] ?? '')
}

/** `!`-prefixed or `*`-prefixed. EMPTY is NOT a locked marker; see the header. */
function isLockedMarker(hash: string): boolean {
  return hash.startsWith('!') || hash.startsWith('*')
}

function lines(root: string, path: string): string[] {
  if (entry(root, path) === undefined) return []
  return readFileSync(join(root, path), 'utf8').split('\n')
}

/** The units the reconciler must be ordered before, each with the file that must exist. */
const BEFORE_PAIRS: readonly { dep: string, file: string, feature?: string }[] = [
  { dep: 'micad.service', file: '/usr/lib/systemd/system/micad.service', feature: 'micad' },
  { dep: 'dropbear.service', file: '/etc/systemd/system/dropbear.service' },
  { dep: 'systemd-logind.service', file: '/usr/lib/systemd/system/systemd-logind.service' },
  { dep: 'systemd-user-sessions.service', file: '/usr/lib/systemd/system/systemd-user-sessions.service' },
]

export const SHADOW_CHECKS: readonly CheckCase[] = [
  {
    // Half one of the end-to-end property: the path PAM reads IS the symlink,
    // and it names the tmpfs directory exactly. "A symlink exists" would pass
    // for a symlink pointing anywhere at all.
    id: 'shadow-is-symlink-to-run',
    shell: {
      pass: `${SHADOW} is a symlink to ${SHADOW_LINK_TARGET} (the path pam_unix opens`,
      fail: `expected a symlink to ${SHADOW_LINK_TARGET}`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const type = shadowType(root)
      const dest = shadowDest(root)
      const ok = type === 'symbolic link' && dest === SHADOW_LINK_TARGET
      return [verdict(
        'shadow-is-symlink-to-run',
        ok,
        ok
          ? `${SHADOW} is a symlink to ${SHADOW_LINK_TARGET} (the path pam_unix opens is writable at runtime)`
          : `${SHADOW} is '${type}'${dest === '' ? '' : ` -> ${dest}`}, expected a symlink to `
            + `${SHADOW_LINK_TARGET}; on the read-only verity root a regular file there can never be `
            + `written, so no per-device password is possible`,
      )]
    },
  },

  {
    // Half two: nothing INSIDE the squashfs can satisfy that path. This is the
    // pair that makes "PAM reads the copy built in RAM" provable from the
    // artifact rather than asserted.
    id: 'shadow-no-regular-in-image',
    shell: {
      pass: `no regular ${SHADOW} inside the squashfs`,
      fail: `${SHADOW} is a REGULAR FILE inside the squashfs`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const regular = shadowType(await packedRoot(ctx)) === 'regular file'
      return [verdict(
        'shadow-no-regular-in-image',
        !regular,
        regular
          ? `${SHADOW} is a REGULAR FILE inside the squashfs; it shadows the STATE-backed copy and is `
          + `identical on every device in the fleet`
          : `no regular ${SHADOW} inside the squashfs (nothing shadows the STATE-backed copy)`,
      )]
    },
  },

  {
    id: 'shadow-target-absent-in-image',
    shell: {
      pass: 'does not exist inside the squashfs, so the symlink can only ever resolve',
      fail: `exists inside the squashfs, so ${SHADOW} would resolve to an image file`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      // `[ -e ] || [ -L ]`: either a real file or a dangling link at the
      // destination is enough to make the symlink resolve inside the image.
      const present = entry(await packedRoot(ctx), SHADOW_LINK_TARGET) !== undefined
      return [verdict(
        'shadow-target-absent-in-image',
        !present,
        present
          ? `${SHADOW_LINK_TARGET} exists inside the squashfs, so ${SHADOW} would resolve to an image `
          + `file -- byte-identical on every device in the fleet -- rather than to the copy built `
          + `in RAM at boot`
          : `${SHADOW_LINK_TARGET} does not exist inside the squashfs, so the symlink can only ever `
            + `resolve to the file mica-shadow-reconcile builds in RAM`,
      )]
    },
  },

  {
    // Derived from the ACTUAL link destination rather than from the constant
    // above: a check against the constant would keep passing for a symlink
    // retargeted anywhere else, which is the whole thing being guarded against.
    id: 'shadow-link-lands-on-tmpfs',
    shell: {
      pass: 'under /run: systemd mounts /run as a tmpfs before any unit starts',
      fail: [
        'so it has no target directory to place',
        'is not under /run. mica supports no persistent password',
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const dest = shadowDest(await packedRoot(ctx))
      if (dest === '') {
        return [verdict('shadow-link-lands-on-tmpfs', false,
          `${SHADOW} is not a symlink, so it has no target directory to place; a regular file on the `
          + `read-only verity root can never be written`)]
      }
      const dir = dirname(dest)
      const onTmpfs = dir === '/run' || dir.startsWith('/run/')
      return [verdict(
        'shadow-link-lands-on-tmpfs',
        onTmpfs,
        onTmpfs
          ? `the ${SHADOW} symlink lands in ${dir}, under /run: systemd mounts /run as a tmpfs before `
          + `any unit starts, so a transient root password cannot outlive the boot that set it`
          : `the ${SHADOW} symlink target dir '${dir}' is not under /run. mica supports no persistent `
            + `password (mica:docs/design/access.md 4.2), so a credential file on storage that survives a `
            + `reboot can only be made transient by a protocol something has to run -- exactly the `
            + `design mica does not have`,
      )]
    },
  },

  {
    // The same claim from the other side. A symlink that satisfies "is a
    // symlink" and "is not a regular file in the image" while pointing back at
    // the persistent copy would pass everything else here.
    id: 'shadow-link-not-persistent',
    shell: {
      pass: 'points at nothing under /mnt/data/state or /var',
      fail: 'which is persistent storage; the transient password would survive',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const dest = shadowDest(await packedRoot(ctx))
      const dir = dest === '' ? '<not a symlink>' : dirname(dest)
      const persistent = dir.startsWith('/mnt/data/state/') || dir.startsWith('/var/')
      return [verdict(
        'shadow-link-not-persistent',
        !persistent,
        persistent
          ? `the ${SHADOW} symlink points at '${dir}', which is persistent storage; the transient `
          + `password would survive the reboot that is supposed to end it`
          : `the ${SHADOW} symlink points at nothing under /mnt/data/state or /var, so no shadow file is `
            + `kept on persistent storage`,
      )]
    },
  },

  {
    // The factory template has to carry the accounts the image ships, or an
    // account added by a later update gets a bare placeholder instead of its
    // aging fields -- and an EMPTY template would make every check above pass
    // for the wrong reason.
    id: 'factory-shadow-covers-passwd',
    shell: {
      pass: 'accounts listed in /etc/passwd (root included)',
      fail: ['cannot compare /etc/passwd against ', 'entries and is missing:'],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (entry(root, FACTORY_SHADOW) === undefined || entry(root, '/etc/passwd') === undefined) {
        return [verdict('factory-shadow-covers-passwd', false,
          `cannot compare /etc/passwd against ${FACTORY_SHADOW}: one of them is missing`)]
      }
      const entries = factoryLines(root)
      const missing = passwdNames(root).filter(u => !entries.some(l => l.startsWith(`${u}:`)))
      const ok = missing.length === 0 && entries.length > 0
      return [verdict(
        'factory-shadow-covers-passwd',
        ok,
        ok
          ? `${FACTORY_SHADOW} carries all ${entries.length} accounts listed in /etc/passwd (root included)`
          : `${FACTORY_SHADOW} has ${entries.length} entries and is missing:`
            + `${missing.length === 0 ? ' (nothing, but it is empty)' : missing.map(u => ` ${u}`).join('')}`,
      )]
    },
  },

  {
    // unix_chkpwd is setgid `shadow` precisely so a non-root PAM stack can read
    // the file. Without the group, password verification stops working for
    // every non-root caller.
    id: 'shadow-group-defined',
    shell: {
      pass: 'the image defines the \'shadow\' group (gid ',
      fail: 'the image has no \'shadow\' group',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const gid = shadowGid(await packedRoot(ctx))
      return [verdict(
        'shadow-group-defined',
        gid !== undefined,
        gid !== undefined
          ? `the image defines the 'shadow' group (gid ${gid}), which unix_chkpwd runs setgid to`
          : `the image has no 'shadow' group, so unix_chkpwd cannot read ${SHADOW} at all`,
      )]
    },
  },

  {
    // 0640 root:shadow, and it must survive packing -- which is why this reads
    // the unpacked tree rather than the source overlay. squashfs carries the
    // mode and ownership; a build step that copied the file through something
    // that did not is invisible everywhere else.
    id: 'factory-shadow-mode',
    shell: {
      pass: ' is 0640 root:shadow (0:',
      fail: 'expected 640 and 0:',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const gid = shadowGid(root)
      const st = entry(root, FACTORY_SHADOW)
      const mode = st === undefined ? 'none' : (st.mode & 0o7777).toString(8)
      const owner = st === undefined ? 'none' : `${st.uid}:${st.gid}`
      const ok = mode === '640' && owner === `0:${gid ?? ''}`
      return [verdict(
        'factory-shadow-mode',
        ok,
        ok
          ? `${FACTORY_SHADOW} is 0640 root:shadow (0:${gid ?? ''}) in the packed image`
          : `${FACTORY_SHADOW} is mode ${mode} owner ${owner}, expected 640 and 0:${gid ?? ''} (root:shadow)`,
      )]
    },
  },

  {
    // EVERY reader is listed, not a sample. The file does not exist until this
    // unit runs -- it is built in RAM -- so a reader that starts first finds no
    // /etc/shadow at all and fails every account closed, including the one an
    // operator is trying to use. That failure direction is the safe one, which
    // is exactly why the ordering has to be complete rather than approximately
    // right.
    //
    // `many`, with the ordered-against unit as the instance: the oracle loops
    // over four pairs and prints one conclusion each, and a family compared by
    // COUNT could not say which reader lost its ordering.
    id: 'shadow-reconcile-ordered-before',
    cardinality: 'many',
    // ` naming ` is optional because the "has no Before= naming X" branch puts
    // the unit name after the `=` rather than at it.
    instance: /Before=(?: naming )?([A-Za-z0-9@._-]+)/,
    shell: {
      pass: 'mica-shadow-reconcile.service orders ',
      fail: [
        'ordering cannot be checked',
        'has no Before= naming',
        'systemd drops an ordering against a non-existent unit SILENTLY',
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const unitPresent = entry(root, REC_UNIT)?.isFile() === true
      // A whitespace-separated unit LIST, matched as a whole token: a substring
      // match would accept `Before=xmicad.serviceX` and a bare search for the
      // name would accept it appearing in a comment.
      const named = new Set(lines(root, REC_UNIT)
        .filter(l => l.startsWith('Before='))
        .flatMap(l => l.slice('Before='.length).split(/\s+/))
        .filter(t => t !== ''))
      // A pair whose unit a product feature ships is judged only when the product selected it.
      return BEFORE_PAIRS.filter(({ feature }) => feature === undefined || ctx.product.features.has(feature)).map(({ dep, file }) => {
        const firing = { instance: dep }
        if (!unitPresent) {
          return verdict('shadow-reconcile-ordered-before', false,
            `mica-shadow-reconcile.service is missing, so its Before=${dep} ordering cannot be checked`,
            firing)
        }
        if (!named.has(dep)) {
          return verdict('shadow-reconcile-ordered-before', false,
            `mica-shadow-reconcile.service has no Before= naming ${dep}; ${dep} would look for `
            + `${SHADOW} before this unit builds it, and find no file at all`, firing)
        }
        if (entry(root, file)?.isFile() !== true) {
          return verdict('shadow-reconcile-ordered-before', false,
            `mica-shadow-reconcile.service orders Before=${dep} but ${file} is not in the image; `
            + `systemd drops an ordering against a non-existent unit SILENTLY`, firing)
        }
        return verdict('shadow-reconcile-ordered-before', true,
          `mica-shadow-reconcile.service orders Before=${dep}, and ${file} is present in the image`,
          firing)
      })
    },
  },

  {
    // ...and NO ordering against STATE. The file is built on a tmpfs systemd
    // has already mounted, so a dependency on var-lib-mica.mount would delay the
    // credential file behind a storage mount that can fail -- and it would say,
    // to the next reader of this unit, that the file still lives on STATE.
    id: 'shadow-reconcile-no-state-dep',
    shell: {
      pass: 'declares no After=/Requires= against var-lib-mica.mount or /mnt/data/state',
      fail: ['still depends on STATE:', 'so its lack of a STATE ordering cannot be checked'],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (entry(root, REC_UNIT)?.isFile() !== true) {
        return [verdict('shadow-reconcile-no-state-dep', false,
          'mica-shadow-reconcile.service is missing, so its lack of a STATE ordering cannot be checked')]
      }
      const hits = lines(root, REC_UNIT)
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /^(After|Requires|RequiresMountsFor|BindsTo)=.*(var-lib-mica|\/mnt\/data\/state)/.test(l))
      return [verdict(
        'shadow-reconcile-no-state-dep',
        hits.length === 0,
        hits.length === 0
          ? 'mica-shadow-reconcile.service declares no After=/Requires= against var-lib-mica.mount or '
          + '/mnt/data/state; it needs only the tmpfs systemd has already mounted'
          : `mica-shadow-reconcile.service still depends on STATE: `
            + `${hits.map(h => `${h.n}:${h.l}`).join(' ')} . It builds ${SHADOW_LINK_TARGET} in RAM `
            + `and touches no persistent storage; an ordering against a mount it does not need can `
            + `only delay or block the file PAM opens`,
      )]
    },
  },

  {
    // And nothing may seed a shadow file onto STATE behind its back.
    // mica-seed-state ran the reconciler against /mnt/data/state/mica/shadow on first
    // boot, back when /etc/shadow resolved there; with the file in RAM that
    // line would put a credential on persistent storage that nothing reads and
    // nothing ever clears.
    id: 'seed-state-no-shadow-on-state',
    shell: {
      pass: 'mica-seed-state seeds no shadow file onto STATE',
      fail: ['mica-seed-state still puts a shadow file on STATE:', `${SEED_STATE} is not in the image`],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (entry(root, SEED_STATE)?.isFile() !== true) {
        return [verdict('seed-state-no-shadow-on-state', false,
          `${SEED_STATE} is not in the image, so its handling of the shadow file cannot be checked`)]
      }
      const hits = lines(root, SEED_STATE)
        .map((l, i) => ({ l, n: i + 1 }))
        // `grep -v '^[0-9]*:#'`: a COMMENT is not a seeding, and the file is
        // allowed to explain why it does not do this.
        .filter(({ l }) => /mica-shadow-reconcile|\/mnt\/data\/state\/[a-z]*\/?shadow/.test(l) && !l.startsWith('#'))
      return [verdict(
        'seed-state-no-shadow-on-state',
        hits.length === 0,
        hits.length === 0
          ? `mica-seed-state seeds no shadow file onto STATE; the only ${SHADOW} on the device is the `
          + `one built in RAM at boot`
          : `mica-seed-state still puts a shadow file on STATE: ${hits.map(h => `${h.n}:${h.l}`).join(' ')} . `
            + `The only credential mica supports is a transient root password, and a copy on a `
            + `partition that survives reboots cannot be transient by construction`,
      )]
    },
  },

  {
    // The unit being present and enabled is batch 2a's. That is not the same as
    // it DOING anything, and what it must do has changed shape: the file is
    // REBUILT from the factory copy on every boot. What has to be proven from
    // the artifact is that the build reads the factory copy and NOT whatever
    // was there before -- a script that preserved existing entries would make a
    // password persist across reboots on a tmpfs too, the moment anything
    // restored the file.
    id: 'shadow-reconcile-builds-in-ram',
    shell: {
      pass: 'in RAM from ',
      fail: [
        'mica-shadow-reconcile would not make the root password transient:',
        `${REC_SCRIPT} is not in the image`,
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (entry(root, REC_SCRIPT)?.isFile() !== true) {
        return [verdict('shadow-reconcile-builds-in-ram', false,
          `${REC_SCRIPT} is not in the image, so nothing would build ${SHADOW} and every account `
          + `would be unauthenticable`)]
      }
      const script = lines(root, REC_SCRIPT)
      const has = (re: RegExp): boolean => script.some(l => re.test(l))
      const defects: string[] = []
      if (!has(/^FACTORY=.*\/usr\/share\/factory\/etc\/shadow/))
        defects.push(` it does not name ${FACTORY_SHADOW} as its source;`)

      if (!has(/^SHADOW=.*\/run\//)) {
        defects.push(' its default destination is not under /run, so the file it builds would not be '
          + 'on a tmpfs;')
      }
      // The build loop's input redirection is the load-bearing line: reading
      // the DESTINATION here is precisely how a transient password survives.
      if (!has(/done[ \t]*<"\$FACTORY"/)) defects.push(' its build loop does not read $FACTORY;')
      if (has(/done[ \t]*<"\$SHADOW"/)) {
        defects.push(' its build loop reads $SHADOW, i.e. it carries the previous boot\'s entries '
          + 'forward, which is exactly what makes a password persist;')
      }
      if (!has(/\$2 = "!"/))
        defects.push(' it does not force a locked password field on the entries it copies;')

      return [verdict(
        'shadow-reconcile-builds-in-ram',
        defects.length === 0,
        defects.length === 0
          ? `mica-shadow-reconcile builds ${SHADOW_LINK_TARGET} in RAM from ${FACTORY_SHADOW} on every `
          + `boot, locking every entry it copies and reading nothing from the previous boot -- which `
          + `is what makes the root password transient without a protocol to get wrong`
          : `mica-shadow-reconcile would not make the root password transient:${defects.join('')}`,
      )]
    },
  },

  {
    // The WEAKER of the two locked-field checks, ported as it stands: its awk
    // is `$2 !~ /^[!*]/ && $2 != ""`, so an EMPTY field passes here. See the
    // module header -- the check below disagrees, and both are the oracle's.
    id: 'factory-shadow-locked',
    shell: {
      pass: 'is locked (password field ! or * or empty)',
      fail: ['ships a usable password hash for:', `${FACTORY_SHADOW} is missing, so the shipped credential set`],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      if (entry(root, FACTORY_SHADOW)?.isFile() !== true) {
        return [verdict('factory-shadow-locked', false,
          `${FACTORY_SHADOW} is missing, so the shipped credential set cannot be checked`)]
      }
      const unlocked = factoryLines(root)
        .filter((l) => {
          const h = l.split(':')[1] ?? ''
          return !isLockedMarker(h) && h !== ''
        })
        .map(l => l.split(':')[0] ?? '')
      return [verdict(
        'factory-shadow-locked',
        unlocked.length === 0,
        unlocked.length === 0
          ? `every entry in ${FACTORY_SHADOW} is locked (password field ! or * or empty), so the image `
          + `ships no usable credential for any account`
          : `${FACTORY_SHADOW} ships a usable password hash for: ${unlocked.join(' ')} . The rootfs is `
            + `signed and byte-identical across the fleet, so that is the same credential on every `
            + `device, and it is the file every boot rebuilds ${SHADOW} from`,
      )]
    },
  },

  {
    // What this proves: the shadow file that SHIPS carries no usable ROOT
    // password, so a signed rootfs -- byte-identical on every device in the
    // fleet -- cannot hand anyone a working login. What it does NOT prove is
    // that the device ends up with a good password; that is micad's job at
    // runtime and is only observable on a real boot.
    id: 'factory-shadow-root-locked',
    shell: {
      pass: 'the packed rootfs carries NO usable root password',
      fail: [
        'has no root: entry, so no claim can be made',
        'has an EMPTY hash field, which means PASSWORDLESS root login',
        'the packed rootfs carries a usable root password hash in ',
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const hash = factoryHash(root, 'root')
      if (hash === undefined) {
        return [verdict('factory-shadow-root-locked', false,
          `${FACTORY_SHADOW} has no root: entry, so no claim can be made about the baked root password`)]
      }
      if (hash === '') {
        return [verdict('factory-shadow-root-locked', false,
          `the root: entry in ${FACTORY_SHADOW} has an EMPTY hash field, which means PASSWORDLESS root `
          + `login: pam_unix accepts any password, including none. Empty is not a locked marker — only `
          + `'!' (including '!!' and '!'-prefixed forms that retain a hash) and '*' lock an account`)]
      }
      if (isLockedMarker(hash)) {
        return [verdict('factory-shadow-root-locked', true,
          `the packed rootfs carries NO usable root password (root: hash field is '${hash}', a locked marker)`)]
      }
      return [verdict('factory-shadow-root-locked', false,
        `the packed rootfs carries a usable root password hash in ${FACTORY_SHADOW}. A signed rootfs `
        + `is byte-identical on every device, so this is a fleet-wide shared secret. Something in the `
        + `build wrote a root credential (the build has no ROOT_PASSWORD build arg on purpose); root access `
        + `is provisioned at runtime — micad's transient password`)]
    },
  },

  {
    // The rule covers every account /etc/passwd names, not just root: a check
    // that stayed root-shaped would quietly stop covering the case it was
    // written for as soon as a second account shipped.
    //
    // TWO failure branches with two messages, because they are two different
    // defects with different repairs. EMPTY means the account accepts any
    // password on this device. A usable hash means a credential every device in
    // the fleet shares. Reporting one as the other sends the fix the wrong way.
    id: 'factory-shadow-accounts-locked',
    shell: {
      pass: 'have a LOCKED password field — none empty, none a usable hash',
      fail: [
        'no account could be read from ',
        'with an EMPTY password field:',
        'carrying a usable password hash:',
      ],
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const empty: string[] = []
      const hashed: string[] = []
      let checked = 0
      if (entry(root, FACTORY_SHADOW) !== undefined && entry(root, '/etc/passwd') !== undefined) {
        for (const user of passwdNames(root)) {
          const h = factoryHash(root, user)
          if (h === undefined) continue
          checked += 1
          if (h === '') empty.push(user)
          else if (!isLockedMarker(h)) hashed.push(user)
        }
      }
      if (checked === 0) {
        return [verdict('factory-shadow-accounts-locked', false,
          `no account could be read from ${FACTORY_SHADOW}, so nothing can be claimed about the `
          + `passwords this image ships`)]
      }
      if (empty.length > 0) {
        return [verdict('factory-shadow-accounts-locked', false,
          `account(s) in ${FACTORY_SHADOW} with an EMPTY password field:${empty.map(u => ` ${u}`).join('')}. `
          + `An empty field means PASSWORDLESS login — pam_unix accepts any password, including none. `
          + `Empty is not a locked marker; only '!' (including '!!' and '!'-prefixed forms that retain `
          + `a hash) and '*' lock an account`)]
      }
      if (hashed.length > 0) {
        return [verdict('factory-shadow-accounts-locked', false,
          `account(s) in ${FACTORY_SHADOW} carrying a usable password hash:${hashed.map(u => ` ${u}`).join('')}. `
          + `A signed rootfs is byte-identical on every device in the fleet, so any hash baked into `
          + `one is a shared secret by construction; passwords are provisioned per device at runtime, `
          + `never in the image`)]
      }
      return [verdict('factory-shadow-accounts-locked', true,
        `all ${checked} accounts in ${FACTORY_SHADOW} have a LOCKED password field — none empty, none `
        + `a usable hash`)]
    },
  },

  {
    // The two environment overrides that let tests/shadow-reconcile-test.sh
    // drive the REAL script against fixtures. They are safe only while nothing
    // in the image sets them: a stray drop-in pointing MICA_SHADOW_PASSWD or
    // MICA_SHADOW_FACTORY elsewhere would silently reconcile root's credentials
    // against the wrong files, and every other check here would still pass.
    //
    // Checked in the shipped unit AND in both drop-in directories, since a
    // drop-in overrides the unit invisibly.
    id: 'shadow-reconcile-no-test-override',
    shell: {
      pass: 'names MICA_SHADOW_PASSWD or MICA_SHADOW_FACTORY',
      fail: 'MICA_SHADOW_PASSWD/MICA_SHADOW_FACTORY override by:',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const candidates = [
        REC_UNIT,
        ...dropIns(root, '/etc/systemd/system/mica-shadow-reconcile.service.d'),
        ...dropIns(root, '/usr/lib/systemd/system/mica-shadow-reconcile.service.d'),
      ]
      const hits = candidates.filter(p => entry(root, p)?.isFile() === true
        && lines(root, p).some(l => /^[ \t]*Environment(File)?=.*(MICA_SHADOW_PASSWD|MICA_SHADOW_FACTORY)/.test(l)))
      return [verdict(
        'shadow-reconcile-no-test-override',
        hits.length === 0,
        hits.length === 0
          ? 'no Environment=/EnvironmentFile= in mica-shadow-reconcile.service or its drop-in dirs names '
          + 'MICA_SHADOW_PASSWD or MICA_SHADOW_FACTORY (the test-harness overrides stay inert in the image)'
          : `mica-shadow-reconcile.service is given a MICA_SHADOW_PASSWD/MICA_SHADOW_FACTORY override by:`
            + `${hits.map(p => ` ${p}`).join('')}. Those exist so the offline test harness can run the `
            + `real script; in the image they redirect where root's credentials are reconciled from and to`,
      )]
    },
  },
]

/** `*.conf` in a drop-in directory. An absent directory contributes nothing. */
function dropIns(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir)).filter(n => n.endsWith('.conf')).sort().map(n => `${dir}/${n}`)
  }
  catch {
    return []
  }
}

/** The gid of the `shadow` group, from the image's own /etc/group. */
function shadowGid(root: string): string | undefined {
  const line = lines(root, '/etc/group').find(l => l.startsWith('shadow:'))
  const gid = line?.split(':')[2]
  return gid === undefined || gid === '' ? undefined : gid
}
