import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './paths.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from './testing.ts'

let scratch: string
let image: string
function run(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30000 })
}
function crypto(command: string) {
  return run('docker', ['run', '--rm', '--label', 'ai-agent=true', '--network', 'traefik', '-v', `${scratch}:/w`, '--entrypoint', '/bin/sh', image, '-ec', command])
}
function tool(...args: string[]) {
  return run('bash', [join(REPO_ROOT, 'boot/verity-tool.sh'), ...args])
}

beforeAll(() => {
  mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
  scratch = mkdtempSync(join(REPO_ROOT, '.tmp/p2-verity-'))
  const resolved = run('bash', [join(REPO_ROOT, 'tools/from.sh'), '--ref', 'IMAGE_MICA_BUILD_BASE'])
  expect(resolved.status).toBe(0)
  image = resolved.stdout.trim()
  const created = crypto('umask 077; openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=verity-test -keyout /w/key.pem -out /w/cert.pem >/dev/null 2>&1')
  expect(created.status).toBe(0)
  writeFileSync(join(scratch, 'hash'), 'a'.repeat(64))
}, OPEN_TIMEOUT_MS)

afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) }, TOOL_TIMEOUT_MS)

test('only signing is offered, and a certificate input carrying key material is refused', () => {
  expect(tool('stage', join(scratch, 'cert.pem'), join(scratch, 'trust')).status).not.toBe(0)
  writeFileSync(join(scratch, 'mixed.pem'), readFileSync(join(scratch, 'cert.pem'), 'utf8') + readFileSync(join(scratch, 'key.pem'), 'utf8'), { mode: 0o600 })
  expect(tool('sign', join(scratch, 'hash'), join(scratch, 'key.pem'), join(scratch, 'mixed.pem'), join(scratch, 'mixed.p7s')).status).not.toBe(0)
  expect(tool('sign', join(scratch, 'hash'), join(scratch, 'key.pem'), join(scratch, 'missing.pem'), join(scratch, 'missing.p7s')).status).not.toBe(0)
}, TOOL_TIMEOUT_MS)

test('sign precisely 64 ASCII bytes and verify detached PKCS#7 against the public certificate', () => {
  expect(tool('sign', join(scratch, 'hash'), join(scratch, 'key.pem'), join(scratch, 'cert.pem'), join(scratch, 'root.p7s')).status).toBe(0)
  expect(crypto('openssl cms -verify -binary -inform DER -in /w/root.p7s -content /w/hash -certfile /w/cert.pem -noverify -out /dev/null').status).toBe(0)
  const dump = crypto('openssl cms -cmsout -print -inform DER -in /w/root.p7s')
  expect(dump.status).toBe(0)
  expect(dump.stdout).toMatch(/certificates:\s+<ABSENT>/)
  expect(dump.stdout).toMatch(/signedAttrs:\s+<ABSENT>/)
  expect(tool('sign', join(scratch, 'hash'), join(scratch, 'key.pem'), join(scratch, 'cert.pem'), join(scratch, 'root.p7s')).status).not.toBe(0)
  writeFileSync(join(scratch, 'hash'), 'b'.repeat(64))
  expect(crypto('openssl cms -verify -binary -inform DER -in /w/root.p7s -content /w/hash -certfile /w/cert.pem -noverify -out /dev/null').status).not.toBe(0)
}, TOOL_TIMEOUT_MS)

test('refuse newline, uppercase, short hashes and mismatched signing keys', () => {
  for (const hash of ['a'.repeat(64) + '\n', 'A'.repeat(64), 'a'.repeat(63)]) {
    writeFileSync(join(scratch, 'invalid-hash'), hash)
    expect(tool('sign', join(scratch, 'invalid-hash'), join(scratch, 'key.pem'), join(scratch, 'cert.pem'), join(scratch, 'bad.p7s')).status).not.toBe(0)
  }
  expect(crypto('umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /w/other.pem >/dev/null 2>&1').status).toBe(0)
  expect(tool('sign', join(scratch, 'hash'), join(scratch, 'other.pem'), join(scratch, 'cert.pem'), join(scratch, 'bad.p7s')).status).not.toBe(0)
}, TOOL_TIMEOUT_MS)
