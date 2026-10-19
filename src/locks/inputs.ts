// This tree's locks/, read through mica-build-tools (locks/mica-build-tools.pin; mica-build-tools:docs/design.md
// 3.1): the one implementation of the release lock and its pins. What is here is only the shape this tree's callers
// take -- the checked inputs, the rows of one kind prefixed with their input, and image selectors resolved against
// this tree's locks/ -- and no rule of its own.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs as toolBuildArgs, checkLocks, checkUpstream, modeOf, resolveImage, type Input, type Row } from '@mica/build-tools'

export { Refused, ToolError } from '@mica/build-tools'
export type { Row }

export const REPO_ROOT: string = join(import.meta.dir, '..', '..')
export const LOCKS: string = process.env['MICA_LOCKS_DIR'] || join(REPO_ROOT, 'locks')

/** The checked inputs of a locks/ directory. */
export type Records = Input[]

/** Every input of a locks/ directory, checked; the default is this tree's locks/ (or MICA_LOCKS_DIR). */
export function inputs(locks = LOCKS): Records {
  return checkLocks(locks, modeOf())
}

/** Every row of one kind, each prefixed with its input, in input order; `upstream.lock` names locks/upstream.lock. */
export function rows(kind: string, input?: string, locks = LOCKS, checked?: Records): Row[] {
  if (input === 'upstream.lock') {
    const path = join(locks, 'upstream.lock')
    return (existsSync(path) ? checkUpstream(path) : []).filter(r => r[0] === kind).map(r => ['upstream.lock', ...r.slice(1)])
  }
  const out: Row[] = []
  for (const i of [...(checked ?? inputs(locks))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (input !== undefined && i.name !== input) continue
    for (const row of i.lock.rows) if (row[0] === kind) out.push([i.name, ...row.slice(1)])
  }
  return out
}

/** The one reference an image selector names. */
export function resolve(selector: string, records: Records = inputs(), locks = LOCKS): string {
  return resolveImage(selector, records, locks)
}

/** `--build-arg` lines for ARG=selector pairs, as docker buildx build takes them. */
export function buildArgs(pairs: string[], records: Records = inputs(), locks = LOCKS): string[] {
  return toolBuildArgs(pairs, records, locks)
}
