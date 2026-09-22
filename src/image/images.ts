// An image selector (<source>:<name>[@<platform>], an image row of locks/) -> the image reference it names.
//
// THIS FILE PARSES NOTHING. src/locks/from.ts is the tree's one resolver: it asks src/locks/locks.ts, which
// checks every lock and pin of locks/ first, and refuses a selector that is missing or malformed, a value that
// is a TAG rather than a digest, and a reference that is not well formed -- each with a sentence naming the key
// and the file. R6 removed the last floating tag from the shipping path by routing eighteen call sites through
// it, and a second reader of that file here would be the nineteenth place for the pin to be wrong. Until
// 2026-09-22 the resolver was a bash script and this file a subprocess call to it; it is an import now, and the
// two guards that call needed (an absent script, an empty answer) have no failure left to catch.

import { join } from 'node:path'
import { resolve } from '../locks/from.ts'
import { inputs, Refused, rows } from '../locks/locks.ts'

/** Resolved references, by key: locks/ is read once per process, a toolbox opens more than once. */
const cache = new Map<string, string>()

/**
 * The image reference the selector `key` names in locks/.
 *
 * @throws Error carrying the resolver's own refusal, which names the key and the file.
 */
export async function resolveImage(key: string): Promise<string> {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const ref = resolve(key, inputs())
  cache.set(key, ref)
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
