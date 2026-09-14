// The register, and the two directions that keep it from falling behind.
//
// `pinCoverageFaults` is the guard, and a guard is only worth the
// run it can refuse -- so every case below drives it RED first and keeps the
// green one beside it. The shipped register passing is the positive control and
// on its own it proves nothing: a coverage check that never fires and a
// coverage check that cannot fire report the same thing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './paths.ts'
import {
  ARTIFACTS,
  EXPECTED_UNCLAIMED,
  pinCoverageFaults,
  unclaimedFaults,
  type Artifact,
} from './smoke-register.ts'
import { PODMAN_VERSIONS_ENV, pinKeys, VERSIONS_ENV_FILES } from './smoke-pins.ts'

let SCRATCH = ''
beforeAll(() => {
  mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
  SCRATCH = mkdtempSync(join(REPO_ROOT, '_out', 'verify-smoke-register-'))
})
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

function fixture(name: string, body: string): string {
  if (SCRATCH === '') throw new Error('the scratch directory was read before beforeAll created it')
  const path = join(SCRATCH, name)
  writeFileSync(path, body)
  return path
}

/**
 * The artifact list, transcribed once, HERE and not in the register.
 *
 * This is the one place a list of names is written down on purpose, and it is
 * written in the TEST rather than in the code so that it is an independent
 * statement of the requirement rather than a restatement of the
 * implementation. A register that quietly dropped an artifact would still
 * satisfy every property `pinCoverageFaults` checks -- the pin would just go
 * unclaimed if it had one, and micad, apid, mica-mqttd and mica-mqtt-broker have
 * no `versions.env` pin at all, so three of the four could vanish without any
 * coverage direction noticing. This is what notices.
 *
 * Scope: "for micad, apid, mica-mqttd, mica-mqtt-broker, mica-deploy, podman, quadlet,
 * crun, conmon, netavark, aardvark-dns -- minimal invocation inside that image
 * ... catatonit (static, no --version contract) gets an exec-only check."
 */
const SCOPE_ARTIFACTS = [
  'micad',
  'apid',
  'mica-mqttd',
  'mica-mqtt-broker',
  'mica-deploy',
  'podman',
  'quadlet',
  'crun',
  'conmon',
  'netavark',
  'aardvark-dns',
  'catatonit',
] as const

describe('the register names exactly the artifacts in scope', () => {
  test('every artifact in Scope is in the register, and nothing else is', () => {
    expect([...ARTIFACTS].map(a => a.name).sort()).toEqual([...SCOPE_ARTIFACTS].sort())
  })

  test('each installed path is absolute and each name appears once', () => {
    const names = new Set<string>()
    for (const a of ARTIFACTS) {
      expect(a.path.startsWith('/')).toBe(true)
      expect(names.has(a.name)).toBe(false)
      names.add(a.name)
    }
    expect(names.size).toBe(SCOPE_ARTIFACTS.length)
  })

  test('every entry can read its own pin, and none of them is empty', () => {
    for (const a of ARTIFACTS) {
      const pin = a.pin()
      expect(pin.recorded).not.toBe('')
      expect(pin.expected).not.toBe('')
    }
  })

  // The lock, and the edit it was built to force.
  //
  // Every artifact answers `--version`, so the unclaimed list is empty. Adding
  // an unclaimed artifact costs three edits that must move together -- the
  // register entry, EXPECTED_UNCLAIMED, and this line -- because
  // `unclaimedFaults` refuses a stale record in either direction, including
  // when the change it is stale about is a fix.
  test('every artifact is asked for a version, and none is unclaimed', () => {
    expect(ARTIFACTS.filter(a => a.contract.kind === 'unclaimed').map(a => a.name)).toEqual([])
    for (const a of ARTIFACTS) {
      expect(a.contract.kind).toBe('version')
      // `kind` is narrowed by the line above for the reader, not for tsc.
      expect(a.contract.kind === 'version' ? a.contract.argv : null).toEqual(['--version'])
    }
    // The vacuity control on the loop: `[]` is what an empty register would
    // give too, and a register with nothing in it satisfies "none is unclaimed"
    // perfectly.
    expect(ARTIFACTS.length).toBe(SCOPE_ARTIFACTS.length)
  })

  // The commit half, and the set is stated here rather than derived from the
  // register for the reason the whole SCOPE_ARTIFACTS list is: this is an
  // independent statement of what the scope amendment authorised. The user
  // lifted the exclusion for micad:micad/src/main.rs and micad:apid/src/main.rs.
  // mica-mqttd and mica-mqtt-broker are built by the same script from the same
  // workspace and were NOT named, so they do not embed a commit -- and if a
  // later change gives them one, this test is where that has to be argued for.
  // The executor-limited signature, locked to one entry for the reason
  // EXPECTED_UNCLAIMED is locked: a category that can grow on its own is a gate
  // that can stop asking on its own. It is declared on the entry rather than as
  // a pattern the runner matches every artifact against, so a second member is
  // a visible edit to this file and to this test.
  test('exactly one artifact declares an executor limitation, and it is crun', () => {
    const declaring = ARTIFACTS.filter(a => a.executorLimit !== undefined)
    expect(declaring.map(a => a.name)).toEqual(['crun'])

    // The signature itself, transcribed from the run that measured it: crun
    // 1.29.1 under the buildkit/qemu-user executor while building the cx3576
    // root on 2026-08-30. rootfs/scripts/podman-exercise.sh matches the same
    // sentence at the stage level ("version withheld under emulation"), which
    // is the precedent this entry follows.
    expect(declaring[0]!.executorLimit).toEqual({
      status: 1,
      stderrIncludes: 'Failed to re-execute libcrun via memory file descriptor',
      why: declaring[0]!.executorLimit!.why,
    })
    // The reason is printed on the row, so it has to say something.
    expect(declaring[0]!.executorLimit!.why).toContain('memory file descriptor')

    // The vacuity control: eleven entries declare nothing, and an entry that
    // declares nothing can never be executor-limited whatever it prints.
    expect(ARTIFACTS.filter(a => a.executorLimit === undefined).length).toBe(ARTIFACTS.length - 1)
    expect(ARTIFACTS.length).toBe(SCOPE_ARTIFACTS.length)
  })

  test('exactly the two files the amendment named embed a build commit', () => {
    const embedding = ARTIFACTS.filter(a => a.embedsBuildCommit === true).map(a => a.name)
    expect(embedding.sort()).toEqual(['apid', 'micad'])

    // ...and the other ten say nothing rather than `false`, which is the same
    // thing to the runner. Asserted so a future entry cannot claim a commit by
    // accident and go red against a record that says nothing about it.
    const silent = ARTIFACTS.filter(a => a.embedsBuildCommit !== true)
    expect(silent.length).toBe(ARTIFACTS.length - 2)
    expect(silent.map(a => a.name)).not.toContain('micad')
  })
})

describe('unclaimedFaults -- the category that must not grow silently', () => {
  /**
   * A register with one unclaimed entry, for the cases the SHIPPED register can
   * no longer reach.
   *
   * EXPECTED_UNCLAIMED is empty, so `unclaimedFaults()` over the shipped
   * register compares two empty sets -- and a green over two empty sets is
   * exactly what an authorisation list that had quietly emptied ITSELF would
   * produce. So every direction below is driven from this fixture instead,
   * where the search space is stated and non-empty.
   */
  const withUnclaimed = (name: string) =>
    ARTIFACTS.map(a =>
      a.name === name
        ? { ...a, contract: { kind: 'unclaimed' as const, why: 'MEASURED: fabricated for this case' } }
        : a)

  test('the shipped register matches what EXPECTED_UNCLAIMED authorises', () => {
    expect(unclaimedFaults()).toEqual([])
    // And what that green is now a statement about, stated rather than left to
    // be assumed: both sets are EMPTY, which is the post-M7d steady state and
    // the strictest the guard can be -- nothing may go unasked at all.
    expect(EXPECTED_UNCLAIMED.length).toBe(0)
    expect(ARTIFACTS.filter(a => a.contract.kind === 'unclaimed').length).toBe(0)
    // ...and the register it concluded that over is not itself empty.
    expect(ARTIFACTS.length).toBe(SCOPE_ARTIFACTS.length)
  })

  // The green above is not vacuous, because the same function over a populated
  // pair still agrees, and over a mismatched pair still refuses. Without this,
  // `unclaimedFaults` could have been replaced by `() => []` and every case in
  // this block that follows would still pass on the shipped register.
  test('over a POPULATED pair it still agrees, and a mismatched pair still refuses', () => {
    const one = withUnclaimed('conmon')
    expect(one.filter(a => a.contract.kind === 'unclaimed').map(a => a.name)).toEqual(['conmon'])
    expect(unclaimedFaults(one, ['conmon'])).toEqual([])
    expect(unclaimedFaults(one, ['crun']).length).toBe(1)
  })

  // The direction that matters: something new goes unasked.
  test('a THIRD unclaimed artifact refuses the run, and says it is a FAIL not a category', () => {
    const withRogue = ARTIFACTS.map(a =>
      a.name === 'crun'
        ? { ...a, contract: { kind: 'unclaimed' as const, why: 'it stopped answering one day' } }
        : a)
    // The mutation is a mutation: crun really was a version entry.
    expect(ARTIFACTS.find(a => a.name === 'crun')!.contract.kind).toBe('version')
    expect(withRogue.find(a => a.name === 'crun')!.contract.kind).toBe('unclaimed')

    const faults = unclaimedFaults(withRogue)
    expect(faults.length).toBe(1)
    expect(faults[0]!.message).toContain('crun')
    expect(faults[0]!.message).toMatch(/is a FAIL, not a category/)
  })

  // The other direction, which is the GOOD one and still fails: a stale
  // authorisation record understates the gap.
  //
  // This is the case M7d actually hit. Merging M7b's lock into a tree whose
  // handlers had already landed made the shipped register disagree with
  // EXPECTED_UNCLAIMED in exactly this direction, and `unclaimedFaults` refused
  // every smoke run until the constant was emptied -- nine red cases, from one
  // stale list. The guard worked on the change it was hardest to get right.
  //
  // It is driven from the SHIPPED register against a stale authorisation now,
  // rather than from a mutated register against the shipped one, because
  // post-M7d nothing in the register is unclaimed to un-claim.
  test('an artifact that GAINS a version contract also refuses, until the record is updated', () => {
    // The premise is a premise: micad really is asked for a version now.
    expect(ARTIFACTS.find(a => a.name === 'micad')!.contract.kind).toBe('version')

    const faults = unclaimedFaults(ARTIFACTS, ['micad'])
    expect(faults.length).toBe(1)
    expect(faults[0]!.message).toContain('micad')
    expect(faults[0]!.message).toMatch(/GOOD direction/)
  })

  test('and with the record updated too, it is clean -- which is what M7d landing looks like', () => {
    // The exact pair the previous case refused, with the record caught up: the
    // authorisation emptied to match a register that asks everything.
    expect(ARTIFACTS.filter(a => a.contract.kind === 'unclaimed').length).toBe(0)
    expect(unclaimedFaults(ARTIFACTS, [])).toEqual([])
    // And the same pair with the stale entry still in it is NOT clean, so the
    // line above is about the record having moved and not about `[]` being
    // agreeable to everything.
    expect(unclaimedFaults(ARTIFACTS, ['micad', 'apid']).length).toBe(1)
  })

  test('nothing infers the category at runtime -- an unclaimed entry is a literal', () => {
    // The requirement is that a binary which LOSES its --version becomes a
    // FAIL rather than joining the category. That is a property of there being
    // no inference path at all: `checkArtifact` reads `contract.kind` off the
    // register and never writes it.
    //
    // M7b asserted this as a shape over the shipped register's unclaimed
    // entries -- every one carries a hand-written `why` that no runtime path
    // could produce. Post-M7d there are none, and a `for` loop that `continue`s
    // over every element is a test that cannot fail. So the shipped set is
    // asserted EMPTY, and the shape is asserted over the fixture instead.
    expect(ARTIFACTS.filter(a => a.contract.kind === 'unclaimed')).toEqual([])
    const one = withUnclaimed('conmon').filter(a => a.contract.kind === 'unclaimed')
    expect(one.length).toBe(1)
    for (const a of one) {
      expect(a.contract.kind === 'unclaimed' ? a.contract.why : '').toContain('MEASURED')
    }
  })
})

describe('pinCoverageFaults -- forward, and driven red', () => {
  test('the shipped register agrees with the shipped pin files', () => {
    expect(pinCoverageFaults()).toEqual([])
  })

  // The vacuity control for the line above. `[]` is what an empty search space
  // returns too, so the green is only evidence if the sets it compared were
  // populated. Measured here rather than assumed: this repository has shipped a
  // lint reporting 26/26 PASS while a whole board was invisible to it.
  test('the green above is over a populated search space', () => {
    expect(ARTIFACTS.length).toBeGreaterThan(0)
    expect(VERSIONS_ENV_FILES.length).toBeGreaterThan(0)
    let pins = 0
    for (const f of VERSIONS_ENV_FILES) pins += pinKeys(f).length
    expect(pins).toBeGreaterThan(1)
  })

  test('an entry whose pin cannot be read is a fault naming the artifact', () => {
    const broken: Artifact = {
      name: 'ghost',
      path: '/usr/bin/ghost',
      pin: () => {
        throw new Error('GHOST_VERSION is not in any file')
      },
      contract: { kind: 'version', argv: ['--version'] },
    }
    const faults = pinCoverageFaults([...ARTIFACTS, broken])
    expect(faults.some(f => f.message.includes('ghost') && f.message.includes('GHOST_VERSION'))).toBe(true)
  })
})

describe('pinCoverageFaults -- reverse, the direction that catches a NEW artifact', () => {
  // This is the whole point of the pairing. Drop the entry that claims
  // CRUN_VERSION and the forward direction is still perfectly happy: every
  // remaining entry reads a key that exists. Only the reverse direction
  // notices that a binary this tree builds and ships is no longer executed.
  test('a pin no artifact reads is a fault, naming the key and both explanations', () => {
    const withoutCrun = ARTIFACTS.filter(a => a.name !== 'crun')
    // The mutation is a mutation: crun was there to be removed.
    expect(withoutCrun.length).toBe(ARTIFACTS.length - 1)

    const faults = pinCoverageFaults(withoutCrun)
    expect(faults.length).toBe(1)
    expect(faults[0]!.file).toBe(PODMAN_VERSIONS_ENV)
    expect(faults[0]!.message).toContain('CRUN_VERSION')
    expect(faults[0]!.message).toMatch(/would have reported a full green while never executing it/)
  })

  test('two artifacts may share one pin -- quadlet and podman do, and that is not a fault', () => {
    const readers = ARTIFACTS.filter(a => a.pin().key === 'PODMAN_VERSION').map(a => a.name)
    expect(readers.sort()).toEqual(['podman', 'quadlet'])
    expect(pinCoverageFaults()).toEqual([])
  })

  test('dropping ONE of two readers of a shared pin is not a fault, and dropping both is', () => {
    // The half-measure: podman goes, quadlet still claims the key.
    const withoutPodman = ARTIFACTS.filter(a => a.name !== 'podman')
    expect(withoutPodman.length).toBe(ARTIFACTS.length - 1)
    expect(pinCoverageFaults(withoutPodman)).toEqual([])

    // And with both gone the key is orphaned.
    const withoutBoth = ARTIFACTS.filter(a => a.name !== 'podman' && a.name !== 'quadlet')
    expect(withoutBoth.length).toBe(ARTIFACTS.length - 2)
    const faults = pinCoverageFaults(withoutBoth)
    expect(faults.length).toBe(1)
    expect(faults[0]!.message).toContain('PODMAN_VERSION')
  })

  test('a versions.env with no version pins at all is a fault, not a vacuous pass', () => {
    // A "this set is empty" check over a file that has been emptied, moved or
    // renamed passes forever. It is the failure this repository has already
    // paid for elsewhere, so it is named here rather than tolerated.
    const empty = fixture('emptied.env', '# every pin was moved out of this file\n')
    const faults = pinCoverageFaults(ARTIFACTS, [empty])
    expect(faults.length).toBe(1)
    expect(faults[0]!.message).toContain('declares no *_VERSION at all')
  })

  test('an unrelated pin file with an unclaimed key is a fault', () => {
    const extra = fixture('newthing.env', 'NEWTHING_VERSION=v0.1.0\nNEWTHING_SHA256=abc\n')
    const faults = pinCoverageFaults(ARTIFACTS, [...VERSIONS_ENV_FILES, extra])
    expect(faults.length).toBe(1)
    expect(faults[0]!.file).toBe(extra)
    expect(faults[0]!.message).toContain('NEWTHING_VERSION')
    // ...and the SHA256 half is not reported, because it is not a version.
    expect(faults[0]!.message).not.toContain('NEWTHING_SHA256')
  })

  test('the deployment client reads its version from the pin that imports it', () => {
    const deploy = ARTIFACTS.find(a => a.name === 'mica-deploy')!
    expect(deploy.pin().file).toBe(join(REPO_ROOT, 'deps/packages/mica-deploy.json'))
    expect(deploy.pin().key).toBe('targets.*.version')
  })
})
