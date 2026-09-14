// The firewall family, driven from the failing side.
//
// Every check here passes by FINDING something, which is the easier half to get
// right, and most of them can be made green by an implementation that never
// followed a symlink or never read a preset -- so the mutations are mutations
// of the chain and of the preset set. Each takes a fixture asserted green first
// and then makes one edit to it.
//
// The mutations are the real shapes: a package that stopped being installed
// (nothing on PATH), a payload edit that lost the execute bit, and -- for the
// unit -- the enable link a `systemctl preset-all` writes and the deletion of
// the preset that stops it. The ORDERING case is separate because preset rules
// are first-match-wins and a grep for the disable line would pass with an
// `enable` above it.
//
// One case is still the most important test in this file: the HOST-LEAK case.
// It points nft at an absolute path that exists on the machine running the
// suite and NOT in the packed root, and requires red. A resolution that handed
// an image-absolute link target to statSync would go green there, and the
// verdict would be about the verifier host rather than about the image.

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { FIREWALL_CHECKS } from './checks-firewall.ts'
import { assertRegisterWellFormed, CHECKS, type CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))

/** The host path the leak test points at: on this machine, not in the fixture. */
const HOST_ONLY = '/usr/bin/env'

function checkNamed(id: string): CheckCase {
  const found = FIREWALL_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no firewall check is registered as '${id}'. Registered: `
      + FIREWALL_CHECKS.map(c => c.id).join(', '))
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

describe('the firewall family is in the register and can be diffed', () => {
  test('every check is registered in CHECKS, and the register is well formed', () => {
    const registered = new Set(CHECKS.map(c => c.id))
    for (const c of FIREWALL_CHECKS) expect(registered.has(c.id)).toBe(true)
    // Not a tautology over an empty list: the family has to have members.
    expect(FIREWALL_CHECKS.length).toBeGreaterThan(0)
    assertRegisterWellFormed()
  })

  test('no other check claims one of these matchers, in either direction', () => {
    // Not "no other matcher says nft" -- container-engine-nft's conclusion
    // legitimately does. What must not happen is a matcher CONTAINING another,
    // which is how one check claims a second's line.
    const mine = new Set(FIREWALL_CHECKS.map(c => c.id))
    const alternatives = (c: CheckCase): string[] =>
      [c.shell.pass, c.shell.fail, c.shell.skip]
        .flatMap(m => (typeof m === 'string' ? [m] : Array.isArray(m) ? m as string[] : []))
    const ours = FIREWALL_CHECKS.flatMap(alternatives)
    expect(ours.length).toBeGreaterThan(0)
    for (const c of CHECKS.filter(c => !mine.has(c.id))) {
      for (const theirs of alternatives(c)) {
        for (const own of ours) {
          expect(`${c.id}:${theirs.includes(own)}`).toBe(`${c.id}:false`)
          expect(`${c.id}:${own.includes(theirs)}`).toBe(`${c.id}:false`)
        }
      }
    }
  })

  test('the whole family is green on the healthy fixture', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      for (const c of FIREWALL_CHECKS) {
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

describe('nft, the native front-end the base image now carries', () => {
  test('the fixture ships it, and the verdict names the path and the mode', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'packed-nft-present')).toBe('pass')
      const message = await messageOf(fx, 'packed-nft-present')
      expect(message).toContain('/usr/sbin/nft')
      expect(message).toContain('mode 0755')
    }
    finally {
      fx.dispose()
    }
  })

  test('a root where nftables stopped being installed fails', async () => {
    // What dropping `nftables` from mica-system's Depends produces on a profile
    // that also declines containers: no nft, so no complete view of the rules.
    const fx = await mutated('packed-nft-present', root =>
      rmSync(join(root, 'usr/sbin/nft')))
    try {
      expect(await verdictOf(fx, 'packed-nft-present')).toBe('fail')
      expect(await messageOf(fx, 'packed-nft-present'))
        .toContain('no entry called nft is in any of')
    }
    finally {
      fx.dispose()
    }
  })

  test('a link that dangles in the root does NOT resolve against the verifier host', async () => {
    // The target exists on the machine running this suite, and its absence from
    // the root is asserted too -- without that the case would pass on a host
    // where the path happened to be missing, for the wrong reason.
    const fx = await mutated('packed-nft-present', (root) => {
      expect(existsSync(HOST_ONLY)).toBe(true)
      expect(existsSync(join(root, HOST_ONLY))).toBe(false)
      unlinkSync(join(root, 'usr/sbin/nft'))
      symlinkSync(HOST_ONLY, join(root, 'usr/sbin/nft'))
    })
    try {
      expect(await verdictOf(fx, 'packed-nft-present')).toBe('fail')
      expect(await messageOf(fx, 'packed-nft-present'))
        .toContain('resolves to nothing inside the root')
    }
    finally {
      fx.dispose()
    }
  })

  test('a binary that lost its execute bit fails, and says so separately', async () => {
    const fx = await mutated('packed-nft-present', root =>
      chmodSync(join(root, 'usr/sbin/nft'), 0o644))
    try {
      expect(await verdictOf(fx, 'packed-nft-present')).toBe('fail')
      expect(await messageOf(fx, 'packed-nft-present')).toContain('mode 0644')
    }
    finally {
      fx.dispose()
    }
  })

  test('it does not claim container-engine-nft\'s conclusion, or vice versa', () => {
    // The two coexist deliberately -- one is the base image's vocabulary, one is
    // whether the engine can run -- and the register can only tell them apart if
    // neither matcher contains the other. The generic containment test above
    // covers this; this one names the pair, because it is the collision a reader
    // of either module would actually worry about.
    const engine = CHECKS.find(c => c.id === 'container-engine-nft')
    expect(engine).toBeDefined()
    const mine = FIREWALL_CHECKS.find(c => c.id === 'packed-nft-present') as CheckCase
    const strings = (c: CheckCase): string[] =>
      [c.shell.pass, c.shell.fail, c.shell.skip]
        .flatMap(m => (typeof m === 'string' ? [m] : Array.isArray(m) ? m as string[] : []))
    for (const a of strings(mine)) {
      for (const b of strings(engine as CheckCase)) {
        expect(a.includes(b)).toBe(false)
        expect(b.includes(a)).toBe(false)
      }
    }
  })
})

describe('nftables.service is disabled by a decision, not by an absence', () => {
  test('the fixture is green, and the verdict names the rule and its file', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('pass')
      const message = await messageOf(fx, 'packed-nftables-service-disabled')
      expect(message).toContain('/usr/lib/systemd/system/nftables.service is in the root')
      expect(message).toContain("'disable nftables.service' in "
        + '/usr/lib/systemd/system-preset/50-mica-nftables.preset')
    }
    finally {
      fx.dispose()
    }
  })

  test('the enable link a preset-all would write fails, naming what it costs', async () => {
    const fx = await mutated('packed-nftables-service-disabled', (root) => {
      mkdirSync(join(root, 'etc/systemd/system/sysinit.target.wants'), { recursive: true })
      symlinkSync('/usr/lib/systemd/system/nftables.service',
        join(root, 'etc/systemd/system/sysinit.target.wants/nftables.service'))
    })
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('fail')
      const message = await messageOf(fx, 'packed-nftables-service-disabled')
      expect(message).toContain('/etc/systemd/system/sysinit.target.wants/nftables.service')
      expect(message).toContain('flush ruleset')
    }
    finally {
      fx.dispose()
    }
  })

  test('a .requires link fails too: enablement is not only .wants', async () => {
    const fx = await mutated('packed-nftables-service-disabled', (root) => {
      mkdirSync(join(root, 'etc/systemd/system/sysinit.target.requires'), { recursive: true })
      symlinkSync('/usr/lib/systemd/system/nftables.service',
        join(root, 'etc/systemd/system/sysinit.target.requires/nftables.service'))
    })
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-nftables-service-disabled'))
        .toContain('sysinit.target.requires/nftables.service')
    }
    finally {
      fx.dispose()
    }
  })

  test('removing the preset fails even with no link, which is the whole point', async () => {
    // The state the image was in BEFORE this change: correct today, and one
    // `systemctl preset-all` away from a boot that flushes the ruleset, because
    // an unmatched unit presets to enable. A check that counted links would
    // call this root green.
    const fx = await mutated('packed-nftables-service-disabled', root =>
      rmSync(join(root, 'usr/lib/systemd/system-preset/50-mica-nftables.preset')))
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('fail')
      const message = await messageOf(fx, 'packed-nftables-service-disabled')
      expect(message).toContain('no preset rule in')
      expect(message).toContain('presets to ENABLE')
    }
    finally {
      fx.dispose()
    }
  })

  test('an enable rule that SORTS EARLIER wins, and the check says so', async () => {
    // First match wins, in basename order across the merged directories. A
    // check that grepped for `disable nftables.service` would find its line and
    // report green over a root where systemd would enable the unit.
    const fx = await mutated('packed-nftables-service-disabled', root =>
      writeFileSync(join(root, 'usr/lib/systemd/system-preset/10-vendor.preset'),
        'enable nftables.*\n'))
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('fail')
      const message = await messageOf(fx, 'packed-nftables-service-disabled')
      expect(message).toContain("'enable nftables.*' in "
        + '/usr/lib/systemd/system-preset/10-vendor.preset')
      expect(message).toContain('the first match wins')
    }
    finally {
      fx.dispose()
    }
  })

  test('an /etc preset MASKS the shipped one of the same name', async () => {
    // Not hypothetical policy trivia: /etc is the tree an operator or a later
    // package can write, it outranks /usr/lib, and masking is by basename. A
    // resolution that concatenated the directories instead of masking would
    // still find the shipped disable rule and report green.
    const fx = await mutated('packed-nftables-service-disabled', (root) => {
      mkdirSync(join(root, 'etc/systemd/system-preset'), { recursive: true })
      writeFileSync(join(root, 'etc/systemd/system-preset/50-mica-nftables.preset'),
        'enable nftables.service\n')
    })
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-nftables-service-disabled'))
        .toContain('/etc/systemd/system-preset/50-mica-nftables.preset')
    }
    finally {
      fx.dispose()
    }
  })

  test('a root with no unit fails rather than reporting nothing wrong', async () => {
    // Vacuity, and the L1 brief named this shape by name: "nothing enables it"
    // is true of an image that lost the unit to a rename, to a dropped
    // dependency, or to an unpack that produced nothing.
    const fx = await mutated('packed-nftables-service-disabled', root =>
      rmSync(join(root, 'usr/lib/systemd/system/nftables.service')))
    try {
      expect(await verdictOf(fx, 'packed-nftables-service-disabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-nftables-service-disabled'))
        .toContain('is a statement about nothing')
    }
    finally {
      fx.dispose()
    }
  })
})
