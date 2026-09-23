// src/pool/deploy-pool.ts and src/pool/micad-pool.ts over fixtures: mica-runkit and the OpenAPI document out
// of fixture archives with their modes, one archive per pool or a refusal, and the contract fixture's board
// vocabulary against a boards.tsv -- each refusal by name. The source checkout halves (--check, --source) need
// the network and run under `make os-pool` and `make os-verify-test`.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DeployPoolError, lifecycle, vocabulary } from '../../src/pool/deploy-pool.ts'
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

describe('the board vocabulary of the contract fixture', () => {
  const cases = (boards: unknown) => { const p = join(T, `cases-${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(boards === undefined ? {} : { boards })); return p }
  const tsv = (rows: string) => { const p = join(T, `boards-${Math.random().toString(36).slice(2)}.tsv`); writeFileSync(p, rows); return p }
  const PINNED = '# board\tarch\tboot\ncx3576\tarm64\tuboot-fit\nuefi-x64\tamd64\tsystemd-boot\n'
  test('the accepted set at the declared architectures is the tree\'s; the refused names are not', () => {
    const c = cases([{ name: 'cx3576', arch: 'arm64', result: 'accepted' }, { name: 'uefi-x64', arch: 'amd64', result: 'accepted' }, { name: 'rpi4', arch: 'arm64', result: 'refused' }])
    expect(vocabulary(c, tsv(PINNED))).toBe('deploy-pool: the fixture\'s board vocabulary is this tree\'s: cx3576, uefi-x64 accepted at their declared architectures, rpi4 refused')
  })
  test('each mismatch is named: built and not accepted, accepted and not built, another architecture, a refused board this tree builds', () => {
    expect(() => vocabulary(cases([{ name: 'cx3576', arch: 'arm64', result: 'accepted' }]), tsv(PINNED))).toThrow('Built and not accepted: uefi-x64.')
    expect(() => vocabulary(cases([{ name: 'cx3576', arch: 'arm64', result: 'accepted' }, { name: 'uefi-x64', arch: 'amd64', result: 'accepted' }, { name: 'old', arch: 'arm64', result: 'accepted' }]), tsv(PINNED))).toThrow('Accepted and not built: old.')
    expect(() => vocabulary(cases([{ name: 'cx3576', arch: 'amd64', result: 'accepted' }, { name: 'uefi-x64', arch: 'amd64', result: 'accepted' }]), tsv(PINNED))).toThrow('Architecture: cx3576 is amd64 in the fixture and arm64 in boards/boards.tsv.')
    expect(() => vocabulary(cases([{ name: 'cx3576', arch: 'arm64', result: 'accepted' }, { name: 'uefi-x64', arch: 'amd64', result: 'accepted' }, { name: 'uefi-x64', arch: 'amd64', result: 'refused' }]), tsv(PINNED))).toThrow('lists uefi-x64 as REFUSED while boards/boards.tsv lists it')
    expect(() => vocabulary(cases(undefined), tsv(PINNED))).toThrow('declares no \'boards\' vocabulary')
    expect(() => vocabulary(cases([{ name: 'cx3576', arch: 'arm64', result: 'accepted' }]), tsv('# empty\n'))).toThrow('lists no board')
  })
  test('the committed fixture names the boards this tree builds', () => {
    expect(vocabulary(join(REPO_ROOT, 'tests/fixtures/component-contracts/cases.json'), join(REPO_ROOT, 'boards/boards.tsv'))).toMatch(/^deploy-pool: the fixture's board vocabulary is this tree's: /)
  })
})
