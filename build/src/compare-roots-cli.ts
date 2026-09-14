// The entry point PLAN-036 section 6's dual-build gate calls.
//
// Two directories, a ledger, an exit code. The driver that BUILDS both paths
// lands with the composer; this is the seam it is written against, and the
// usage text below is the whole contract -- there is nothing to reinvent about
// the comparison or the ledger format on the other side of it.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { compareRoots, extractOciRoot, formatReport } from './compare-roots.ts'
import { REPO_ROOT } from './paths.ts'

/** The shipped ledger. A default, so the gate driver needs no path of its own. */
export const DEFAULT_LEDGER = join(REPO_ROOT, 'tests', 'dual-build-sanctions.md')

const USAGE = `usage: bash build/run.sh --compare-roots [--sanctions FILE] DIR_A DIR_B
       bash build/run.sh --compare-roots --extract-oci ARCHIVE DIR

Compares two ALREADY-EXTRACTED root trees and reports the difference set,
classified against a written sanction ledger. This is the instrument behind
PLAN-036 section 6's last paragraph: one board built through both the rootfs stage
chain and the package composer, their unpacked trees compared, every difference
either sanctioned in writing or reported.

  DIR_A            the baseline root -- the path being replaced (the stage chain)
  DIR_B            the candidate root -- the path replacing it (the composer)
  --sanctions FILE the ledger (default: tests/dual-build-sanctions.md)

PASS ABSOLUTE PATHS. run.sh runs bun with build/ as its working directory,
so a relative argument is resolved against build/ and not against wherever
the caller stood -- which surfaces as "does not exist" naming a path the caller
can see. Every mode of run.sh behaves this way; this is the one that takes bare
directories rather than a --out-dir with an absolute default.

'added' means present in B and absent in A, so which argument is which decides
what the ledger's stanzas mean. PLAN-036 sanctions ADDITIONS -- package
documentation and the package composition record -- so the composed root is B.

Compared, for every path in the union of the two trees: presence, file type,
mode, uid, gid, symlink target, regular-file content hash, and file
capabilities. NOT mtime -- src/compare-roots.ts says why at the site.

  --extract-oci ARCHIVE DIR
                   unpack a factory-root.oci (the OCI-layout tar that
                   rootfs/compose/90-pack.Dockerfile's 'factory-root' target
                   exports, written to _out/<board>/) into DIR, as a root tree
                   this can compare. DIR must not already hold anything.

exit codes -- the contract the gate driver reads:
  0  compared: every difference is sanctioned, every active sanction matched
     something, and no pending sanction has come live.
  1  compared, and the ledger does not account for the result: an unsanctioned
     difference, an active sanction that matched nothing, or a pending sanction
     that now matches. The report names each.
  2  REFUSED -- no comparison was made. A side that is missing, is not a
     directory, is empty or is under the path floor; both sides being one
     directory; a ledger that is absent or unparseable; no getcap to read file
     capabilities with. These are separate from 1 because a gate that cannot
     tell "the roots agree" from "nothing was compared" is not a gate.

The counters are printed on every run, including the passing ones: "no
differences" and "nothing was examined" reach the same verdict by opposite
routes, and the path counts are what separate them.
`

export type CliOptions =
  | { readonly mode: 'compare', readonly a: string, readonly b: string, readonly sanctions: string }
  | { readonly mode: 'extract-oci', readonly archive: string, readonly dest: string }

export function parseArgs(argv: readonly string[]): CliOptions {
  let sanctions = DEFAULT_LEDGER
  const positional: string[] = []
  let extract: { archive: string, dest: string } | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string
    if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (a === '--sanctions') {
      const next = argv[i + 1]
      if (next === undefined) throw new Error(`--sanctions needs a file\n\n${USAGE}`)
      sanctions = next
      i += 1
      continue
    }
    if (a === '--extract-oci') {
      const archive = argv[i + 1]
      const dest = argv[i + 2]
      if (archive === undefined || dest === undefined) {
        throw new Error(`--extract-oci needs an archive and a destination directory\n\n${USAGE}`)
      }
      extract = { archive, dest }
      i += 2
      continue
    }
    if (a.startsWith('-')) throw new Error(`unknown argument ${JSON.stringify(a)}\n\n${USAGE}`)
    positional.push(a)
  }
  if (extract !== undefined) {
    if (positional.length > 0) {
      throw new Error(`--extract-oci unpacks one archive and compares nothing; it takes no other arguments\n\n${USAGE}`)
    }
    return { mode: 'extract-oci', archive: extract.archive, dest: extract.dest }
  }
  // Two directories exactly. A single one would be compared against a default
  // that does not exist, and three would leave one of them unread -- which, on
  // a gate, is a root nobody looked at reported as a root that agreed.
  if (positional.length !== 2) {
    throw new Error(`expected exactly two root directories, got ${positional.length}\n\n${USAGE}`)
  }
  return { mode: 'compare', a: positional[0] as string, b: positional[1] as string, sanctions }
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  if (options.mode === 'extract-oci') {
    const r = extractOciRoot(options.archive, options.dest)
    console.log(`extracted ${options.archive} -> ${options.dest} (${r.layers} layer(s), ${r.paths} paths)`)
    return 0
  }
  if (!existsSync(options.sanctions) && options.sanctions === DEFAULT_LEDGER) {
    // Named here rather than left to the library, because the default path is
    // this file's decision and a reader who did not pass --sanctions has no
    // reason to think a path was involved at all.
    console.error(`note: the default ledger ${DEFAULT_LEDGER} is not there; --sanctions names another`)
  }
  const result = compareRoots({ a: options.a, b: options.b, ledgerPath: options.sanctions })
  console.log(formatReport(result))
  return result.exitCode
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)))
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    // 2 is "refused", and a bad argument, a defect in this program and a
    // refusal from the library all land here together. What none of them may do
    // is exit 1, which is the verdict "the comparison ran and the ledger did
    // not account for it" -- a status a run that never compared anything must
    // not be able to produce.
    process.exit(2)
  }
}
