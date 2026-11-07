// Module signing: the appended signature form, the keyring check, and signModules over throwaway keys -- the same
// modules signed twice are byte-identical, the signature verifies against its certificate and not another, and
// a signed module is not signed again. The keys are made where openssl is, the build-env base image.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolve as fromRef } from '../locks/inputs.ts'
import { inputs } from '../locks/inputs.ts'
import { dockerBin } from '../shared/docker.ts'
import { hostPath } from '../shared/host-path.ts'
import { REPO_ROOT } from './paths.ts'
import { appendModuleSignature, signsModules, MODULE_SIGNATURE_MAGIC, moduleSignature, signModules, untrustedSigner } from './module-signing.ts'

mkdirSync(join(REPO_ROOT, '_out'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, '_out/.module-signing-test.'))
const docker = (...args: string[]) => Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', ...args], { stdout: 'pipe', stderr: 'pipe' })
afterAll(() => {
  docker('-v', `${hostPath(WORK)}:/w`, '--entrypoint', 'sh', fromRef('mica-build-env:base', inputs()), '-c', 'rm -rf /w/*')
  rmSync(WORK, { recursive: true, force: true })
})

const PEM = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`

test('the appended form is the module, the signature, the 12-byte info and the magic', () => {
  const signed = appendModuleSignature(Buffer.from('module'), Buffer.from('sig'))
  expect(signed.subarray(0, 9).toString()).toBe('modulesig')
  expect([...signed.subarray(9, 21)]).toEqual([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 3])
  expect(signed.subarray(21).toString()).toBe(MODULE_SIGNATURE_MAGIC)
  expect(moduleSignature(signed)?.toString()).toBe('sig')
  expect(moduleSignature(Buffer.from('module'))).toBeUndefined()
})

test('a kernel\'s modules are signed when it checks signatures, CONFIG_MODULE_SIG=y', () => {
  expect(signsModules('CONFIG_MODULE_SIG=y\n# CONFIG_MODULE_SIG_FORCE is not set\n')).toBe(true)
  expect(signsModules('# CONFIG_MODULE_SIG is not set\n')).toBe(false)
})

test('the signing certificate must be one of the builtin keyring\'s', () => {
  expect(untrustedSigner(PEM('QUJD'), PEM('WFla') + PEM('QU\nJD'))).toBeUndefined()
  expect(untrustedSigner(PEM('QUJD'), PEM('WFla'))).toContain('not in the kernel\'s builtin keyring')
  expect(untrustedSigner('', PEM('WFla'))).toContain('holds no PEM certificate')
})

test('two throwaway keys are made', () => {
  for (const d of ['keys', 'other-keys']) mkdirSync(join(WORK, d))
  const r = docker('-v', `${hostPath(WORK)}:/w`, fromRef('mica-build-env:base', inputs()), 'bash', '-c', `
    set -euo pipefail
    for d in keys other-keys; do
        openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj "/CN=module-signing-test-$d" -keyout "/w/$d/key.pem" -out "/w/$d/cert.pem" >/dev/null 2>&1
    done
    chmod 0644 /w/*/key.pem`)
  expect(r.exitCode, r.stderr.toString()).toBe(0)
}, 600000)

const keys = (d: string) => ({ key: join(WORK, d, 'key.pem'), certificate: join(WORK, d, 'cert.pem') })

test('signModules signs every module, to the same bytes each time, verifiable against its certificate only', () => {
  mkdirSync(join(WORK, 'one/kernel/net'), { recursive: true })
  writeFileSync(join(WORK, 'one/kernel/net/a.ko'), 'module a')
  writeFileSync(join(WORK, 'one/kernel/b.ko'), 'module b')
  writeFileSync(join(WORK, 'one/modules.dep'), 'kernel/b.ko:\n')
  cpSync(join(WORK, 'one'), join(WORK, 'two'), { recursive: true })
  expect(signModules(join(WORK, 'one'), keys('keys'))).toBe(2)
  expect(signModules(join(WORK, 'two'), keys('keys'))).toBe(2)
  for (const m of ['kernel/net/a.ko', 'kernel/b.ko']) {
    const one = readFileSync(join(WORK, 'one', m))
    expect(one.equals(readFileSync(join(WORK, 'two', m)))).toBe(true)
    const signature = moduleSignature(one)!
    expect(signature).toBeDefined()
    writeFileSync(join(WORK, 'sig.p7s'), signature)
    writeFileSync(join(WORK, 'content'), one.subarray(0, one.length - signature.length - 12 - MODULE_SIGNATURE_MAGIC.length))
    const verify = (d: string) => docker('-v', `${hostPath(WORK)}:/w:ro`, fromRef('mica-build-env:base', inputs()), 'openssl', 'cms', '-verify', '-binary', '-inform', 'DER',
      '-in', '/w/sig.p7s', '-content', '/w/content', '-certfile', `/w/${d}/cert.pem`, '-noverify', '-out', '/dev/null').exitCode
    expect(verify('keys')).toBe(0)
    expect(verify('other-keys')).not.toBe(0)
  }
  expect(readFileSync(join(WORK, 'one/modules.dep'), 'utf8')).toBe('kernel/b.ko:\n')
}, 600000)

test('a signed module is refused, and a key that is not the certificate\'s signs nothing', () => {
  expect(() => signModules(join(WORK, 'one'), keys('keys'))).toThrow('already signed')
  mkdirSync(join(WORK, 'three'))
  writeFileSync(join(WORK, 'three/c.ko'), 'module c')
  expect(() => signModules(join(WORK, 'three'), { key: keys('keys').key, certificate: keys('other-keys').certificate })).toThrow('Module signing failed')
  expect(readFileSync(join(WORK, 'three/c.ko'), 'utf8')).toBe('module c')
}, 600000)
