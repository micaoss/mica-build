// An image selector (<source>:<name>[@<platform>], an image row of locks/) -> the image reference it names.
//
// THIS FILE PARSES NOTHING. tools/from.sh is the tree's one resolver:
// it asks src/locks/locks.ts, which checks every lock and pin of locks/ first, and refuses a selector that is missing or malformed, a
// value that is a TAG rather than a digest, and a reference that is not well
// formed -- each with a sentence naming the key and the file. R6 removed the
// last floating tag from the shipping path by routing eighteen call sites
// through it, and a second reader of that file here would be the nineteenth
// place for the pin to be wrong.
//
// So this is a subprocess, not a parser. What it adds over the bare call is
// the two failures a caller of `docker run` would otherwise absorb silently:
// an empty answer, and a from.sh that could not be found at all.

import { $ } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FROM_SH } from './paths.ts'
import { Refused, rows } from '../locks/locks.ts'

/** Resolved references, by key. from.sh is a bash process; a toolbox opens more than once. */
const cache = new Map<string, string>()

/**
 * The image reference the selector `key` names in locks/.
 *
 * @param resolver the script to ask. A parameter only so the two guards below
 *   are REACHABLE: neither an absent from.sh nor one that exits 0 printing
 *   nothing can be produced by asking the real one, and a guard that can only
 *   fire when the repository is broken is a guard nobody has run. M3a and M3b
 *   each shipped one of those.
 * @throws Error carrying from.sh's own refusal, which names the key and the file.
 */
export async function resolveImage(key: string, resolver: string = FROM_SH): Promise<string> {
  const hit = resolver === FROM_SH ? cache.get(key) : undefined
  if (hit !== undefined) return hit

  // Checked rather than left to bash. `bash /gone/from.sh --ref mica-build-env:base`
  // fails with "No such file or directory" and the only proper noun in that
  // sentence is the path -- which a reader who asked for an image KEY reads as
  // a statement about the key.
  if (!existsSync(resolver)) {
    throw new Error(
      `${resolver} does not exist, so no image key can be resolved -- including ${key}. `
      + `src/paths.ts anchors this path; either tools/from.sh moved or that anchor did.`,
    )
  }

  const r = await $`bash ${resolver} --ref ${key}`.nothrow().quiet()
  if (r.exitCode !== 0) {
    throw new Error(
      `${resolver} refused ${key} (exit ${r.exitCode}):\n${r.stderr.toString().trimEnd()}`,
    )
  }

  const ref = r.stdout.toString().trim()
  // AN EMPTY ANSWER IS THE ONE FAILURE THAT DOES NOT LOOK LIKE ONE. `docker run
  // ${ref} sh -c ...` with an empty ref does not report a missing image: it
  // reads `sh` as the image name and `-c` as the command, and fails several
  // sentences away from the cause. from.sh has its own guards against printing
  // nothing; this is the caller refusing to build a command line out of it.
  if (ref === '') {
    throw new Error(
      `${resolver} exited 0 for ${key} and printed nothing. An empty reference substituted `
      + `into a docker command line is not a missing image -- docker reads the next word as the `
      + `image name -- so it is refused here, where the key is still in hand.`,
    )
  }

  if (resolver === FROM_SH) cache.set(key, ref)
  return ref
}

/** Drop the memo. Only a test that mutates an image file has any reason to. */
export function forgetResolvedImages(): void {
  cache.clear()
}

/**
 * Every image row a checkout's locks/ names, for the release record, keyed by
 * its selector <source>:<name>@<platform>; read through that checkout's own
 * src/locks/locks.ts, which refuses a locks/ that breaks a rule.
 */
export function builderImagesAt(root: string): Record<string, string> {
  let imageRows
  try {
    imageRows = rows('image', undefined, join(root, 'locks'))
  }
  catch (e) {
    if (e instanceof Refused) throw new Error(`${join(root, 'locks')} rows image failed:\nlocks: refused ${e.rule}${e.detail ? `: ${e.detail}` : ''}`)
    throw e
  }
  return Object.fromEntries(imageRows.map(([, source, name, platform, reference]) => [`${source}:${name}@${platform}`, reference!]))
}
