// Can tests/gates/host-toolchain-lint.ts fail? (make os-host-toolchain-lint-test)
//
// A lint that has only ever been run against a clean tree has been observed to exit 0 and nothing else. Every case
// below plants ONE defect in a fixture checkout and requires the lint to go red naming it -- and the false-positive
// controls plant something that is NOT a defect and require green, because a rule whose findings are false positives
// teaches people to ignore it.
//
// The fixtures are throwaway git repositories, because the lint takes its file list from `git ls-files` and a
// fixture that is not one would exercise a different code path from the real run. Each case matches a fragment of
// the output as well as the colour, so that it cannot be satisfied by the lint failing for some unrelated reason.
// The port of tests/gates/host-toolchain-lint-test.sh (deleted 2026-09-25), case for case.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { lint } from './host-toolchain-lint.ts'

const REPO_ROOT = resolve(import.meta.dir, '../..')
mkdirSync(join(REPO_ROOT, 'tmp'), { recursive: true })
const WORK = mkdtempSync(join(REPO_ROOT, 'tmp', 'host-toolchain-lint.'))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

// Every green fixture needs one container declaration, because the lint refuses a run that found none.
const DECL = '# mica-build-side: container -- fixture: pretend this runs in an image'
const DECLARED = [DECL, 'mksquashfs /a /b']

/** A fixture checkout: a git repository with the named files tracked. Every fixture carries one ordinary command
 * line, so that the "not one command line was examined" control does not fire on a fixture that is simply small. */
function fixture(files: Record<string, string[]>, plain = true): string {
  const d = mkdtempSync(join(WORK, 'case.'))
  Bun.spawnSync(['git', '-C', d, 'init', '-q'])
  if (plain) files = { 'plain.sh': ['#!/bin/sh', 'set -eu', 'true'], ...files }
  for (const [name, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true })
    writeFileSync(join(d, name), `${lines.join('\n')}\n`)
  }
  Bun.spawnSync(['git', '-C', d, 'add', '-A'])
  return d
}

/** The lint over a fixture, required to be the colour named and to mention the needle. */
function expectLint(dir: string, want: 'green' | 'red', needle: string) {
  const r = lint(dir, true), out = r.lines.map(l => l.text).join('\n')
  expect(r.code === 0 ? 'green' : 'red', out).toBe(want)
  expect(out, `${want} as expected, but the output does not mention '${needle}', so this case is not testing what it says`).toContain(needle)
}

// 1. The real tree. The control for everything below: if this is not green, the red cases prove nothing.
test('the lint is green on this tree', () => {
  const r = lint(REPO_ROOT, true)
  expect(r.code, r.lines.map(l => l.text).join('\n')).toBe(0)
})

test.each([
  // 2. A host filesystem maker.
  ['a host mkfs.ext4 is found', { 'declared.sh': DECLARED, 'assemble.sh': ['#!/bin/sh', 'mkfs.ext4 -F disk.img'] }, 'red', 'assemble.sh:2: `mkfs.ext4` runs on the host'],
  // 3. A host compiler. Separate from case 2 because no assembly and no compilation are separate claims, and a table
  //    that lost its toolchain half would still pass case 2.
  ['a host cargo build is found', { 'declared.sh': DECLARED, 'compile.sh': ['#!/bin/sh', 'cargo build --release'] }, 'red', 'compile.sh:2: `cargo` runs on the host'],
  // 4. THE FALSE-POSITIVE CONTROL. Without it, the cheapest way to pass 2 and 3 is a rule that flags every occurrence.
  ['a producer inside a declared container block is not a finding', {
    'blocked.sh': ['#!/bin/sh', 'echo host side', '# mica-build-side: container-block -- fixture: the lines below are a container\'s', 'docker run --rm alpine sh -c \'',
      '    mkfs.ext4 -F /w/disk.img', '    sgdisk --clear /w/disk.img', '\'', '# mica-build-side: host', 'echo host side again'],
  }, 'green', 'RESULT: PASS'],
  // 5 and 6. THE MUTATION. The whole-file declaration is what makes 5 green; removing it must turn the same bytes red.
  ['a whole-file declaration covers the file', { 'pack.sh': ['#!/bin/sh', DECL, 'mksquashfs /rootfs /out/rootfs.squashfs'] }, 'green', 'RESULT: PASS'],
  ['removing that declaration turns the same file red', { 'pack.sh': ['#!/bin/sh', 'mksquashfs /rootfs /out/rootfs.squashfs'], 'other.sh': [DECL, 'mkimage -T script'] }, 'red', 'pack.sh:2: `mksquashfs` runs on the host'],
  // 7. An unclosed container block: everything after it is skipped, so the failure mode is a file that stops being
  //    scanned and still reports clean.
  ['an unclosed container block is a failure, not a silent skip', {
    'unclosed.sh': ['#!/bin/sh', '# mica-build-side: container-block -- fixture: opened and never closed', 'docker run --rm alpine true', 'mkfs.ext4 -F disk.img'],
  }, 'red', 'is never closed'],
  // 8. A close with no open.
  ['a host marker closing nothing is a failure', { 'declared.sh': DECLARED, 'stray.sh': ['#!/bin/sh', '# mica-build-side: host', 'true'] }, 'red', 'never opened'],
  // 9. A marker with no reason is a rubber stamp; treating it as "not a marker" would leave its author believing the
  //    file was declared.
  ['a marker with no reason is refused by name', { 'declared.sh': DECLARED, 'stamped.sh': ['#!/bin/sh', '# mica-build-side: container', 'mkfs.ext4 -F disk.img'] }, 'red', 'malformed `mica-build-side:` marker'],
  // 10. A whole-file declaration after code would otherwise read as covering lines that ran before it.
  ['a whole-file declaration after code is refused', { 'declared.sh': DECLARED, 'late.sh': ['#!/bin/sh', 'echo work', 'true', DECL, 'mkfs.ext4 -F disk.img'] }, 'red', 'must come before any code'],
  // 11. A LIVE exemption silences its finding, a STALE one is a failure, and one with no reason is refused: a register
  //     that silenced everything and one that was never read produce the same green on the first.
  ['a registered exemption silences its finding', {
    'declared.sh': DECLARED, 'keys.sh': ['#!/bin/sh', 'openssl genpkey -out k'], 'tests/fixtures/host-toolchain-exemptions': ['keys.sh\topenssl\tfixture: registered, with a reason'],
  }, 'green', 'RESULT: PASS'],
  ['an exemption that matches nothing is a failure', {
    'declared.sh': DECLARED, 'tests/fixtures/host-toolchain-exemptions': ['gone.sh\topenssl\tfixture: points at a file that is not here'],
  }, 'red', 'matches nothing'],
  ['an exemption with no reason is refused', {
    'declared.sh': DECLARED, 'keys.sh': ['#!/bin/sh', 'openssl genpkey -out k'], 'tests/fixtures/host-toolchain-exemptions': ['keys.sh\topenssl'],
  }, 'red', 'no tool or no reason'],
  // 12. THE SECOND SHAPE: a script that REACHES for a host toolchain, and the negative half that keeps the rule
  //     narrow -- a fixture PATH built out of a directory the test just made is not a finding.
  ['a PATH prepended with a directory under $HOME is found', { 'declared.sh': DECLARED, 'reaches.sh': ['#!/bin/sh', 'export PATH="$HOME/.cargo/bin:$PATH"', 'true'] }, 'red', 'reaches.sh:2: this prepends a directory under $HOME to PATH'],
  ['a fixture PATH built from a temp dir is NOT a finding', { 'declared.sh': DECLARED, 'fixture.sh': ['#!/bin/sh', 'FAKEBIN=$(mktemp -d)', 'env PATH="${FAKEBIN}:$PATH" some-fixture'] }, 'green', 'RESULT: PASS'],
  // 13. A COMMENT THAT MENTIONS A HEREDOC MUST NOT OPEN ONE. A real defect when it was fixed: 152 command lines of
  //     this repository that had never been examined came back.
  ['a heredoc named in a COMMENT does not swallow the lines after it', {
    'declared.sh': DECLARED,
    'prose.sh': ['#!/bin/sh', '# The producer below is a real one. This comment mentions a heredoc, <<EOF,', '# because scripts explain themselves and prose talks about shell syntax.', 'mkfs.ext4 -F disk.img'],
  }, 'red', 'prose.sh:4: `mkfs.ext4` runs on the host'],
  // 14. THE POSITIVE CONTROL, driven directly: no producer running in a container is a pattern that stopped matching.
  ['a scan that saw no container-side producer refuses to report clean', { 'quiet.sh': ['#!/bin/sh', 'echo nothing interesting here'] }, 'red', 'no container-side declaration was found'],
  // 16 and 17. THE SECOND SURFACE, in both shapes: bun's shell tag and an argv-taking spawn are resolved by different
  //     code, and a scanner that lost one would still pass the other.
  ['a producer launched from a bun shell template is found', {
    'declared.sh': DECLARED, 'pack.ts': ['import { $ } from \'bun\'', 'export async function pack(root: string, out: string) {', '  await $`mksquashfs ${root} ${out} -comp zstd`', '}'],
  }, 'red', 'pack.ts:3: this launches `mksquashfs` on the host'],
  ['a producer launched through Bun.spawnSync is found, path and all', {
    'declared.sh': DECLARED, 'part.ts': ['export function part(img: string) {', '  return Bun.spawnSync([\'/usr/sbin/sgdisk\', \'--clear\', img], { stdout: \'pipe\' })', '}'],
  }, 'red', 'part.ts:2: this launches `sgdisk` on the host'],
  // 17b. A TYPESCRIPT FILE THAT RUNS IN AN IMAGE declares it in its leading comment, before any code, with a reason.
  ['a TypeScript file declared container-side may launch a producer', {
    'declared.sh': DECLARED,
    'regdb.ts': ['// mica-build-side: container -- runs in a stage on the build-env base image, whose openssl writes the PEM', 'export function pem(der: Uint8Array) {',
      '  return Bun.spawnSync([\'openssl\', \'x509\', \'-inform\', \'DER\', \'-outform\', \'PEM\'], { stdin: der, stdout: \'pipe\' })', '}'],
  }, 'green', 'RESULT: PASS'],
  ['a TypeScript declaration with no reason is refused by name', {
    'declared.sh': DECLARED,
    'regdb.ts': ['// mica-build-side: container', 'export function pem(der: Uint8Array) {', '  return Bun.spawnSync([\'openssl\', \'x509\', \'-inform\', \'DER\', \'-outform\', \'PEM\'], { stdin: der, stdout: \'pipe\' })', '}'],
  }, 'red', 'regdb.ts: malformed `mica-build-side:` marker'],
  ['a TypeScript declaration after code is refused', {
    'declared.sh': DECLARED,
    'regdb.ts': ['export const inform = \'DER\'', '// mica-build-side: container -- declared too late to cover the file', 'export function pem(der: Uint8Array) {',
      '  return Bun.spawnSync([\'openssl\', \'x509\', \'-inform\', inform, \'-outform\', \'PEM\'], { stdin: der, stdout: \'pipe\' })', '}'],
  }, 'red', 'regdb.ts: a whole-file container declaration must come before any code; this one is after line 1'],
  // 18. THE FALSE-POSITIVE CONTROL FOR THAT SURFACE: a producer handed to docker as an ARGUMENT, which is what the
  //     whole toolbox is, and a regex anchor immediately before a template's closing backtick.
  ['a producer passed to docker, and a regex anchor, are NOT findings', {
    'declared.sh': DECLARED,
    'toolbox.ts': ['import { $ } from \'bun\'', 'export const re = (name: string) => new RegExp(`^${name}=(.*)$`, \'gm\')', 'export async function pack(docker: string, root: string, out: string) {',
      '  await $`${docker} run --rm alpine mksquashfs ${root} ${out}`', '  Bun.spawn([\'docker\', \'exec\', \'c\', \'mkfs.ext4\', \'-F\', \'/w/disk.img\'])', '}'],
  }, 'green', 'RESULT: PASS'],
  // 19. THE SCANNER'S CONTROL ON ITSELF: an unterminated template is the silent-elision shape case 13 fixed.
  ['a TypeScript file that does not scan back to code state is a finding', { 'declared.sh': DECLARED, 'broken.ts': ['export const oops = `an unterminated template'] }, 'red', 'did not scan back to code state'],
  // 20. AND THE VACUITY CONTROL: TypeScript scanned with no launch site looks the same as a scanner that stopped
  //     recognising the language.
  ['TypeScript scanned with no launch site at all is refused', { 'declared.sh': DECLARED, 'quiet.ts': ['export const answer = 42'] }, 'red', 'not one process launch was found'],
  // 21. PROSE INSIDE A QUOTED ARGUMENT IS NOT A COMMAND -- AND A COMMAND SUBSTITUTION INSIDE ONE STILL IS. The
  //     distinction is substitution versus literal paren, not quoted versus unquoted.
  ['a producer named in prose inside a quoted argument is NOT a finding', {
    'declared.sh': DECLARED,
    'prose-arg.sh': ['#!/bin/sh', 'step ab-update \\', '    "install the GOOD bundle (rauc install <bundle>), reboot, then confirm" \\', '    \'and the same in single quotes (mkfs.ext4 -F disk.img) is prose too\''],
  }, 'green', 'RESULT: PASS'],
  ['a command substitution inside a double-quoted string is still a finding', { 'declared.sh': DECLARED, 'subst.sh': ['#!/bin/sh', 'ver="$(cargo build --release)"'] }, 'red', 'subst.sh:2: `cargo` runs on the host'],
] as [string, Record<string, string[]>, 'green' | 'red', string][])('%s', (_what, files, want, needle) => {
  expectLint(fixture(files), want, needle)
})

// 15. And a tree with no scannable files at all: the one case that wants an EMPTY surface.
test('an empty surface is a failure, not a pass', () => {
  expectLint(fixture({ 'README.md': ['not a script'] }, false), 'red', 'would pass by finding nothing')
})
