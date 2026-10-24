// The two boot gates the ssd202d first hardware boot asked for, over fixture trees: the kernel's watchdog
// drivers set NOWAYOUT (common/kernel/watchdog-nowayout-check.py), and an SPL carries no %ll conversion
// tiny-printf cannot take (common/uboot/spl-printf-check.sh). No toolchain: the trees are written here.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const SCRATCH = mkdtempSync(join(REPO_ROOT, 'tmp/boot-gates-test.'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

let n = 0
function tree(files: Record<string, string>): string {
  const root = join(SCRATCH, `t${n++}`)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

function run(argv: string[]): [number, string, string] {
  const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  return [r.exitCode ?? -1, r.stdout.toString(), r.stderr.toString()]
}

// ---- watchdog NOWAYOUT ----

const KERNEL = {
  'drivers/watchdog/Makefile': [
    'obj-$(CONFIG_WATCHDOG_CORE)\t+= watchdog.o',
    'watchdog-objs\t+= watchdog_core.o watchdog_dev.o',
    'obj-$(CONFIG_GOOD_WDT) += good_wdt.o',
    'obj-$(CONFIG_BAD_WDT) += bad_wdt.o',
    '',
  ].join('\n'),
  'drivers/watchdog/watchdog_core.c': 'int watchdog_register_device(void);\n',
  'drivers/watchdog/watchdog_dev.c': '\n',
  'drivers/watchdog/good_wdt.c': 'static int probe(void) { watchdog_set_nowayout(&wdd, nowayout); return 0; }\n',
  'drivers/watchdog/bad_wdt.c': 'static int probe(void) { return devm_watchdog_register_device(dev, &wdd); }\n',
  // A vendor tree's driver, built through a composite object named by a variable (s905x5m's common_drivers).
  'common_drivers/drivers/watchdog/Makefile': 'MODULE_NAME = vendor-watchdog\nobj-$(CONFIG_VENDOR_WDT) = $(MODULE_NAME).o\n$(MODULE_NAME)-y += vendor_wdt.o\n',
  'common_drivers/drivers/watchdog/vendor_wdt.c': 'void f(void) { watchdog_set_nowayout(&d->wdt, WATCHDOG_NOWAYOUT); }\n',
}

function watchdog(config: string, exceptions?: string): [number, string, string] {
  const root = tree({ ...KERNEL, '.config': config, ...(exceptions === undefined ? {} : { 'wdt.exceptions': exceptions }) })
  return run(['python3', join(REPO_ROOT, 'common/kernel/watchdog-nowayout-check.py'), root, join(root, '.config'), exceptions === undefined ? '-' : join(root, 'wdt.exceptions')])
}

test('watchdog: every enabled driver that sets NOWAYOUT passes, built in, as a module and through a vendor composite', () => {
  const [code, out, err] = watchdog('CONFIG_WATCHDOG_CORE=y\nCONFIG_GOOD_WDT=m\nCONFIG_VENDOR_WDT=y\n# CONFIG_BAD_WDT is not set\n')
  expect([code, err]).toEqual([0, ''])
  expect(out).toContain('CONFIG_GOOD_WDT: drivers/watchdog/good_wdt.c calls watchdog_set_nowayout()')
  expect(out).toContain('CONFIG_VENDOR_WDT: common_drivers/drivers/watchdog/vendor_wdt.c calls watchdog_set_nowayout()')
  expect(out).not.toContain('WATCHDOG_CORE')
})

test('watchdog: an enabled driver that never sets NOWAYOUT is refused by name', () => {
  const [code, , err] = watchdog('CONFIG_WATCHDOG_CORE=y\nCONFIG_GOOD_WDT=y\nCONFIG_BAD_WDT=y\n')
  expect(code).toBe(1)
  expect(err).toContain('error: CONFIG_BAD_WDT: enabled, and drivers/watchdog/bad_wdt.c never calls watchdog_set_nowayout()')
})

test('watchdog: a documented exception passes, and a stale one is refused either way', () => {
  expect(watchdog('CONFIG_BAD_WDT=y\n', '# why\nCONFIG_BAD_WDT\tregisters no watchdog device\n')[0]).toBe(0)
  const [notBuilt, , err1] = watchdog('CONFIG_GOOD_WDT=y\n', 'CONFIG_BAD_WDT\tregisters no watchdog device\n')
  expect([notBuilt, err1]).toEqual([1, 'error: CONFIG_BAD_WDT: listed as an exception, but the config does not build it as a watchdog driver; drop the stale exception\n'])
  const [calls, , err2] = watchdog('CONFIG_GOOD_WDT=y\n', 'CONFIG_GOOD_WDT\tno reason\n')
  expect(calls).toBe(1)
  expect(err2).toContain('CONFIG_GOOD_WDT: listed as an exception, but drivers/watchdog/good_wdt.c calls watchdog_set_nowayout()')
  const [malformed, , err3] = watchdog('CONFIG_BAD_WDT=y\n', 'CONFIG_BAD_WDT no tab\n')
  expect([malformed, err3]).toEqual([1, `error: ${join(SCRATCH, `t${n - 1}`, 'wdt.exceptions')}:1: not \`CONFIG_<SYMBOL><TAB>why\`\n`])
})

// ---- SPL %ll ----

function spl(...binaries: string[]): [number, string, string] {
  const root = tree(Object.fromEntries(binaries.map((b, i) => [`spl/b${i}`, b])))
  return run(['bash', join(REPO_ROOT, 'common/uboot/spl-printf-check.sh'), ...binaries.map((_, i) => join(root, `spl/b${i}`))])
}

test('spl: binaries with single-l conversions pass', () => {
  const [code, out, err] = spl('\0\0U-Boot copy %c at 0x%lx: %s (%d)\n\0\0', '\0%ld\0')
  expect([code, err]).toEqual([0, ''])
  expect(out).toStartWith('spl-printf: no %ll in ')
})

test('spl: a %ll conversion in the SPL strings is refused by name, flags and width included', () => {
  const [code, out, err] = spl('\0\0cyclic function %s took too long: %lldus vs %dus max\n\0', '\0[%#016llx]\0')
  expect(code).toBe(1)
  expect(out).toContain('cyclic function %s took too long: %lldus vs %dus max')
  expect(out).toContain('[%#016llx]')
  expect(err).toContain('tiny-printf takes a single l')
})

test('spl: a missing SPL binary is refused rather than passed', () => {
  const [code, , err] = run(['bash', join(REPO_ROOT, 'common/uboot/spl-printf-check.sh'), join(SCRATCH, 'absent')])
  expect(code).toBe(1)
  expect(err).toContain('error: no SPL binary')
})
