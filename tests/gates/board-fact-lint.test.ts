// The board-fact lint: a board fact is consumed at one dispatch point per axis, a table keyed by the declared value
// (mica:docs/plan/20260921-1142-merge-boards-into-build.md, P3, the dispatch rule). The board-name lint keeps board
// NAMES out of the engine; this keeps the boot backends and firmware formats out of it as values to branch on:
// a quoted `'uboot-fit'`, `'systemd-boot'`, `'rockchip-loader'` or `'amlogic-boot0'` in the engine is a finding
// outside the registries (src/image/backends/, src/image/firmware-formats.ts) and the two readers of the tables
// (src/image/board-facts.ts reads board.env, src/image/file-layout.ts reads layout.tsv), and so is a
// LAYOUT_PARTITIONS anywhere in the engine or the Makefile. The word inside a sentence, a path or a package name
// (lifecycle-uboot-fit, mica-systemd-boot) is not a quoted value and is not a finding; tests are fixtures, not
// the engine, and are not read.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const VALUES = ['uboot-fit', 'systemd-boot', 'rockchip-loader', 'amlogic-boot0']
const ALLOWED = ['src/image/backends/', 'src/image/firmware-formats.ts', 'src/image/board-facts.ts', 'src/image/file-layout.ts']
const QUOTED = new RegExp(`(['"\`])(${VALUES.join('|')})\\1`)
const MAKE_WORD = new RegExp(`(^|[^-/\\w])(${VALUES.join('|')})([^-/\\w]|$)`)

export type Finding = { file: string, line: number, text: string }

/** The findings in one file's text; `file` is repository-relative. */
export function findings(file: string, text: string): Finding[] {
  const out: Finding[] = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    const code = file === 'Makefile'
      ? (/^\s*(#|@?echo\b)/.test(raw) ? '' : line)
      : line.replace(/\/\/.*$/, '').replace(/^\*.*$|^\/\*.*$/, '')
    if (/\bLAYOUT_PARTITIONS\b/.test(code)) out.push({ file, line: i + 1, text: line })
    else if (file === 'Makefile' ? MAKE_WORD.test(code) : QUOTED.test(code) && !ALLOWED.some(a => file.startsWith(a))) out.push({ file, line: i + 1, text: line })
  }
  return out
}

function engineFiles(): string[] {
  const out: string[] = ['Makefile']
  const walk = (dir: string) => {
    for (const name of readdirSync(join(REPO_ROOT, dir))) {
      const rel = join(dir, name)
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) walk(rel)
      else if (rel.endsWith('.ts') && !rel.endsWith('.test.ts')) out.push(rel)
    }
  }
  walk('src')
  return out
}

test('the engine branches on no boot backend or firmware format outside their registries and the table readers', () => {
  const files = engineFiles()
  expect(files.length).toBeGreaterThan(100)
  const found = files.flatMap(f => findings(f, readFileSync(join(REPO_ROOT, f), 'utf8')))
  expect(found.map(f => `${f.file}:${f.line}: ${f.text}`)).toEqual([])
})

test('the lint goes red on each shape it refuses, and passes what is not a value', () => {
  expect(findings('src/image/planted.ts', 'if (facts.backend === \'uboot-fit\') pack()')).toHaveLength(1)
  expect(findings('src/verify/planted.ts', 'const efi = target.format === "rockchip-loader"')).toHaveLength(1)
  expect(findings('src/image/planted.ts', 'const partitions = env.get(\'LAYOUT_PARTITIONS\')')).toHaveLength(1)
  expect(findings('Makefile', 'ifeq ($(BACKEND),uboot-fit)')).toHaveLength(1)
  expect(findings('Makefile', '\tbash tests/suites/lifecycle-uboot-fit/records.sh')).toHaveLength(0)
  expect(findings('Makefile', '\t@echo "  os-boot-tools   build the UKI/systemd-boot packager image"')).toHaveLength(0)
  expect(findings('src/image/planted.ts', '// a uboot-fit board forces its line: \'uboot-fit\' in a comment')).toHaveLength(0)
  expect(findings('src/image/planted.ts', 'fetchPool(\'amd64\', [\'mica-systemd-boot\'])')).toHaveLength(0)
  expect(findings('src/image/backends/uboot-fit.ts', 'const name = \'uboot-fit\'')).toHaveLength(0)
})
