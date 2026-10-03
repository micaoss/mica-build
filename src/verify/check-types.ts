// What a check is to the register (src/verify/checks.ts) and what it concludes.

/** The three things a check can conclude. A SKIP is not a PASS. */
export type Verdict = 'pass' | 'fail' | 'skip'

/** The substrings of a check's printed conclusion that name it, one per direction. */
export interface ShellMatcher {
  /**
   * A substring of the check's PASS line. Optional only for a check that has no PASS line on any board it applies
   * to (a family that prints one `skip` on the board without the hardware); a check that registers no matcher at
   * all, or an empty one, is refused by `assertRegisterWellFormed`.
   */
  readonly pass?: Matcher
  /**
   * Of its FAIL line, when the two directions share no substring. A list names each way the check can fail; each
   * element is a plain substring, and a line is claimed by exactly one registered check.
   */
  readonly fail?: Matcher
  /** Of its SKIP line. Not defaulted to `pass`: a check that quietly became a skip must not read as run. */
  readonly skip?: Matcher
}

/** One substring of the conclusion, or several alternative spellings of it. */
export type Matcher = string | readonly string[]

/** The alternatives a matcher offers, as a list. Never empty for a live matcher. */
export function matcherAlternatives(matcher: Matcher | undefined): readonly string[] {
  if (matcher === undefined) return []
  return typeof matcher === 'string' ? [matcher] : matcher
}

/** A registered check, as `CheckCase` in checks.ts satisfies it. */
export interface RegisteredCheck {
  readonly id: string
  /** Board names this check applies to. Undefined means every board. */
  readonly boards?: readonly string[]
  /**
   * The product features this check needs, every one of them: a product that did not select one of them ships
   * nothing for this check to look at, and the check is not run over it (checks.ts checksFor). Undefined means
   * every product.
   */
  readonly features?: readonly string[]
  /** The init this check is about; undefined means either. A product on the other init is not checked by it. */
  readonly init?: 'systemd' | 'openrc'
  /** `one` -- the default -- or `many`, a family of conclusions from one check. */
  readonly cardinality?: 'one' | 'many'
  /** For `many`: one capture group naming the instance, e.g. /^p(\d+) PARTLABEL/. */
  readonly instance?: RegExp
  readonly shell: ShellMatcher
}

/** One conclusion of a check. */
export interface CheckResult {
  readonly id: string
  /** Required exactly when the check's cardinality is `many`. */
  readonly instance?: string
  readonly verdict: Verdict
  readonly message: string
}
