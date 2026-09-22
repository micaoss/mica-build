// The console family driven from the failing side.
//
// Each case breaks exactly one link in the path a person walks -- tty1 idle,
// Alt+F2 reaching a login prompt -- against a fixture asserted green first.
//
// THE MUTATIONS ARE THE SHAPES THE FAILURE ACTUALLY TAKES, not invented ones.
// `dropTty1Decision` is the state three of four boards were in until
// rootfs/build.sh carried the rule: no enablement link and no preset rule,
// which reads as correct and is an absence. `dropAutovt` is what a composer
// that stopped carrying an unowned alias symlink would produce, and it is the
// silent one -- an image in that state passes every other check in this tree
// and opens a blank terminal on Alt+F2.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard, type Board } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { CONSOLE_CHECKS } from './checks-console.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))
const uefiX64 = loadBoard(boardEnvPath('uefi-x64'))

const PRESET = '/usr/lib/systemd/system-preset/40-mica-build.preset'
const AUTOVT = '/usr/lib/systemd/system/autovt@.service'
const TTY1_WANTS = '/etc/systemd/system/getty.target.wants/getty@tty1.service'

function checkNamed(id: string): CheckCase {
  const found = CONSOLE_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no console check is registered as '${id}'. Registered: `
      + CONSOLE_CHECKS.map(c => c.id).join(', '))
  }
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

describe('the healthy image', () => {
  test('every console check PASSES on both boards -- this family is board-unconditional', async () => {
    for (const board of [cx3576, uefiX64]) {
      const fx = packedRootFixture(board)
      try {
        for (const c of CONSOLE_CHECKS) {
          const got = await c.run(fx.ctx)
          expect(`${board.name}/${c.id}: ${[...new Set(got.map(r => r.verdict))].join(',')}`)
            .toBe(`${board.name}/${c.id}: pass`)
        }
      }
      finally {
        fx.dispose()
      }
    }
    for (const c of CONSOLE_CHECKS) expect(`${c.id}: ${c.boards}`).toBe(`${c.id}: undefined`)
  })
})

describe('tty1 idle by decision, not by accident', () => {
  test('an enablement link for getty@tty1 fails, even with the preset in place', async () => {
    // A login prompt on tty1 draws over the boot logo every board now shows.
    const fx = await mutated('packed-getty-tty1-disabled', (root) => {
      writeFileSync(join(root, '/usr/lib/systemd/system/getty@tty1.service'), '')
      // the .wants link the composer drops, put back
      const dir = join(root, '/etc/systemd/system/getty.target.wants')
      writeFileSync(join(root, PRESET), 'disable getty@.service\n')
      mkdirSync(dir, { recursive: true })
      symlinkSync('/usr/lib/systemd/system/getty@.service', join(root, TTY1_WANTS))
    })
    try {
      expect(await verdictOf(fx, 'packed-getty-tty1-disabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-getty-tty1-disabled')).toContain('enable(s) getty@tty1.service')
    }
    finally {
      fx.dispose()
    }
  })

  test('NO LINK AND NO RULE FAILS -- the absence that reads as a decision', async () => {
    // This is the whole reason the check asserts both halves. Removing the
    // preset leaves an image that is tty1-idle today and says nothing about
    // why, and one `systemctl preset-all` turns it into a login prompt.
    const fx = await mutated('packed-getty-tty1-disabled', root => rmSync(join(root, PRESET)))
    try {
      expect(await verdictOf(fx, 'packed-getty-tty1-disabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-getty-tty1-disabled')).toContain('ABSENCE AND NOT A DECISION')
    }
    finally {
      fx.dispose()
    }
  })

  test('a rule that ENABLES the template fails, and names the file it came from', async () => {
    const fx = await mutated('packed-getty-tty1-disabled', root =>
      writeFileSync(join(root, PRESET), 'enable getty@.service\n'))
    try {
      expect(await verdictOf(fx, 'packed-getty-tty1-disabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-getty-tty1-disabled')).toContain('\'enable getty@.service\'')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the alias that makes Alt+F2 reach anything', () => {
  test('a dropped autovt@.service fails -- the silent one', async () => {
    const fx = await mutated('packed-autovt-alias', root => rmSync(join(root, AUTOVT)))
    try {
      expect(await verdictOf(fx, 'packed-autovt-alias')).toBe('fail')
      expect(await messageOf(fx, 'packed-autovt-alias')).toContain('BLANK terminals')
    }
    finally {
      fx.dispose()
    }
  })

  test('a REGULAR FILE at autovt@.service fails: systemd ships an alias link', async () => {
    const fx = await mutated('packed-autovt-alias', (root) => {
      rmSync(join(root, AUTOVT))
      writeFileSync(join(root, AUTOVT), '[Unit]\n')
    })
    try {
      expect(await verdictOf(fx, 'packed-autovt-alias')).toBe('fail')
      expect(await messageOf(fx, 'packed-autovt-alias')).toContain('is not a symlink')
    }
    finally {
      fx.dispose()
    }
  })

  test('an alias pointing somewhere else fails and prints where', async () => {
    const fx = await mutated('packed-autovt-alias', (root) => {
      rmSync(join(root, AUTOVT))
      symlinkSync('serial-getty@.service', join(root, AUTOVT))
    })
    try {
      expect(await messageOf(fx, 'packed-autovt-alias')).toContain('\'serial-getty@.service\'')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the rest of the login path', () => {
  for (const missing of ['/usr/sbin/agetty', '/usr/bin/login', '/etc/pam.d/login']) {
    test(`a root without ${missing} fails`, async () => {
      const fx = await mutated('packed-console-login-path', root => rmSync(join(root, missing)))
      try {
        expect(await verdictOf(fx, 'packed-console-login-path')).toBe('fail')
        expect(await messageOf(fx, 'packed-console-login-path')).toContain(missing)
      }
      finally {
        fx.dispose()
      }
    })
  }

  test('logind present but not enabled fails: no VT is ever autospawned', async () => {
    const fx = await mutated('packed-console-login-path', root =>
      rmSync(join(root, '/usr/lib/systemd/system/multi-user.target.wants/systemd-logind.service')))
    try {
      expect(await verdictOf(fx, 'packed-console-login-path')).toBe('fail')
      expect(await messageOf(fx, 'packed-console-login-path')).toContain('no .wants or .requires link names it')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the unit that is correct and looks wrong', () => {
  test('removing dbus-daemon makes getty-static live, and THAT is the failure', async () => {
    // An unrelated-looking change -- dropping a binary -- would put login
    // prompts on tty2..tty6 without anybody pressing a key.
    const fx = await mutated('packed-getty-static-inert', root =>
      rmSync(join(root, '/usr/bin/dbus-daemon')))
    try {
      expect(await verdictOf(fx, 'packed-getty-static-inert')).toBe('fail')
      expect(await messageOf(fx, 'packed-getty-static-inert')).toContain('its conditions are satisfied')
    }
    finally {
      fx.dispose()
    }
  })

  test('a getty-static with no negated condition fails', async () => {
    const fx = await mutated('packed-getty-static-inert', root =>
      writeFileSync(join(root, '/usr/lib/systemd/system/getty-static.service'),
        '[Unit]\nConditionPathExists=/dev/tty0\n[Service]\nType=oneshot\n'))
    try {
      expect(await verdictOf(fx, 'packed-getty-static-inert')).toBe('fail')
      expect(await messageOf(fx, 'packed-getty-static-inert')).toContain('no negated ConditionPathExists')
    }
    finally {
      fx.dispose()
    }
  })
})
