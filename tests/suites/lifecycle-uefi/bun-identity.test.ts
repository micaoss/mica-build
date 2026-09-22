import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../..')
function git(checkout: string, ...args: string[]) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', checkout, ...args], { encoding: 'utf8', timeout: 10000 })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
function wrapper(checkout: string, code: string, paths: string[]) {
  const result = spawnSync('timeout', ['90', 'bash', join(checkout, 'bin/bun.sh'), '-e', code, ...paths], {
    encoding: 'utf8', timeout: 95000, env: { ...process.env, MICA_BUN_CONTAINER: '1' },
  })
  expect(result.status, result.stdout + result.stderr).toBe(0)
  return result.stdout
}
// Opening existing metadata for writing is enough to test the mount without
// changing any bytes if a regression accidentally leaves it writable.
const readonly = `
  import { openSync, closeSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
  for (const path of Bun.argv.slice(1)) {
    let error;
    try { closeSync(openSync(path, 'r+')); } catch (caught) { error = caught; }
    if (error?.code !== 'EROFS') throw new Error('Expected read-only Git metadata: ' + path + ': ' + error);
  }
  const scratch = mkdtempSync('.identity-write-');
  try { writeFileSync(scratch + '/marker', 'owned fixture'); }
  finally { rmSync(scratch, { recursive: true }); }
`

test('pinned wrapper reads actual linked-worktree identity with read-only metadata', () => {
  const gitDir = git(repo, 'rev-parse', '--absolute-git-dir')
  const commonDir = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const expected = { commit: git(repo, 'rev-parse', 'HEAD'), dirty: git(repo, 'status', '--porcelain').length > 0 }
  const output = wrapper(repo, `
    import { sourceIdentity } from './src/image/release-cli.ts';
    const identity = await sourceIdentity();
    ${readonly}
    console.log('IDENTITY=' + JSON.stringify(identity));
  `, [join(gitDir, 'HEAD'), join(commonDir, 'config'), ...(gitDir === join(repo, '.git') ? [] : [join(repo, '.git')])])
  const line = output.split('\n').find(line => line.startsWith('IDENTITY='))
  expect(line).toBeDefined()
  expect(JSON.parse(line!.slice('IDENTITY='.length))).toEqual(expected)
}, 100000)

test('pinned wrapper protects ordinary checkout metadata and preserves writable checkout', () => {
  mkdirSync(join(repo, '.tmp'), { recursive: true })
  const checkout = mkdtempSync(join(repo, '.tmp/bun-identity-'))
  try {
    for (const path of ['bin/bun.sh', 'bin/Dockerfile', 'package.json', 'src/cli.ts', 'tools/from.sh', 'bin/bun.sh', 'src/cli.ts', 'src/locks/locks.ts', 'locks/mica-build-env.lock', 'locks/pins/mica-build-env.pin']) {
      mkdirSync(dirname(join(checkout, path)), { recursive: true })
      copyFileSync(join(repo, path), join(checkout, path))
    }
    writeFileSync(join(checkout, 'Makefile'), '# Isolated wrapper fixture\n')
    git(checkout, 'init', '--initial-branch=fixture')
    git(checkout, 'add', '.')
    git(checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--no-gpg-sign', '-m', 'Freeze wrapper fixture')
    wrapper(checkout, `${readonly}\nconsole.log('ORDINARY_IDENTITY_MOUNTS_PASS');`, [
      join(checkout, '.git/HEAD'), join(checkout, '.git/config'),
    ])
    expect(git(checkout, 'status', '--porcelain')).toBe('')
  }
  finally { rmSync(checkout, { recursive: true, force: true }) }
}, 100000)
