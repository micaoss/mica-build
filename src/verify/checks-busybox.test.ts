// The BusyBox family, driven from the failing side.
//
// Every check in checks-busybox.ts is a NEGATIVE -- no applet link, no PATH
// entry, no initramfs role, no shadowed GNU command -- and a negative passes by
// finding nothing. That is the same green a check that cannot fail reports, and
// only a mutation separates them, so every case below takes a fixture that is
// asserted green FIRST and then makes one edit to it.
//
// The mutations are the real shapes, not invented wrecks: `busybox --install`
// makes symlinks in /usr/bin; Debian's own initramfs hook makes HARD links; the
// conf fragment that turns that hook on is one `BUSYBOXDIR=` line; the way a
// command gets shadowed in practice is a link earlier in PATH rather than a
// replaced file. Each of those is one test here.
//
// Two cases carry no mutation and are still tests. The initramfs POSITIVE
// CONTROL asserts that the words `BUSYBOX=auto` and `${BUSYBOXDIR}`, which the
// shipped root really does carry, do NOT fail the check -- a check written as a
// content grep would be red on a correct image, and nothing else in this file
// would say so. The VACUITY cases empty a search space and require the check to
// go red rather than report that it found nothing wrong.

import { describe, expect, test } from 'bun:test'
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { BUSYBOX_CHECKS, BUSYBOX_PATH } from './checks-busybox.ts'
import { assertRegisterWellFormed, CHECKS, type CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))

function checkNamed(id: string): CheckCase {
  const found = BUSYBOX_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no busybox check is registered as '${id}'. Registered: `
      + BUSYBOX_CHECKS.map(c => c.id).join(', '))
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

/**
 * Seed a fixture, assert the check is GREEN on it, run `mutate`, hand it back.
 *
 * The green assertion is the half that makes the red one mean something: a
 * fixture that was already failing would report the same red after any edit at
 * all, including one that changed nothing.
 */
async function mutated(id: string, mutate: (root: string) => void): Promise<RootFixture> {
  const fx = packedRootFixture(cx3576)
  expect(await verdictOf(fx, id)).toBe('pass')
  mutate(fx.root)
  return fx
}

describe('the busybox family is in the register and can be diffed', () => {
  test('every check is registered in CHECKS, and the register is well formed', () => {
    const registered = new Set(CHECKS.map(c => c.id))
    for (const c of BUSYBOX_CHECKS) expect(registered.has(c.id)).toBe(true)
    // Not a tautology over an empty list: the family has to have members.
    expect(BUSYBOX_CHECKS.length).toBeGreaterThan(0)
    assertRegisterWellFormed()
  })

  test('no other check claims a busybox matcher', () => {
    // Every matcher in this family names BusyBox, and it is the only family in
    // the register that does. A matcher that also matched another batch's
    // conclusion would make one of the two `ambiguous`.
    const mine = new Set(BUSYBOX_CHECKS.map(c => c.id))
    const others = CHECKS.filter(c => !mine.has(c.id))
    const alternatives = (m: unknown): string[] =>
      typeof m === 'string' ? [m] : Array.isArray(m) ? m as string[] : []
    for (const c of others) {
      for (const m of [c.shell.pass, c.shell.fail, c.shell.skip].flatMap(alternatives))
        expect(m.toLowerCase()).not.toContain('busybox')
    }
  })

  test('the whole family is green on the healthy fixture', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      for (const c of BUSYBOX_CHECKS) {
        const got = await c.run(fx.ctx)
        expect(got.length).toBe(1)
        expect(`${c.id}:${(got[0] as CheckResult).verdict}`).toBe(`${c.id}:pass`)
      }
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the binary itself', () => {
  test('the fixture ships it, and the verdict says where and at what mode', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'packed-busybox-present')).toBe('pass')
      expect(await messageOf(fx, 'packed-busybox-present')).toContain('/usr/bin/busybox, mode 0755')
    }
    finally {
      fx.dispose()
    }
  })

  test('an image without it fails: there is no emergency tool to reach', async () => {
    const fx = await mutated('packed-busybox-present', root =>
      rmSync(join(root, 'usr/bin/busybox')))
    try {
      expect(await verdictOf(fx, 'packed-busybox-present')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-present')).toContain('is not at /usr/bin/busybox')
    }
    finally {
      fx.dispose()
    }
  })

  test('a binary that lost its execute bit fails, and says so separately', async () => {
    // Not the same failure as absence: the package shipped, and does nothing.
    const fx = await mutated('packed-busybox-present', root =>
      chmodSync(join(root, 'usr/bin/busybox'), 0o644))
    try {
      expect(await verdictOf(fx, 'packed-busybox-present')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-present')).toContain('mode 0644')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('no applet link, which is the assertion RFCT-281 asks to be falsifiable', () => {
  test('the fixture has none, and the verdict says how much tree it walked', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'packed-busybox-unexpanded')).toBe('pass')
      expect(await messageOf(fx, 'packed-busybox-unexpanded')).toContain('paths walked')
    }
    finally {
      fx.dispose()
    }
  })

  test('ONE applet symlink fails, named: this is the negative the clause requires', async () => {
    const fx = await mutated('packed-busybox-unexpanded', root =>
      symlinkSync(BUSYBOX_PATH, join(root, 'usr/bin/ash')))
    try {
      expect(await verdictOf(fx, 'packed-busybox-unexpanded')).toBe('fail')
      const message = await messageOf(fx, 'packed-busybox-unexpanded')
      expect(message).toContain('1 BusyBox applet link(s)')
      expect(message).toContain('/usr/bin/ash -> /usr/bin/busybox')
    }
    finally {
      fx.dispose()
    }
  })

  test('a whole farm fails, counted, with the overflow summarised', async () => {
    // What `busybox --install` produces, in miniature: the shape the clause is
    // really about is not one link but a second userland.
    const applets = ['ls', 'cat', 'tar', 'sh', 'mount', 'grep', 'sed']
    const fx = await mutated('packed-busybox-unexpanded', (root) => {
      mkdirSync(join(root, 'usr/lib/busybox/bin'), { recursive: true })
      for (const a of applets) symlinkSync(BUSYBOX_PATH, join(root, 'usr/lib/busybox/bin', a))
    })
    try {
      expect(await verdictOf(fx, 'packed-busybox-unexpanded')).toBe('fail')
      const message = await messageOf(fx, 'packed-busybox-unexpanded')
      expect(message).toContain(`${applets.length} BusyBox applet link(s)`)
      expect(message).toContain('(+2 more)')
    }
    finally {
      fx.dispose()
    }
  })

  test('a RELATIVE applet symlink fails too: the target is resolved, not compared', async () => {
    const fx = await mutated('packed-busybox-unexpanded', root =>
      symlinkSync('busybox', join(root, 'usr/bin/vi')))
    try {
      expect(await verdictOf(fx, 'packed-busybox-unexpanded')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-unexpanded')).toContain('/usr/bin/vi -> ')
    }
    finally {
      fx.dispose()
    }
  })

  test('a HARD-linked applet fails: Debian\'s own initramfs hook expands that way', async () => {
    // The mutation a symlink-only test cannot see. It is found by inode
    // identity, so the name it was given does not matter.
    const fx = await mutated('packed-busybox-unexpanded', root =>
      linkSync(join(root, 'usr/bin/busybox'), join(root, 'usr/bin/nc')))
    try {
      expect(await verdictOf(fx, 'packed-busybox-unexpanded')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-unexpanded')).toContain('/usr/bin/nc (hard link)')
    }
    finally {
      fx.dispose()
    }
  })

  test('VACUITY: with no binary in the root the check FAILS rather than finding nothing', async () => {
    // Without this direction the check is green over an image that ships no
    // BusyBox, over a root that failed to unpack, and over any directory at all.
    const fx = await mutated('packed-busybox-unexpanded', root =>
      rmSync(join(root, 'usr/bin/busybox')))
    try {
      expect(await verdictOf(fx, 'packed-busybox-unexpanded')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-unexpanded')).toContain('a statement about nothing')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('no PATH change and no /build/bin', () => {
  test('a profile drop-in that puts an applet directory on PATH fails', async () => {
    const fx = await mutated('packed-busybox-no-path-change', root =>
      writeFileSync(join(root, 'etc/profile.d/99-busybox.sh'),
        'PATH="$PATH:/usr/lib/busybox/bin"\nexport PATH\n'))
    try {
      expect(await verdictOf(fx, 'packed-busybox-no-path-change')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-no-path-change'))
        .toContain('/etc/profile.d/99-busybox.sh')
    }
    finally {
      fx.dispose()
    }
  })

  test('a PATH set in login.defs fails as well, and it is the one a login shell reads', async () => {
    const fx = await mutated('packed-busybox-no-path-change', root =>
      writeFileSync(join(root, 'etc/login.defs'),
        'ENV_PATH\tPATH=/usr/local/bin:/usr/bin:/usr/lib/busybox/bin\n'))
    try {
      expect(await verdictOf(fx, 'packed-busybox-no-path-change')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-no-path-change')).toContain('/etc/login.defs')
    }
    finally {
      fx.dispose()
    }
  })

  test('a SYMLINKED PATH drop-in is followed, and inside the root', async () => {
    // Both shipped roots put /etc/profile.d/70-systemd-shell-extra.sh in as a
    // link to /usr/lib/systemd/profile.d/..., so a check reading only regular
    // files never read the one PATH drop-in this image has. The follow has to
    // resolve inside the root: the link target is image-absolute, and handing it
    // to readFileSync would read the verifier host's file of that name.
    const fx = await mutated('packed-busybox-no-path-change', root =>
      writeFileSync(join(root, 'usr/lib/systemd/profile.d/70-systemd-shell-extra.sh'),
        'PATH="/usr/lib/busybox/bin:$PATH"\n'))
    try {
      expect(await verdictOf(fx, 'packed-busybox-no-path-change')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-no-path-change'))
        .toContain('/etc/profile.d/70-systemd-shell-extra.sh')
    }
    finally {
      fx.dispose()
    }
  })

  test('PLAN-045\'s rejected alternative -- applets under /build/bin -- fails on the directory alone',
    async () => {
      const fx = await mutated('packed-busybox-no-path-change', (root) => {
        mkdirSync(join(root, 'build/bin'), { recursive: true })
        symlinkSync(BUSYBOX_PATH, join(root, 'build/bin/ls'))
      })
      try {
        expect(await verdictOf(fx, 'packed-busybox-no-path-change')).toBe('fail')
        expect(await messageOf(fx, 'packed-busybox-no-path-change')).toContain('it ships /build')
      }
      finally {
        fx.dispose()
      }
    })

  test('VACUITY: a root with no PATH source at all FAILS rather than reading nothing', async () => {
    const fx = await mutated('packed-busybox-no-path-change', (root) => {
      for (const p of ['etc/environment', 'etc/profile', 'etc/login.defs']) rmSync(join(root, p))
      rmSync(join(root, 'etc/profile.d'), { recursive: true })
      rmSync(join(root, 'usr/lib/environment.d'), { recursive: true })
    })
    try {
      expect(await verdictOf(fx, 'packed-busybox-no-path-change')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-no-path-change')).toContain('read nothing')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('no initramfs role and no init role', () => {
  test('POSITIVE CONTROL: the BUSYBOX=auto and ${BUSYBOXDIR} the image really ships do not fail it',
    async () => {
      // The check this guards against is the obvious one -- "no initramfs file
      // mentions busybox" -- which is RED on a correct image, because
      // initramfs.conf documents the BUSYBOX setting and initramfs-tools' own
      // klibc-utils hook reads BUSYBOXDIR. Both lines are in the fixture.
      const fx = packedRootFixture(cx3576)
      try {
        expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('pass')
        const message = await messageOf(fx, 'packed-busybox-not-early-boot')
        expect(message).toContain('initramfs-tools path(s)')
        expect(message).toContain('name it in no directive')
      }
      finally {
        fx.dispose()
      }
    })

  test('Debian\'s zz-busybox hook fails: it is what copies the binary into the initrd', async () => {
    const fx = await mutated('packed-busybox-not-early-boot', root =>
      writeFileSync(join(root, 'usr/share/initramfs-tools/hooks/zz-busybox'),
        '#!/bin/sh\ncopy_exec /usr/bin/busybox /bin/busybox\n'))
    try {
      expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-not-early-boot'))
        .toContain('hooks/zz-busybox (an initramfs file named for busybox)')
    }
    finally {
      fx.dispose()
    }
  })

  test('a BUSYBOXDIR assignment fails even under a name that does not say busybox', async () => {
    // The conf fragment is the switch: without it mkinitramfs leaves BUSYBOXDIR
    // empty and never looks. Named `emergency` on purpose, so this case tests
    // the assignment and not the filename the case above already covers.
    const fx = await mutated('packed-busybox-not-early-boot', (root) => {
      mkdirSync(join(root, 'etc/initramfs-tools/conf.d'), { recursive: true })
      writeFileSync(join(root, 'etc/initramfs-tools/conf.d/emergency'), 'BUSYBOXDIR=/usr/bin\n')
    })
    try {
      expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-not-early-boot'))
        .toContain('conf.d/emergency (sets BUSYBOXDIR or BUSYBOX=y)')
    }
    finally {
      fx.dispose()
    }
  })

  test('POSITIVE CONTROL: a drop-in whose COMMENT names busybox is not a role', async () => {
    // cx3576 ships two of these. `serial-getty@ttyFIQ0.service.d/local-line.conf`
    // explains, in a `#` line, which busybox invocation the BSP bring-up rootfs
    // proved on this tty -- history, not a dependency. A whole-body match reads
    // that as an init role and reports one on a correct image, which is how this
    // check first went red: green on uefi-x64, where those drop-ins do not exist, and
    // red on the board they ship for.
    const fx = await mutated('packed-busybox-not-early-boot', (root) => {
      mkdirSync(join(root, 'etc/systemd/system/serial-getty@ttyX.service.d'), { recursive: true })
      writeFileSync(join(root, 'etc/systemd/system/serial-getty@ttyX.service.d/local-line.conf'),
        '# The BSP bring-up rootfs proved the working form with busybox `getty -L`.\n'
        + '[Service]\nExecStart=\nExecStart=-/sbin/agetty --local-line 1500000 %I vt100\n')
    })
    try {
      expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('the same drop-in fails when the DIRECTIVE names it, not the comment', async () => {
    // The other direction of the case above, so the comment exemption cannot be
    // read as "unit files are exempt".
    const fx = await mutated('packed-busybox-not-early-boot', (root) => {
      mkdirSync(join(root, 'etc/systemd/system/serial-getty@ttyX.service.d'), { recursive: true })
      writeFileSync(join(root, 'etc/systemd/system/serial-getty@ttyX.service.d/local-line.conf'),
        '# nothing to see here\n[Service]\nExecStart=\nExecStart=-/usr/bin/busybox getty -L 1500000 %I\n')
    })
    try {
      expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-not-early-boot'))
        .toContain('local-line.conf (an init file naming busybox)')
    }
    finally {
      fx.dispose()
    }
  })

  test('a unit that execs it fails: an emergency tool init needs is part of the boot contract',
    async () => {
      const fx = await mutated('packed-busybox-not-early-boot', root =>
        writeFileSync(join(root, 'usr/lib/systemd/system/mica-rescue.service'),
          '[Service]\nType=oneshot\nExecStart=/usr/bin/busybox sh -c "true"\n'))
      try {
        expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('fail')
        expect(await messageOf(fx, 'packed-busybox-not-early-boot'))
          .toContain('mica-rescue.service (an init file naming busybox)')
      }
      finally {
        fx.dispose()
      }
    })

  test('VACUITY: a root with no unit at all FAILS rather than reporting no init role', async () => {
    const fx = await mutated('packed-busybox-not-early-boot', (root) => {
      // The whole of both systemd trees and Mica OS's own: INIT_TREES names six
      // directories inside them, and leaving one -- the generator directory the
      // engine seed fills -- would leave the search space populated.
      for (const d of ['usr/lib/systemd', 'etc/systemd', 'usr/lib/mica'])
        rmSync(join(root, d), { recursive: true, force: true })
    })
    try {
      expect(await verdictOf(fx, 'packed-busybox-not-early-boot')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-not-early-boot')).toContain('empty search')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the bill of materials the SBOM, licences and source offer are derived from', () => {
  test('the fixture row is there, and the verdict quotes it', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'packed-busybox-in-manifest')).toBe('pass')
      expect(await messageOf(fx, 'packed-busybox-in-manifest')).toContain('mica-busybox 1.0.0-1')
    }
    finally {
      fx.dispose()
    }
  })

  test('a binary in the root with NO row fails: the release would ship an unlisted GPL binary',
    async () => {
      // The failure this check exists for. A file copied in by a compose stage
      // or left in the overlay is in the image and in no row, so every record a
      // compliance request is answered from omits it -- with the binary, the
      // applet-link check and every other check green.
      const fx = await mutated('packed-busybox-in-manifest', (root) => {
        const path = join(root, 'usr/share/mica/manifest.tsv')
        const kept = readFileSync(path, 'utf8')
          .split('\n')
          .filter(l => !l.startsWith('mica-busybox\t'))
          .join('\n')
        writeFileSync(path, kept)
      })
      try {
        expect(await verdictOf(fx, 'packed-busybox-in-manifest')).toBe('fail')
        const message = await messageOf(fx, 'packed-busybox-in-manifest')
        expect(message).toContain('IN the root')
        expect(message).toContain('arrived outside the package system')
      }
      finally {
        fx.dispose()
      }
    })

  test('a row with no binary fails the other way: an inventory naming what is not there',
    async () => {
      const fx = await mutated('packed-busybox-in-manifest', root =>
        rmSync(join(root, 'usr/bin/busybox')))
      try {
        expect(await verdictOf(fx, 'packed-busybox-in-manifest')).toBe('fail')
        expect(await messageOf(fx, 'packed-busybox-in-manifest'))
          .toContain('is not in the root')
      }
      finally {
        fx.dispose()
      }
    })

  test('no manifest at all fails: there is nothing to derive a release record from', async () => {
    const fx = await mutated('packed-busybox-in-manifest', root =>
      rmSync(join(root, 'usr/share/mica/manifest.tsv')))
    try {
      expect(await verdictOf(fx, 'packed-busybox-in-manifest')).toBe('fail')
      expect(await messageOf(fx, 'packed-busybox-in-manifest')).toContain('no /usr/share/mica/manifest.tsv')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the GNU commands still resolve as before', () => {
  test('the fixture resolves every one of them, and the verdict lists where', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'packed-gnu-commands-unshadowed')).toBe('pass')
      const message = await messageOf(fx, 'packed-gnu-commands-unshadowed')
      // sh is the case that makes this a RESOLUTION test: it is a link to dash.
      expect(message).toContain('sh=/usr/bin/dash')
      expect(message).toContain('ls=/usr/bin/ls')
    }
    finally {
      fx.dispose()
    }
  })

  test('a command replaced by a link to busybox fails, named', async () => {
    const fx = await mutated('packed-gnu-commands-unshadowed', (root) => {
      unlinkSync(join(root, 'usr/bin/ls'))
      symlinkSync(BUSYBOX_PATH, join(root, 'usr/bin/ls'))
    })
    try {
      expect(await verdictOf(fx, 'packed-gnu-commands-unshadowed')).toBe('fail')
      expect(await messageOf(fx, 'packed-gnu-commands-unshadowed'))
        .toContain('ls resolves to /usr/bin/busybox')
    }
    finally {
      fx.dispose()
    }
  })

  test('a command SHADOWED from an earlier PATH directory fails, with the file left alone',
    async () => {
      // The realistic shape: /usr/bin/tar is untouched and correct, and an
      // applet farm earlier in PATH is what a shell would find first. A check
      // that asked "is /usr/bin/tar a regular file" would be green here.
      const fx = await mutated('packed-gnu-commands-unshadowed', (root) => {
        mkdirSync(join(root, 'usr/local/bin'), { recursive: true })
        symlinkSync(BUSYBOX_PATH, join(root, 'usr/local/bin/tar'))
      })
      try {
        expect(await verdictOf(fx, 'packed-gnu-commands-unshadowed')).toBe('fail')
        expect(await messageOf(fx, 'packed-gnu-commands-unshadowed'))
          .toContain('tar resolves to /usr/bin/busybox')
      }
      finally {
        fx.dispose()
      }
    })

  test('re-pointing the sh link at busybox fails: the chain is followed to its end', async () => {
    const fx = await mutated('packed-gnu-commands-unshadowed', (root) => {
      unlinkSync(join(root, 'usr/bin/sh'))
      symlinkSync(BUSYBOX_PATH, join(root, 'usr/bin/sh'))
    })
    try {
      expect(await verdictOf(fx, 'packed-gnu-commands-unshadowed')).toBe('fail')
      expect(await messageOf(fx, 'packed-gnu-commands-unshadowed'))
        .toContain('sh resolves to /usr/bin/busybox')
    }
    finally {
      fx.dispose()
    }
  })

  test('a command the image stopped shipping fails, and says that rather than "shadowed"',
    async () => {
      const fx = await mutated('packed-gnu-commands-unshadowed', root =>
        rmSync(join(root, 'usr/bin/dmesg')))
      try {
        expect(await verdictOf(fx, 'packed-gnu-commands-unshadowed')).toBe('fail')
        expect(await messageOf(fx, 'packed-gnu-commands-unshadowed'))
          .toContain('dmesg is not in PATH at all')
      }
      finally {
        fx.dispose()
      }
    })
})
