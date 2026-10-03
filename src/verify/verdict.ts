// How a check spells its conclusion.
//
// Three constructors, in their own module so that the check batches can use
// them without importing the register they are part of. The id (and instance)
// is the conclusion's identity; the message is what a reader sees, so it says
// the FACT in its units rather than paraphrasing the verdict.

import type { CheckResult, Verdict } from './check-types.ts'

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
 * Never produced by defaulting: a skip is never a pass, and a check that means "this board has no such thing" has to say so.
 */
export function skipped(id: string, message: string, firing: Firing = {}): CheckResult {
  return {
    id,
    ...(firing.instance === undefined ? {} : { instance: firing.instance }),
    verdict: 'skip' as Verdict,
    message,
  }
}
