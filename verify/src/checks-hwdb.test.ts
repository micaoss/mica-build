// The hwdb family, driven from the failing side.
//
// Every check here passes by finding NOTHING, which is the direction that goes
// green for the wrong reason: a walk that reads the wrong directory, a scanner
// that stopped recognising the clause, and an empty root all report the same
// "no hardware database ships". So each case restores exactly one of the things
// PLAN-086 S4 removed and requires red, and each check's own vacuity guard is
// driven separately -- by emptying the space it searches rather than by putting
// a database back.
//
// The mutations are the real shapes. A Debian systemd upgrade re-running
// `systemd-hwdb update` in a postinst puts /etc/udev/hwdb.bin back; a package
// that ships its own .hwdb file puts one under a path no list here names; a
// rules file restored from upstream brings its IMPORT clauses with it; and a
// unit that names systemd-hwdb-update.service in After= is what a systemd
// package refresh reinstates, silently, because systemd drops an ordering onto
// a missing unit without a word.
//
// The last group is the opposite direction and the reason this family has four
// checks rather than three: the removal EDITS rules that do other things, and
// the way that goes wrong is by taking a whole rule. Each case there deletes one
// surviving action and requires the check to name it and its category.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadBoard } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import {
  HWDB_BINARIES,
  HWDB_CHECKS,
  HWDB_SOURCE_DIRS,
  HWDB_TOOL,
  HWDB_UNIT,
  SURVIVORS,
} from './checks-hwdb.ts'
import { assertRegisterWellFormed, CHECKS, type CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))

function checkNamed(id: string): CheckCase {
  const found = HWDB_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no hwdb check is registered as '${id}'. Registered: `
      + HWDB_CHECKS.map(c => c.id).join(', '))
  }
  return found
}

async function resultOf(fx: RootFixture, id: string): Promise<CheckResult> {
  const got = await checkNamed(id).run(fx.ctx)
  expect(got.length).toBe(1)
  return got[0] as CheckResult
}

async function verdictOf(fx: RootFixture, id: string): Promise<Verdict> {
  return (await resultOf(fx, id)).verdict
}

/**
 * Seed, assert GREEN, mutate, hand back.
 *
 * The green assertion is what makes the red one a test: a fixture that was
 * already failing reports the same red after an edit that changed nothing.
 */
async function mutated(id: string, mutate: (root: string) => void): Promise<RootFixture> {
  const fx = packedRootFixture(cx3576)
  expect(await verdictOf(fx, id)).toBe('pass')
  mutate(fx.root)
  return fx
}

function write(root: string, path: string, body = 'x\n'): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
}

function edit(root: string, path: string, fn: (body: string) => string): void {
  const p = join(root, path)
  writeFileSync(p, fn(readFileSync(p, 'utf8')))
}

const RULE = (name: string): string => `/usr/lib/udev/rules.d/${name}`

describe('the hwdb family is in the register and can be diffed', () => {
  test('every check is registered in CHECKS, and the register is well formed', () => {
    const registered = new Set(CHECKS.map(c => c.id))
    for (const c of HWDB_CHECKS) expect(registered.has(c.id)).toBe(true)
    expect(HWDB_CHECKS.length).toBeGreaterThan(0)
    assertRegisterWellFormed()
  })

  test('no matcher in the register contains another, in either direction', () => {
    const all = CHECKS.flatMap(c => [c.shell.pass, c.shell.fail, c.shell.skip])
      .filter((m): m is string => typeof m === 'string' && m.trim() !== '')
    const mine = HWDB_CHECKS.flatMap(c => [c.shell.pass, c.shell.fail])
      .filter((m): m is string => typeof m === 'string')
    for (const m of mine) {
      const clashes = all.filter(o => o !== m && (o.includes(m) || m.includes(o)))
      expect(clashes).toEqual([])
    }
  })

  test('the survivor table still covers the four categories the plan names', () => {
    // A table that shrank is a check that stopped looking, and it shrinks
    // silently: every remaining entry keeps passing.
    const categories = new Set(SURVIVORS.map(s => s.category))
    for (const needed of ['permissions', 'symlinks', 'module loading', 'service activation']) {
      expect([...categories]).toContain(needed)
    }
    expect(SURVIVORS.length).toBeGreaterThanOrEqual(12)
  })
})

describe('the static database itself', () => {
  test('the healthy fixture ships none of it', async () => {
    const fx = packedRootFixture(cx3576)
    const r = await resultOf(fx, 'packed-hwdb-absent')
    expect(r.verdict).toBe('pass')
    // The conclusion has to say how big the space it searched was, or the
    // reader cannot tell this from a green over an empty directory.
    expect(r.message).toContain('udev rule file(s)')
    fx.dispose()
  })

  for (const path of [...HWDB_BINARIES, HWDB_TOOL]) {
    test(`${path} put back turns it red`, async () => {
      const fx = await mutated('packed-hwdb-absent', root => write(root, path, 'KSLPHHRH'))
      const r = await resultOf(fx, 'packed-hwdb-absent')
      expect(r.verdict).toBe('fail')
      expect(r.message).toContain(path)
      fx.dispose()
    })
  }

  for (const dir of HWDB_SOURCE_DIRS) {
    test(`a source tree at ${dir} turns it red`, async () => {
      const fx = await mutated('packed-hwdb-absent',
        root => write(root, `${dir}/20-usb-vendor-model.hwdb`, 'usb:v1D6Bp0002*\n ID_MODEL=hub\n'))
      const r = await resultOf(fx, 'packed-hwdb-absent')
      expect(r.verdict).toBe('fail')
      expect(r.message).toContain(dir)
      fx.dispose()
    })
  }

  test('a .hwdb outside all four named paths is still found', async () => {
    // The case a path list cannot see: a package shipping its own source file
    // somewhere else under /usr/lib/udev. The removal names four paths; the
    // check sweeps the trees.
    const fx = await mutated('packed-hwdb-absent',
      root => write(root, '/usr/lib/udev/vendor.d/70-board.hwdb', 'evdev:name:*\n KEYBOARD_KEY_1=esc\n'))
    const r = await resultOf(fx, 'packed-hwdb-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('/usr/lib/udev/vendor.d/70-board.hwdb')
    fx.dispose()
  })

  test('a root with no udev rules cannot conclude it', async () => {
    const fx = await mutated('packed-hwdb-absent', root => {
      rmSync(join(root, '/usr/lib/udev/rules.d'), { recursive: true, force: true })
    })
    const r = await resultOf(fx, 'packed-hwdb-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('cannot be concluded')
    fx.dispose()
  })

  test('a root with no udevd cannot conclude it either', async () => {
    const fx = await mutated('packed-hwdb-absent', root => {
      for (const p of ['/usr/lib/systemd/systemd-udevd', '/usr/bin/udevadm']) {
        rmSync(join(root, p), { force: true })
      }
    })
    const r = await resultOf(fx, 'packed-hwdb-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('cannot be concluded')
    fx.dispose()
  })
})

describe('the machinery that would rebuild it', () => {
  test(`${HWDB_UNIT} put back turns it red`, async () => {
    const fx = await mutated('packed-hwdb-update-machinery-absent',
      root => write(root, `/usr/lib/systemd/system/${HWDB_UNIT}`,
        '[Unit]\nConditionPathExists=|!/usr/lib/udev/hwdb.bin\n[Service]\nExecStart=systemd-hwdb update\n'))
    const r = await resultOf(fx, 'packed-hwdb-update-machinery-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain(HWDB_UNIT)
    fx.dispose()
  })

  test('the enablement link alone turns it red', async () => {
    // The dangling half. A `systemctl preset-all` writes this link and nothing
    // reports it; the unit it points at is not even there.
    const fx = await mutated('packed-hwdb-update-machinery-absent', root => {
      const dir = join(root, '/usr/lib/systemd/system/sysinit.target.wants')
      mkdirSync(dir, { recursive: true })
      symlinkSync(`../${HWDB_UNIT}`, join(dir, HWDB_UNIT))
    })
    const r = await resultOf(fx, 'packed-hwdb-update-machinery-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('sysinit.target.wants')
    fx.dispose()
  })

  test('an After= naming it turns it red, though systemd would drop it in silence', async () => {
    const fx = await mutated('packed-hwdb-update-machinery-absent', root => {
      edit(root, '/usr/lib/systemd/system/systemd-udevd.service',
        b => b.replace('After=systemd-sysusers.service',
          `After=systemd-sysusers.service ${HWDB_UNIT}`))
    })
    const r = await resultOf(fx, 'packed-hwdb-update-machinery-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('systemd-udevd.service')
    fx.dispose()
  })

  test('a walk that never reaches systemd-udevd.service cannot conclude', async () => {
    const fx = await mutated('packed-hwdb-update-machinery-absent', root => {
      rmSync(join(root, '/usr/lib/systemd/system/systemd-udevd.service'), { force: true })
    })
    const r = await resultOf(fx, 'packed-hwdb-update-machinery-absent')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('cannot be concluded')
    fx.dispose()
  })
})

describe('the rules that used to read it', () => {
  test('an import clause put back turns it red, and names the file', async () => {
    const fx = await mutated('packed-udev-rules-query-no-hwdb', root => {
      edit(root, RULE('50-udev-default.rules'),
        b => `${b}ENV{MODALIAS}!="", IMPORT{builtin}="hwdb --subsystem=$env{SUBSYSTEM}"\n`)
    })
    const r = await resultOf(fx, 'packed-udev-rules-query-no-hwdb')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('50-udev-default.rules')
    fx.dispose()
  })

  test('the private flag alone turns it red', async () => {
    // The half an edit forgets. With the flag set and no import, 60-evdev's
    // gate on it stops being a gate and the keyboard builtin runs on every
    // input device.
    const fx = await mutated('packed-udev-rules-query-no-hwdb', root => {
      write(root, RULE('60-evdev.rules'),
        'KERNEL!="event*", GOTO="evdev_end"\n'
        + 'DRIVERS=="atkbd", ENV{.HAVE_HWDB_PROPERTIES}="1"\n'
        + 'ENV{.HAVE_HWDB_PROPERTIES}=="1", IMPORT{builtin}="keyboard"\n'
        + 'LABEL="evdev_end"\n')
    })
    const r = await resultOf(fx, 'packed-udev-rules-query-no-hwdb')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('HAVE_HWDB_PROPERTIES')
    fx.dispose()
  })

  test('the surviving `=="1"` consumer on its own is NOT a failure', async () => {
    // What the shipped 60-evdev.rules actually looks like after the removal:
    // the gate is still there and nothing sets the property, so it never fires.
    // A check that matched the consumer would demand deleting a line the plan
    // does not ask anyone to delete.
    const fx = packedRootFixture(cx3576)
    write(fx.root, RULE('60-evdev.rules'),
      'KERNEL!="event*", GOTO="evdev_end"\n'
      + 'ENV{.HAVE_HWDB_PROPERTIES}=="1", IMPORT{builtin}="keyboard"\n'
      + 'LABEL="evdev_end"\n')
    expect(await verdictOf(fx, 'packed-udev-rules-query-no-hwdb')).toBe('pass')
    fx.dispose()
  })

  test('rules with no builtin imports at all cannot conclude', async () => {
    // The scanner-broke case. Emptying the clauses rather than the directory:
    // a full rules directory with nothing the scanner recognises is exactly
    // what a parser regression looks like, and it reads as green.
    const fx = await mutated('packed-udev-rules-query-no-hwdb', root => {
      for (const name of ['50-udev-default.rules', '60-input-id.rules', '60-serial.rules',
        '75-net-description.rules', '78-sound-card.rules']) {
        edit(root, RULE(name), b => b.replaceAll('IMPORT{builtin}="', 'NOTANIMPORT="'))
      }
    })
    const r = await resultOf(fx, 'packed-udev-rules-query-no-hwdb')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('cannot be concluded')
    fx.dispose()
  })
})

describe('the actions that shared a line with a removed clause', () => {
  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    ['permissions', '50-udev-default.rules', 'GROUP="tty", MODE="0666"', 'permissions'],
    ['device identification', '50-udev-default.rules', 'IMPORT{builtin}="usb_id"', 'device identification'],
    ['symlinks', '60-serial.rules', 'SYMLINK+="serial/by-id/', 'symlinks'],
    ['module loading', '80-drivers.rules', 'RUN{builtin}+="kmod load"', 'module loading'],
    ['service activation', '99-systemd.rules', 'TAG+="systemd"', 'service activation'],
  ]

  for (const [what, file, token, category] of cases) {
    test(`${what}: losing ${token} in ${file} turns it red`, async () => {
      const fx = await mutated('packed-udev-actions-survived-hwdb-removal', root => {
        edit(root, RULE(file), b => b.replace(token, 'REMOVED_BY_THE_MUTATION'))
      })
      const r = await resultOf(fx, 'packed-udev-actions-survived-hwdb-removal')
      expect(r.verdict).toBe('fail')
      expect(r.message).toContain(file)
      expect(r.message).toContain(category)
      fx.dispose()
    })
  }

  test('a rule file deleted whole is named as a deleted file, not as a lost token', async () => {
    // The two failures deserve two sentences: an edit that took the file is a
    // different defect from one that took a line out of it, and the removal
    // never deletes a rule file at all.
    const fx = await mutated('packed-udev-actions-survived-hwdb-removal', root => {
      rmSync(join(root, RULE('60-serial.rules')), { force: true })
    })
    const r = await resultOf(fx, 'packed-udev-actions-survived-hwdb-removal')
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('is not in the root at all')
    fx.dispose()
  })

  test('the healthy fixture names how many actions it checked', async () => {
    const fx = packedRootFixture(cx3576)
    const r = await resultOf(fx, 'packed-udev-actions-survived-hwdb-removal')
    expect(r.verdict).toBe('pass')
    expect(r.message).toContain(`${SURVIVORS.length} action(s)`)
    fx.dispose()
  })
})

describe('the fixture itself is hwdb-free, which is what makes the family testable', () => {
  test('the seeded root carries no database and no update unit', () => {
    const fx = packedRootFixture(cx3576)
    for (const p of [...HWDB_BINARIES, ...HWDB_SOURCE_DIRS, HWDB_TOOL,
      `/usr/lib/systemd/system/${HWDB_UNIT}`]) {
      expect(existsSync(join(fx.root, p))).toBe(false)
    }
    fx.dispose()
  })
})
