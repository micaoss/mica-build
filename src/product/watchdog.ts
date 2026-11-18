// The watchdog's times (mica-core watchdog-20261115): what the signed boot policy's `board.watchdog` carries beside
// the identity a product names (WATCHDOG, src/product/product.ts), and the bounds core holds them to.
//
//   boards/<board>/watchdog.env  BOARD_WATCHDOG_HANDOVER_S, BOARD_WATCHDOG_CONFIRM_S (not board.env, an input of the
//                                board package); either may be absent
//   product.env                  WATCHDOG_CONFIRM_S, the product's own confirm budget over its board's
//   boot.json                    board.watchdog: {identity?, handoverS?, confirmS?}, no other member; an absent one is
//                                core's default (watchdog0, 120 s, 900 s)
//
// handoverS is the timeout the runkit asks the driver for at the handover (clamped to the driver's range); confirmS is
// the uptime a TRIAL boot has to be confirmed in before it is failed and the device reboots.

export const HANDOVER_S = { min: 30, max: 600 } as const
export const CONFIRM_S = { min: 120, max: 7200 } as const
export const MEMBERS = ['identity', 'handoverS', 'confirmS'] as const

export type Watchdog = { identity?: string, handoverS?: number, confirmS?: number }

export class WatchdogError extends Error {}

function seconds(text: string, key: string, range: { min: number, max: number }): number {
  if (!/^[1-9][0-9]{0,4}$/.test(text) || Number(text) < range.min || Number(text) > range.max)
    throw new WatchdogError(`${key}=${text}; it is a whole number of seconds from ${range.min} to ${range.max}`)
  return Number(text)
}

/** The product's watchdog policy from its identity (WATCHDOG, '' when unnamed), its product.env (each getter answers ''
 * for an unnamed key) and its board's watchdog.env: undefined when nothing is named, or a refusal. */
export function productWatchdog(identity: string, get: (key: string) => string, boardFact: (key: string) => string): Watchdog | undefined {
  const handover = boardFact('BOARD_WATCHDOG_HANDOVER_S'), confirm = get('WATCHDOG_CONFIRM_S') || boardFact('BOARD_WATCHDOG_CONFIRM_S')
  const w: Watchdog = {
    ...(identity === '' ? {} : { identity }),
    ...(handover === '' ? {} : { handoverS: seconds(handover, 'BOARD_WATCHDOG_HANDOVER_S', HANDOVER_S) }),
    ...(confirm === '' ? {} : { confirmS: seconds(confirm, get('WATCHDOG_CONFIRM_S') === '' ? 'BOARD_WATCHDOG_CONFIRM_S' : 'WATCHDOG_CONFIRM_S', CONFIRM_S) }),
  }
  return Object.keys(w).length === 0 ? undefined : w
}

/** What is wrong with a policy's `board.watchdog`, or undefined: core's contract (deny_unknown_fields, every member
 * optional, at least one named here since an empty one is left out). */
export function watchdogProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'board.watchdog is not an object'
  const w = value as Record<string, unknown>
  const keys = Object.keys(w)
  if (keys.length === 0) return 'board.watchdog is empty; an empty one is left out'
  const unknown = keys.filter(k => !(MEMBERS as readonly string[]).includes(k))
  if (unknown.length > 0) return `board.watchdog names ${unknown.join(', ')}; its members are ${MEMBERS.join(', ')}`
  if ('identity' in w && (typeof w['identity'] !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(w['identity']))) return 'board.watchdog.identity is not 1 to 32 printable characters'
  for (const [key, range] of [['handoverS', HANDOVER_S], ['confirmS', CONFIRM_S]] as const) {
    if (!(key in w)) continue
    const v = w[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < range.min || v > range.max) return `board.watchdog.${key} is not a whole number from ${range.min} to ${range.max}`
  }
  return undefined
}
