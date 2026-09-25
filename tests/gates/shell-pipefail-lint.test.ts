// A pipeline whose reader exits early is a lie under `set -o pipefail` (make os-shell-pipefail-lint).
//
// `producer | grep -q PATTERN` looks like "did the producer say PATTERN?". It is not. -q makes grep exit at the
// FIRST match, which closes the pipe; the producer's next write dies of SIGPIPE (status 141); and pipefail defines
// the pipeline's status as that of the rightmost command to exit non-zero. So the pipeline reports FAILURE precisely
// when the pattern was FOUND, and which way it lands depends on whether the producer still had bytes to write: a
// race, not a reliable bug. Its worst instance was a security assertion whose failure direction was green.
//
// The rule is narrow on purpose, so that it has no false positives to teach anyone to ignore. `| grep -q` is
// flagged: it prints nothing, so its status is all a caller can want, and on the right of a pipe under pipefail
// that status is the one thing it gets wrong (`grep -c PATTERN >/dev/null` keeps the status and reads to EOF).
// `| head`, `| grep -m` and a quitting `| sed` are flagged on the same terms, unless the line discards the status
// with `|| true`: they print, and are used for their output, but the pipeline's status is still the producer's
// SIGPIPE (`sed -n '1p'` and `awk 'NR == 1'` print the same line and read to EOF). NOT matched, because no pattern
// tells them apart reliably: an `awk` that calls `exit` outside END, and a `read` on the right of a pipe.
//
// Comment lines are skipped, so prose describing the trap is not an instance of it. The file list is git's, so a
// script added to the tree is covered the day it lands; an unresolved merge is refused rather than counted (git
// lists a conflicted path once per index stage, and a file holding conflict markers is not a script to scan).
//
// THERE IS NO shellcheck IN THIS REPOSITORY, and some files carry `# shellcheck disable=` directives for it. If
// anybody ever wires it up, those suppressions are part of the proposal and not an inheritance: on the day the tool
// is added they take effect against code that may have changed, and the first run comes back greener than the tree
// is. Nor does shellcheck cover this lint's subject.
//
// The port of tests/gates/shell-pipefail-lint.sh (deleted 2026-09-25), rule for rule and message for message, with
// the planted cases it did not have.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const QUIET_GREP = /\|\s*(command\s+)?e?grep(\s+-[A-Za-z]*q[A-Za-z]*)+/
const EARLY_READER = /\|\s*(head(\s|$)|(command\s+)?e?grep\s+-[A-Za-z]*m|sed\s+(-n\s+)?.?[0-9]*q)/

/** The findings of one script's text; empty for a file that does not enable pipefail. */
export function findings(file: string, text: string): string[] {
  if (!text.includes('pipefail')) return []
  const out: string[] = []
  for (const [i, line] of text.split('\n').entries()) {
    if (/^\s*#/.test(line)) continue
    if (QUIET_GREP.test(line))
      out.push(`${file}:${i + 1}: an early-exiting grep on the right of a pipe, in a file that sets pipefail: the pipeline reports failure when the pattern IS found. Use 'grep -c ... >/dev/null'`)
    if (EARLY_READER.test(line) && !line.includes('|| true'))
      out.push(`${file}:${i + 1}: an early-exiting reader on the right of a pipe, in a file that sets pipefail: the producer dies of SIGPIPE and the pipeline reports failure. Use "sed -n '1p'" or "awk 'NR == 1'", or discard the status with '|| true'`)
  }
  return out
}

const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: REPO_ROOT, stdout: 'pipe' }).stdout.toString().split('\n').filter(l => l !== '')

test('the tree has no unresolved merge, so the count below is one entry per script', () => {
  expect(git('diff', '--name-only', '--diff-filter=U')).toEqual([])
})

test('no script that sets pipefail pipes into an early-exiting reader', () => {
  const files = [...new Set(git('ls-files', '*.sh', 'hack/*'))].sort().filter(f => existsSync(join(REPO_ROOT, f)))
  expect(files.length, 'no shell scripts found; this lint would pass by finding nothing').toBeGreaterThan(0)
  const scanned = files.filter(f => readFileSync(join(REPO_ROOT, f), 'utf8').includes('pipefail'))
  expect(scanned.length, 'no file enabled pipefail; the scan matched nothing and would report clean').toBeGreaterThan(0)
  expect(scanned.flatMap(f => findings(f, readFileSync(join(REPO_ROOT, f), 'utf8')))).toEqual([])
})

test('each shape it refuses is refused, and what it leaves alone is left alone', () => {
  const f = (body: string) => findings('planted.sh', `set -euo pipefail\n${body}\n`).length
  expect(f('producer | grep -q PATTERN')).toBe(1)
  expect(f('producer | command grep -Eq PATTERN')).toBe(1)
  expect(f('x="$(producer | head -1)"')).toBe(1)
  expect(f('producer | grep -m1 PATTERN')).toBe(1)
  expect(f('producer | sed 1q')).toBe(1)
  expect(f('hit="$(console | grep -m1 APID_LISTENING || true)"')).toBe(0)
  expect(f('producer | grep -c PATTERN >/dev/null')).toBe(0)
  expect(f('producer | sed -n \'1p\'')).toBe(0)
  expect(f('# producer | grep -q PATTERN is the trap')).toBe(0)
  expect(findings('no-pipefail.sh', 'producer | grep -q PATTERN\n')).toEqual([])
})
