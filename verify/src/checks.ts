import type { Board } from './board.ts'
import type { ProductFacts } from './product-conf.ts'
import type { ToolRuntime } from './tools.ts'
import { ToolOutputError } from './tools.ts'
import { matcherAlternatives, type RegisteredCheck, type CheckResult, type Verdict } from './parity.ts'
import { BUSYBOX_CHECKS } from './checks-busybox.ts'
import { FIREWALL_CHECKS } from './checks-firewall.ts'
import { HWDB_CHECKS } from './checks-hwdb.ts'
import { CONND_CHECKS } from './checks-connd.ts'
import { DBUS_CHECKS } from './checks-dbus.ts'
import { ENGINE_CHECKS_ALL } from './checks-engine.ts'
import { MQTT_CHECKS } from './checks-mqtt.ts'
import { SHADOW_CHECKS } from './checks-shadow.ts'
import { TIME_CHECKS } from './checks-time.ts'
import { ROOT_CHECKS } from './checks-file-root.ts'
export type { CheckResult, Verdict }
export interface ImageContext {
 readonly board: Board
 /** The product the root was composed for (product-conf.ts); its features scope the register. */
 readonly product: ProductFacts
 readonly image: string
 readonly tools: ToolRuntime
 readonly workDir: string
 readonly outDir: string
 unpackRoot: () => Promise<string>
}
export interface CheckCase extends RegisteredCheck { readonly run: (ctx: ImageContext) => Promise<readonly CheckResult[]> }
export const CHECKS: readonly CheckCase[] = [...ROOT_CHECKS, ...BUSYBOX_CHECKS, ...FIREWALL_CHECKS, ...HWDB_CHECKS, ...CONND_CHECKS, ...DBUS_CHECKS, ...ENGINE_CHECKS_ALL, ...MQTT_CHECKS, ...SHADOW_CHECKS, ...TIME_CHECKS]
export function assertRegisterWellFormed(checks: readonly CheckCase[] = CHECKS): void {
  const seen = new Set<string>()
  for (const c of checks) {
    if (c.id.trim() === '') {
      throw new ToolOutputError('a check is registered with an empty id; the id IS its identity.')
    }
    if (seen.has(c.id)) {
      throw new ToolOutputError(`two checks are registered as '${c.id}'.`)
    }
    seen.add(c.id)
    const alternatives = [c.shell.pass, c.shell.fail, c.shell.skip].flatMap(m => matcherAlternatives(m))
    if (alternatives.some(m => m.trim() === '')) {
      throw new ToolOutputError(
        `check '${c.id}' registers an EMPTY matcher. An empty substring is contained in every line, `
        + `so it would claim the FIRST shell conclusion of the run and compare this check's verdict `
        + `against something unrelated.`,
      )
    }
    // The other half of making `pass` optional (M4d): a check that registers NO
    // matcher at all claims no line on any board, comes out `unfired`, and reads
    // exactly like a check whose matcher stopped matching. `pass` may be omitted
    // only by an entry that owns a SKIP instead -- never by one that owns nothing.
    // An empty list is the same fault wearing a different shape, which is why
    // this counts alternatives rather than asking whether the fields are set.
    if (alternatives.length === 0) {
      throw new ToolOutputError(
        `check '${c.id}' registers no matcher at all -- no pass, no fail, no skip. It could never `
        + `claim a shell conclusion, so it would report 'unfired' on every board, which is the same `
        + `row a check whose matcher went stale produces.`,
      )
    }
    if (c.cardinality === 'many' && c.instance === undefined) {
      throw new ToolOutputError(
        `check '${c.id}' fires many times and registers no \`instance\` pattern, so its firings `
        + `could only be compared by count.`,
      )
    }
    if (c.features !== undefined && c.features.length === 0) {
      throw new ToolOutputError(
        `check '${c.id}' declares \`features: []\`, so it needs no feature and the field says nothing; `
        + `omit it to mean every product.`,
      )
    }
    if (c.boards !== undefined && c.boards.length === 0) {
      throw new ToolOutputError(
        `check '${c.id}' declares \`boards: []\`, so it applies to no board and can never run. `
        + `Omit the field to mean every board; an empty list is the shape a filtered-down list `
        + `takes when the filter was wrong.`,
      )
    }
  }
}

/** The checks that apply to a board, which is what the diff is scoped to. */
export function checksFor(board: string, checks: readonly CheckCase[] = CHECKS): CheckCase[] {
  return checks.filter(c => c.boards === undefined || c.boards.includes(board))
}

/** A check's features the product did not select; empty when the check applies. */
export function featuresMissing(check: RegisteredCheck, product: ProductFacts): string[] {
  return (check.features ?? []).filter(f => !product.features.has(f))
}

export interface CheckFailure {
  readonly id: string
  readonly error: Error
}

export interface CheckRun {
  readonly results: readonly CheckResult[]
  /** Checks that threw. Never folded into a `fail`; see CheckCase.run. */
  readonly failures: readonly CheckFailure[]
  /** Checks not run because the product did not select a feature they need. */
  readonly notRun: readonly { id: string, features: readonly string[] }[]
}

/**
 * Run the register against one image.
 *
 * Sequential, not concurrent. Several checks extract multi-hundred-megabyte
 * partitions through one container, and the cache below only helps if the
 * second asker waits for the first rather than starting its own extract.
 */
export async function runChecks(ctx: ImageContext, checks: readonly CheckCase[] = CHECKS): Promise<CheckRun> {
  const results: CheckResult[] = []
  const failures: CheckFailure[] = []
  const notRun: { id: string, features: readonly string[] }[] = []
  for (const check of checksFor(ctx.board.name, checks)) {
    const missing = featuresMissing(check, ctx.product)
    if (missing.length > 0) { notRun.push({ id: check.id, features: missing }); continue }
    try {
      const got = await check.run(ctx)
      for (const r of got) {
        if (r.id !== check.id) {
          throw new ToolOutputError(
            `check '${check.id}' produced a result labelled '${r.id}'. The id is the identity the `
            + `parity diff pairs on; a mislabelled result would be compared against another check's `
            + `shell conclusion.`,
          )
        }
        results.push(r)
      }
      if (got.length === 0) {
        throw new ToolOutputError(
          `check '${check.id}' ran and concluded nothing. A check that returns no result is `
          + `invisible in a pass/fail count and reports the same absence of failure as one that `
          + `passed -- so it is an error here, not a quiet zero.`,
        )
      }
    }
    catch (error) {
      failures.push({ id: check.id, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return { results, failures, notRun }
}
