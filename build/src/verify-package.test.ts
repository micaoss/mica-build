// The cross-package boundary, asserted rather than described.
//
// verify-package.ts explains at length why build imports verify's board
// model instead of copying it. A comment saying "there is one parser" is worth
// nothing on the day someone adds a second, so the three things that make the
// claim true are checked here:
//
//   1. what build imports IS verify's module, not a same-named twin;
//   2. exactly one file in this package names the other package;
//   3. no file in this package DEFINES any part of the parser or the model.
//
// The third is the one written for M6b through M6e. The tempting shortcut when
// an assembler needs one more field is to read board.env "just here" -- and a
// second reader of that format is the defect this campaign has spent its length
// removing.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { boardEnvPath, PACKAGE_DIR, SRC_DIR, VERIFY_PACKAGE_DIR } from './paths.ts'
import { parseBoardEnv } from './verify-package.ts'

/**
 * Every .ts file in this package's src/, recursively.
 *
 * `skipSelf` drops THIS file, and only for the two tests that search source
 * text for patterns. It has to quote `../../verify/` and a `function
 * parseBoardEnv` to search for them at all, so a sweep that included itself
 * would report itself -- and the fix for that must not be to loosen the
 * pattern, because the pattern is the check. Every other file in the package,
 * tests included, stays in scope.
 */
function sourceFiles(skipSelf = false): { path: string, text: string }[] {
  const out: { path: string, text: string }[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (!e.name.endsWith('.ts')) continue
      else if (skipSelf && p === import.meta.path) continue
      else out.push({ path: p, text: readFileSync(p, 'utf8') })
    }
  }
  walk(SRC_DIR)
  return out
}

describe('build imports the model rather than owning a copy', () => {
  test('the sweep itself is not vacuous', () => {
    // Every assertion below is a filter over this list. A walk that found
    // nothing would satisfy all of them by having nothing to object to, which
    // is the shape of green this package exists to make visible.
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(5)
    expect(files.map(f => relative(SRC_DIR, f.path))).toContain('verify-package.ts')
  })

  test('the imported parser is the shared board-env module', async () => {
    const direct = await import(join(VERIFY_PACKAGE_DIR, 'src', 'board-env.ts'))
    expect(direct.parseBoardEnv).toBe(parseBoardEnv)
  })

  test('exactly one file in this package names the other package', () => {
    const naming = sourceFiles(true)
      .filter(f => f.text.includes('../../verify/'))
      .map(f => relative(SRC_DIR, f.path))
      .sort()
    expect(naming).toEqual(['verify-package.ts'])
  })

  test('no file in this package defines a second parser or a second model', () => {
    // By DEFINITION, not by mention: verify-package.ts and this file both name
    // parseBoardEnv, and neither implements one.
    const forbidden = [
      /(?:export\s+)?function\s+parseBoardEnv\b/,
      /(?:export\s+)?function\s+modelBoard\b/,
      /(?:export\s+)?function\s+evaluateArithmetic\b/,
      /(?:export\s+)?const\s+KNOWN_ROLES\s*=/,
    ]
    const offenders: string[] = []
    const scanned = sourceFiles(true)
    expect(scanned.length).toBeGreaterThan(4)
    for (const f of scanned) {
      for (const re of forbidden) {
        if (re.test(f.text)) offenders.push(`${relative(SRC_DIR, f.path)} matches ${re}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('the guard above is reachable: it does catch a definition', () => {
    // A pattern that matches nothing on any real input is a pattern nobody has
    // checked. M3a and M3b each shipped a guard that was unreachable and only
    // mutation found it, so the pattern is run against text that must match.
    const secondCopy = 'export function parseBoardEnv(text: string, path: string) { return null }'
    expect(/(?:export\s+)?function\s+parseBoardEnv\b/.test(secondCopy)).toBe(true)
    // ...and does not fire on a mere mention, which is what the files above do.
    expect(/(?:export\s+)?function\s+parseBoardEnv\b/.test('// parseBoardEnv is imported')).toBe(false)
  })

  test('the shared parser reads the current board definition', () => {
    const env = parseBoardEnv(readFileSync(boardEnvPath('x64'), 'utf8'), 'board.env').values
    expect(env.get('LAYOUT_VERSION')).toBe('3')
    expect(env.get('LAYOUT_PARTITIONS')).toBe('ESP SYSTEM DATA')
    expect(env.get('BOOT_BACKEND')).toBe('systemd-boot')
  })

  test('this package installs its own dependencies and does not reach into the other one', () => {
    // A relative source import is the whole coupling. If build ever grew a
    // `file:../verify` dependency or a workspace, node_modules would carry a
    // link and the boundary would stop being one file.
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toBeUndefined()
    expect(Object.keys(manifest.devDependencies).sort()).toEqual(['@types/bun', 'typescript'])
    expect(manifest.workspaces).toBeUndefined()
  })
})
