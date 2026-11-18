// The watchdog policy an acceptance kernel carries (build.ts, update.ts): the product's own (src/product/watchdog.ts),
// as its kernel package carries it, with MICA_TEST_CONFIRM_S over its confirmS when set, so the trial deadline suite
// (trial-deadline.sh) fails a held boot in minutes on any product.
import { product } from '../../../src/product/product.ts'
import { type Watchdog, watchdogProblem } from '../../../src/product/watchdog.ts'

export function acceptanceWatchdog(name: string, env: Record<string, string | undefined> = process.env): Watchdog | undefined {
  const own = product(name).watchdogPolicy
  const confirm = env['MICA_TEST_CONFIRM_S']
  if (confirm === undefined || confirm === '') return own
  const w = { ...own, confirmS: Number(confirm) }
  const problem = watchdogProblem(w)
  if (problem !== undefined) throw new Error(`MICA_TEST_CONFIRM_S=${confirm}: ${problem}`)
  return w
}
