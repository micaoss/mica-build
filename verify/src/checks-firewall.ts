// The base image's firewall TOOL (RFCT-296/PLAN-075) and the unit that must not
// run.
//
// mica-system depends on `nftables`, so every image carries it whatever it
// declines; `iptables` left the image (2026-09-13), nft is the one front-end.
// NO RULE, NO POLICY AND NOTHING THAT PERSISTS ONE is shipped with it, so
// nothing here reads a ruleset: the facts an image can be asked about are that
// the binary is reachable and that nftables.service is disabled by a decision
// rather than by an absence.
//
// WHY `packed-nft-present` IS NOT A DUPLICATE OF `container-engine-nft`, which
// also asserts nft is in the image. They are two independent statements that
// happen to share a binary, exactly as mica-podman and mica-system both declaring
// `nftables` are two statements rather than one. checks-engine.ts asks whether
// the CONTAINER ENGINE can run -- netavark execs nft by name and the first
// `podman run` fails without it -- and that check is the engine family's, board
// and profile scoped with it. This one asks whether the BASE IMAGE has its
// firewall vocabulary, which is now true of an image that declines containers
// and where the engine family has nothing to say. Deleting either because the
// other exists would leave a real hole; their matchers are disjoint on purpose
// and checks-firewall.test.ts asserts that.
//
// THE CHAIN IS FOLLOWED INSIDE THE ROOT, hop by hop, and that is not a nicety:
// a link's target may be image-absolute, so handing it to statSync would ask
// about the VERIFIER HOST's filesystem, and a packed root with a DANGLING link
// would then resolve against this machine. `script-commands.ts` re-roots the
// same walk for the same reason and says so; this module cannot reuse it
// because `resolvesInRoot` answers a boolean and the check has to name the
// chain it walked.
//
// THE SECOND CHECK IS ABOUT A UNIT NOBODY ENABLED, and its whole point is that
// "nobody enabled it" is not the same fact as "it is disabled". The nftables
// package ships nftables.service, whose ExecStart is `nft -f
// /etc/nftables.conf`, and the config it ships begins with `flush ruleset` --
// so an enabled unit clears netavark's container-network rules at every boot.
// Before mica-system shipped 50-mica-nftables.preset, NO preset in the image
// matched that unit, and the unmatched fallback is ENABLE: measured in a clean
// trixie root, `systemctl preset nftables.service` with the stock set creates
// sysinit.target.wants/nftables.service. So the check asserts the preset
// RESOLUTION and not only the absence of a link -- a root with no link and no
// rule is one `systemctl preset-all` away from the failure, and a check that
// only counted links would call it correct.

import { existsSync, lstatSync, readlinkSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CheckCase } from './checks.ts'
import { packedRoot } from './checks-root.ts'
import type { CheckResult } from './parity.ts'
import { PRESET_DIRS, UNIT_DIRS, presetFor, wantsLinksNaming } from './unit-state.ts'
import { verdict } from './verdict.ts'

/**
 * The directories a bare command name is looked up in, in PATH order.
 *
 * An independent transcription; `checks-busybox.ts` and `script-commands.ts`
 * each keep their own. The list is the image's PATH and not this module's
 * opinion, so a copy here is a copy of a fact rather than a second definition
 * of one -- and importing another family's private constant would couple two
 * checks that have no reason to move together.
 */
const PATH_DIRS: readonly string[] = [
  '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
]

/** The native front-end, and the name netavark also execs. */
const NFT_COMMAND = 'nft'

/** The unit the nftables package ships, which must never run in this image. */
const NFTABLES_UNIT = 'nftables.service'

/** Where a symlink at an image-absolute `path` points, as an image path. */
function linkTarget(root: string, path: string): string {
  const raw = readlinkSync(join(root, path))
  return raw.startsWith('/') ? raw : join(dirname(path), raw)
}

interface Resolution {
  /** The chain walked, image-absolute, first entry the PATH hit. Empty: not on PATH. */
  readonly chain: readonly string[]
  /** The last hop's stat, when the chain ended at something that exists. */
  readonly endpoint?: Stats
}

/**
 * What a bare command name resolves to in this root, following symlinks.
 *
 * Bounded at eight hops, `script-commands.ts`'s own bound: a link cycle in the
 * image is not this check's subject, and an unbounded follow would hang the run
 * rather than report one. A chain that is still a link at the eighth hop is
 * returned with no endpoint, which reads as unresolved -- correct, because a
 * name nothing can follow to a file is a name the shell cannot execute either.
 *
 * A DANGLING link is a hit, not a miss: the candidate is chosen with lstat, so
 * a broken /usr/sbin/nft is found and then fails to resolve, which is a
 * different sentence from "nft is not on PATH" and a different defect.
 */
function resolve(root: string, name: string): Resolution {
  const chain: string[] = []
  let at = ''
  for (const dir of PATH_DIRS) {
    const candidate = `${dir}/${name}`
    try {
      lstatSync(join(root, candidate))
      at = candidate
      break
    }
    catch {
      continue
    }
  }
  if (at === '') return { chain }
  for (let hop = 0; hop < 8; hop += 1) {
    chain.push(at)
    let st: Stats
    try {
      st = lstatSync(join(root, at))
    }
    catch {
      return { chain }
    }
    if (!st.isSymbolicLink()) return { chain, endpoint: st }
    at = linkTarget(root, at)
  }
  return { chain }
}

/** The chain as one line, `a -> b -> c`. Never empty when it is printed. */
const spell = (chain: readonly string[]): string => chain.join(' -> ')

export const FIREWALL_CHECKS: readonly CheckCase[] = [
  {
    // The native front-end, from the BASE image's side. mica-system names
    // nftables in Depends, and this is the assertion that the name became a
    // binary an operator can run -- on every image, including the profiles that
    // decline containers, where checks-engine.ts has nothing to say.
    //
    // The chain is followed even though /usr/sbin/nft is a regular file today:
    // a check that only stats the first hit is one Debian packaging change away
    // from resolving against the verifier host.
    id: 'packed-nft-present',
    shell: {
      pass: 'nft is executable in the packed root',
      fail: 'nft is not executable in the packed root',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const { chain, endpoint } = resolve(root, NFT_COMMAND)
      if (chain.length === 0) {
        return [verdict('packed-nft-present', false,
          `nft is not executable in the packed root: no entry called ${NFT_COMMAND} is in any of `
          + `${PATH_DIRS.join(' ')}. mica-system names nftables in Depends, so an image without it `
          + 'is one where that dependency stopped being installed -- and nft is the complete view '
          + 'of the rule set, the one an operator is told to reach for first')]
      }
      if (endpoint === undefined || !endpoint.isFile()) {
        return [verdict('packed-nft-present', false,
          `nft is not executable in the packed root: ${spell(chain)} resolves to nothing inside `
          + 'the root')]
      }
      const mode = endpoint.mode & 0o777
      if ((mode & 0o111) === 0) {
        return [verdict('packed-nft-present', false,
          `nft is not executable in the packed root: ${spell(chain)} is mode `
          + `0${mode.toString(8)}. The package installed and the operator still cannot run it`)]
      }
      return [verdict('packed-nft-present', true,
        `nft is executable in the packed root: ${spell(chain)}, mode 0${mode.toString(8)}, `
        + `${endpoint.size} bytes`)]
    },
  },

  {
    // The unit that must not run, and the DECISION that keeps it from running.
    //
    // Three facts, one conclusion, because they are one decision: the unit is
    // in the root (so this says something), nothing enables it, and the shipped
    // presets RESOLVE it to disabled. The third is the one that is easy to
    // leave out and the one that matters -- an image with no link and no rule
    // is correct today and one `systemctl preset-all` away from a boot that
    // runs `nft -f /etc/nftables.conf`, whose first line is `flush ruleset`.
    id: 'packed-nftables-service-disabled',
    shell: {
      pass: 'nftables.service is disabled by a preset',
      fail: 'nftables.service is not disabled by a preset',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const unit = UNIT_DIRS
        .map(dir => `${dir}/${NFTABLES_UNIT}`)
        .find(p => existsSync(join(root, p)))
      if (unit === undefined) {
        return [verdict('packed-nftables-service-disabled', false,
          `nftables.service is not disabled by a preset: there is no ${NFTABLES_UNIT} in `
          + `${UNIT_DIRS.join(' or ')} at all, so "nothing enables it" is a statement about `
          + 'nothing -- true of an image with no nftables in it, of a root that failed to unpack, '
          + 'and of a directory that was never a root. mica-system depends on nftables, and the '
          + 'package ships this unit')]
      }
      const links = wantsLinksNaming(root, NFTABLES_UNIT)
      if (links.length > 0) {
        return [verdict('packed-nftables-service-disabled', false,
          `nftables.service is not disabled by a preset: ${links.join(' ')} enable(s) it. Its `
          + 'ExecStart is `nft -f /etc/nftables.conf` and that config opens with `flush ruleset`, '
          + 'so the unit clears netavark\'s container-network rules at every boot. mica ships the '
          + 'tools and no ruleset; nothing is meant to load one')]
      }
      const rule = presetFor(root, NFTABLES_UNIT)
      if (rule === undefined) {
        return [verdict('packed-nftables-service-disabled', false,
          `nftables.service is not disabled by a preset: no preset rule in ${PRESET_DIRS.join(' ')} `
          + `matches ${NFTABLES_UNIT}, and an unmatched unit presets to ENABLE -- measured in a `
          + 'clean trixie root, `systemctl preset nftables.service` with the stock set creates '
          + 'sysinit.target.wants/nftables.service. No link exists today, but that is an absence '
          + 'and not a decision, and one preset-all turns it into a boot that flushes the ruleset')]
      }
      if (rule.verb !== 'disable') {
        return [verdict('packed-nftables-service-disabled', false,
          `nftables.service is not disabled by a preset: the first rule that claims it is `
          + `'${rule.verb} ${rule.pattern}' in ${rule.file}. Preset rules are consulted in `
          + 'lexicographic order of basename and the first match wins, so a later `disable` line '
          + 'would never be read')]
      }
      return [verdict('packed-nftables-service-disabled', true,
        `nftables.service is disabled by a preset: ${unit} is in the root, no .wants or .requires `
        + `link names it, and the first preset rule that claims it is '${rule.verb} `
        + `${rule.pattern}' in ${rule.file}. The tool ships and no ruleset is loaded at boot`)]
    },
  },
]
