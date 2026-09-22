// The twelve artifacts this repository BUILDS -- micad, apid, mica-mqttd,
// mica-mqtt-broker, mica-deploy, podman, quadlet, crun, conmon, netavark, aardvark-dns
// and catatonit -- where each lands in the factory root, and how each is asked
// what version it is. No version STRING is written down here, only identity:
// every `pin` is a function that reads the value from the file that owns it at
// run time (smoke-pins.ts), and `pinCoverageFaults` checks the set in both
// directions from the smoke runner itself, so an eighth binary added to
// `mica-podman:` cannot leave this register reporting a full green over seven of
// eight.
//
// The installed paths are measured. Five of the seven container binaries are NOT
// in /usr/bin: `stages/compose/scripts/podman-install.sh` puts podman and crun there
// and writes the other five with
// `install -m0755 "/tmp/podman/${b}" "/usr/libexec/podman/${b}"`, a
// ${VAR}-assembled destination appearing nowhere as a literal. A wrong path here
// fails with rc=127 rather than passing quietly.

import { readPin, pinKeys, type Pin } from './smoke-pins.ts'
import { PODMAN_UPSTREAM_LOCK, UPSTREAM_LOCK_FILES, readPinnedPackageVersion } from './smoke-pins.ts'

/**
 * How an artifact is asked what it is.
 *
 * `version` asserts BOTH halves of the Scope sentence -- exit 0 AND reported
 * version == the recorded pin -- so it is strictly stronger than `exec`, which
 * asserts only the first. `unclaimed` asserts neither and is never invoked at
 * all; it exists so that "we did not check this" is a thing the output can say.
 *
 * No entry below is `unclaimed`, and the kind stays anyway: it is the only
 * honest thing to write down for an artifact this repository ships and cannot
 * yet ask, the alternatives being to report it as passing or to leave it out.
 * Its branches are exercised from the failing side in smoke.test.ts.
 */
export type Contract
  = | { readonly kind: 'version', readonly argv: readonly string[] }
    | { readonly kind: 'exec', readonly argv: readonly string[] }
    | { readonly kind: 'unclaimed', readonly why: string }

/**
 * A failure that is the EXECUTOR'S limit rather than the artifact's.
 *
 * Declared per entry, never as a global pattern, and consulted only on the
 * emulated buildkit route: an entry that declares nothing can never be
 * executor-limited, so the category cannot spread to a binary nobody measured.
 * The runner requires the observed status AND the observed stderr to match what
 * is written here before it will report anything other than a FAIL, which is
 * what keeps this from becoming "a non-zero exit we have learned to tolerate".
 */
export interface ExecutorLimit {
  /** The exit status the executor's limit produces. Any other status is a FAIL. */
  readonly status: number
  /** A substring of stderr that identifies it. Matched against stderr only -- see `judge`. */
  readonly stderrIncludes: string
  /** Why this is the executor's limit and not the artifact's. Printed on the row. */
  readonly why: string
}

export interface Artifact {
  /** The binary's name, as Scope spells it. */
  readonly name: string
  /** Its installed path INSIDE the factory root. Not a host path. */
  readonly path: string
  /**
   * The package that ships it, as the composition record names it. A product
   * that does not select the package does not carry the binary, and the
   * runner executes what the root carries (artifactsForPackages); absent,
   * the artifact is executed in every root.
   */
  readonly package?: string
  /**
   * The recorded version, read from its own file when the runner asks.
   *
   * A function and not a value: a `Pin` computed at module load would be read
   * once per process, and the negative test that proves the version loop closes
   * edits an `upstream.lock` and re-reads it. More importantly it would put the
   * read at import time, where a malformed file becomes an import error in
   * every test in the package rather than a failure of the one thing that reads
   * it.
   */
  readonly pin: () => Pin
  readonly contract: Contract
  /**
   * The one failure of this artifact that is a statement about the executor.
   *
   * Absent for eleven of the twelve, and absent means the entry can only pass
   * or fail. See [`ExecutorLimit`] and `judge`.
   */
  readonly executorLimit?: ExecutorLimit
}

/** The container engine's shared pin file, named once per entry rather than per line. */
const podman = (name: string) => () => readPin(PODMAN_UPSTREAM_LOCK, name)
/** An imported package's package rows in `locks/`, named once per entry. */
const pinned = (name: string) => () => readPinnedPackageVersion(name)
/** An imported package whose binary reports the whole package version. */
const pinnedPackage = (name: string) => () => readPinnedPackageVersion(name, 'package')

export const ARTIFACTS: readonly Artifact[] = [
  // The four micaoss/mica-core writes in Rust and this repository imports through
  // the lock. micad and apid report the declared package version compiled into
  // them; mica-mqttd and mica-mqtt-broker report their crate version, the upstream part.
  {
    // micad and apid answer `--version` before any daemon initialisation --
    // provisioning, bus connection, key generation -- because asking a daemon
    // for its version must not MUTATE. micad:micad/src/main.rs answers from a
    // synchronous `main`, before the tokio runtime, the subscriber, the settings
    // store and provisioning, so this invocation reports, exits 0 and leaves
    // nothing behind. `/usr/bin/micad` with no argv still provisions (secrets/,
    // settings.toml) and still exits 1 on the absent system bus, and
    // `/usr/bin/micad -v` -- NOT this flag -- falls through into that daemon and
    // prints no version at all.
    name: 'micad', package: 'micad',
    path: '/usr/bin/micad',
    pin: pinnedPackage('micad'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    // The same, and for the same reason: without the early handler this binary
    // binds 0.0.0.0:443 and never returns.
    name: 'apid', package: 'mica-apid',
    path: '/usr/bin/mica-apid',
    pin: pinnedPackage('mica-apid'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    name: 'mica-mqttd', package: 'mica-mqttd',
    path: '/usr/bin/mica-mqttd',
    pin: pinned('mica-mqttd'),
    // The two crates that CAN answer are the two that declare clap and carry
    // `#[command(name = ..., version)]`, which emits CARGO_PKG_VERSION -- so
    // the value compared is literally the manifest's, one file, two readers.
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    name: 'mica-mqtt-broker', package: 'mica-mqtt-broker',
    path: '/usr/bin/mica-mqtt-broker',
    pin: pinned('mica-mqtt-broker'),
    contract: { kind: 'version', argv: ['--version'] },
  },

  // The authenticated file-deployment client.
  {
    name: 'mica-deploy', package: 'mica-deploy',
    path: '/usr/bin/mica-deploy',
    pin: () => readPinnedPackageVersion('mica-deploy'),
    contract: { kind: 'version', argv: ['--version'] },
  },

  // The container engine, built from source by mica-podman:.
  {
    name: 'podman', package: 'mica-podman',
    path: '/usr/bin/podman',
    pin: podman('podman'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    // Quadlet ships out of the podman tree and carries podman's version, which
    // is why two entries read one key, and why `pinCoverageFaults` requires "at
    // least one claimant" rather than "exactly one": a pin with two readers is
    // correct here, a pin with none is the drift being guarded. It is also the
    // only artifact whose --version output is the bare number `5.8.6`, with no
    // program name in front of it. Nothing here depends on that shape --
    // `versionTokens` reads the numbers out of whatever is printed.
    name: 'quadlet', package: 'mica-podman',
    path: '/usr/libexec/podman/quadlet',
    pin: podman('podman'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    name: 'crun', package: 'mica-podman',
    path: '/usr/bin/crun',
    pin: podman('crun'),
    contract: { kind: 'version', argv: ['--version'] },
    // crun 1.29.1's mitigation for CVE-2024-21626 re-executes libcrun out of a
    // memory file descriptor (memfd_create + fexecve) before it will parse a
    // single argument, `--version` included. qemu-user cannot service that
    // fexecve, so under the emulated buildkit executor crun exits 1 having
    // printed this on stderr and nothing on stdout -- measured 2026-08-30 while
    // building the cx3576 root. It is the emulator that cannot run the
    // re-exec, not crun that is broken: the same binary in the same root
    // reports `crun version 1.29.1` on a host whose kernel executes it
    // natively, and stages/compose/scripts/podman-exercise.sh already records the
    // same signature at the stage level ("version withheld under emulation").
    // Declared here so the exemption is one entry, one status and one sentence
    // rather than a pattern every artifact is measured against; on the native
    // route this entry stays strict and this failure is a FAIL.
    executorLimit: {
      status: 1,
      stderrIncludes: 'Failed to re-execute libcrun via memory file descriptor',
      why:
        'crun re-executes libcrun through a memory file descriptor (its CVE-2024-21626 mitigation) '
        + 'before parsing argv, and qemu-user cannot service that fexecve -- so under emulation it '
        + 'cannot reach its own --version handler. The emulator\'s limit, not the binary\'s',
    },
  },
  {
    name: 'conmon', package: 'mica-podman',
    path: '/usr/libexec/podman/conmon',
    pin: podman('conmon'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    name: 'netavark', package: 'mica-podman',
    path: '/usr/libexec/podman/netavark',
    pin: podman('netavark'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    name: 'aardvark-dns', package: 'mica-podman',
    path: '/usr/libexec/podman/aardvark-dns',
    pin: podman('aardvark-dns'),
    contract: { kind: 'version', argv: ['--version'] },
  },
  {
    // catatonit is a `version` entry although Scope says "exec-only". Both
    // checks are run, and Scope's premise is recorded as measured-false rather
    // than rewritten. The parenthesis reads "catatonit (static, no --version
    // contract)"; measured in the uefi-x64 factory root on 2026-08-26,
    // `/usr/libexec/podman/catatonit --version` exits 0 and prints
    // `tini version 0.2.1_catatonit` -- catatonit is a fork of tini and keeps
    // its banner, so the contract exists. The Acceptance clause points the same
    // way: "bumping an `upstream.lock` pin without rebuilding the artifact turns
    // the smoke run red" is false for the catatonit row if nothing reads it. The
    // exec-only conjunct is discharged rather than dropped, because a `version`
    // contract asserts exit 0 exactly as an `exec` one does and asserts the
    // output on top.
    name: 'catatonit', package: 'mica-podman',
    path: '/usr/libexec/podman/catatonit',
    // The normalisation, stated, because this is where it could go soft. The pin
    // is the tag `v0.2.1` and the binary says
    // `tini version 0.2.1_catatonit`; neither string contains the other, so the
    // comparison takes exactly two steps. On the pin side `expectedFromRecorded`
    // strips a leading `v` immediately followed by a digit (`v0.2.1` -> `0.2.1`),
    // the git tag prefix that no `--version` output in this image carries. On the
    // output side `versionTokens` takes maximal runs of digits-and-dots, so
    // `tini version 0.2.1_catatonit` yields exactly `["0.2.1"]`: `_catatonit` is
    // upstream's fork marker, terminates the token, and is not trimmed by a rule
    // written for this one artifact. Then `"0.2.1" === "0.2.1"` -- equality
    // against an extracted token, never a substring test. A loose `includes()`
    // on the raw line would pass on almost anything: `.includes("0.2")` and
    // `.includes("2.1")` are both true of that output, and a pin of `0.2.10`
    // would be satisfied by a `0.2.1` binary the other way round. So
    // `smoke.test.ts` drives THIS artifact from the failing side with a wrong
    // pin, and if upstream removes the banner the entry goes red naming what it
    // got.
    pin: podman('catatonit'),
    contract: { kind: 'version', argv: ['--version'] },
  },
]

/**
 * The artifacts a root carries, by the packages its composition record names:
 * every entry whose owning package is installed, plus the optional binaries a
 * product may add. Coverage is judged over the whole register (every pin has
 * an artifact); execution over this subset (every artifact that is there).
 */
export function artifactsForPackages(packages: ReadonlySet<string>): readonly Artifact[] {
  const result = ARTIFACTS.filter(a => a.package === undefined || packages.has(a.package))
  if (packages.has('mica-mqtt-reference')) {
    result.push({
      name: 'mica-mqtt-reference', path: '/usr/bin/mica-mqtt-reference',
      pin: pinned('mica-mqtt-reference'), contract: { kind: 'version', argv: ['--version'] },
    })
  }
  return result
}

/**
 * The only artifacts allowed to be `unclaimed`, and the record of who allowed it.
 *
 * A second place to edit, on purpose, and this file's one deliberate
 * duplication: everything else is written once so it cannot drift, this twice so
 * it cannot MOVE without somebody deciding it should. `unclaimed` lets a run
 * stay non-green without failing, and such a category decays one way only --
 * something loses its `--version`, somebody marks it unclaimed to get the
 * pipeline moving, and the gate quietly stops asking while the summary still
 * says INCOMPLETE. So the set is declared, `pinCoverageFaults` refuses any run
 * whose register disagrees with it, and a third name means editing the entry,
 * this constant and the lock in smoke-register.test.ts in one diff. It is never
 * inferred: no code path computes "this binary did not answer, so call it
 * unclaimed", because that turns a regression into a membership nobody chose,
 * and a binary asked for a version that gives none is a FAIL. Empty is not dead
 * -- `unclaimedFaults` still refuses a register that marks anything unclaimed,
 * which makes an empty authorisation stricter rather than weaker.
 */
export const EXPECTED_UNCLAIMED: readonly string[] = []

/** A register/pin-file disagreement, in the words the runner refuses with. */
export interface CoverageFault {
  readonly file: string
  readonly message: string
}

/**
 * The register's `unclaimed` set against the list that authorises it.
 *
 * Separate from `pinCoverageFaults` because it is a different question -- that
 * one asks whether the register and the pin files agree about which artifacts
 * exist, this one asks whether anybody decided that an artifact may go
 * unasked. Both are called by `smokeRun` before anything is executed.
 */
export function unclaimedFaults(
  artifacts: readonly Artifact[] = ARTIFACTS,
  allowed: readonly string[] = EXPECTED_UNCLAIMED,
): CoverageFault[] {
  const actual = artifacts.filter(a => a.contract.kind === 'unclaimed').map(a => a.name).sort()
  const want = [...allowed].sort()
  if (actual.join(' ') === want.join(' ')) return []

  const added = actual.filter(n => !want.includes(n))
  const removed = want.filter(n => !actual.includes(n))
  const parts: string[] = []
  if (added.length > 0) {
    parts.push(
      `${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} marked unclaimed and NOT in `
      + `EXPECTED_UNCLAIMED. An artifact may only go unasked if somebody decided it should: an `
      + `unclaimed entry is the one verdict that keeps a run non-green without failing it, so a `
      + `set that can grow on its own is a gate that can stop asking on its own. If this is `
      + `deliberate, add the name to EXPECTED_UNCLAIMED and to the lock in `
      + `smoke-register.test.ts, and record who decided. If it is a binary that LOST its `
      + `--version, it is a FAIL, not a category.`,
    )
  }
  if (removed.length > 0) {
    parts.push(
      `${removed.join(', ')} ${removed.length === 1 ? 'is' : 'are'} in EXPECTED_UNCLAIMED and no `
      + `longer marked unclaimed. That is the GOOD direction -- it is what landing a --version `
      + `handler looks like -- and it still fails here, because the constant is the record of what `
      + `is outstanding and a stale record understates the gap. Remove the name and say so.`,
    )
  }
  return [{ file: 'src/verify/smoke-register.ts', message: parts.join(' ') }]
}

/**
 * Both directions between the register and the `upstream.lock` files.
 *
 * Forward: every entry's key exists in the file it names, which catches a typo
 * and a name an `upstream.lock` rename left behind. Reverse: every git row in
 * every `upstream.lock` is claimed by at least one entry, which is what makes a
 * new self-built artifact unable to arrive unchecked and is the direction a
 * forward-only check passes happily without. `tools/docs/verify-index.sh` earned this
 * pairing the hard way -- its forward half was a `grep -q`, equally satisfied by
 * one occurrence or five, and the tree carried a duplicated index row through a
 * reported 162/162 PASS. Run by `smokeRun` and not only by tests, since a
 * register that has fallen behind must refuse a real run; `artifacts` and
 * `files` are parameters so both directions are reachable from a test.
 */
export function pinCoverageFaults(
  artifacts: readonly Artifact[] = ARTIFACTS,
  files: readonly string[] = UPSTREAM_LOCK_FILES,
): CoverageFault[] {
  const faults: CoverageFault[] = []

  // Forward. Reading the pin is the check: readPin throws, naming the file, the
  // key and the keys that are there.
  const claimed = new Map<string, Set<string>>()
  for (const a of artifacts) {
    let pin: Pin
    try {
      pin = a.pin()
    }
    catch (e) {
      faults.push({
        file: '(unresolved)',
        message: `${a.name}'s recorded version could not be read: ${(e as Error).message}`,
      })
      continue
    }
    const keys = claimed.get(pin.file) ?? new Set<string>()
    keys.add(pin.key)
    claimed.set(pin.file, keys)
  }

  // Reverse. Only over the upstream.lock files -- a crate manifest is not one of
  // these and has exactly one version key by construction.
  for (const file of files) {
    const keys = pinKeys(file)
    if (keys.length === 0) {
      faults.push({
        file,
        message:
          `declares no git row at all. That is not an empty set to be satisfied vacuously: this `
          + `file exists to pin versions, so zero of them means it was moved, renamed or emptied, `
          + `and a coverage check over nothing passes forever.`,
      })
      continue
    }
    const seen = claimed.get(file) ?? new Set<string>()
    for (const key of keys) {
      if (seen.has(key)) continue
      faults.push({
        file,
        message:
          `${key} is pinned here and no artifact in the smoke register reads it. Either a new `
          + `self-built binary arrived without being added to src/verify/smoke-register.ts -- in `
          + `which case the smoke run would have reported a full green while never executing it -- `
          + `or the pin outlived the artifact and should go. Both are edits; neither is a pass.`,
      })
    }
  }
  return faults
}
