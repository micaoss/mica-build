// The boot-tools recipe (stages/boot/Dockerfile) for both EFI targets, without building it (make os-boot-test):
// the target is checked before anything is acquired and an empty, doubled or unknown one refused; the stages are the
// two the build expects; the loader comes from the Base pool's archive by bind mount; nothing of a source build
// (meson, ninja, versions.env) or of the retired cross route is left. Then the first two RUN steps are executed in
// sh for x64 and aa64 with apt-get, dpkg-deb, dpkg, rm and find recorded instead of run and every absolute path
// under a scratch root: x64 adds no foreign architecture, aa64 adds arm64 and installs the arm64 loader and the
// aarch64 binutils. No image is built and nothing of the target executes.
//
// The launcher's own cases are src/boot/build-tools.test.ts's. The port of tests/gates/boot-startup-package-test.sh
// (deleted 2026-09-25) and the Python program it ran on the host, assertion for assertion.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, 'tmp', 'boot-recipe.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const recipe = readFileSync(join(REPO_ROOT, 'stages/boot/Dockerfile'), 'utf8').replaceAll('\\\n', '')
const instructions = recipe.split('\n').filter(l => l !== '' && !l.startsWith('#')).map(l => l.trim())
const runs = instructions.filter(l => l.startsWith('RUN ')).map(l => l.slice(4))

test('the target is declared once and checked before the first acquisition, and a bad one is refused', () => {
  expect(instructions.filter(l => l === 'ARG MICA_BOOT_TARGET=x64').length).toBe(1)
  const guard = /^(case "\$MICA_BOOT_TARGET" in .*?esac;)/.exec(runs[0] ?? '')?.[1]
  expect(guard, 'target must be checked before first acquisition').toBeDefined()
  for (const target of ['', 'both', 'x64 aa64']) {
    const r = Bun.spawnSync(['sh', '-c', guard!], { env: { ...process.env, MICA_BOOT_TARGET: target }, stdout: 'ignore', stderr: 'ignore' })
    expect(r.exitCode, `MICA_BOOT_TARGET='${target}' was accepted`).not.toBe(0)
  }
})

test('the stages, the tools and the label are the ones the build reads, and no source build is left', () => {
  expect(instructions.filter(l => l.startsWith('FROM '))).toEqual(['FROM ${MICA_IMAGE_DEBIAN_TRIXIE} AS tools', 'FROM tools AS artifact-tools'])
  for (const required of ['COPY initramfs.sh kernel.sh compression.sh elf-closure.sh /tools/', 'LABEL mica.boot.target=${MICA_BOOT_TARGET}'])
    expect(instructions).toContain(required)
  for (const word of ['meson', 'ninja', 'versions.env', 'systemd-boot-persistence', 'arm64-cross']) expect(recipe).not.toContain(word)
  const loader = runs.filter(l => l.includes('--mount=type=bind,from=loader,target=/loader'))
  expect(loader.length).toBe(1)
  expect(loader[0]).toContain('/loader-pkg/usr/lib/mica/systemd-boot/systemd-boot${MICA_BOOT_TARGET}.efi')
  expect(loader[0]).toContain('/usr/lib/systemd/boot/efi/')
})

// The recording route: stubs on PATH for the two programs, shell functions for the three builtins' neighbours.
const route = join(WORK, 'route'), bin = join(route, 'bin')
mkdirSync(bin, { recursive: true })
for (const name of ['apt-get', 'dpkg-deb']) {
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf "%s\\n" "${name} $*" >> "$ROUTE_COMMANDS"\n`)
  chmodSync(join(bin, name), 0o755)
}
const PREFIX = `log() { printf '%s\\n' "$*" >> "$ROUTE_COMMANDS"; }
dpkg() { log dpkg "$@"; }
rm() { log rm "$@"; }; find() { log find "$@"; }
`

function commands(target: 'x64' | 'aa64'): string[] {
  const root = join(route, target)
  for (const d of ['etc/apt/sources.list.d', 'etc/apt/preferences.d']) mkdirSync(join(root, d), { recursive: true })
  const log = join(root, 'commands.txt')
  for (const step of runs.slice(0, 2)) {
    const code = step.replace(/(?<![A-Za-z0-9_/])\/(?:etc\/|var\/|arm-debs|arm64)/g, m => root + m)
    const env: Record<string, string> = { ...process.env as Record<string, string>, PATH: `${bin}:${process.env.PATH}`, MICA_BOOT_TARGET: target, MICA_DEBIAN_SNAPSHOT: 'fixture', ROUTE_COMMANDS: log }
    const r = Bun.spawnSync(['sh', '-eu', '-c', PREFIX + code], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, `${target}: ${code}\n${r.stderr.toString()}`).toBe(0)
  }
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(l => l !== '') : []
}

test('the x64 branch adds no foreign architecture', () => {
  const lines = commands('x64')
  expect(lines.filter(l => ['--add-architecture', ':arm64', 'aarch64'].some(w => l.includes(w)))).toEqual([])
})

test('the aa64 branch adds arm64 and installs the arm64 loader and the aarch64 binutils', () => {
  const lines = commands('aa64')
  expect(lines.some(l => l.includes('dpkg --add-architecture arm64'))).toBe(true)
  expect(lines.some(l => l.includes('systemd-boot-efi:arm64'))).toBe(true)
  expect(lines.some(l => l.includes('apt-get install') && l.includes('binutils-aarch64-linux-gnu'))).toBe(true)
})
