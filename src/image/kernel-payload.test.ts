import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kernelExecutables } from './kernel-package.ts'
import { componentId } from './components.ts'

const owned: string[] = []
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(machine = 62) {
  const root = mkdtempSync(join(tmpdir(), 'mica-b3-kernel-payload-')); owned.push(root)
  const bytes = Buffer.alloc(512); bytes.set([0x7f, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(machine, 18); bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52)
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(512n, 96)
  const runkit = join(root, 'mica-runkit')
  writeFileSync(runkit, bytes, { mode: 0o755 })
  return { root, bytes, runkit }
}

describe('required authenticated native lifecycle input', () => {
  test('both architectures participate in identity with exact executable bytes', () => {
    for (const [arch, machine] of [['amd64', 62], ['arm64', 183]] as const) {
      const input = fixture(machine)
      const first = kernelExecutables(input.runkit, arch)
      expect(Object.keys(first)).toEqual(['runkit'])
      input.bytes[500] = 1; writeFileSync(input.runkit, input.bytes)
      const changed = kernelExecutables(input.runkit, arch)
      expect(changed.runkit).not.toEqual(first.runkit)
      expect(componentId(changed)).not.toBe(componentId(first))
    }
  })
  test('missing, foreign-architecture, non-ELF and unsafe modes are refused', () => {
    const input = fixture()
    for (const path of [undefined, join(input.root, 'absent'), input.root])
      expect(() => kernelExecutables(path as string, 'amd64')).toThrow()

    expect(() => kernelExecutables(input.runkit, 'arm64')).toThrow('architecture')
    const alias = join(input.root, 'alias'); symlinkSync(input.runkit, alias)
    expect(() => kernelExecutables(alias, 'amd64')).toThrow()
    for (const mode of [0o644, 0o777, 0o4755]) {
      chmodSync(input.runkit, mode)
      expect(() => kernelExecutables(input.runkit, 'amd64')).toThrow()
    }
    chmodSync(input.runkit, 0o755); writeFileSync(input.runkit, '#!/bin/sh\nreboot -f\n'.padEnd(128, ' '))
    expect(() => kernelExecutables(input.runkit, 'amd64')).toThrow('ELF')
  })
})

test('the static lifecycle input refuses interpreter, dependencies and malformed segment tables', () => {
  for (const change of ['interpreter', 'needed', 'rpath', 'truncated', 'overflow', 'unterminated', 'no-load', 'no-headers']) {
    const input = fixture()
    input.bytes.writeUInt16LE(2, 56)
    input.bytes.writeUInt32LE(2, 120)
    input.bytes.writeBigUInt64LE(240n, 128)
    input.bytes.writeBigUInt64LE(32n, 152)
    if (change === 'interpreter') input.bytes.writeUInt32LE(3, 120)
    if (change === 'needed') input.bytes.writeBigUInt64LE(1n, 240)
    if (change === 'rpath') input.bytes.writeBigUInt64LE(29n, 240)
    if (change === 'truncated') input.bytes.writeBigUInt64LE(500n, 32)
    if (change === 'overflow') input.bytes.writeBigUInt64LE(0xffffffffffffffffn, 128)
    if (change === 'unterminated') { input.bytes.writeBigUInt64LE(30n, 240); input.bytes.writeBigUInt64LE(30n, 256) }
    if (change === 'no-load') input.bytes.writeUInt32LE(0, 64)
    if (change === 'no-headers') input.bytes.writeUInt16LE(0, 56)
    writeFileSync(input.runkit, input.bytes)
    expect(() => kernelExecutables(input.runkit, 'amd64')).toThrow('static lifecycle')
  }
})
test('static PIE relocation table is accepted for the lifecycle executable', () => {
  const input = fixture()
  input.bytes.writeUInt16LE(2, 56); input.bytes.writeUInt32LE(2, 120)
  input.bytes.writeBigUInt64LE(240n, 128); input.bytes.writeBigUInt64LE(32n, 152)
  input.bytes.writeBigUInt64LE(30n, 240)
  writeFileSync(input.runkit, input.bytes)
  expect(kernelExecutables(input.runkit, 'amd64').runkit).toBeDefined()
  input.bytes.writeUInt32LE(3, 120); writeFileSync(input.runkit, input.bytes)
  expect(() => kernelExecutables(input.runkit, 'amd64')).toThrow('static lifecycle')
})
