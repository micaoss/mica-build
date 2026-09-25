// The boot-tools image's own parts, run inside it (make os-boot-test; docker, after make os-boot-tools): the startup
// initramfs of one mica-runkit, packed twice to the same bytes, and the payload compression's determinism and
// refusals. The two checks are container shell (tests/suites/boot-tools/guest/); this starts them with the checkout
// at /src, the lifecycle runkit at /input and a scratch /output. The port of tests/gates/boot-tools-test.sh
// (deleted 2026-09-25).
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dockerBin } from '../../src/shared/docker.ts'
import { hostPath } from '../../src/shared/host-path.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const IMAGE = 'ai-agent/mica-boot-tools-amd64'
mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.boot-tools-test.'))
afterAll(() => {
  // The container wrote /output as root; it removes what it wrote.
  Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(WORK)}:/w`, '--entrypoint', 'rm', IMAGE, '-rf', '/w/output'])
  rmSync(WORK, { recursive: true, force: true })
})

test('the boot-tools image is built', () => {
  expect(Bun.spawnSync([dockerBin(), 'image', 'inspect', IMAGE], { stdout: 'ignore', stderr: 'ignore' }).exitCode, `${IMAGE} is not built; run make os-boot-tools`).toBe(0)
  mkdirSync(join(WORK, 'input')); mkdirSync(join(WORK, 'output'))
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'deploy-pool', '--lifecycle', 'amd64', join(WORK, 'input')], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  writeFileSync(join(WORK, 'input/boot.json'), '{}\n')
})

const run = (...args: string[]) => Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(REPO_ROOT)}:/src:ro`,
  '-v', `${hostPath(join(WORK, 'input'))}:/input:ro`, '-v', `${hostPath(join(WORK, 'output'))}:/output`, '--entrypoint', 'bash', IMAGE, ...args], { stdout: 'pipe', stderr: 'pipe' })

test('the startup initramfs is one static init and one exitrd link, packed twice to the same bytes', () => {
  const r = run('/src/tests/suites/boot-tools/guest/initramfs-check.sh', '/src')
  expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0)
  expect(r.stdout.toString()).toContain('STARTUP_SINGLE_STATIC_MANIFEST_PASS')
}, 600000)

test('the payload compression is deterministic and refuses what it must', () => {
  const r = run('/src/tests/suites/boot-tools/guest/compression-check.sh')
  expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0)
  expect(r.stdout.toString()).toContain('BOOT_COMPRESSION_PASS')
}, 600000)
