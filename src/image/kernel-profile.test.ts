import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { kernelDirectory, loadBoardFacts } from './board-facts.ts'
import { kernelFeatures, profileCommandLine, type Profile } from './kernel-package.ts'
import { pinnedBoards, REPO_ROOT } from './paths.ts'
import { TOOLS_PLATFORM } from '../boot/build-tools.ts'

// The image profile travels on the signed kernel command line as exactly one
// `mica.profile=dev|prod` token, written for prod too; the reader takes only an
// exact single `mica.profile=dev` as dev.
const count = (line: string) => line.split(/\s+/).filter(token => token.startsWith('mica.profile')).length

describe('profileCommandLine', () => {
  test.each(['dev', 'prod'] as Profile[])('writes one explicit %s token after the board arguments', (profile) => {
    const line = profileCommandLine('console=ttyS0 ro  panic=5', profile)
    expect(line).toBe(`console=ttyS0 ro panic=5 mica.profile=${profile}`)
    expect(count(line)).toBe(1)
  })

  test.each(['mica.profile=dev', 'mica.profile', 'mica.recovery=factory'])('refuses a board line that already carries %s', (token) => {
    expect(() => profileCommandLine(`console=ttyS0 ${token} ro`, 'prod')).toThrow(/names mica.profile or mica.recovery/)
  })

  test('a prod line of a kernel that checks module signatures enforces them; a dev line does not', () => {
    expect(profileCommandLine('console=ttyS0 ro', 'prod', true)).toBe('console=ttyS0 ro module.sig_enforce=1 lockdown=integrity mica.profile=prod')
    expect(profileCommandLine('console=ttyS0 ro', 'dev', true)).toBe('console=ttyS0 ro mica.profile=dev')
    expect(profileCommandLine('console=ttyS0 ro', 'prod')).toBe('console=ttyS0 ro mica.profile=prod')
    for (const token of ['module.sig_enforce=0', 'lockdown=none'])
      expect(() => profileCommandLine(`console=ttyS0 ${token}`, 'dev', true)).toThrow(/names module.sig_enforce or lockdown/)
  })

  test.each(['', 'Dev', 'production'])('refuses the profile %p', (profile) => {
    expect(() => profileCommandLine('ro', profile as Profile)).toThrow(/Invalid image profile/)
  })

  test('every pinned board yields exactly one token for both profiles', () => {
    const boards = pinnedBoards()
    expect(boards.length).toBeGreaterThan(0)
    for (const board of boards)
      for (const profile of ['dev', 'prod'] as Profile[]) expect(count(profileCommandLine(loadBoardFacts(board).cmdline, profile))).toBe(1)
  })
})

describe('kernelDirectory', () => {
  test.each(['dev', 'prod'] as Profile[])('a FIT board packs kernel/%s', (profile) => {
    expect(kernelDirectory({ board: 'fitboard', backend: 'uboot-fit' }, profile, '/b')).toBe(`/b/fitboard/kernel/${profile}`)
  })

  test.each(['dev', 'prod'] as Profile[])('a UEFI board packs its one kernel/ for %s', (profile) => {
    expect(kernelDirectory({ board: 'efiboard', backend: 'systemd-boot' }, profile, '/b')).toBe('/b/efiboard/kernel')
  })

  test('refuses a profile other than dev or prod', () => {
    expect(() => kernelDirectory({ board: 'fitboard', backend: 'uboot-fit' }, 'staging' as Profile, '/b')).toThrow(/Invalid image profile/)
  })
})

test('the product build packs the kernel directory of its profile', () => {
  const script = readFileSync(join(REPO_ROOT, 'src/product/build.ts'), 'utf8')
  expect(script).toContain('const kernelDirectory = kernelDir(p.board, p.profile)')
  expect(script).toContain('\'--input\', kernelDirectory')
})

test('the UKI packager compares the signed .cmdline with the one handed in and counts the token', () => {
  const script = readFileSync(join(REPO_ROOT, 'stages/boot/kernel.sh'), 'utf8')
  expect(script).toContain('--dump-section .cmdline=/output/signed-cmdline')
  expect(script).toContain('cmp /input/cmdline /output/signed-cmdline')
  expect(script).toContain(`grep -c '^mica\\.profile='`)
})

test('the product build hands its PROFILE to the kernel component', () => {
  expect(readFileSync(join(REPO_ROOT, 'src/product/build.ts'), 'utf8')).toContain('cli([\'components\', \'kernel\', \'--board\', p.board, \'--profile\', p.profile')
})

test('the packaging tools images run on the platform src/boot/build-tools.ts builds every one of them for', () => {
  expect(TOOLS_PLATFORM).toBe('linux/amd64')
  expect(readFileSync(join(REPO_ROOT, 'src/image/kernel-package.ts'), 'utf8')).toContain('const TOOLS_PLATFORM = \'linux/amd64\'')
})

test('a kernel that takes driver extensions claims its KERNEL_FEATURES and driver-ext; any other claims nothing', () => {
  const ok1 = 'CONFIG_MODULE_SIG=y\nCONFIG_MICA_OWNER_KEYRING=y\n'
  const declared = ['storage-gpt', 'netdev', 'module-signing', 'drivers-amd64']
  expect(kernelFeatures(declared, ok1, 'amd64')).toEqual(['driver-ext', 'drivers-amd64', 'module-signing', 'netdev', 'storage-gpt'])
  expect(kernelFeatures(declared, 'CONFIG_MODULE_SIG=y\n', 'amd64')).toBeUndefined()
  expect(kernelFeatures(['storage-gpt', 'module-signing'], ok1, 'amd64')).toBeUndefined()
  expect(kernelFeatures(['storage-gpt', 'drivers-amd64'], ok1, 'amd64')).toBeUndefined()
  expect(kernelFeatures(declared, ok1, 'arm64')).toBeUndefined()
})
