// driver-key init: a CA and a signing leaf it issued, made offline; a module signed with the leaf carries the
// leaf's certificate, so it verifies against the CA alone -- the certificate a device admin enrols.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as fromRef } from '../locks/inputs.ts'
import { inputs } from '../locks/inputs.ts'
import { REPO_ROOT } from '../pool/producers.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'
import { MODULE_SIGNATURE_MAGIC, moduleSignature, signModules } from '../image/module-signing.ts'
import { init } from './driver-key.ts'

mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.driver-key-test.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))
const openssl = (...args: string[]) => Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(WORK)}:/w:ro`,
  '--entrypoint', 'openssl', fromRef('mica-build-env:base', inputs()), ...args], { stdout: 'pipe', stderr: 'pipe' })

test('init makes a CA to enrol and a leaf it issued, the keys private', () => {
  const dir = init(join(WORK, 'owner'), 'Test owner')
  for (const f of ['owner-ca.key.pem', 'signer.key.pem']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
  expect(openssl('verify', '-CAfile', '/w/owner/owner-ca.cert.pem', '/w/owner/signer.cert.pem').exitCode).toBe(0)
  const ca = openssl('x509', '-in', '/w/owner/owner-ca.cert.pem', '-noout', '-text').stdout.toString()
  expect(ca).toContain('CA:TRUE, pathlen:0')
  expect(ca).toContain('Certificate Sign')
  expect(ca).toContain('Public-Key: (3072 bit)')
  const leaf = openssl('x509', '-in', '/w/owner/signer.cert.pem', '-noout', '-text').stdout.toString()
  expect(leaf).toContain('CA:FALSE')
  expect(leaf).toContain('Code Signing')
  expect(() => init(join(WORK, 'owner'))).toThrow('exists')
}, 600000)

test('a module signed with the leaf verifies against the enrolled CA alone', () => {
  mkdirSync(join(WORK, 'mods'))
  writeFileSync(join(WORK, 'mods/a.ko'), 'module a')
  expect(signModules(join(WORK, 'mods'), { key: join(WORK, 'owner/signer.key.pem'), certificate: join(WORK, 'owner/signer.cert.pem') }, {})).toBe(1)
  const signed = readFileSync(join(WORK, 'mods/a.ko'))
  const signature = moduleSignature(signed)!
  writeFileSync(join(WORK, 'sig.p7s'), signature)
  writeFileSync(join(WORK, 'content'), signed.subarray(0, signed.length - signature.length - 12 - MODULE_SIGNATURE_MAGIC.length))
  const verify = (ca: string) => openssl('cms', '-verify', '-binary', '-inform', 'DER', '-in', '/w/sig.p7s', '-content', '/w/content', '-CAfile', ca, '-purpose', 'any', '-out', '/dev/null')
  expect(verify('/w/owner/owner-ca.cert.pem').exitCode).toBe(0)
  init(join(WORK, 'other'), 'Other owner')
  expect(verify('/w/other/owner-ca.cert.pem').exitCode).not.toBe(0)
}, 600000)

test('the CLI runs init, and refuses a bad call', () => {
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'driver-key', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const r = cli('init', '--out', join(WORK, 'by-cli'))
  expect(r.exitCode).toBe(0)
  expect(statSync(join(WORK, 'by-cli/owner-ca.cert.pem')).size).toBeGreaterThan(0)
  expect(cli('init').exitCode).toBe(1)
}, 600000)
