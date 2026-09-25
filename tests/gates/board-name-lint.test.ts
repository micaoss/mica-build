// No board name in the engine. A board is data under boards/<board>/; the assembly dispatches on its facts
// (src/image/board-facts.ts, the registries of src/image/backends/ and src/image/firmware-formats.ts, layout.tsv)
// and never on its name. The names are read from boards/boards.tsv, so a board added tomorrow is covered the day
// it is listed.
//
//   make os-board-name-lint         the tree, and the planted cases below
//
// Scope: the Makefile, all of src/, rootfs/, tests/ and .github/. Not *.test.ts (fixtures name boards on purpose),
// not products/ (a product names its board), not boards/ (a board directory is its own) and not locks/. A comment
// line, and a Makefile help line (`@echo "  ...`), may name a board: prose is not dispatch. A product's name
// (products/<name>) carries its board's and is not a board name: those are masked before the match.
// tests/fixtures/board-name-lint.allow lists the files that name a board on purpose, one repository-relative path
// per line with the reason after `#`.
//
// The port of tests/gates/board-name-lint.sh (deleted 2026-09-25), case for case, with one correction: the shell
// scanned src/image and src/verify, the whole engine when it was written, and missed src/boards, src/pool,
// src/product, src/release, src/rootfs, src/boot, src/offline and src/locks when the engine moved there.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const ALLOW = join(REPO_ROOT, 'tests/fixtures/board-name-lint.allow')
const SCOPE = ['src', 'rootfs', 'tests', '.github']
const KINDS = /(\.ts|\.sh|\.py|\.yml|(^|\/)Dockerfile|\.Dockerfile)$/

/** Every finding under `root`: `<file>:<line>:<text>`. */
export function lint(root: string, allowFile = ALLOW): string[] {
  const names = readFileSync(join(root, 'boards/boards.tsv'), 'utf8').split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.split('\t')[0]!)
  if (names.length === 0) throw new Error(`${root}/boards/boards.tsv lists no board, so the lint has no name to look for`)
  const pattern = new RegExp(`\\b(${[...new Set(names)].join('|')})\\b`)
  const products = existsSync(join(root, 'products')) ? readdirSync(join(root, 'products')).filter(p => existsSync(join(root, 'products', p, 'product.env'))) : []
  const mask = products.length === 0 ? undefined : new RegExp(`\\b(${products.join('|')})\\b`, 'g')
  const allowed = new Set(existsSync(allowFile) ? readFileSync(allowFile, 'utf8').split('\n').map(l => l.replace(/\s*#.*$/, '').trim()).filter(Boolean) : [])
  const files: string[] = existsSync(join(root, 'Makefile')) ? ['Makefile'] : []
  const walk = (dir: string) => {
    if (!existsSync(join(root, dir))) return
    for (const name of readdirSync(join(root, dir))) {
      const rel = join(dir, name)
      if (name === 'node_modules') continue
      if (statSync(join(root, rel)).isDirectory()) walk(rel)
      else if (KINDS.test(rel) && !rel.endsWith('.test.ts')) files.push(rel)
    }
  }
  for (const d of SCOPE) walk(d)
  const out: string[] = []
  for (const rel of files.sort()) {
    if (allowed.has(rel)) continue
    for (const [i, raw] of readFileSync(join(root, rel), 'utf8').split('\n').entries()) {
      const line = mask === undefined ? raw : raw.replace(mask, 'PRODUCT')
      if (!pattern.test(line)) continue
      if (/^\s*(#|\/\/|\*|\/\*)/.test(line) || /^\s*@echo " {2}/.test(line)) continue
      out.push(`${rel}:${i + 1}:${line}`)
    }
  }
  return out
}

test('no board name in the engine', () => {
  expect(lint(REPO_ROOT)).toEqual([])
})

// The lint goes red on a planted literal, and on nothing else: a clean tree, a comment, a product name.
const work = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'board-name-lint.'))
afterAll(() => rmSync(work, { recursive: true, force: true }))
mkdirSync(join(work, 'boards'), { recursive: true })
mkdirSync(join(work, 'src/image'), { recursive: true })
writeFileSync(join(work, 'boards/boards.tsv'), readFileSync(join(REPO_ROOT, 'boards/boards.tsv')))
writeFileSync(join(work, 'Makefile'), readFileSync(join(REPO_ROOT, 'Makefile')))
const first = readFileSync(join(REPO_ROOT, 'boards/boards.tsv'), 'utf8').split('\n').find(l => l !== '' && !l.startsWith('#'))!.split('\t')[0]!

test('a tree with no board name is clean', () => {
  writeFileSync(join(work, 'src/image/clean.ts'), 'export const x = 1\n')
  expect(lint(work, '/dev/null')).toEqual([])
})

test('a planted literal is reported at its file and line', () => {
  writeFileSync(join(work, 'src/image/planted.ts'), `export const board = '${first}'\n`)
  expect(lint(work, '/dev/null')).toEqual([`src/image/planted.ts:1:export const board = '${first}'`])
})

test('a planted literal outside src/image and src/verify is reported too', () => {
  mkdirSync(join(work, 'src/pool'), { recursive: true })
  writeFileSync(join(work, 'src/image/planted.ts'), 'export const y = 2\n')
  writeFileSync(join(work, 'src/pool/planted.ts'), `if (board === '${first}') {}\n`)
  expect(lint(work, '/dev/null').map(l => l.split(':').slice(0, 2).join(':'))).toEqual(['src/pool/planted.ts:1'])
  rmSync(join(work, 'src/pool/planted.ts'))
})

test('a board name in a comment is prose', () => {
  writeFileSync(join(work, 'src/image/planted.ts'), `// the ${first} board\nexport const y = 2\n`)
  expect(lint(work, '/dev/null')).toEqual([])
})

test('a product name is not a board name', () => {
  mkdirSync(join(work, `products/${first}-dev`), { recursive: true })
  mkdirSync(join(work, 'tests'), { recursive: true })
  writeFileSync(join(work, `products/${first}-dev/product.env`), `PRODUCT=${first}-dev\n`)
  writeFileSync(join(work, 'tests/product.sh'), `MICA_PRODUCT=${first}-dev bash bin/bun.sh src/cli.ts compose\n`)
  expect(lint(work, '/dev/null')).toEqual([])
})
