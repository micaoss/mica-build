import { expect, test } from 'bun:test'
import { acceptanceWatchdog } from './acceptance-watchdog.ts'

test('the product\'s own policy, with MICA_TEST_CONFIRM_S over its confirmS, refused out of core\'s range', () => {
  expect(acceptanceWatchdog('uefi-x64.full', {})).toEqual({ confirmS: 600 })
  expect(acceptanceWatchdog('uefi-x64.gcp', { MICA_TEST_CONFIRM_S: '120' })).toEqual({ identity: 'Software Watchdog', confirmS: 120 })
  expect(acceptanceWatchdog('cx3576.full', { MICA_TEST_CONFIRM_S: '120' })).toEqual({ confirmS: 120 })
  expect(() => acceptanceWatchdog('uefi-x64.full', { MICA_TEST_CONFIRM_S: '60' })).toThrow('MICA_TEST_CONFIRM_S=60')
})
