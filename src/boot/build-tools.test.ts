// src/boot/build-tools.ts without docker: the target the argument and MICA_BOOT_TARGET agree on, and the
// inputs label, which is the shell's `sha256sum` over the same lines (a kernel component's buildId names it, so
// the port must not move it).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build, BuildToolsError, inputsLabel, main, STAGE_FILES, target, TOOLS_PLATFORM } from './build-tools.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('the target', () => {
  test('the argument, MICA_BOOT_TARGET, or x64; a disagreement and an unknown target are refused with 64', () => {
    expect(target([], {})).toBe('x64')
    expect(target([], { MICA_BOOT_TARGET: 'aa64' })).toBe('aa64')
    expect(target(['--target', 'aa64'], {})).toBe('aa64')
    expect(target(['--target', 'aa64'], { MICA_BOOT_TARGET: 'aa64' })).toBe('aa64')
    for (const [argv, env, message] of [
      [['--target', 'x64'], { MICA_BOOT_TARGET: 'aa64' }, 'conflicting boot-tools targets'],
      [['--target', 'ia32'], {}, 'must be x64 or aa64'],
      [[], { MICA_BOOT_TARGET: 'arm' }, 'must be x64 or aa64'],
      [['x64'], {}, 'usage'],
      [['--target'], {}, 'usage'],
    ] as [string[], Record<string, string>, string][]) {
      expect(() => target(argv, env)).toThrow(BuildToolsError)
      expect(() => target(argv, env)).toThrow(message)
      try { target(argv, env) }
      catch (e) { expect((e as BuildToolsError).code).toBe(64) }
    }
  })
})

describe('the inputs label', () => {
  test('is sha256 over the base, snapshot, target and loader lines and the sha256sum lines of the stage files', () => {
    const d = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'build-tools-test.'))
    try {
      const loader = join(d, 'loader.deb')
      writeFileSync(loader, 'not a deb\n')
      const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
      const expected = sha([`base b@sha256:0\nsnapshot http://s\ntarget x64\nloader ${sha('not a deb\n')}\n`,
        ...STAGE_FILES.map(f => `${sha(readFileSync(join(REPO_ROOT, 'stages/boot', f)))}  ${f}\n`)].join(''))
      expect(inputsLabel('b@sha256:0', 'http://s', 'x64', loader)).toBe(expected)
      expect(inputsLabel('b@sha256:0', 'http://s', 'aa64', loader)).not.toBe(expected)
    }
    finally { rmSync(d, { recursive: true, force: true }) }
  })
  test('every image is built for linux/amd64', () => {
    expect(TOOLS_PLATFORM).toBe('linux/amd64')
    expect(STAGE_FILES).toEqual(['Dockerfile', 'initramfs.sh', 'kernel.sh', 'compression.sh', 'elf-closure.sh'])
  })
})

describe('the launcher, docker an argument recorder', () => {
  // The cases of tests/gates/boot-startup-package-test.sh's launcher half (moved here 2026-09-23): nothing is built.
  const d = mkdtempSync(join((mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true }), join(REPO_ROOT, 'tmp')), 'build-tools-launcher.'))
  const record = join(d, 'docker.jsonl'), stub = join(d, 'docker'), loader = join(d, 'loader.deb')
  // The record's path is written into the recorder: a variable set on process.env here did not reach the
  // recorder spawned by the module (KeyError, 2026-09-23), the path in its source does.
  writeFileSync(stub, `#!/usr/bin/env python3\nimport json,sys\nopen(${JSON.stringify(record)},"a").write(json.dumps(sys.argv[1:])+"\\n")\n`)
  chmodSync(stub, 0o755)
  writeFileSync(loader, '!<arch>\n')
  const calls = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(l => l !== '').map(l => JSON.parse(l) as string[]) : [])
  const withEnv = async (env: Record<string, string | undefined>, f: () => Promise<unknown> | unknown) => {
    const before = { ...process.env }
    rmSync(record, { force: true })
    Object.assign(process.env, { MICA_BUILD_DOCKER: stub, MICA_BOOT_LOADER_DEB: loader })
    delete process.env['MICA_BOOT_TARGET']
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try { return await f() }
    finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before) }
  }
  test('a refusal records no docker call and exits 64', async () => {
    for (const [argv, env] of [[['--target', ''], {}], [['--target', 'invalid'], {}], [['--target', 'x64', '--target', 'aa64'], {}],
      [[], { MICA_BOOT_TARGET: '' }], [[], { MICA_BOOT_TARGET: 'amd64' }], [['--target', 'aa64'], { MICA_BOOT_TARGET: 'x64' }]] as [string[], Record<string, string>][]) {
      expect(await withEnv(env, () => main(argv))).toBe(64)
      expect(calls()).toEqual([])
    }
  })
  test('a build is one docker build of stages/boot for the target, on linux/amd64, with the pinned base, snapshot and loader context', async () => {
    for (const [argv, env, t] of [[[], {}, 'x64'], [['--target', 'x64'], {}, 'x64'], [[], { MICA_BOOT_TARGET: 'aa64' }, 'aa64'], [['--target', 'aa64'], { MICA_BOOT_TARGET: 'aa64' }, 'aa64']] as [string[], Record<string, string>, 'x64' | 'aa64'][]) {
      const arch = t === 'x64' ? 'amd64' : 'arm64'
      expect(await withEnv(env, () => build(target(argv, process.env)))).toBe(`ai-agent/mica-boot-tools-${arch}`)
      const recorded = calls()
      expect(recorded).toHaveLength(1)
      const a = recorded[0]!
      expect(a[0]).toBe('build')
      expect(a.at(-1)).toBe(join(REPO_ROOT, 'stages/boot'))
      expect(a.some(v => v === `loader=${join(REPO_ROOT, '_out/boot-tools', `loader-${arch}`)}`)).toBe(true)
      expect(a.filter(v => v === `MICA_BOOT_TARGET=${t}`)).toHaveLength(1)
      expect(a.filter(v => v === '--platform')).toHaveLength(1)
      expect(a[a.indexOf('--platform') + 1]).toBe('linux/amd64')
      expect(a[a.indexOf('-t') + 1]).toBe(`ai-agent/mica-boot-tools-${arch}`)
      expect(a.some(v => v.startsWith('MICA_IMAGE_DEBIAN_TRIXIE=') && v.includes('@sha256:'))).toBe(true)
      expect(a.some(v => v.startsWith('MICA_DEBIAN_SNAPSHOT=http://snapshot.debian.org/archive/debian/'))).toBe(true)
      expect(a.some(v => v.startsWith('mica.boot.inputs=') && /^[0-9a-f]{64}$/.test(v.slice('mica.boot.inputs='.length)))).toBe(true)
    }
    rmSync(d, { recursive: true, force: true })
  })
})
