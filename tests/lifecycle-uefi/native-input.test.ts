import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { kernelExecutables } from '../../build/src/kernel-package.ts'

const owned: string[] = []
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }) })
const callers = [
  ['build.ts', 'x64', 'factory'], ['build.ts', 'virt-arm64', 'factory'],
  ['update.ts', 'x64', 'kernel'], ['update.ts', 'virt-arm64', 'combined'],
  ['trust-rotation.ts', 'x64', 'rotation'],
] as const

function fixture(script: string, board: string, kind: string) {
  const work = mkdtempSync(join(tmpdir(), 'mica-file-ab-native-')); owned.push(work)
  const baseline = join(work, 'baseline'), kernel = join(work, 'kernel'), root = join(work, 'root')
  for (const path of [baseline, kernel, root]) mkdirSync(path)
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })
  writeFileSync(join(baseline, 'metadata.key.pem'), key, { mode: 0o600 })
  for (const name of ['db.key.pem', 'db.cert.pem']) writeFileSync(join(baseline, name), 'isolated fixture', { mode: 0o600 })
  const arch = board === 'x64' ? 'amd64' : 'arm64'
  writeFileSync(join(kernel, 'kernel.json'), JSON.stringify({ board, arch }))
  writeFileSync(join(root, 'rootfs.json'), '{}')
  const bytes = Buffer.alloc(128)
  bytes.set([0x7f, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(board === 'x64' ? 62 : 183, 18); bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52)
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(128n, 96)
  const runkit = join(work, 'mica-runkit')
  writeFileSync(runkit, bytes, { mode: 0o755 })
  const cert = join(work, 'content.cert'), signingKey = join(work, 'content.key')
  const args = script === 'build.ts' ? [join(work, 'output'), board, kernel, cert, signingKey, runkit, root]
    : script === 'update.ts' ? [baseline, cert, signingKey, '3', kind, root, kernel, runkit]
      : [work, baseline, runkit, cert, signingKey, board]
  return { work, args, runkit, arch: arch as 'amd64' | 'arm64', bytes }
}

for (const [script, board, kind] of callers) {
  for (const scenario of ['valid', 'missing', 'wrong-architecture'] as const) {
    test(`${script} ${board} ${kind}: ${scenario} required native input`, () => {
      const f = fixture(script, board, kind)
      if (scenario === 'missing') f.args.splice(f.args.indexOf(f.runkit), 1)
      if (scenario === 'wrong-architecture') {
        f.bytes.writeUInt16LE(board === 'x64' ? 183 : 62, 18)
        writeFileSync(f.runkit, f.bytes)
      }
      const capture = join(f.work, 'capture.json')
      const child = Bun.spawnSync([process.execPath, '--preload', resolve(import.meta.dir, 'native-input.preload.ts'),
        resolve(import.meta.dir, script), ...f.args], {
        cwd: resolve(import.meta.dir, '../..'), env: { ...process.env, MICA_FILE_AB_INPUT_CAPTURE: capture }, timeout: 10000,
      })
      const stderr = child.stderr.toString()
      expect(child.exitCode).not.toBe(0)
      if (scenario === 'valid') {
        expect(stderr).toContain('NATIVE_INPUT_CAPTURED')
        const result = JSON.parse(readFileSync(capture, 'utf8'))
        expect(result.input.runkit).toBe(f.runkit)
        expect(result.input.init).toBeUndefined()
        expect(result.input.shutdown).toBeUndefined()
        expect(result.executables).toEqual(kernelExecutables(f.runkit, f.arch))
      } else {
        expect(stderr).toContain(scenario === 'missing' ? 'Usage:' : 'Native lifecycle architecture mismatch')
        expect(existsSync(capture)).toBe(false)
      }
    })
  }
}
