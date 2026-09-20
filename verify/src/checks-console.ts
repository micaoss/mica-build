import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckCase } from './checks.ts'
import { packedRoot } from './checks-root.ts'
import type { CheckResult } from './parity.ts'
import { PRESET_DIRS, UNIT_DIRS, presetForInstance, wantsLinksNaming } from './unit-state.ts'
import { verdict } from './verdict.ts'

/**
 * The console a person meets: tty1 idle for the boot logo, a login prompt on
 * Alt+F2 through Alt+F6.
 *
 * *** THESE ARE NECESSARY CONDITIONS AND NOT A TESTED CLAIM, AND THE
 * DISTINCTION IS THE REASON THIS FILE IS WORTH READING BEFORE TRUSTING IT. ***
 *
 * NOTHING IN THIS TREE CAN EXERCISE A VIRTUAL TERMINAL. The QEMU harness runs
 * `-nographic`, so the guest has no /dev/tty0 at all: getty@.service and
 * getty-static.service both fail `ConditionPathExists=/dev/tty0`, and logind
 * allocates no VTs. The session probe's console is a serial line. So no gate
 * here has ever pressed Alt+F2, and none can. THE ONLY EVIDENCE THAT Alt+F2
 * WORKS IS THE USER PRESSING IT ON HARDWARE.
 *
 * What these four assertions do is make the console's preconditions fail
 * loudly when they stop holding. A reader who takes them for a tested claim
 * will believe the console is covered; it is not. That misreading is not
 * hypothetical here -- `verify/src/checks-display.ts` asserted the getty
 * outcome over the packed root until it was deleted on 2026-09-09 inside a
 * cleanup (1875d133, "remove retired update paths, obsolete documentation and
 * unused layout code"). `rootfs/scripts/preset-enforce.sh` still named it in
 * the present tense afterwards, and `checks-fixture.ts` still seeds
 * 50-mica-getty.preset -- a file three of four real boards do not have -- to
 * feed a suite that no longer exists. A FIXTURE IS NEVER COMPARED TO A ROOT,
 * so it can fabricate reality in the one place where nothing can notice.
 */

const GETTY_TEMPLATE = 'getty@.service'
const GETTY_TTY1 = 'getty@tty1.service'
const AUTOVT = 'autovt@.service'
const GETTY_STATIC = 'getty-static.service'
const LOGIND_UNIT = 'systemd-logind.service'

/** The login path a VT getty walks, each piece measured in the packed root. */
const LOGIN_CLOSURE = ['/usr/sbin/agetty', '/usr/bin/login', '/etc/pam.d/login'] as const

export const CONSOLE_CHECKS: readonly CheckCase[] = [
  {
    // (a) THE DECISION, NOT THE ACCIDENT.
    //
    // Both halves are asserted deliberately: no enablement link for
    // getty@tty1.service AND a preset rule that resolves it to `disable`. An
    // image with no link and no rule is tty1-idle today and says nothing about
    // why -- which is exactly the state three of four boards were in until
    // 40-mica-build.preset carried the rule. The link is absent there because
    // the composer DROPS it as unowned: systemd's postinst creates
    // /etc/systemd/system/getty.target.wants/getty@tty1.service directly, so
    // there is no dpkg ownership and no deb-systemd-helper record, and both of
    // the composer's proofs miss it. Teach the composer to keep unowned
    // enablement links and three boards get a login prompt over the boot logo,
    // with the written policy on those boards saying that is correct.
    id: 'packed-getty-tty1-disabled',
    shell: {
      pass: 'tty1 is idle by decision',
      fail: 'tty1 is not idle by decision',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const unit = UNIT_DIRS.map(dir => `${dir}/${GETTY_TEMPLATE}`).find(p => existsSync(join(root, p)))
      if (unit === undefined) {
        return [verdict('packed-getty-tty1-disabled', false,
          `tty1 is not idle by decision: there is no ${GETTY_TEMPLATE} in ${UNIT_DIRS.join(' or ')} `
          + 'at all, so "nothing enables it" is a statement about nothing -- true of a root that '
          + 'failed to unpack and of a directory that was never a root. systemd ships this unit')]
      }
      const links = wantsLinksNaming(root, GETTY_TTY1)
      if (links.length > 0) {
        return [verdict('packed-getty-tty1-disabled', false,
          `tty1 is not idle by decision: ${links.join(' ')} enable(s) ${GETTY_TTY1}, so a login `
          + 'prompt runs on tty1 and draws over the boot logo the user asked every board to show')]
      }
      // presetForInstance AND NOT presetFor. The rule this tree ships is
      // `disable getty@.service` -- the TEMPLATE -- and systemd resolves an
      // instance against both its own rules and its template's. presetFor
      // matches literally, so it answers "no rule" over a root whose policy
      // file is right there, and this check reported the decision as an
      // absence until the fixture said otherwise. unit-state.ts carries that
      // warning in presetForInstance's own comment; I wrote the bug anyway.
      const rule = presetForInstance(root, GETTY_TTY1)
      if (rule === undefined) {
        return [verdict('packed-getty-tty1-disabled', false,
          `tty1 is not idle by decision: no preset rule in ${PRESET_DIRS.join(' ')} matches `
          + `${GETTY_TTY1}, and an unmatched unit presets to ENABLE. No link exists today, but `
          + 'that is an ABSENCE AND NOT A DECISION -- and one `systemctl preset-all`, or one '
          + 'composer change that keeps unowned enablement links, turns it into a login prompt on '
          + 'top of the logo')]
      }
      if (rule.verb !== 'disable') {
        return [verdict('packed-getty-tty1-disabled', false,
          `tty1 is not idle by decision: the first rule that claims ${GETTY_TTY1} is `
          + `'${rule.verb} ${rule.pattern}' in ${rule.file}. Preset rules are consulted in `
          + 'lexicographic order of basename and the first match wins, so a later `disable` would '
          + 'never be read')]
      }
      return [verdict('packed-getty-tty1-disabled', true,
        `tty1 is idle by decision: ${unit} is in the root, no .wants or .requires link names `
        + `${GETTY_TTY1}, and the first preset rule that claims it is '${rule.verb} `
        + `${rule.pattern}' in ${rule.file}`)]
    },
  },

  {
    // (b) THE SILENT ONE, AND THE REASON THIS FAMILY GOT A FILE.
    //
    // logind starts `autovt@ttyN.service` when a VT is activated; that unit is
    // an ALIAS SYMLINK to getty@.service and nothing else. A disabled template
    // is still startable by name, which is why (a) and this one do not
    // conflict. IF THIS SYMLINK IS EVER DROPPED, Alt+F2 OPENS A BLANK VT,
    // NOTHING LOGS ANYTHING, AND EVERY OTHER INSTRUMENT IN THIS TREE REPORTS A
    // HEALTHY IMAGE -- one door along from the PAM stack that never assembled.
    // It is exactly the shape the composer cannot see by itself: a path kept
    // by no DT_NEEDED and claimed by no ownership proof.
    //
    // LISTED WITH lstat AND readlink RATHER THAN existsSync: a symlink whose
    // TARGET is missing answers "absent" to a test that dereferences and
    // "present" to one that does not, and the two answers are both about the
    // link. Here the wrong reading would be the reassuring one.
    id: 'packed-autovt-alias',
    shell: {
      pass: 'autovt@.service aliases getty@.service',
      fail: 'autovt@.service does not alias getty@.service',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const found = UNIT_DIRS
        .map(dir => ({ dir, path: join(root, dir, AUTOVT) }))
        .find(c => { try { lstatSync(c.path); return true } catch { return false } })
      if (found === undefined) {
        return [verdict('packed-autovt-alias', false,
          `autovt@.service does not alias getty@.service: no ${AUTOVT} in `
          + `${UNIT_DIRS.join(' or ')}. logind starts autovt@ttyN when a VT is activated, so `
          + 'without it Alt+F2 through Alt+F6 open BLANK terminals -- no login prompt, no error, '
          + 'and nothing in the journal saying why')]
      }
      const stat = lstatSync(found.path)
      if (!stat.isSymbolicLink()) {
        return [verdict('packed-autovt-alias', false,
          `autovt@.service does not alias getty@.service: ${found.dir}/${AUTOVT} is not a symlink `
          + '(systemd ships it as the alias link that makes logind\'s autovt name resolve)')]
      }
      const target = readlinkSync(found.path)
      if (target !== GETTY_TEMPLATE && target !== `./${GETTY_TEMPLATE}`) {
        return [verdict('packed-autovt-alias', false,
          `autovt@.service does not alias getty@.service: ${found.dir}/${AUTOVT} points at `
          + `'${target}'`)]
      }
      return [verdict('packed-autovt-alias', true,
        `autovt@.service aliases getty@.service: ${found.dir}/${AUTOVT} -> ${target}. This is what `
        + 'makes Alt+F2 reach a login prompt on a tty with no enabled getty')]
    },
  },

  {
    // (c) THE REST OF THE LOGIN PATH, REACHED THROUGH A SECOND DOOR.
    //
    // /etc/pam.d/login is here as well as in the PAM family on purpose. TWO
    // INDEPENDENT ASSERTIONS REACHING ONE FILE IS A FEATURE: the PAM family
    // asks whether the stack assembles, this one asks whether the console's
    // login path is complete, and either question alone would have missed the
    // defect that shipped a console answering "PAM failure, aborting" on every
    // published image before 20260920-0622.
    id: 'packed-console-login-path',
    shell: {
      pass: 'the console login path is complete',
      fail: 'the console login path is incomplete',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const missing = LOGIN_CLOSURE.filter(p => !existsSync(join(root, p)))
      if (missing.length > 0) {
        return [verdict('packed-console-login-path', false,
          `the console login path is incomplete: ${missing.join(' ')} missing from the packed `
          + 'root. agetty opens the terminal, login authenticates through PAM, and /etc/pam.d/login '
          + 'is the service file that stack is assembled from -- without it PAM falls back to '
          + '/etc/pam.d/other and a console login is refused')]
      }
      const logind = UNIT_DIRS.map(dir => `${dir}/${LOGIND_UNIT}`).find(p => existsSync(join(root, p)))
      if (logind === undefined) {
        return [verdict('packed-console-login-path', false,
          `the console login path is incomplete: no ${LOGIND_UNIT} in ${UNIT_DIRS.join(' or ')}. `
          + 'logind is what spawns a getty when a VT is activated; without it no Alt+F key reaches '
          + 'anything')]
      }
      const wants = wantsLinksNaming(root, LOGIND_UNIT)
      if (wants.length === 0) {
        return [verdict('packed-console-login-path', false,
          `the console login path is incomplete: ${logind} is in the root but no .wants or `
          + '.requires link names it, so logind does not start and no VT is ever autospawned')]
      }
      return [verdict('packed-console-login-path', true,
        `the console login path is complete: ${LOGIN_CLOSURE.join(' ')} are in the root and `
        + `${LOGIND_UNIT} is enabled by ${wants.join(' ')}`)]
    },
  },

  {
    // (d) THE UNIT THAT IS CORRECT AND LOOKS WRONG.
    //
    // getty-static.service is Wanted by getty.target in every root and would
    // start getty@tty2..tty6 directly -- which would put login prompts on the
    // VTs whether or not anybody pressed a key, and would contradict (a) if it
    // ever ran. It does not run: its conditions are
    // `ConditionPathExists=!/usr/bin/dbus-daemon` and the dbus-broker twin,
    // and we carry dbus-daemon. This is asserted so that nobody "repairs" a
    // unit that is already right, and so that REMOVING dbus-daemon -- which
    // would look like an unrelated change -- fails here rather than surprising
    // somebody at a console.
    id: 'packed-getty-static-inert',
    shell: {
      pass: 'getty-static.service is inert',
      fail: 'getty-static.service is not inert',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const unit = UNIT_DIRS.map(dir => `${dir}/${GETTY_STATIC}`).find(p => existsSync(join(root, p)))
      if (unit === undefined) {
        return [verdict('packed-getty-static-inert', true,
          `getty-static.service is inert: there is no ${GETTY_STATIC} in the root at all`)]
      }
      const text = readFileSync(join(root, unit), 'utf8')
      const negated = [...text.matchAll(/^ConditionPathExists=!(\S+)\s*$/gm)].map(m => m[1]!)
      if (negated.length === 0) {
        return [verdict('packed-getty-static-inert', false,
          `getty-static.service is not inert: ${unit} carries no negated ConditionPathExists, so `
          + 'nothing stops it starting getty@tty2..tty6 directly. That would put login prompts on '
          + 'the VTs without anybody pressing a key, which is the opposite of the tty1 decision '
          + 'one check above')]
      }
      const present = negated.filter(p => existsSync(join(root, p)))
      if (present.length === 0) {
        return [verdict('packed-getty-static-inert', false,
          `getty-static.service is not inert: its conditions are satisfied. ${unit} skips itself `
          + `only when one of ${negated.join(' ')} EXISTS, and none of them is in this root, so `
          + 'the unit runs and starts getty@tty2..tty6 on its own')]
      }
      return [verdict('packed-getty-static-inert', true,
        `getty-static.service is inert: ${unit} declines to run while ${present.join(' ')} `
        + `exist(s), and it is in the root. The VTs come from logind's autovt path alone`)]
    },
  },
]
