// stages/compose/scripts/init-steps.sh: one init's steps at one position, <init>/<position>-*.sh in name order,
// each hashed into the record when one is given; a position with no step does nothing; an init with no directory
// is refused. Run over a scratch copy with fixture steps, then over the shipped directories.
import { afterAll, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRIPTS = join(REPO_ROOT, 'stages/compose/scripts')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, 'tmp', 'init-steps.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const LOG = join(WORK, 'ran')
copyFileSync(join(SCRIPTS, 'init-steps.sh'), join(WORK, 'init-steps.sh'))
mkdirSync(join(WORK, 'alpha'))
for (const name of ['tree-20-second.sh', 'tree-10-first.sh', 'shadow-10-other.sh'])
  writeFileSync(join(WORK, 'alpha', name), `#!/bin/sh\necho ${name} >>"${LOG}"\n`)

const run = (...args: string[]) => Bun.spawnSync(['sh', join(WORK, 'init-steps.sh'), ...args], { stdout: 'pipe', stderr: 'pipe' })

test('runs the position\'s steps in name order, and records each', () => {
  const record = join(WORK, 'record')
  const r = run('alpha', 'tree', record)
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString()).toContain('tree: 2 step(s) of alpha')
  expect(readFileSync(LOG, 'utf8')).toBe('tree-10-first.sh\ntree-20-second.sh\n')
  expect(readFileSync(record, 'utf8').trim().split('\n').map(l => l.split(/\s+/)[1])).toEqual([join(WORK, 'alpha/tree-10-first.sh'), join(WORK, 'alpha/tree-20-second.sh')])
})

test('a position with no step does nothing', () => {
  rmSync(LOG, { force: true })
  const r = run('alpha', 'closed')
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString()).toContain('closed: 0 step(s) of alpha')
  expect(existsSync(LOG)).toBe(false)
})

test('an init with no steps directory is refused', () => {
  const r = run('runit', 'tree')
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain('there are no steps for INIT=runit')
})

test('a failing step stops the run', () => {
  writeFileSync(join(WORK, 'alpha', 'tree-15-fails.sh'), '#!/bin/sh\nexit 3\n')
  expect(run('alpha', 'tree').exitCode).not.toBe(0)
  rmSync(join(WORK, 'alpha', 'tree-15-fails.sh'))
})

test('every shipped step is named <position>-<nn>-<name>.sh at a position the stages run', () => {
  const positions = new Set(['compose', 'closed', 'tree', 'shadow'])
  for (const init of ['systemd', 'openrc']) {
    for (const name of readdirSync(join(SCRIPTS, init)).filter(n => n.endsWith('.sh'))) {
      const m = /^([a-z]+)-[0-9]{2}-[a-z0-9-]+\.sh$/.exec(name)
      expect(m !== null && positions.has(m[1]!), `${init}/${name}`).toBe(true)
    }
    expect(existsSync(join(SCRIPTS, init, 'kept-commands')), `${init}/kept-commands`).toBe(true)
  }
})
