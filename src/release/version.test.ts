// src/release/version.ts over fixture checkouts: the stamp is <VERSION>+git<commit12>[.dirty]-1, and a VERSION
// file that is missing, empty, two lines or not a Debian upstream version is refused by name.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { version, VersionError } from './version.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const T = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'version-test.'))
afterAll(() => rmSync(T, { recursive: true, force: true }))
// The fixtures sit inside this repository's own checkout; git must not discover it above them.
process.env['GIT_CEILING_DIRECTORIES'] = T

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } as Record<string, string>
function git(tree: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-C', tree, ...args], { stdout: 'pipe', stderr: 'pipe', env: ENV })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return r.stdout.toString().trim()
}

function tree(name: string, declared: string | undefined): string {
  const t = join(T, name)
  mkdirSync(t, { recursive: true })
  if (declared !== undefined) writeFileSync(join(t, 'VERSION'), declared)
  git(t, 'init', '-q')
  git(t, 'add', '-A')
  git(t, 'commit', '-q', '--allow-empty', '-m', 'fixture')
  return t
}

test('a clean checkout is stamped with its short commit; a dirty one says so', () => {
  const t = tree('clean', '0.1.0\n')
  const commit = git(t, 'rev-parse', '--short=12', 'HEAD')
  expect(version(t)).toBe(`0.1.0+git${commit}-1`)
  writeFileSync(join(t, 'extra'), 'x')
  expect(version(t)).toBe(`0.1.0+git${commit}.dirty-1`)
})

test('the refusals name the file', () => {
  expect(() => version(tree('none', undefined))).toThrow(/VERSION does not exist$/)
  expect(() => version(tree('empty', '\n'))).toThrow('must hold exactly one non-empty line')
  expect(() => version(tree('two', '1\n2\n'))).toThrow('must hold exactly one non-empty line')
  expect(() => version(tree('bad', 'v1.0\n'))).toThrow('which is not a Debian upstream version')
  for (const t of ['none', 'empty', 'two', 'bad']) expect(() => version(join(T, t))).toThrow(VersionError)
  const plain = join(T, 'plain'); mkdirSync(plain); writeFileSync(join(plain, 'VERSION'), '1\n')
  expect(() => version(plain)).toThrow('is not a git checkout, so there is no commit to stamp')
})
