// Authenticode signing is repeatable: stages/boot/kernel.sh signs the systemd-boot loader twice with a throwaway key
// to the same bytes, and the signature validates against its certificate and not against another (make
// os-boot-test; after make os-boot-tools). The throwaway RSA keys are made where openssl is, the build-env base
// image; signing and verification run in the boot-tools image. The port of tests/gates/boot-signing-test.sh
// (deleted 2026-09-25), check for check.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolve as fromRef } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'
import { dockerBin } from '../../src/shared/docker.ts'
import { hostPath } from '../../src/shared/host-path.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const IMAGE = 'ai-agent/mica-boot-tools-amd64'
mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.boot-signing-test.'))
const docker = (...args: string[]) => Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', ...args], { stdout: 'pipe', stderr: 'pipe' })
afterAll(() => {
  docker('-v', `${hostPath(WORK)}:/w`, '--entrypoint', 'rm', IMAGE, '-rf', '/w/one', '/w/two', '/w/other')
  rmSync(WORK, { recursive: true, force: true })
})

const sign = (keys: string, out: string) => docker('--platform', 'linux/amd64', '-v', `${hostPath(join(WORK, keys, 'key.pem'))}:/signing/key.pem:ro`,
  '-v', `${hostPath(join(WORK, keys, 'cert.pem'))}:/signing/cert.pem:ro`, '-v', `${hostPath(join(WORK, out))}:/output`, '--entrypoint', 'bash', IMAGE, '/tools/kernel.sh', 'firmware', 'x64')
const verify = (keys: string) => docker('--platform', 'linux/amd64', '-v', `${hostPath(WORK)}:/w:ro`, '--entrypoint', 'sbverify', IMAGE, '--cert', `/w/${keys}/cert.pem`, '/w/one/BOOTX64.EFI').exitCode
const loader = (dir: string) => readFileSync(join(WORK, dir, 'BOOTX64.EFI'))

test('the boot-tools image is built, and two throwaway keys are made', () => {
  expect(Bun.spawnSync([dockerBin(), 'image', 'inspect', IMAGE], { stdout: 'ignore', stderr: 'ignore' }).exitCode, `${IMAGE} is not built; run make os-boot-tools`).toBe(0)
  for (const d of ['keys', 'other-keys', 'one', 'two', 'other']) mkdirSync(join(WORK, d))
  const r = docker('-v', `${hostPath(WORK)}:/w`, fromRef('mica-build-env:base', inputs()), 'bash', '-c', `
    set -euo pipefail
    for d in keys other-keys; do
        openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj "/CN=signing-test-$d" -keyout "/w/$d/key.pem" -out "/w/$d/cert.pem" >/dev/null 2>&1
    done
    chmod 0644 /w/*/key.pem`)
  expect(r.exitCode, r.stderr.toString()).toBe(0)
}, 600000)

test('the loader signed twice, two seconds apart, is byte-identical', async () => {
  expect(sign('keys', 'one').exitCode).toBe(0)
  await Bun.sleep(2000)
  expect(sign('keys', 'two').exitCode).toBe(0)
  expect(loader('one').equals(loader('two'))).toBe(true)
}, 600000)

test('the signature validates against its certificate and is refused against another', () => {
  expect(verify('keys')).toBe(0)
  expect(verify('other-keys')).not.toBe(0)
}, 600000)

test('another key signs to other bytes, so the comparison above can fail', () => {
  expect(sign('other-keys', 'other').exitCode).toBe(0)
  expect(loader('one').equals(loader('other'))).toBe(false)
}, 600000)
