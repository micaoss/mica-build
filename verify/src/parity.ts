// The parity harness: what the shell verifier concluded, what the TypeScript
// port concluded, and where the two differ -- per check.
//
// Nothing here runs a check: it parses one verifier's output, takes the other's
// results, and says by name, per check, agree / diverge / not ported.
//
// By name and not by count, following the image fixture contract: "395 checks
// both sides" is equally true of two runs that agreed on 395 and of two that
// agreed on none because both were empty, and M3a's board-env oracle reported
// agreement "on all 0 keys" for exactly that reason. A SKIP is a third verdict
// that never equals a PASS, so pass-vs-skip is a named divergence rather than
// noise in a total.
//
// Identity is assigned rather than parsed. The verification contract prints
// `PASS: <prose>`, `FAIL: <prose>`, `SKIP: <prose>` and nothing else -- measured
// on both boards' real images 2026-08-25, every one of 398 and 312 stdout lines
// is a verdict line or the final RESULT line -- but the prose is not an
// identifier: `eq_ci` prints "X is Y" passing and "X is 'Z', expected Y"
// failing. So each ported check carries a substring from its PASS line, plus
// separate substrings for FAIL and SKIP where the directions do not share one,
// as a field on the CheckCase rather than a file that could drift from it. The
// shell verifier is NOT modified to emit ids: an oracle edited to make its
// readings easier to compare is not independent of the thing it measures.
//
// `not-ported` is a first-class outcome, counted separately from agreement, and
// a run with any of them concludes INCOMPLETE and never PASS.

/** The three things a verifier can conclude about one check. A SKIP is not a PASS. */
export type Verdict = 'pass' | 'fail' | 'skip'

export interface ShellLine {
  readonly verdict: Verdict
  readonly message: string
  /** 1-based, into the verifier's stdout. Named so a row can be looked up. */
  readonly line: number
}

export interface ShellSummary {
  readonly result: 'PASS' | 'FAIL'
  readonly passed: number
  readonly total: number
  readonly skipped: number
}

export interface ShellRun {
  readonly lines: readonly ShellLine[]
  readonly summary: ShellSummary
}

class ParityInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ParityInputError'
  }
}

const VERDICT_PREFIX: ReadonlyMap<string, Verdict> = new Map([
  ['PASS: ', 'pass'],
  ['FAIL: ', 'fail'],
  ['SKIP: ', 'skip'],
])

/**
 * Parse the shell verifier's stdout, and refuse a parse that does not add up.
 *
 * The self-consistency guard is the point. The verifier counts its own
 * conclusions in PASS_N/FAIL_N/SKIP_N and prints them in its last line. This
 * parser counts them again from the lines. If the two disagree, the parser has
 * missed conclusions -- a message with an embedded newline, an output format
 * change, a truncated capture -- and every "agreement" computed from a partial
 * reading is agreement about the part that was read. That failure is silent in
 * every direction except this one, so it is checked before anything else uses
 * the result.
 */
export function parseShellRun(stdout: string): ShellRun {
  const lines: ShellLine[] = []
  let summary: ShellSummary | undefined
  const raw = stdout.split('\n')

  for (const [index, text] of raw.entries()) {
    const prefix = [...VERDICT_PREFIX.keys()].find(p => text.startsWith(p))
    if (prefix !== undefined) {
      lines.push({
        verdict: VERDICT_PREFIX.get(prefix) as Verdict,
        message: text.slice(prefix.length),
        line: index + 1,
      })
      continue
    }
    if (!text.startsWith('RESULT: ')) continue
    const m = /^RESULT: (PASS|FAIL) \((\d+)\/(\d+) checks(?:, (\d+) skipped)?/.exec(text)
    if (m === null) {
      throw new ParityInputError(
        `the verifier's summary line is not a shape this parser knows:\n    ${text}\n`
        + `  Every count below is checked against it; an unparsed summary means the check cannot run.`,
      )
    }
    summary = {
      result: m[1] as 'PASS' | 'FAIL',
      passed: Number(m[2]),
      total: Number(m[3]),
      skipped: Number(m[4] ?? 0),
    }
  }

  if (summary === undefined) {
    throw new ParityInputError(
      `the verifier printed no "RESULT:" line. It prints one on every path that reaches the end, `
      + `so its absence means the run DIED mid-check -- and the conclusions it did print are a `
      + `prefix of a run, not a run. The verification contract records that exact signature from a `
      + `SIGPIPE under \`set -o pipefail\`.`,
    )
  }

  const counted = {
    pass: lines.filter(l => l.verdict === 'pass').length,
    fail: lines.filter(l => l.verdict === 'fail').length,
    skip: lines.filter(l => l.verdict === 'skip').length,
  }
  const disagreements: string[] = []
  if (counted.pass !== summary.passed) {
    disagreements.push(`${counted.pass} PASS lines, summary says ${summary.passed}`)
  }
  if (counted.pass + counted.fail !== summary.total) {
    disagreements.push(`${counted.pass + counted.fail} PASS+FAIL lines, summary says ${summary.total}`)
  }
  if (counted.skip !== summary.skipped) {
    disagreements.push(`${counted.skip} SKIP lines, summary says ${summary.skipped}`)
  }
  if (disagreements.length > 0) {
    throw new ParityInputError(
      `this parser and the verifier disagree about what the verifier printed:\n`
      + disagreements.map(d => `    ${d}`).join('\n')
      + `\n  The verifier counts its own conclusions; a parser that reads a different number has `
      + `\n  missed some, and every comparison built on a partial reading is a comparison of the part.`,
    )
  }
  if (lines.length === 0) {
    throw new ParityInputError(
      `the verifier printed a RESULT line and no conclusions at all. A comparison against nothing `
      + `agrees with everything -- which is how M3a's first oracle run reported agreement "on all 0 `
      + `keys" about two empty dumps.`,
    )
  }

  return { lines, summary }
}

// the register: how a ported check names the shell conclusion it replaces

export interface ShellMatcher {
  /**
   * A substring of the check's PASS line.
   *
   * Optional since M4d, and only for the one case that needs it: a check whose
   * shell counterpart has no PASS line on any board it applies to. The oracle
   * has whole families that print N conclusions on the board with the hardware
   * and ONE `skip` on the board without -- the radio firmware set, the hwinit
   * confs, the status-indicator overlay -- and a shell line can have exactly one
   * owner, so that skip needs a register entry of its own. Such an entry has a
   * `skip` matcher and genuinely nothing else.
   *
   * It is NOT a way to omit a matcher. `assertRegisterWellFormed` refuses a
   * check that registers no matcher at all, because that check would claim no
   * line on any board, report `unfired`, and be indistinguishable from one whose
   * matcher had stopped matching. And an EMPTY pass matcher is still refused,
   * for the original reason: the empty substring is contained in every line, so
   * it would claim the run's first conclusion.
   */
  readonly pass?: Matcher
  /**
   * Of its FAIL line, when the two directions share no substring.
   *
   * A LIST is allowed here, and it is what `fail` is usually given since M4d.
   * The oracle's PASS branches say one thing; its FAIL branches FORK -- an
   * ordering assertion fails differently when the unit is absent, when the
   * ordering is not there, and when it names a unit the image does not ship,
   * and those three sentences share no substring that is not also in some other
   * check's line. One loose matcher covering all three is how a check comes to
   * claim a neighbour's conclusion; three exact ones cannot.
   *
   * Each element is still a plain substring and the claim is still "exactly one
   * registered check matches this line" -- a list widens what ONE check will
   * answer for, never what two of them may share.
   */
  readonly fail?: Matcher
  /**
   * Of its SKIP line.
   *
   * Deliberately NOT defaulted to `pass`. A check that quietly turned into a
   * skip would then match its own pass matcher and be compared as though it had
   * run -- and "the shell verifier skips a lot, per board" is measured: 3 skips
   * on cx3576 and 22 on x64. An unregistered SKIP shows up as an unclaimed
   * conclusion with SKIP written next to it, which is a question, not a green.
   */
  readonly skip?: Matcher
}

/** One substring of the conclusion, or several alternative spellings of it. */
export type Matcher = string | readonly string[]

/** The alternatives a matcher offers, as a list. Never empty for a live matcher. */
export function matcherAlternatives(matcher: Matcher | undefined): readonly string[] {
  if (matcher === undefined) return []
  return typeof matcher === 'string' ? [matcher] : matcher
}

/** What the diff needs of a ported check. `CheckCase` in checks.ts satisfies it. */
export interface RegisteredCheck {
  readonly id: string
  /** Board names this check applies to. Undefined means every board. */
  readonly boards?: readonly string[]
  /**
   * The product features this check needs, every one of them: a product
   * that did not select one of them ships nothing for this check to look at,
   * and the check is not run over it (checks.ts checksFor). Undefined means
   * every product.
   */
  readonly features?: readonly string[]
  /** `one` -- the default -- means matching two shell lines is a register fault. */
  readonly cardinality?: 'one' | 'many'
  /**
   * For `many`: one capture group naming the instance, e.g. /^p(\d+) PARTLABEL/.
   *
   * The oracle runs whole families of checks in loops -- eleven `p<n> PARTLABEL
   * is ...` conclusions from one call site. Comparing those as a COUNT would be
   * a delta, and R4 measured one defect as 465, 467, 562 and 925 differing bytes
   * from nothing but the clock. So each firing carries an identity and the diff
   * is over the set of (id, instance) pairs.
   */
  readonly instance?: RegExp
  readonly shell: ShellMatcher
}

/** One conclusion from the TypeScript side. */
export interface CheckResult {
  readonly id: string
  /** Required exactly when the check's cardinality is `many`. */
  readonly instance?: string
  readonly verdict: Verdict
  readonly message: string
}

export type Outcome =
  /** Both sides concluded, and concluded the same thing. */
  | 'agree'
  /** Both sides concluded, and they differ. Includes pass-vs-skip. */
  | 'diverge'
  /** The shell concluded; no registered check claims that line. */
  | 'not-ported'
  /** A registered check claims the line; the TS side produced no result for it. */
  | 'ts-silent'
  /** The TS side concluded; no shell line matched its register entry. */
  | 'orphan'
  /** Registered, applies to this board, and NEITHER side said anything. */
  | 'unfired'
  /** The register cannot tell two checks apart, or one check from two lines. */
  | 'ambiguous'

export interface ParityRow {
  readonly outcome: Outcome
  readonly id: string
  readonly instance?: string
  readonly shell?: Verdict
  readonly ts?: Verdict
  /** The shell line number, when there is one. */
  readonly line?: number
  readonly detail: string
}

export interface ParityReport {
  readonly board: string
  readonly image: string
  readonly rows: readonly ParityRow[]
  readonly counts: Readonly<Record<Outcome, number>>
  readonly shellSummary: ShellSummary
  readonly registered: number
  readonly conclusion: 'PASS' | 'INCOMPLETE' | 'FAIL'
}

const NOT_PORTED = '(unclaimed)'

function matcherFor(check: RegisteredCheck, verdict: Verdict): readonly string[] {
  if (verdict === 'pass') return matcherAlternatives(check.shell.pass)
  if (verdict === 'fail') return matcherAlternatives(check.shell.fail ?? check.shell.pass)
  return matcherAlternatives(check.shell.skip)
}

function appliesTo(check: RegisteredCheck, board: string): boolean {
  return check.boards === undefined || check.boards.includes(board)
}

function instanceOf(check: RegisteredCheck, message: string): string | undefined {
  if (check.cardinality !== 'many') return undefined
  if (check.instance === undefined) return undefined
  return check.instance.exec(message)?.[1]
}

function keyOf(id: string, instance: string | undefined): string {
  return instance === undefined ? id : `${id}[${instance}]`
}

/**
 * Diff one shell run against one set of TypeScript results, per check.
 *
 * Order is not compared. The shell verifier's order is an artefact of where its
 * code sits in a 4,637-line file, and M5/M6 will move code; an order comparison
 * would go red for a reason that is not about the image. What IS compared is
 * the SET of (check, instance) identities and the verdict at each -- identity,
 * never a delta.
 */
export function diffParity(input: {
  board: string
  image: string
  shell: ShellRun
  checks: readonly RegisteredCheck[]
  results: readonly CheckResult[]
}): ParityReport {
  const { board, image, shell, checks, results } = input

  const seenIds = new Set<string>()
  for (const c of checks) {
    if (seenIds.has(c.id)) {
      throw new ParityInputError(
        `two checks are registered as '${c.id}'. An id is the whole identity here; two of them `
        + `would silently compare one check's verdict against the other's.`,
      )
    }
    seenIds.add(c.id)
    if (c.cardinality === 'many' && c.instance === undefined) {
      throw new ParityInputError(
        `check '${c.id}' is registered with cardinality 'many' and no \`instance\` pattern. Without `
        + `one, its firings could only be compared by COUNT, and a count cannot say WHICH firing `
        + `went missing.`,
      )
    }
  }

  const rows: ParityRow[] = []
  const applicable = checks.filter(c => appliesTo(c, board))

  // claim each shell line
  const shellByKey = new Map<string, { verdict: Verdict, line: number, message: string }>()
  const firedIds = new Set<string>()

  for (const l of shell.lines) {
    const claimants = applicable.filter(c =>
      matcherFor(c, l.verdict).some(needle => l.message.includes(needle)))

    if (claimants.length === 0) {
      rows.push({
        outcome: 'not-ported',
        id: NOT_PORTED,
        shell: l.verdict,
        line: l.line,
        detail: l.message,
      })
      continue
    }
    if (claimants.length > 1) {
      rows.push({
        outcome: 'ambiguous',
        id: claimants.map(c => c.id).join(' + '),
        shell: l.verdict,
        line: l.line,
        detail: `${claimants.length} registered checks claim this one line, so neither side's verdict `
          + `can be attributed: ${l.message}`,
      })
      continue
    }

    const check = claimants[0] as RegisteredCheck
    firedIds.add(check.id)
    const instance = instanceOf(check, l.message)
    if (check.cardinality === 'many' && instance === undefined) {
      rows.push({
        outcome: 'ambiguous',
        id: check.id,
        shell: l.verdict,
        line: l.line,
        detail: `'${check.id}' fires many times and its \`instance\` pattern matched nothing in this `
          + `line, so this firing has no identity: ${l.message}`,
      })
      continue
    }
    const key = keyOf(check.id, instance)
    const already = shellByKey.get(key)
    if (already !== undefined) {
      rows.push({
        outcome: 'ambiguous',
        id: check.id,
        ...(instance === undefined ? {} : { instance }),
        shell: l.verdict,
        line: l.line,
        detail: `'${key}' matched a second shell line (${already.line} and ${l.line}). One check `
          + `cannot own two conclusions: either the matcher is too loose, or the check fires per `
          + `instance and is registered as if it fired once.`,
      })
      continue
    }
    shellByKey.set(key, { verdict: l.verdict, line: l.line, message: l.message })
  }

  // pair the TypeScript results against them
  const tsByKey = new Map<string, CheckResult>()
  for (const r of results) {
    const check = checks.find(c => c.id === r.id)
    if (check === undefined) {
      rows.push({
        outcome: 'orphan',
        id: r.id,
        ...(r.instance === undefined ? {} : { instance: r.instance }),
        ts: r.verdict,
        detail: `the TypeScript side produced a result for '${r.id}', which is not a registered `
          + `check. Nothing names the shell conclusion it is supposed to equal, so it cannot be `
          + `compared to anything.`,
      })
      continue
    }
    if (check.cardinality === 'many' && r.instance === undefined) {
      rows.push({
        outcome: 'ambiguous',
        id: r.id,
        ts: r.verdict,
        detail: `'${r.id}' fires many times and this TypeScript result carries no instance, so it `
          + `cannot be matched to one of the shell's firings.`,
      })
      continue
    }
    const key = keyOf(r.id, r.instance)
    if (tsByKey.has(key)) {
      rows.push({
        outcome: 'ambiguous',
        id: r.id,
        ...(r.instance === undefined ? {} : { instance: r.instance }),
        ts: r.verdict,
        detail: `the TypeScript side produced two results for '${key}'.`,
      })
      continue
    }
    tsByKey.set(key, r)
  }

  for (const [key, s] of shellByKey) {
    const [id, instance] = splitKey(key)
    const t = tsByKey.get(key)
    if (t === undefined) {
      rows.push({
        outcome: 'ts-silent',
        id,
        ...(instance === undefined ? {} : { instance }),
        shell: s.verdict,
        line: s.line,
        detail: `'${key}' is a registered check and the shell concluded ${s.verdict.toUpperCase()}, `
          + `but the TypeScript side produced no result for it. A check that did not run reports `
          + `the same absence of failure as one that passed.`,
      })
      continue
    }
    rows.push({
      outcome: s.verdict === t.verdict ? 'agree' : 'diverge',
      id,
      ...(instance === undefined ? {} : { instance }),
      shell: s.verdict,
      ts: t.verdict,
      line: s.line,
      detail: s.verdict === t.verdict
        ? `both ${s.verdict.toUpperCase()}`
        : `shell ${s.verdict.toUpperCase()} / TypeScript ${t.verdict.toUpperCase()}\n`
          + `      shell: ${s.message}\n`
          + `      ts   : ${t.message}`,
    })
  }

  for (const [key, t] of tsByKey) {
    if (shellByKey.has(key)) continue
    const [id, instance] = splitKey(key)
    rows.push({
      outcome: 'orphan',
      id,
      ...(instance === undefined ? {} : { instance }),
      ts: t.verdict,
      detail: `the TypeScript side concluded ${t.verdict.toUpperCase()} for '${key}' and NO shell `
        + `line matched its register entry. Either the shell check did not run on this board, or `
        + `the substring registered for it does not appear in what the shell actually prints -- and `
        + `an unmatched register entry is how a ported check comes to be compared against nothing.`,
    })
  }

  // registered, applicable, and silent on both sides
  for (const c of applicable) {
    if (firedIds.has(c.id)) continue
    if ([...tsByKey.keys()].some(k => splitKey(k)[0] === c.id)) continue
    rows.push({
      outcome: 'unfired',
      id: c.id,
      detail: `'${c.id}' is registered for ${board} and NEITHER side said anything about it. `
        + `A check that runs nowhere is indistinguishable from a check that passes everywhere.`,
    })
  }

  const counts: Record<Outcome, number> = {
    agree: 0, diverge: 0, 'not-ported': 0, 'ts-silent': 0, orphan: 0, unfired: 0, ambiguous: 0,
  }
  for (const r of rows) counts[r.outcome] += 1

  const broken = counts.diverge + counts['ts-silent'] + counts.orphan + counts.unfired + counts.ambiguous
  const conclusion: ParityReport['conclusion']
    = broken > 0 ? 'FAIL' : counts['not-ported'] > 0 ? 'INCOMPLETE' : counts.agree > 0 ? 'PASS' : 'FAIL'

  return {
    board,
    image,
    rows,
    counts,
    shellSummary: shell.summary,
    registered: applicable.length,
    conclusion,
  }
}

function splitKey(key: string): [string, string | undefined] {
  const m = /^(.*)\[(.*)\]$/.exec(key)
  if (m === null || m[1] === undefined) return [key, undefined]
  return [m[1], m[2]]
}

const ORDER: readonly Outcome[] = [
  'ambiguous', 'diverge', 'ts-silent', 'orphan', 'unfired', 'not-ported', 'agree',
]

/**
 * The human report.
 *
 * The headline names the unported conclusions FIRST and in words, because "0
 * divergences" about a comparison that compared nothing is the most misleading
 * true sentence this harness could print.
 */
export function formatReport(report: ParityReport, options?: { showAgreed?: boolean, maxNotPorted?: number }): string {
  const out: string[] = []
  const show = options?.showAgreed ?? false
  const cap = options?.maxNotPorted ?? 12

  out.push(`── parity: ${report.board} ── ${report.image}`)
  out.push(`   shell verifier: RESULT ${report.shellSummary.result}`
    + ` (${report.shellSummary.passed}/${report.shellSummary.total} checks,`
    + ` ${report.shellSummary.skipped} skipped)`)
  out.push(`   TypeScript register: ${report.registered} check${report.registered === 1 ? '' : 's'} for this board`)
  out.push('')

  for (const outcome of ORDER) {
    const rows = report.rows.filter(r => r.outcome === outcome)
    if (rows.length === 0) continue
    if (outcome === 'agree' && !show) {
      out.push(`   agree       ${rows.length}`)
      continue
    }
    if (outcome === 'not-ported') {
      out.push(`   not-ported  ${rows.length}  (shell conclusions no TypeScript check claims yet)`)
      const byVerdict = (v: Verdict): number => rows.filter(r => r.shell === v).length
      out.push(`               of which PASS ${byVerdict('pass')}, FAIL ${byVerdict('fail')}, SKIP ${byVerdict('skip')}`)
      for (const r of rows.slice(0, cap)) {
        out.push(`      [${(r.shell ?? '?').toUpperCase().padEnd(4)}] line ${String(r.line).padStart(4)}  ${r.detail}`)
      }
      if (rows.length > cap) out.push(`      ... and ${rows.length - cap} more (--all to list them)`)
      continue
    }
    out.push(`   ${outcome.padEnd(11)} ${rows.length}`)
    for (const r of rows) {
      const name = r.instance === undefined ? r.id : `${r.id}[${r.instance}]`
      out.push(`      ${name}: ${r.detail}`)
    }
  }

  out.push('')
  out.push(conclusionLine(report))
  return out.join('\n')
}

function conclusionLine(report: ParityReport): string {
  const c = report.counts
  const head = `PARITY ${report.board}: ${report.conclusion}`
  if (report.conclusion === 'PASS') {
    return `${head} — ${c.agree} checks compared, every one agreeing, and nothing left unclaimed`
  }
  if (report.conclusion === 'INCOMPLETE') {
    return `${head} — ${c['not-ported']} of ${c['not-ported'] + c.agree} shell conclusions have NO `
      + `TypeScript counterpart. ${c.agree} compared. This is NOT agreement: the port is unfinished, `
      + `and an unclaimed conclusion has been compared to nothing.`
  }
  const parts: string[] = []
  if (c.ambiguous > 0) parts.push(`${c.ambiguous} ambiguous`)
  if (c.diverge > 0) parts.push(`${c.diverge} diverging`)
  if (c['ts-silent'] > 0) parts.push(`${c['ts-silent']} claimed but unanswered by the port`)
  if (c.orphan > 0) parts.push(`${c.orphan} orphaned`)
  if (c.unfired > 0) parts.push(`${c.unfired} registered and never fired`)
  if (parts.length === 0) parts.push('nothing was compared at all')
  return `${head} — ${parts.join(', ')}; ${c.agree} agreeing, ${c['not-ported']} unclaimed`
}
