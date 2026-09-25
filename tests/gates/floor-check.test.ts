// The NEGATIVE half of common/kernel/floor-check.sh, which the FIT boards run inside their kernel build over a
// resolved .config after olddefconfig (make floor-fixtures-test). Until 2026-09-20 it asserted only the =y lines of
// common/kernel/mica-required.fragment; the `# CONFIG_X is not set` lines were merged into the input and never looked
// at again. Every real board holds the floor, so the refusals are exercised here over synthetic source trees, and a
// refusal that never refuses is not a refusal.
//
// ONE DEFECT PER FIXTURE: a fixture that violates two rules tests neither. The script stays the shell it is (it runs
// in the bsp image, over the kernel tree); this drives it. The port of tests/gates/floor-check-fixtures.sh (deleted
// 2026-09-25), case for case.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const CHECK = join(REPO_ROOT, 'common/kernel/floor-check.sh')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const T = mkdtempSync(join(REPO_ROOT, 'tmp', 'floor-fixtures.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const FLOOR = `CONFIG_SYSTEM_TRUSTED_KEYS="certs/anchor.pem"
CONFIG_LSM="landlock,lockdown,yama,integrity,selinux,bpf"
CONFIG_MEMCG=y
CONFIG_CFS_BANDWIDTH=y
# CONFIG_CGROUP_RDMA is not set
# CONFIG_TASKSTATS is not set
`

/** A complete, passing pair -- a source tree with its resolved .config and anchor, and a fragment stating both
 * halves of a floor -- with one edit to the config or the fragment. */
function fixture(name: string, edit: { config?: (t: string) => string, fragment?: (t: string) => string, noConfig?: boolean } = {}): [string, string] {
  const src = join(T, name, 'src'), frag = join(T, name, 'mica-required.fragment')
  mkdirSync(join(src, 'certs'), { recursive: true })
  writeFileSync(join(src, 'certs/anchor.pem'), '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n')
  if (!edit.noConfig) writeFileSync(join(src, '.config'), (edit.config ?? (t => t))(FLOOR))
  writeFileSync(frag, (edit.fragment ?? (t => t))(FLOOR))
  return [src, frag]
}

const run = ([src, frag]: [string, string]) => Bun.spawnSync(['bash', CHECK, src, frag], { stdout: 'pipe', stderr: 'pipe' }).exitCode

test.each([
  ['a resolved config holding both halves of the floor is accepted', fixture('clean'), 0],
  // The case the negative half was written for.
  ['a symbol the fragment records off, resolved =y, is refused', fixture('off-is-on', { config: t => t.replace('# CONFIG_TASKSTATS is not set', 'CONFIG_TASKSTATS=y') }), 1],
  ['a symbol the fragment records off, resolved =m, is refused', fixture('off-is-module', { config: t => t.replace('# CONFIG_CGROUP_RDMA is not set', 'CONFIG_CGROUP_RDMA=m') }), 1],
  // Off in the stronger sense: kconfig omits a symbol whose dependencies are unmet.
  ['a symbol absent from the resolved config counts as off', fixture('off-is-absent', { config: t => t.replace('# CONFIG_TASKSTATS is not set\n', '') }), 0],
  // The empty-parse guards: a fragment that asserts nothing must say so.
  ['a fragment with no off lines is refused rather than passed', fixture('no-off-lines', { fragment: t => t.split('\n').filter(l => !l.endsWith(' is not set')).join('\n') }), 1],
  ['a fragment with no =y lines is refused rather than passed', fixture('no-on-lines', { fragment: t => t.split('\n').filter(l => !l.endsWith('=y')).join('\n') }), 1],
  ['an =y line of the fragment dropped by olddefconfig is refused', fixture('missing-on', { config: t => t.replace('CONFIG_MEMCG=y\n', '') }), 1],
  ['a source tree with no resolved config is refused', fixture('no-config', { noConfig: true }), 1],
] as const)('%s', (_what, pair, accepted) => {
  expect(run(pair as [string, string]) === 0).toBe(accepted === 0)
})

test('the fixture is the floor it claims: every line of it is in the shipped fragment\'s grammar', () => {
  const shipped = readFileSync(join(REPO_ROOT, 'common/kernel/mica-required.fragment'), 'utf8')
  expect(shipped).toMatch(/^CONFIG_[A-Z0-9_]+=y$/m)
  expect(shipped).toMatch(/^# CONFIG_[A-Z0-9_]+ is not set$/m)
})
