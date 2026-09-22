// How a ported check spells its conclusion.
//
// Three constructors, in their own module so that the check batches can use
// them without importing the register they are part of.
//
// The MESSAGE is not the identity -- `parity.ts` pairs on (id, instance) and
// compares verdicts, and the whole reason the matcher lives on the check is
// that the oracle's prose is not an identifier. The message is what a reader
// sees on the TypeScript side of a divergence, next to the shell's own
// sentence, so it says the same FACT in the same units rather than paraphrasing
// the conclusion.

import type { CheckResult, Verdict } from './parity.ts'

export interface Firing {
  /** Required exactly when the check's cardinality is `many`. */
  readonly instance?: string
}

/** A conclusion about the image: `ok` decides which direction. */
export function verdict(
  id: string,
  ok: boolean,
  message: string,
  firing: Firing = {},
): CheckResult {
  return {
    id,
    ...(firing.instance === undefined ? {} : { instance: firing.instance }),
    verdict: ok ? 'pass' : 'fail',
    message,
  }
}

/**
 * The third verdict, spelled out.
 *
 * Never produced by defaulting: `parity.ts` refuses to treat a skip as a pass,
 * and a check that means "this board has no such thing" has to say so.
 */
export function skipped(id: string, message: string, firing: Firing = {}): CheckResult {
  return {
    id,
    ...(firing.instance === undefined ? {} : { instance: firing.instance }),
    verdict: 'skip' as Verdict,
    message,
  }
}

/**
 * The case-insensitive equality the oracle spells `eq_ci`: GUIDs and
 * typecodes are hexadecimal and the
 * tools that print them disagree about case, so the comparison folds it and the
 * message does not.
 *
 * The two directions share the leading `"<what> is "` clause and nothing else,
 * which is exactly why a matcher for one of these checks is that clause -- a
 * matcher taken from further along the PASS line would stop matching the moment
 * the check went red.
 */
export function eqCi(
  id: string,
  what: string,
  got: string | undefined,
  want: string,
  firing: Firing = {},
): CheckResult {
  const ok = (got ?? '').toLowerCase() === want.toLowerCase()
  return verdict(
    id,
    ok,
    ok ? `${what} is ${want}` : `${what} is '${got ?? ''}', expected ${want}`,
    firing,
  )
}
