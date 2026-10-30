import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, pinTools, producerOutput, provenance, stageHandover } from './local-build.ts'

const work = mkdtempSync(join(tmpdir(), 'local-build-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function must(argv: string[]): string {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** A committed checkout with `files`; its HEAD. */
function checkout(name: string, files: Record<string, string>): { dir: string, commit: string } {
  const dir = join(work, name)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  must(['git', 'init', '--quiet', dir])
  must(['git', '-C', dir, 'add', '-A'])
  must(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '--quiet', '-m', 'fixture'])
  return { dir, commit: must(['git', '-C', dir, 'rev-parse', 'HEAD']) }
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

test('the arguments: each input flag names a checkout; refused under CI, without a product, on a directory that is no checkout', () => {
  const core = checkout('core', { README: 'core\n' })
  expect(parse(['cx3576.full', '--core', core.dir, '--tools', core.dir, '--build'], {}))
    .toEqual({ product: 'cx3576.full', checkouts: { 'mica-core': core.dir }, tools: core.dir, build: true, gates: true, handover: 'cx3576.full' })
  expect(parse(['cx3576.full', '--handover', 'cx3576.full-alllocal'], {}).handover).toBe('cx3576.full-alllocal')
  expect(() => parse(['cx3576.full', '--handover', '../x'], {})).toThrow('usage:')
  expect(() => parse(['cx3576.full'], { GITHUB_ACTIONS: 'true' })).toThrow('never run in CI')
  expect(() => parse(['--core', core.dir], {})).toThrow('usage: bin/local-build.sh <product>')
  expect(() => parse(['cx3576.full', '--kernel', core.dir], {})).toThrow('usage:')
  expect(() => parse(['cx3576.full', '--core', work], {})).toThrow('is not a git checkout')
})

test('a producer that publishes images is taken only with section 6\'s layout; a dirty checkout is refused', () => {
  const base = checkout('base', { README: 'base\n' })
  expect(() => producerOutput('mica-system-base', true, base.dir, false, work)).toThrow('holds no mica-system-base.lock (release-lock.md section 6)')
  mkdirSync(join(base.dir, '_out/offline'), { recursive: true })
  writeFileSync(join(base.dir, '_out/offline/mica-system-base.lock'), `# mica-lock v1\nrelease\tmica-system-base\toffline\t${base.commit}\n`)
  expect(producerOutput('mica-system-base', true, base.dir, false, work)).toBe(base.dir)
  writeFileSync(join(base.dir, 'README'), 'changed\n')
  expect(() => producerOutput('mica-system-base', true, base.dir, false, work)).toThrow('has uncommitted changes')
})

test('a section 6 layout of another commit is refused: its lock names the commit it was built from', () => {
  const env = checkout('env-head', { README: 'env\n' })
  mkdirSync(join(env.dir, '_out/offline'), { recursive: true })
  writeFileSync(join(env.dir, '_out/offline/mica-build-env.lock'), `# mica-lock v1\nrelease\tmica-build-env\toffline\t${'f'.repeat(40)}\n`)
  expect(() => producerOutput('mica-build-env', true, env.dir, false, work)).toThrow(`is of ${'f'.repeat(40)}, not of HEAD ${env.commit}`)
  writeFileSync(join(env.dir, '_out/offline/mica-build-env.lock'), `# mica-lock v1\nrelease\tmica-build-env\toffline\t${env.commit}\n`)
  expect(producerOutput('mica-build-env', true, env.dir, false, work)).toBe(env.dir)
})

test('--build runs make offline in a shared clone at the checkout\'s HEAD, never in the checkout', () => {
  const pkgs = checkout('pkgs', { Makefile: 'offline:\n\tmkdir -p _out/debs && git rev-parse HEAD > _out/debs/built\n' })
  const run = join(work, 'run')
  mkdirSync(run)
  const out = producerOutput('mica-pkgs', false, pkgs.dir, true, run)
  expect(out).toBe(join(run, 'mica-pkgs'))
  expect(readFileSync(join(out, '_out/debs/built'), 'utf8').trim()).toBe(pkgs.commit)
  expect(must(['git', '-C', pkgs.dir, 'status', '--porcelain', '--ignored'])).toBe('')
})

test('--build syncs the clone\'s tools first, which a clone lacks (repos/ is no part of a commit)', () => {
  const base = checkout('base-sync', {
    'bin/mica-tools': '#!/bin/bash\n[ "$1" = sync ] && mkdir -p repos && echo synced > repos/tools\n',
    'Makefile': 'offline:\n\tmkdir -p _out/debs && cp repos/tools _out/debs/built\n',
  })
  const run = join(work, 'run-sync')
  mkdirSync(run)
  expect(readFileSync(join(producerOutput('mica-pkgs', false, base.dir, true, run), '_out/debs/built'), 'utf8')).toBe('synced\n')
})

test('the tools pin names the checkout\'s HEAD, and bin/mica-tools becomes its bootstrap when that differs', () => {
  const tools = checkout('tools', { 'bootstrap/mica-tools': '#!/bin/bash\necho new\n' })
  const root = join(work, 'root-tools')
  mkdirSync(join(root, 'locks'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/mica-tools'), '#!/bin/bash\necho old\n')
  expect(pinTools(tools.dir, root)).toEqual(['locks/mica-build-tools.pin', 'bin/mica-tools'])
  expect(readFileSync(join(root, 'locks/mica-build-tools.pin'), 'utf8')).toBe(`# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${tools.commit}\n`)
  expect(readFileSync(join(root, 'bin/mica-tools'), 'utf8')).toContain('echo new')
  expect(pinTools(tools.dir, root)).toEqual(['locks/mica-build-tools.pin'])
})

test('the hand-over: every image kind as .img and .img.gz, the board\'s committed loader, verify.log, SHA256SUMS over them', () => {
  const root = join(work, 'root-handover'), out = join(root, '_out/products/demo.full')
  mkdirSync(join(out, 'kinds'), { recursive: true })
  mkdirSync(join(root, 'boards/demo/loader'), { recursive: true })
  writeFileSync(join(out, 'kinds/mica-demo.full-1.img'), 'image bytes\n')
  writeFileSync(join(out, 'kinds.tsv'), `disk\tkinds/mica-demo.full-1.img\t${sha('image bytes\n')}\n`)
  writeFileSync(join(root, 'boards/demo/loader/Loader.bin'), 'loader\n')
  writeFileSync(join(root, 'boards/demo/loader/Loader.bin.sha256'), `${sha('loader\n')}  loader/Loader.bin\n`)
  writeFileSync(join(root, 'boards/demo/loader/Other.bin'), 'no record\n')
  writeFileSync(join(work, 'verify.log'), 'RESULT: PASS\n')
  mkdirSync(join(root, '_out/handover/demo.full'), { recursive: true })
  writeFileSync(join(root, '_out/handover/demo.full/old.img'), 'stale\n')
  const dest = join(root, '_out/handover/demo.full')
  expect(stageHandover('demo.full', 'demo', join(work, 'verify.log'), root)).toEqual(
    ['mica-demo.full-1.img', 'mica-demo.full-1.img.gz', 'Loader.bin', 'verify.log', 'SHA256SUMS'].map(f => join(dest, f)))
  expect(must(['bash', '-c', `cd ${dest} && sha256sum -c SHA256SUMS`])).toBe('mica-demo.full-1.img: OK\nmica-demo.full-1.img.gz: OK\nLoader.bin: OK')
  expect(must(['bash', '-c', `gzip -dc ${dest}/mica-demo.full-1.img.gz`])).toBe('image bytes')
  expect(() => stageHandover('none.full', 'demo', join(work, 'verify.log'), root)).toThrow('names no image')
  // Under another name, beside the product's own hand-over, which it leaves as it is.
  expect(stageHandover('demo.full', 'demo', join(work, 'verify.log'), root, 'demo.full-alllocal')[0]).toBe(join(root, '_out/handover/demo.full-alllocal/mica-demo.full-1.img'))
  expect(must(['bash', '-c', `cd ${dest} && sha256sum -c SHA256SUMS`])).toContain('Loader.bin: OK')
})

test('the provenance: an offline pin is local with its checkout, a release pin a release', () => {
  const root = join(work, 'root-prov')
  mkdirSync(join(root, 'locks/pins'), { recursive: true })
  writeFileSync(join(root, 'locks/mica-core.lock'), `# mica-lock v1\nrelease\tmica-core\toffline\t${'a'.repeat(40)}\n`)
  writeFileSync(join(root, 'locks/pins/mica-core.pin'), `# mica-pin v1\nREPOSITORY=mica-core\nRELEASE=offline\nSHA256SUMS=${'b'.repeat(64)}\nCHECKOUT=/x/core\n`)
  writeFileSync(join(root, 'locks/mica-pkgs.lock'), `# mica-lock v1\nrelease\tmica-pkgs\t20261021-0939\t${'c'.repeat(40)}\n`)
  writeFileSync(join(root, 'locks/pins/mica-pkgs.pin'), `# mica-pin v1\nREPOSITORY=mica-pkgs\nRELEASE=20261021-0939\nSHA256SUMS=${'d'.repeat(64)}\n`)
  writeFileSync(join(root, 'locks/mica-build-tools.pin'), `# mica-tools-pin v1\nREPOSITORY=mica-build-tools\nCOMMIT=${'e'.repeat(40)}\n`)
  const lines = provenance(root)
  expect(lines.slice(0, 2)).toEqual([`local    mica-core ${'a'.repeat(40)} from /x/core`, `release  mica-pkgs 20261021-0939 (${'c'.repeat(40)})`])
  expect(lines[2]).toContain(`mica-build-tools ${'e'.repeat(40)}`)
  expect(lines[3]).toStartWith('upstream ')
})
