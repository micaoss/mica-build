// Where a self-built artifact's recorded version is read from, and nothing else.
//
// The version loop is closed here -- bumping an `upstream.lock` pin without
// rebuilding the artifact turns the smoke run red -- and a loop is only closed
// if the two ends are the same file. So every function reads a pin out of the
// file that owns it, at run time, and there is deliberately no literal version
// string anywhere in verify/.
//
// The second list is the failure mode this file exists to avoid: `TOOL_PACKAGES`
// pinned from a copy of an `apk add` line, a hardcoded hwinit list that drifted
// and cost the image its stable MAC, a `SHIPPED_BOARDS = ['cx3576', 'uefi-x64']`
// literal that made a third board invisible to a lint reporting 26/26 PASS.
// Every one was green while being wrong, because a copy agrees with itself.
//
// No second format is invented either. An `upstream.lock` is `mica-lock v1`
// (mica:docs/design/release-lock.md 4.1): tab-separated rows under the header,
// and a version pin is a `git <name> <url> <tag> <commit>` row, whose tag is
// what the binary built from it reports.

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { REPO_ROOT } from './paths.ts'

/**
 * The container engine's pins -- podman, quadlet, crun, conmon, netavark,
 * aardvark-dns, catatonit. The engine is built by micaoss/mica-podman and
 * imported through its package row in locks/mica-podman.lock; this file is the
 * archive's /usr/share/mica-podman/upstream.lock, which tools/podman-pool.sh
 * (`make os-pool`) takes out of both pinned archives and holds equal between them.
 */
export const PODMAN_UPSTREAM_LOCK: string = join(REPO_ROOT, '_out', 'debs', 'mica-podman', 'upstream.lock')

/**
 * The version an imported package's lock records: its package rows in
 * `locks/<repository>.lock` (tools/locks.py rows package), a declared Debian
 * version `<upstream>-<revision>`. A binary reports either the whole package
 * version (`package`: micad and mica-apid compile it in) or its upstream part
 * (`upstream`: the crate version, `0.1.0` of `0.1.0-1`). Both architectures'
 * rows carry the same version by construction.
 */
export function readPinnedPackageVersion(name: string, reports: 'package' | 'upstream' = 'upstream'): Pin {
  const r = spawnSync('python3', [join(REPO_ROOT, 'tools', 'locks.py'), 'rows', 'package'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`tools/locks.py rows package refused locks/:\n${r.stderr.trimEnd()}`)
  const rows = r.stdout.split('\n').map(line => line.split('\t')).filter(f => f[1] === name)
  const file = join(REPO_ROOT, 'locks', `${rows[0]?.[0] ?? '<no repository>'}.lock`)
  const versions = new Set(rows.map(f => f[3] ?? ''))
  if (versions.size !== 1 || versions.has(''))
    throw new Error(`${file} does not record one non-empty version across its targets (got ${[...versions].join(', ') || 'none'}); the pin is what says which version ${name} must report, and a pin that says two things says nothing`)

  const recorded = [...versions][0]!
  const upstream = recorded.replace(/-[0-9A-Za-z.+~]+$/, '')
  if (upstream === recorded)
    throw new Error(`${file} records the version '${recorded}', which carries no Debian revision (<upstream>-<revision>); the upstream part a binary reports is told apart from the package version by it`)

  return { recorded, expected: reports === 'package' ? recorded : upstream, file, key: `package ${name}` }
}

/** Every `upstream.lock` a pin is read out of, so coverage can be asserted over all of them. */
export const UPSTREAM_LOCK_FILES: readonly string[] = [PODMAN_UPSTREAM_LOCK]

/** A recorded version, and the file and key it was read out of. */
export interface Pin {
  /** Exactly as the file writes it -- `v5.8.6`, `1.29.1`, `0.1.0`. */
  readonly recorded: string
  /** What a binary is expected to REPORT: `recorded` with a leading `v` removed. */
  readonly expected: string
  /** Absolute path of the file that owns it. */
  readonly file: string
  /** The git row's name (`podman`), or `package.version` for a crate. */
  readonly key: string
}

/**
 * Strip the `v` that a git TAG carries and a `--version` output does not.
 *
 * Measured, not assumed, and the two spellings live side by side in ONE file:
 * `mica-podman:locks/upstream.lock` pins podman at the tag `v5.8.6` and crun
 * at `1.29.1`, because the pins are upstream TAG names and upstream
 * does not agree with itself about the prefix. The binaries agree with each
 * other instead -- `podman version 5.8.6` and `crun version 1.29.1` both print
 * the bare number. So the normalisation is on the PIN side, once, rather than a
 * per-artifact rule that would have to be written down twice.
 *
 * Only a leading `v` immediately followed by a digit is removed. `version`,
 * `v2-something` and a value that merely starts with a letter are left alone --
 * a blanket `replace(/^v/, '')` would silently rewrite a pin that never had the
 * prefix, and this is a comparison whose whole job is to be exact.
 */
export function expectedFromRecorded(recorded: string): string {
  return /^v[0-9]/.test(recorded) ? recorded.slice(1) : recorded
}

/**
 * Read the git rows of an `upstream.lock` as data: name -> tag.
 *
 * @throws Error naming the file and the line when the file is not a
 *   `mica-lock v1` or a git row is not `git <name> <url> <tag> <commit>`.
 */
export function readUpstreamLock(file: string): ReadonlyMap<string, string> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  }
  catch (e) {
    throw new Error(`${file} cannot be read (${(e as Error).message}); it is taken out of the pinned mica-podman archives by \`make os-pool\``)
  }
  const lines = text.split('\n')
  if (lines[0] !== '# mica-lock v1') throw new Error(`${file} is not a mica-lock v1 file: its first line is ${JSON.stringify(lines[0])}`)
  const tags = new Map<string, string>()
  lines.slice(1).forEach((line, i) => {
    if (line === '' || line.startsWith('#') || !line.startsWith('git\t')) return
    const f = line.split('\t')
    if (f.length !== 5 || tags.has(f[1]!)) throw new Error(`${file}:${i + 2} is not one git <name> <url> <tag> <commit> row: ${JSON.stringify(line)}`)
    tags.set(f[1]!, f[3]!)
  })
  return tags
}

/**
 * Every version pin an `upstream.lock` declares, in file order.
 *
 * This is the direction that catches a new artifact. The register in
 * `smoke-register.ts` names the artifacts; this names the pins
 * the tree actually carries, and `smoke-register.test.ts` requires the second
 * set to be covered by the first. Without it, adding an eighth binary to
 * `mica-podman:` -- with its pin and its install line -- would leave the
 * smoke runner reporting a full green over seven, and a run that got greener by
 * looking at less is the exact defect this package exists to make visible in
 * other people's checkers.
 */
export function pinKeys(file: string): string[] {
  return [...readUpstreamLock(file).keys()]
}

/**
 * One pin, by key, out of one file.
 *
 * @throws Error naming the file, the key and the keys that ARE there. A missing
 *   pin must not read as an empty expectation: `expected === ''` would compare
 *   unequal to every real version and go red for a reason nobody could act on,
 *   so missing and empty pins are both rejected before comparison.
 */
export function readPin(file: string, key: string): Pin {
  const values = readUpstreamLock(file)
  const recorded = values.get(key)
  if (recorded === undefined || recorded === '') {
    const present = [...values.keys()].join(', ')
    throw new Error(
      `${file} declares no non-empty ${key}. The smoke runner reads the version a binary must `
      + `report out of this file and this key; with neither there is nothing to compare against, `
      + `and an empty expectation is not a weaker check but a different one. `
      + `The version pins it does declare are: ${present || '(none at all)'}.`,
    )
  }
  return { recorded, expected: expectedFromRecorded(recorded), file, key }
}

/** `micad:<crate>/Cargo.toml` -- the four device binaries this repository writes. */
