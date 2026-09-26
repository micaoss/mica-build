// src/pool/deploy-pool.ts and src/pool/micad-pool.ts over fixtures: mica-runkit and the OpenAPI document out
// of fixture archives with their modes, one archive per pool or a refusal, and the contract fixture's board
// policies against the ones this tree writes -- each refusal by name. The source checkout halves (--check, --source) need
// the network and run under `make os-pool` and `make os-verify-test`.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DeployPoolError, lifecycle, policies } from '../../src/pool/deploy-pool.ts'
import { MicadPoolError, openapi } from '../../src/pool/micad-pool.ts'
import { fixtureDeb } from './release-fixture.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const T = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'deploy-pool-test.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

describe('the lifecycle binary', () => {
  test('mica-runkit is taken out of the one archive of the architecture, executable', async () => {
    const pool = join(T, 'pool-one')
    fixtureDeb(T, join(pool, 'arm64/pool/mica-lifecycle_0.1.0-4_arm64.deb'), 'mica-lifecycle', 'arm64', '0.1.0-4', { 'usr/lib/mica/lifecycle/mica-runkit': '#!/bin/sh\nrunkit\n' })
    expect(await lifecycle('arm64', join(T, 'lc'), pool)).toBe(`deploy-pool: mica-runkit for arm64 in ${join(T, 'lc')} from mica-lifecycle_0.1.0-4_arm64.deb`)
    expect(readFileSync(join(T, 'lc/mica-runkit'), 'utf8')).toBe('#!/bin/sh\nrunkit\n')
    // The mode is the payload entry's (the fixture packs a 0644 file; the real archive a 0755 binary).
    expect(statSync(join(T, 'lc/mica-runkit')).mode & 0o777).toBe(0o644)
  })
  test('no archive, two archives and a bad architecture are refused by name', async () => {
    const pool = join(T, 'pool-two')
    fixtureDeb(T, join(pool, 'amd64/pool/mica-lifecycle_0.1.0-4_amd64.deb'), 'mica-lifecycle', 'amd64', '0.1.0-4')
    fixtureDeb(T, join(pool, 'amd64/pool/mica-lifecycle_0.1.0-5_amd64.deb'), 'mica-lifecycle', 'amd64', '0.1.0-5')
    await expect(lifecycle('amd64', join(T, 'x'), pool)).rejects.toThrow(`expected exactly one mica-lifecycle archive in ${pool}/amd64/pool, found 2`)
    await expect(lifecycle('arm64', join(T, 'x'), pool)).rejects.toThrow('found 0. locks/mica-core.lock pins it')
    await expect(lifecycle('x86', join(T, 'x'), pool)).rejects.toThrow(DeployPoolError)
    await expect(lifecycle('amd64', '', pool)).rejects.toThrow('usage: deploy-pool --lifecycle')
  })
})

describe('the OpenAPI document', () => {
  test('is taken out of the one amd64 mica-apid archive into <pool>/mica-apid/openapi.json', async () => {
    const pool = join(T, 'pool-apid')
    fixtureDeb(T, join(pool, 'amd64/pool/mica-apid_0.1.0-3_amd64.deb'), 'mica-apid', 'amd64', '0.1.0-3', { 'usr/share/mica-apid/openapi.json': '{"openapi":"3.1.0"}\n' })
    // The summary names the tree-relative path, as the shell did.
    expect(await openapi(pool)).toBe(`micad-pool: ${pool.slice(REPO_ROOT.length + 1)}/mica-apid/openapi.json from mica-apid_0.1.0-3_amd64.deb`)
    expect(readFileSync(join(pool, 'mica-apid/openapi.json'), 'utf8')).toBe('{"openapi":"3.1.0"}\n')
    await expect(openapi(join(T, 'pool-none'))).rejects.toThrow(MicadPoolError)
    await expect(openapi(join(T, 'pool-none'))).rejects.toThrow('expected exactly one mica-apid archive')
  })
})

describe('the board policies of the contract fixture', () => {
  const cases = (boardPolicies: unknown) => { const p = join(T, `cases-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(boardPolicies === undefined ? {} : { boardPolicies })); return p }
  const UEFI = { boot: 'uefi', kernel: 'uki', partitions: { boot: 1, system: 2, data: 3 }, firmware: { format: 'efi', partition: 1, path: 'EFI/BOOT/BOOTX64.EFI' } }
  const tree = (board: string) => (board === 'uefi-x64' ? { arch: 'amd64' as const, policy: UEFI as never } : undefined)
  test('a board both name carries the fixture\'s policy; a board the fixture does not name is unrestricted', () => {
    expect(policies(cases({ 'uefi-x64': { arch: 'amd64', board: UEFI }, 'rpi4': { arch: 'arm64', board: {} } }), tree))
      .toBe('deploy-pool: the boot policy of uefi-x64 is the one mica-core\'s fixture states; a board it does not name is this tree\'s alone')
  })
  test('each mismatch is named: another policy, another architecture, no policies, none of this tree\'s boards', () => {
    expect(() => policies(cases({ 'uefi-x64': { arch: 'amd64', board: { ...UEFI, partitions: { boot: 1, system: 3, data: 2 } } } }), tree)).toThrow('differs from mica-core\'s fixture for uefi-x64')
    expect(() => policies(cases({ 'uefi-x64': { arch: 'arm64', board: UEFI } }), tree)).toThrow('fixture arm64')
    expect(() => policies(cases(undefined), tree)).toThrow('declares no \'boardPolicies\'')
    expect(() => policies(cases({ rpi4: { arch: 'arm64', board: {} } }), tree)).toThrow('name no board this tree builds')
  })
  test('the committed fixture states the policies this tree writes', () => {
    expect(policies(join(REPO_ROOT, 'tests/fixtures/component-contracts/cases.json'))).toMatch(/^deploy-pool: the boot policy of cx3576, s905x5m, uefi-arm64, uefi-x64 is /)
  })
})
