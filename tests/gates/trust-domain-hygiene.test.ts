// The development trust domains, generated for real: three separate keys (boot, verity content, update metadata),
// public inputs that match them, private permissions, and a generator and an initializer that never overwrite.
// The refusals that come before any container are src/boot/keys.test.ts's; this drives the generation and the
// validation themselves (make os-boot-test; docker). The port of tests/gates/trust-domain-hygiene-test.sh (deleted
// 2026-09-25), step for step; the key checks run in the pinned base image with its OpenSSL, as before.
import { afterAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { resolve as fromRef } from '../../src/locks/from.ts'
import { inputs } from '../../src/locks/locks.ts'
import { dockerBin } from '../../src/shared/docker.ts'
import { hostPath } from '../../src/shared/host-path.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true })
const work = mkdtempSync(join(REPO_ROOT, '.tmp/trust-hygiene.'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const cli = (...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, 'src/cli.ts'), ...args], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

/** sha256 of every file under a directory, by relative path: what a refusal must leave untouched. */
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${new Bun.CryptoHasher('sha256').update(readFileSync(p)).digest('hex')}  ${relative(dir, p)}`)
    }
  }
  walk(dir)
  return out.join('\n')
}

test('no private key is tracked, and every place one is written is ignored', () => {
  const tracked = Bun.spawnSync(['git', 'ls-files', '*.pk8', '*.key.pem', '*.p12'], { cwd: REPO_ROOT, stdout: 'pipe' }).stdout.toString().trim()
  expect(tracked).toBe('')
  for (const f of ['meta/boot/signer.key.pem', 'meta/verity/signer.key.pem', 'meta/updates/signer.key.pem', '.tmp/signing/updates/signer.key.pem'])
    expect(Bun.spawnSync(['git', 'check-ignore', '-q', f], { cwd: REPO_ROOT }).exitCode).toBe(0)
})

test('the generator mints three separate domains whose public inputs match, with private permissions, and never overwrites', () => {
  const keys = join(work, 'keys')
  expect(cli('dev-keys', '--out', keys).code).toBe(0)
  // Names and public halves only leave the container: no private bytes enter the output.
  const image = fromRef('mica-build-env:base', inputs())
  const r = Bun.spawnSync([dockerBin(), 'run', '--rm', '--label', 'ai-agent=true', '--network', 'none', '-v', `${hostPath(keys)}:/keys:ro`, '--entrypoint', '/bin/bash', image, '-ceu', `
    set -o pipefail
    for domain in boot verity updates; do
        test "$(stat -c %a /keys/$domain/signer.key.pem)" = 600
        test "$(stat -c %a /keys/$domain)" = 700
        openssl pkey -in /keys/$domain/signer.key.pem -pubout -outform DER > /tmp/$domain.pub
    done
    ! cmp -s /tmp/boot.pub /tmp/verity.pub
    ! cmp -s /tmp/boot.pub /tmp/updates.pub
    ! cmp -s /tmp/verity.pub /tmp/updates.pub
    for domain in boot verity; do
        openssl x509 -in /keys/$domain/signer.cert.pem -pubkey -noout |
            openssl pkey -pubin -outform DER > /tmp/$domain.cert.pub
        cmp /tmp/$domain.pub /tmp/$domain.cert.pub
    done
    tail -c 32 /tmp/updates.pub | base64 -w0 > /tmp/metadata.base64
    cmp /tmp/metadata.base64 /keys/updates/public.key
    grep -qx DEVELOPMENT-GRADE /keys/GENERATED
  `], { stdout: 'pipe', stderr: 'pipe' })
  expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0)

  const marker = readFileSync(join(keys, 'GENERATED'))
  const again = cli('dev-keys', '--out', keys)
  expect(again.code).not.toBe(0)
  expect(again.out).toContain('key output already exists')
  expect(readFileSync(join(keys, 'GENERATED')).equals(marker)).toBe(true)
  symlinkSync('keys', join(work, 'alias'))
  expect(cli('dev-keys', '--out', join(work, 'alias')).code).not.toBe(0)
}, 600000)

test('the initializer is idempotent, safe under two at once, and changes nothing it refuses', async () => {
  const initialized = join(work, 'initialized')
  expect(cli('init-keys', '--out', initialized).code).toBe(0)
  const before = snapshot(initialized)
  expect(cli('init-keys', '--out', initialized).code).toBe(0)
  expect(snapshot(initialized)).toBe(before)

  mkdirSync(join(work, 'empty'))
  const two = [0, 1].map(() => Bun.spawn([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'init-keys', '--out', join(work, 'empty')], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' }))
  expect(await Promise.all(two.map(p => p.exited))).toEqual([0, 0])
  expect(cli('init-keys', '--out', join(work, 'empty')).code).toBe(0)

  for (const fault of ['incomplete', 'mismatch', 'symlink', 'permissions']) {
    const dir = join(work, fault)
    cpSync(initialized, dir, { recursive: true, verbatimSymlinks: true })
    if (fault === 'incomplete') renameSync(join(dir, 'verity/signer.cert.pem'), join(work, 'missing-cert'))
    if (fault === 'mismatch') cpSync(join(work, 'keys/boot/signer.cert.pem'), join(dir, 'boot/signer.cert.pem'))
    if (fault === 'symlink') { renameSync(join(dir, 'boot'), join(work, 'linked-boot')); symlinkSync('../linked-boot', join(dir, 'boot')) }
    if (fault === 'permissions') chmodSync(join(dir, 'boot/signer.key.pem'), 0o644)
    const was = snapshot(dir)
    expect(cli('init-keys', '--out', dir).code, `the initializer accepted ${fault}`).not.toBe(0)
    expect(snapshot(dir)).toBe(was)
  }
  expect(existsSync(join(work, 'alias'))).toBe(true)
  expect(cli('init-keys', '--out', join(work, 'alias')).code).not.toBe(0)
}, 600000)
