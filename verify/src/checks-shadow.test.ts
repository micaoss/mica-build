// The shadow contract driven from the failing side.
//
// The property is end-to-end -- the file PAM
// opens is built in RAM on every boot from a template carrying no usable
// credential -- and every case below breaks exactly one link in it, against a
// fixture asserted green first.
//
// The mutations are chosen to be the shapes the failure actually takes: a
// symlink retargeted at persistent storage (which passes "is a symlink" and "is
// not a regular file in the image"), a build loop reading its own destination,
// an ordering naming a unit the image does not ship, and a template shipped
// with an EMPTY password field -- which is passwordless login and not a lock.

import { describe, expect, test } from 'bun:test'
import { chmodSync, chownSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard, type Board } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { SHADOW_CHECKS } from './checks-shadow.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))
const uefi-x64 = loadBoard(boardEnvPath('uefi-x64'))

const SHADOW = '/etc/shadow'
const FACTORY = '/usr/share/factory/etc/shadow'
const REC_UNIT = '/etc/systemd/system/mica-shadow-reconcile.service'
const REC_SCRIPT = '/usr/lib/mica/mica-shadow-reconcile'

function checkNamed(id: string): CheckCase {
  const found = SHADOW_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no shadow check is registered as '${id}'. Registered: `
      + SHADOW_CHECKS.map(c => c.id).join(', '))
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

function rewrite(root: string, path: string, edit: (text: string) => string): void {
  writeFileSync(join(root, path), edit(readFileSync(join(root, path), 'utf8')))
}

/** Repoint /etc/shadow, keeping the mode and ownership of everything else. */
function retarget(root: string, dest: string): void {
  rmSync(join(root, SHADOW))
  symlinkSync(dest, join(root, SHADOW))
}

describe('the healthy image', () => {
  test('every shadow check PASSES on both boards -- this family is board-unconditional', async () => {
    for (const board of [cx3576, uefi-x64]) {
      const fx = packedRootFixture(board)
      try {
        for (const c of SHADOW_CHECKS) {
          const got = await c.run(fx.ctx)
          expect(`${board.name}/${c.id}: ${[...new Set(got.map(r => r.verdict))].join(',')}`)
            .toBe(`${board.name}/${c.id}: pass`)
        }
      }
      finally {
        fx.dispose()
      }
    }
    for (const c of SHADOW_CHECKS) expect(`${c.id}: ${c.boards}`).toBe(`${c.id}: undefined`)
  })
})

describe('the path PAM opens', () => {
  test('a REGULAR /etc/shadow in the image fails three checks at once', async () => {
    // It shadows the copy built in RAM, and a signed rootfs is byte-identical
    // across the fleet -- so it is one password on every device, unchangeable
    // because the root is read-only.
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'shadow-is-symlink-to-run')).toBe('pass')
      rmSync(join(fx.root, SHADOW))
      writeFileSync(join(fx.root, SHADOW), 'root:$2b$hash:20000:0:99999:7:::\n')
      expect(await verdictOf(fx, 'shadow-is-symlink-to-run')).toBe('fail')
      expect(await verdictOf(fx, 'shadow-no-regular-in-image')).toBe('fail')
      expect(await verdictOf(fx, 'shadow-link-lands-on-tmpfs')).toBe('fail')
      expect(await messageOf(fx, 'shadow-no-regular-in-image')).toContain('identical on every device')
    }
    finally {
      fx.dispose()
    }
  })

  test('a symlink to somewhere ELSE fails, and the message prints where', async () => {
    const fx = await mutated('shadow-is-symlink-to-run', root => retarget(root, '/run/shadow'))
    try {
      expect(await verdictOf(fx, 'shadow-is-symlink-to-run')).toBe('fail')
      expect(await messageOf(fx, 'shadow-is-symlink-to-run')).toContain("-> /run/shadow")
      // ...and it still lands on a tmpfs, so THAT check stays green. One
      // mutation, one named failure.
      expect(await verdictOf(fx, 'shadow-link-lands-on-tmpfs')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a /run/mica/shadow INSIDE the squashfs makes the link resolve to an image file', async () => {
    const fx = await mutated('shadow-target-absent-in-image', (root) => {
      mkdirSync(join(root, '/run/mica'), { recursive: true })
      writeFileSync(join(root, '/run/mica/shadow'), 'root:!:20000:0:99999:7:::\n')
    })
    try {
      expect(await verdictOf(fx, 'shadow-target-absent-in-image')).toBe('fail')
      expect(await messageOf(fx, 'shadow-target-absent-in-image'))
        .toContain('byte-identical on every device in the fleet')
    }
    finally {
      fx.dispose()
    }
  })

  test('a DANGLING /run/mica/shadow counts too: `-e` OR `-L`', async () => {
    const fx = await mutated('shadow-target-absent-in-image', (root) => {
      mkdirSync(join(root, '/run/mica'), { recursive: true })
      symlinkSync('/nowhere', join(root, '/run/mica/shadow'))
    })
    try {
      expect(await verdictOf(fx, 'shadow-target-absent-in-image')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('a link retargeted at STATE fails the persistence check specifically', async () => {
    // This is the mutation the other checks cannot see: it IS a symlink, there
    // IS no regular file in the image, and the destination is NOT in the
    // squashfs. Only "not under /mnt/data/state or /var" catches it, and what it
    // catches is a password that survives the reboot meant to end it.
    const fx = await mutated('shadow-link-not-persistent', root =>
      retarget(root, '/mnt/data/state/mica/shadow'))
    try {
      expect(await verdictOf(fx, 'shadow-link-not-persistent')).toBe('fail')
      expect(await verdictOf(fx, 'shadow-no-regular-in-image')).toBe('pass')
      expect(await verdictOf(fx, 'shadow-target-absent-in-image')).toBe('pass')
      expect(await messageOf(fx, 'shadow-link-not-persistent')).toContain('persistent storage')
    }
    finally {
      fx.dispose()
    }
  })

  test('/var is persistent for this purpose too, and is caught the same way', async () => {
    const fx = await mutated('shadow-link-not-persistent', root =>
      retarget(root, '/var/lib/mica/shadow'))
    try {
      expect(await verdictOf(fx, 'shadow-link-not-persistent')).toBe('fail')
      expect(await verdictOf(fx, 'shadow-link-lands-on-tmpfs')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the factory template', () => {
  test('an account in /etc/passwd with no template entry is named', async () => {
    // An account added by a later update would get a bare placeholder instead
    // of its proper aging fields.
    const fx = await mutated('factory-shadow-covers-passwd', root =>
      rewrite(root, FACTORY, t => t.split('\n').filter(l => !l.startsWith('mica:')).join('\n')))
    try {
      expect(await verdictOf(fx, 'factory-shadow-covers-passwd')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-covers-passwd')).toContain('is missing: mica')
    }
    finally {
      fx.dispose()
    }
  })

  test('an EMPTY template fails, listing every account it should have carried', async () => {
    const fx = await mutated('factory-shadow-covers-passwd', root =>
      writeFileSync(join(root, FACTORY), ''))
    try {
      expect(await verdictOf(fx, 'factory-shadow-covers-passwd')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-covers-passwd'))
        .toContain('has 0 entries and is missing: root mica')
    }
    finally {
      fx.dispose()
    }
  })

  test('TWO empty files fail rather than agreeing with each other', async () => {
    // The vacuous pass this check exists to refuse, and the only shape that
    // reaches it: with /etc/passwd empty too, NOTHING is missing by set
    // arithmetic and only the COUNT turns it red. The oracle's own
    // `${fac_missing:- (nothing, but it is empty)}` is the sentence for exactly
    // this case and has no other way of being produced.
    const fx = await mutated('factory-shadow-covers-passwd', (root) => {
      writeFileSync(join(root, FACTORY), '')
      writeFileSync(join(root, '/etc/passwd'), '')
    })
    try {
      expect(await verdictOf(fx, 'factory-shadow-covers-passwd')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-covers-passwd')).toContain('(nothing, but it is empty)')
    }
    finally {
      fx.dispose()
    }
  })

  test('a template packed 0644 fails: unix_chkpwd runs setgid shadow to read it', async () => {
    const fx = await mutated('factory-shadow-mode', root => chmodSync(join(root, FACTORY), 0o644))
    try {
      expect(await verdictOf(fx, 'factory-shadow-mode')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-mode')).toContain('is mode 644 owner 0:42')
    }
    finally {
      fx.dispose()
    }
  })

  test('a template owned by the wrong GROUP fails, even at the right mode', async () => {
    // The half a mode check alone cannot see: 0640 root:root is unreadable by
    // the setgid-shadow helper, so password verification stops working for
    // every non-root caller and nothing logs why.
    const fx = await mutated('factory-shadow-mode', root => chownSync(join(root, FACTORY), 0, 0))
    try {
      expect(await verdictOf(fx, 'factory-shadow-mode')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-mode')).toContain('owner 0:0')
    }
    finally {
      fx.dispose()
    }
  })

  test('an image with no `shadow` group fails, and the mode check goes with it', async () => {
    const fx = await mutated('shadow-group-defined', root =>
      rewrite(root, '/etc/group', t => t.split('\n').filter(l => !l.startsWith('shadow:')).join('\n')))
    try {
      expect(await verdictOf(fx, 'shadow-group-defined')).toBe('fail')
      expect(await verdictOf(fx, 'factory-shadow-mode')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('no baked credential', () => {
  test('a usable root hash fails: a signed rootfs makes it a fleet-wide secret', async () => {
    const fx = await mutated('factory-shadow-root-locked', root =>
      rewrite(root, FACTORY, t => t.replace('root:!:', 'root:$2b$10$abcdefghijklmnopqrstuv:')))
    try {
      expect(await verdictOf(fx, 'factory-shadow-root-locked')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-root-locked')).toContain('fleet-wide shared secret')
    }
    finally {
      fx.dispose()
    }
  })

  test('an EMPTY root field is PASSWORDLESS login and gets its own sentence', async () => {
    // Empty is not a locked marker. Only '!' (including '!!'
    // and '!'-prefixed forms that retain a hash) and '*' lock an account, and
    // pam_unix accepts any password -- including none -- for an empty field.
    const fx = await mutated('factory-shadow-root-locked', root =>
      rewrite(root, FACTORY, t => t.replace('root:!:', 'root::')))
    try {
      expect(await verdictOf(fx, 'factory-shadow-root-locked')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-root-locked')).toContain('PASSWORDLESS root login')
    }
    finally {
      fx.dispose()
    }
  })

  test('a `*` marker passes, because it locks just as `!` does', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      rewrite(fx.root, FACTORY, t => t.replace('root:!:', 'root:*:'))
      expect(await verdictOf(fx, 'factory-shadow-root-locked')).toBe('pass')
      expect(await messageOf(fx, 'factory-shadow-root-locked')).toContain("hash field is '*'")
    }
    finally {
      fx.dispose()
    }
  })

  test('a NON-root account with a usable hash is caught by the widened check', async () => {
    // The rule covers every account, not just root: a root-shaped check would
    // pass with a shipped credential for the account an operator logs in as.
    const fx = await mutated('factory-shadow-accounts-locked', root =>
      rewrite(root, FACTORY, t => t.replace('mica:!:', 'mica:$2b$10$abcdefghijklmnopqrstuv:')))
    try {
      expect(await verdictOf(fx, 'factory-shadow-accounts-locked')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-accounts-locked')).toContain('usable password hash: mica')
      // ...and the ROOT-scoped check stays green, which is precisely why the
      // widened one had to exist.
      expect(await verdictOf(fx, 'factory-shadow-root-locked')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('THE TWO LOCKED CHECKS DISAGREE ABOUT AN EMPTY FIELD, and both are the oracle', async () => {
    // the verification contract treats an empty password field as locked (its
    // awk is `$2 !~ /^[!*]/ && $2 != ""`);  treats it as passwordless
    // login and fails. The second is right. Both are ported AS THEY ARE: a port
    // that hardened the first would agree with the oracle on both shipped
    // images and diverge on the one image where the difference is the point --
    // and the divergence would be the port's own, found by nobody.
    //
    // Asserted here so the disagreement is a recorded finding about the ORACLE
    // rather than a surprise for whoever next reads either check.
    const fx = packedRootFixture(cx3576)
    try {
      rewrite(fx.root, FACTORY, t => t.replace('mica:!:', 'mica::'))
      expect(await verdictOf(fx, 'factory-shadow-locked')).toBe('pass')
      expect(await verdictOf(fx, 'factory-shadow-accounts-locked')).toBe('fail')
      expect(await messageOf(fx, 'factory-shadow-accounts-locked')).toContain('EMPTY password field: mica')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('the reconcile unit and script', () => {
  test('each of the four orderings is its own firing, named by the unit it protects', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      const got = await checkNamed('shadow-reconcile-ordered-before').run(fx.ctx)
      expect(got.map(r => r.instance)).toEqual([
        'micad.service', 'dropbear.service', 'systemd-logind.service', 'systemd-user-sessions.service',
      ])
      expect([...new Set(got.map(r => r.verdict))]).toEqual(['pass'])
    }
    finally {
      fx.dispose()
    }
  })

  test('a dropped Before= fails ONE firing and names the reader that would race', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      rewrite(fx.root, REC_UNIT, t => t.replace('Before=micad.service dropbear.service\n', 'Before=dropbear.service\n'))
      const got = await checkNamed('shadow-reconcile-ordered-before').run(fx.ctx)
      expect(got.map(r => `${r.instance}=${r.verdict}`)).toEqual([
        'micad.service=fail', 'dropbear.service=pass',
        'systemd-logind.service=pass', 'systemd-user-sessions.service=pass',
      ])
      expect(got[0]?.message).toContain('would look for /etc/shadow before this unit builds it')
    }
    finally {
      fx.dispose()
    }
  })

  test('an ordering against a unit NOT in the image fails: systemd drops it silently', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      rmSync(join(fx.root, '/etc/systemd/system/dropbear.service'))
      const got = await checkNamed('shadow-reconcile-ordered-before').run(fx.ctx)
      expect(got.map(r => `${r.instance}=${r.verdict}`)).toEqual([
        'micad.service=pass', 'dropbear.service=fail',
        'systemd-logind.service=pass', 'systemd-user-sessions.service=pass',
      ])
      expect(got[1]?.message).toContain('SILENTLY')
    }
    finally {
      fx.dispose()
    }
  })

  test('the match is a whole TOKEN: Before=xmicad.serviceX does not count', async () => {
    // A substring match would accept it, and a bare search for the name would
    // accept it appearing in a comment.
    const fx = packedRootFixture(cx3576)
    try {
      rewrite(fx.root, REC_UNIT, t => t.replace('Before=micad.service dropbear.service',
        'Before=xmicad.serviceX dropbear.service'))
      const got = await checkNamed('shadow-reconcile-ordered-before').run(fx.ctx)
      expect(got[0]?.verdict).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test("every firing's message matches the registered instance pattern", () => {
    // A firing whose pattern finds nothing in the shell's line is `ambiguous`.
    // The pattern has to survive all four message shapes, and " naming " is
    // optional precisely because one of them puts the unit after the `=`.
    const pattern = checkNamed('shadow-reconcile-ordered-before').instance as RegExp
    for (const line of [
      'mica-shadow-reconcile.service orders Before=micad.service, and /usr/lib/systemd/system/micad.service is present in the image',
      'mica-shadow-reconcile.service is missing, so its Before=dropbear.service ordering cannot be checked',
      'mica-shadow-reconcile.service has no Before= naming systemd-logind.service; systemd-logind.service would look for /etc/shadow',
      'mica-shadow-reconcile.service orders Before=systemd-user-sessions.service but /usr/lib/systemd/system/systemd-user-sessions.service is not in the image; systemd drops an ordering against a non-existent unit SILENTLY',
    ]) {
      const got = pattern.exec(line)?.[1]
      expect(`${line.slice(40, 70)} -> ${got}`).toBe(`${line.slice(40, 70)} -> ${expectedDep(line)}`)
    }
  })

  test('an After= against var-lib-mica.mount fails, with the offending line quoted', async () => {
    // It builds the file on a tmpfs systemd has already mounted; an ordering
    // against a storage mount that can fail can only delay or block the file
    // PAM opens -- and it tells the next reader the file still lives on STATE.
    const fx = await mutated('shadow-reconcile-no-state-dep', root =>
      rewrite(root, REC_UNIT, t => t.replace('[Unit]\n', '[Unit]\nAfter=var-lib-mica.mount\n')))
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-no-state-dep')).toBe('fail')
      expect(await messageOf(fx, 'shadow-reconcile-no-state-dep')).toContain('After=var-lib-mica.mount')
    }
    finally {
      fx.dispose()
    }
  })

  test('RequiresMountsFor=/mnt/data/state is caught too, not just After=', async () => {
    const fx = await mutated('shadow-reconcile-no-state-dep', root =>
      rewrite(root, REC_UNIT, t => t.replace('[Unit]\n', '[Unit]\nRequiresMountsFor=/mnt/data/state/mica\n')))
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-no-state-dep')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })

  test('a build loop reading its DESTINATION is the mutation that makes a password persist', async () => {
    // The load-bearing line. A script that preserved existing entries would
    // make a password persist across reboots on a tmpfs too, the moment
    // anything restored the file.
    const fx = await mutated('shadow-reconcile-builds-in-ram', root =>
      rewrite(root, REC_SCRIPT, t => t.replace('done <"$FACTORY"', 'done <"$SHADOW"')))
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-builds-in-ram')).toBe('fail')
      const message = await messageOf(fx, 'shadow-reconcile-builds-in-ram')
      expect(message).toContain('its build loop reads $SHADOW')
      // BOTH defects are reported, not the first: the loop no longer reads
      // $FACTORY either, and a message naming one would send the repair half way.
      expect(message).toContain('does not read $FACTORY')
    }
    finally {
      fx.dispose()
    }
  })

  test('a destination outside /run is caught even though the link still points at /run', async () => {
    const fx = await mutated('shadow-reconcile-builds-in-ram', root =>
      rewrite(root, REC_SCRIPT, t => t.replace('SHADOW="${MICA_SHADOW_PASSWD:-/run/mica/shadow}"',
        'SHADOW="${MICA_SHADOW_PASSWD:-/mnt/data/state/mica/shadow}"')))
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-builds-in-ram')).toBe('fail')
      expect(await messageOf(fx, 'shadow-reconcile-builds-in-ram')).toContain('would not be on a tmpfs')
      // The LINK is untouched and still lands on the tmpfs -- which is exactly
      // why the script has to be read as well as the link.
      expect(await verdictOf(fx, 'shadow-link-lands-on-tmpfs')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('a script that does not force a locked field is caught', async () => {
    const fx = await mutated('shadow-reconcile-builds-in-ram', root =>
      rewrite(root, REC_SCRIPT, t => t.replace('$2 = "!"', '$2 = $2')))
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-builds-in-ram')).toBe('fail')
      expect(await messageOf(fx, 'shadow-reconcile-builds-in-ram')).toContain('locked password field')
    }
    finally {
      fx.dispose()
    }
  })

  test('mica-seed-state putting a shadow file on STATE is caught, comments excepted', async () => {
    const fx = await mutated('seed-state-no-shadow-on-state', root =>
      rewrite(root, '/usr/lib/mica/mica-seed-state', t => `${t}install -m 0600 /dev/null /mnt/data/state/mica/shadow\n`))
    try {
      expect(await verdictOf(fx, 'seed-state-no-shadow-on-state')).toBe('fail')
      expect(await messageOf(fx, 'seed-state-no-shadow-on-state')).toContain('/mnt/data/state/mica/shadow')
    }
    finally {
      fx.dispose()
    }
    // A COMMENT saying it no longer does this is not a seeding.
    const documented = packedRootFixture(cx3576)
    try {
      rewrite(documented.root, '/usr/lib/mica/mica-seed-state',
        t => `${t}# no /mnt/data/state/mica/shadow here: the file is built in RAM\n`)
      expect(await verdictOf(documented, 'seed-state-no-shadow-on-state')).toBe('pass')
    }
    finally {
      documented.dispose()
    }
  })

  test('a DROP-IN setting MICA_SHADOW_FACTORY is caught, not just the unit', async () => {
    // A drop-in overrides the unit invisibly. Those two variables exist so the
    // offline harness can drive the real script; in the image they redirect
    // where root's credentials are reconciled from and to, and every other
    // check here would still pass.
    const fx = await mutated('shadow-reconcile-no-test-override', (root) => {
      const dir = join(root, '/etc/systemd/system/mica-shadow-reconcile.service.d')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '10-test.conf'), '[Service]\nEnvironment=MICA_SHADOW_FACTORY=/tmp/fake\n')
    })
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-no-test-override')).toBe('fail')
      expect(await messageOf(fx, 'shadow-reconcile-no-test-override')).toContain('10-test.conf')
    }
    finally {
      fx.dispose()
    }
  })

  test('the VENDOR drop-in directory is searched as well as /etc', async () => {
    const fx = await mutated('shadow-reconcile-no-test-override', (root) => {
      const dir = join(root, '/usr/lib/systemd/system/mica-shadow-reconcile.service.d')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '20-vendor.conf'), '[Service]\nEnvironmentFile=/etc/mica/MICA_SHADOW_PASSWD.env\n')
    })
    try {
      expect(await verdictOf(fx, 'shadow-reconcile-no-test-override')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

/** Which unit each of the four message shapes should yield as its instance. */
function expectedDep(line: string): string {
  for (const dep of ['micad.service', 'dropbear.service', 'systemd-logind.service', 'systemd-user-sessions.service']) {
    if (line.includes(`Before=${dep}`) || line.includes(`Before= naming ${dep}`)) return dep
  }
  return '(none)'
}
