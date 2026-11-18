import { expect, test } from 'bun:test'
import { productWatchdog, watchdogProblem } from './watchdog.ts'

const none = (): string => ''
const from = (values: Record<string, string>) => (key: string): string => values[key] ?? ''

test('nothing named is no board.watchdog at all: core\'s defaults hold', () => {
  expect(productWatchdog('', none, none)).toBeUndefined()
})

test('the identity, the board\'s times and a product\'s confirm over the board\'s', () => {
  expect(productWatchdog('Software Watchdog', none, none)).toEqual({ identity: 'Software Watchdog' })
  expect(productWatchdog('', none, from({ BOARD_WATCHDOG_CONFIRM_S: '600' }))).toEqual({ confirmS: 600 })
  expect(productWatchdog('', none, from({ BOARD_WATCHDOG_HANDOVER_S: '60', BOARD_WATCHDOG_CONFIRM_S: '600' }))).toEqual({ handoverS: 60, confirmS: 600 })
  expect(productWatchdog('', from({ WATCHDOG_CONFIRM_S: '1200' }), from({ BOARD_WATCHDOG_CONFIRM_S: '600' }))).toEqual({ confirmS: 1200 })
  expect(productWatchdog('Software Watchdog', none, from({ BOARD_WATCHDOG_CONFIRM_S: '600' }))).toEqual({ identity: 'Software Watchdog', confirmS: 600 })
})

test('times outside core\'s bounds, or not whole seconds, are refused by name', () => {
  for (const [key, value] of [['BOARD_WATCHDOG_HANDOVER_S', '29'], ['BOARD_WATCHDOG_HANDOVER_S', '601'], ['BOARD_WATCHDOG_CONFIRM_S', '119'],
    ['BOARD_WATCHDOG_CONFIRM_S', '7201'], ['BOARD_WATCHDOG_CONFIRM_S', '600s'], ['BOARD_WATCHDOG_CONFIRM_S', '0600'], ['BOARD_WATCHDOG_CONFIRM_S', '-1']])
    expect(() => productWatchdog('', none, from({ [key!]: value! })), `${key}=${value}`).toThrow(key!)
  expect(() => productWatchdog('', from({ WATCHDOG_CONFIRM_S: '100' }), none)).toThrow('WATCHDOG_CONFIRM_S=100')
  expect(productWatchdog('', none, from({ BOARD_WATCHDOG_HANDOVER_S: '30', BOARD_WATCHDOG_CONFIRM_S: '7200' }))).toEqual({ handoverS: 30, confirmS: 7200 })
  expect(productWatchdog('', none, from({ BOARD_WATCHDOG_HANDOVER_S: '600', BOARD_WATCHDOG_CONFIRM_S: '120' }))).toEqual({ handoverS: 600, confirmS: 120 })
})

test('a policy\'s board.watchdog: core\'s members and bounds, nothing else, never empty', () => {
  expect(watchdogProblem({ identity: 'Software Watchdog', handoverS: 120, confirmS: 900 })).toBeUndefined()
  expect(watchdogProblem({ confirmS: 600 })).toBeUndefined()
  expect(watchdogProblem({})).toContain('empty')
  expect(watchdogProblem({ confirmS: 600, extra: 1 })).toContain('extra')
  expect(watchdogProblem({ handoverS: 29 })).toContain('handoverS')
  expect(watchdogProblem({ confirmS: 7201 })).toContain('confirmS')
  expect(watchdogProblem({ confirmS: 600.5 })).toContain('confirmS')
  expect(watchdogProblem({ confirmS: '600' })).toContain('confirmS')
  expect(watchdogProblem({ identity: '' })).toContain('identity')
  expect(watchdogProblem('Software Watchdog')).toContain('not an object')
})
