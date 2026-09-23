// src/boot/trust-stage.ts: a public certificate bundle is validated in the pinned OpenSSL image and staged as
// <parent>/<sha256>/{signer.cert.pem,sha256}, the trust context a kernel or U-Boot build takes; anything that
// is not public certificates only is refused and nothing is staged. The port of tests/gates/trust-stage-test.sh
// (deleted 2026-09-23), case for case. The certificates and the one private key (for the refusal) are throwaway
// fixtures made here with the host's openssl in scratch under _out/.
//
//   bash bin/bun.sh src/cli.ts test tests/gates/trust-stage.test.ts     (docker; the mica-build-env base image)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stage, TrustStageError } from '../../src/boot/trust-stage.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const WORK = mkdtempSync(join((mkdirSync(join(REPO_ROOT, '_out'), { recursive: true }), join(REPO_ROOT, '_out')), 'trust-stage-test.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }) as string[] : [])

beforeAll(() => {
  for (const n of ['a', 'b']) {
    const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(WORK, `${n}.key`), '-out', join(WORK, `${n}.pem`), '-days', '1', '-subj', `/CN=trust-stage-test-${n}`], { stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`openssl req failed: ${r.stderr.toString()}`)
  }
  writeFileSync(join(WORK, 'bundle.pem'), readFileSync(join(WORK, 'a.pem'), 'utf8') + readFileSync(join(WORK, 'b.pem'), 'utf8'))
  writeFileSync(join(WORK, 'with-key.pem'), readFileSync(join(WORK, 'a.pem'), 'utf8') + readFileSync(join(WORK, 'a.key'), 'utf8'))
  writeFileSync(join(WORK, 'trailing.pem'), readFileSync(join(WORK, 'a.pem'), 'utf8') + 'trailing text\n')
  writeFileSync(join(WORK, 'garbage.pem'), '-----BEGIN CERTIFICATE-----\nnotacertificate\n-----END CERTIFICATE-----\n')
  writeFileSync(join(WORK, 'empty.pem'), '')
}, 60000)

/** The context is <parent>/<sha256 of input> with exactly the two files. */
function staged(out: string, input: string, parent: string): void {
  const sha = sha256(input)
  expect(out).toBe(join(realpathSync(parent), sha))
  expect(readFileSync(join(out, 'signer.cert.pem'))).toEqual(readFileSync(input))
  expect(readFileSync(join(out, 'sha256'), 'utf8').trim()).toBe(sha)
  expect(listing(out).sort()).toEqual(['sha256', 'signer.cert.pem'])
}

/** Non-zero, the message, and the parent holds nothing. */
function refused(name: string, input: string, want: string): void {
  test(`${name}: refused, nothing staged`, () => {
    const parent = join(WORK, `ctx-${name}`)
    expect(() => stage(input, parent)).toThrow(TrustStageError)
    expect(() => stage(input, parent)).toThrow(want)
    expect(listing(parent)).toEqual([])
  }, 60000)
}

describe('staging', () => {
  test('one certificate is staged as <parent>/<sha256>/{signer.cert.pem,sha256}, and staging it again reuses the context', () => {
    const out = stage(join(WORK, 'a.pem'), join(WORK, 'ctx'))
    staged(out, join(WORK, 'a.pem'), join(WORK, 'ctx'))
    expect(stage(join(WORK, 'a.pem'), join(WORK, 'ctx'))).toBe(out)
    expect(readdirSync(join(WORK, 'ctx'))).toHaveLength(1)
  }, 120000)
  test('a bundle of two certificates is staged', () => {
    const out = stage(join(WORK, 'bundle.pem'), join(WORK, 'ctx-bundle'))
    staged(out, join(WORK, 'bundle.pem'), join(WORK, 'ctx-bundle'))
  }, 60000)
})

describe('the refusals', () => {
  refused('with-key', join(WORK, 'with-key.pem'), 'the certificate bundle was refused')
  refused('trailing', join(WORK, 'trailing.pem'), 'the certificate bundle was refused')
  refused('garbage', join(WORK, 'garbage.pem'), 'the certificate bundle was refused')
  refused('empty', join(WORK, 'empty.pem'), 'explicit input is missing')
  refused('missing', join(WORK, 'nonexistent.pem'), 'explicit input is missing')

  test('a context under the certificate\'s digest that holds other bytes is refused and left as it was', () => {
    const sha = sha256(join(WORK, 'b.pem'))
    const parent = join(WORK, 'ctx-tampered')
    mkdirSync(join(parent, sha), { recursive: true })
    writeFileSync(join(parent, sha, 'signer.cert.pem'), readFileSync(join(WORK, 'a.pem')))
    writeFileSync(join(parent, sha, 'sha256'), `${sha}\n`)
    expect(() => stage(join(WORK, 'b.pem'), parent)).toThrow('existing trust context differs')
    expect(readFileSync(join(parent, sha, 'signer.cert.pem'))).toEqual(readFileSync(join(WORK, 'a.pem')))
    expect(listing(parent).sort()).toEqual([sha, join(sha, 'sha256'), join(sha, 'signer.cert.pem')].sort())
  }, 60000)
})
