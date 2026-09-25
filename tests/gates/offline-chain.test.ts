// src/offline/chain.ts over a fixture workspace: three small checkouts whose `make offline` only records when it
// ran and writes a pool listing. It proves the clones, the order, the refusals and the summary without building
// anything (make os-offline-chain-test; git and make, no docker, no network). The port of
// tests/gates/offline-chain-test.sh (deleted 2026-09-25), check for check.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp', 'offline-chain-test.'))
const WS = join(SCRATCH, 'workspace'), LOG = join(SCRATCH, 'events.log')
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

function sh(argv: string[], cwd = REPO_ROOT, env: Record<string, string | undefined> = {}): { code: number, out: string } {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, OFFLINE_CHAIN_TEST_LOG: LOG, ...env })) if (v !== undefined) e[k] = v
  const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: e })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}
const git = (...args: string[]) => sh(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args]).out.trim()

function checkout(repository: string, failing: boolean): void {
  const dir = join(WS, repository)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Makefile'), failing
    ? 'offline:\n\t@echo "start $(notdir $(CURDIR))" >>"$$OFFLINE_CHAIN_TEST_LOG"\n\t@echo "the fixture build fails" >&2; exit 1\n'
    : 'offline:\n\t@echo "start $(notdir $(CURDIR)) verity=$$VERITY_TRUST_CERT" >>"$$OFFLINE_CHAIN_TEST_LOG"\n\t@sleep 1\n\t@mkdir -p _out/debs/amd64\n\t@printf "%s  pool/fixture.deb\\n" "$$(printf %064d 0)" >_out/debs/amd64/SHA256SUMS\n\t@echo "end $(notdir $(CURDIR))" >>"$$OFFLINE_CHAIN_TEST_LOG"\n')
  writeFileSync(join(dir, '.gitignore'), '_out/\nmeta/\n')
  git('init', '--quiet', dir)
  git('-C', dir, 'add', '.')
  git('-C', dir, 'commit', '--quiet', '-m', 'fixture')
}

function workspace(failing = ''): void {
  rmSync(WS, { recursive: true, force: true }); rmSync(LOG, { force: true })
  for (const r of ['mica-core', 'mica-podman', 'mica-build']) checkout(r, r === failing)
  for (const [d, body] of [['verity', 'verity\n'], ['boot', 'boot\n']]) {
    mkdirSync(join(WS, 'mica-build/meta', d!), { recursive: true })
    writeFileSync(join(WS, 'mica-build/meta', d!, 'signer.cert.pem'), body!)
  }
}

const chain = (args: string[], env: Record<string, string | undefined> = {}) => sh([process.execPath, 'src/cli.ts', 'offline-chain', ...args], REPO_ROOT, env)
const runOf = (out: string) => /^offline-chain: run (.*)$/m.exec(out)?.[1] ?? ''

/** The checkouts' own state: every ref, the object and config files of .git, the working tree. */
function fingerprint(): string {
  const parts: string[] = []
  const walk = (d: string, base: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f)
    return statSync(p).isDirectory() ? walk(p, base) : f === 'index' ? [] : [`${p.slice(base.length + 1)} ${statSync(p).size}`]
  })
  for (const r of ['mica-core', 'mica-podman', 'mica-build'])
    parts.push(git('-C', join(WS, r), 'for-each-ref'), git('-C', join(WS, r), 'status', '--porcelain', '--untracked-files=all'), walk(join(WS, r, '.git'), join(WS, r, '.git')).sort().join('\n'))

  return parts.join('\n')
}

beforeEach(() => { delete process.env.GITHUB_ACTIONS })

test('a dry run clones every checkout at its HEAD sharing its objects, runs no build and writes nothing into the checkouts', () => {
  workspace()
  writeFileSync(join(WS, 'mica-core/Makefile.local'), 'uncommitted\n')
  const before = fingerprint()
  const r = chain(['--workspace', WS, '--dry-run'], { GITHUB_ACTIONS: undefined })
  expect(r.code).toBe(0)
  const run = runOf(r.out)
  for (const repo of ['mica-core', 'mica-podman', 'mica-build']) {
    expect(git('-C', join(run, repo), 'rev-parse', 'HEAD')).toBe(git('-C', join(WS, repo), 'rev-parse', 'HEAD'))
    expect(existsSync(join(run, repo, '.git/objects/info/alternates'))).toBe(true)
  }
  expect(existsSync(join(run, 'mica-core/Makefile.local'))).toBe(false)
  expect(existsSync(LOG)).toBe(false)
  expect(r.out).toContain('plan: make product PRODUCT=uefi-x64-dev')
  expect(fingerprint()).toBe(before)
})

test('the producers run in parallel with the signing certificates, and the summary names every commit and pool', () => {
  workspace()
  const r = chain(['--workspace', WS, '--producers-only', '--products', 'uefi-x64-dev cx3576-dev'], { GITHUB_ACTIONS: undefined })
  expect(r.code).toBe(0)
  const run = runOf(r.out)
  const events = readFileSync(LOG, 'utf8').split('\n')
  const lastStart = events.map((l, i) => (l.startsWith('start') ? i : -1)).filter(i => i >= 0).at(-1)!
  const firstEnd = events.findIndex(l => l.startsWith('end'))
  expect(events.filter(l => l.startsWith('start')).length).toBe(2)
  expect(lastStart).toBeLessThan(firstEnd)
  expect(events).toContain(`start mica-core verity=${WS}/mica-build/meta/verity/signer.cert.pem`)
  expect(events.some(l => l.startsWith('start mica-build'))).toBe(false)
  const summary = readFileSync(join(run, 'summary.txt'), 'utf8')
  for (const repo of ['mica-core', 'mica-podman', 'mica-build']) expect(summary).toContain(`commit\t${repo}\t${git('-C', join(WS, repo), 'rev-parse', 'HEAD')}`)
  expect(summary.split('\n').filter(l => l.startsWith('pool\t')).length).toBe(2)
  const sums = new Bun.CryptoHasher('sha256').update(readFileSync(join(run, 'mica-core/_out/debs/amd64/SHA256SUMS'))).digest('hex')
  expect(summary).toContain(`SHA256SUMS ${sums}`)
  expect(summary.split('\n').filter(l => l.startsWith('duration\t')).length).toBe(2)
})

test('every refusal names its reason', () => {
  const refuses = (fragment: string, r: { code: number, out: string }) => {
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(fragment)
  }
  workspace('mica-podman')
  refuses('make offline failed in: mica-podman', chain(['--workspace', WS, '--producers-only'], { GITHUB_ACTIONS: undefined }))
  workspace()
  refuses('never run in CI', chain(['--workspace', WS, '--dry-run'], { GITHUB_ACTIONS: 'true' }))
  rmSync(join(WS, 'mica-podman'), { recursive: true })
  refuses(`${WS}/mica-podman is not a git checkout`, chain(['--workspace', WS, '--dry-run'], { GITHUB_ACTIONS: undefined }))
  workspace()
  rmSync(join(WS, 'mica-build/meta/boot/signer.cert.pem'))
  refuses('boot/signer.cert.pem does not exist', chain(['--workspace', WS, '--dry-run'], { GITHUB_ACTIONS: undefined }))
  refuses('--workspace must name', chain(['--dry-run'], { GITHUB_ACTIONS: undefined }))
  refuses('--products names no product', chain(['--workspace', WS, '--dry-run', '--products', ' '], { GITHUB_ACTIONS: undefined }))
})

test('a failing local pin stops the chain before any commit', () => {
  // The fixture mica-build has no src/cli.ts local-pins: the first failing pin stops the chain.
  workspace()
  const r = chain(['--workspace', WS], { GITHUB_ACTIONS: undefined })
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('pinning the offline builds failed')
  const runs = readdirSync(join(WS, '.mica-offline')).sort()
  expect(git('-C', join(WS, '.mica-offline', runs.at(-1)!, 'mica-build'), 'branch', '--list', 'offline/*')).toBe('')
})
