// Compile pinned logo generation, rendering, VT switch and Rockchip HPD code.
//
//   bun boards/cx3576/kernel/tests/display-logo-test.ts <kernel-source> <evidence-directory>
//
// Run before and after the board patch. Kernel services are controlled by the C fixture; the vendor functions
// under test are extracted without rewriting them. This is a host regression, not a DRM device or
// physical-display qualification. The port of display-logo-test.py (deleted 2026-09-22), step for step.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function run(args: string[]): void {
  const r = Bun.spawnSync(args, { stdout: 'inherit', stderr: 'inherit', timeout: 20000 })
  if (r.exitCode !== 0) throw new Error(`Command '${JSON.stringify(args)}' returned non-zero exit status ${r.exitCode}.`)
}

function output(args: string[]): string {
  const r = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'inherit', timeout: 10000 })
  if (r.exitCode !== 0) throw new Error(`Command '${JSON.stringify(args)}' returned non-zero exit status ${r.exitCode}.`)
  return r.stdout.toString()
}

/** The whole definition of a C function, by name, out of a source file: from its signature to its closing brace. */
function fn(source: string, name: string): string {
  const match = new RegExp('^(?:static )?(?:inline )?[\\w *]+\\b' + name + '\\([^;]*?\\)\\n\\{', 'm').exec(source)
  if (match === null) throw new Error(`Missing vendor function: ${name}`)
  const brace = source.indexOf('{', match.index)
  let depth = 1, end = brace + 1
  while (depth > 0) {
    depth += (source[end] === '{' ? 1 : 0) - (source[end] === '}' ? 1 : 0)
    end += 1
  }
  return source.slice(match.index, end)
}

function main(): number {
  const [root, evidence] = Bun.argv.slice(2).map(p => resolve(p)) as [string, string]
  mkdirSync(evidence, { recursive: true })
  const headers = join(evidence, 'linux')
  mkdirSync(headers, { recursive: true })
  writeFileSync(join(headers, 'linux_logo.h'), readFileSync(join(root, 'include/linux/linux_logo.h')))
  writeFileSync(join(headers, 'init.h'),
    '#define __initdata __attribute__((section(".init.data")))\n'
    + '#define __initconst __attribute__((section(".init.rodata")))\n'
    + '#define __init\n#define __ref\n'
    + '#define late_initcall_sync(fn) static void __attribute__((constructor)) '
    + 'logo_late_init(void) { fn(); }\n')
  writeFileSync(join(headers, 'module.h'),
    '#include <stdbool.h>\n#define module_param(...)\n'
    + '#define MODULE_PARM_DESC(...)\n#define EXPORT_SYMBOL_GPL(...)\n')
  writeFileSync(join(headers, 'stddef.h'), '#include <stddef.h>\n')
  const logoDir = join(root, 'drivers/video/logo')
  run(['gcc', '-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', join(logoDir, 'pnmtologo.c'), '-o', join(evidence, 'pnmtologo')])
  const common = resolve(import.meta.dir, '../../../../common/kernel')
  // The logo generator still runs on python3 until the kernel-side helpers move (plan 20260922-0817, P2).
  run(['python3', join(common, 'mklogo.py'), join(common, 'splash.png'), join(evidence, 'logo.ppm'), '720', '405'])
  run([join(evidence, 'pnmtologo'), '-t', 'clut224', '-n', 'logo_linux_clut224', '-o', join(evidence, 'logo.c'), join(evidence, 'logo.ppm')])
  run(['gcc', '-I', evidence, '-fno-pie', '-c', join(evidence, 'logo.c'), '-o', join(evidence, 'logo.o')])
  const symbols = output(['objdump', '-t', join(evidence, 'logo.o')])
  writeFileSync(join(evidence, 'logo-symbols.txt'), symbols)
  let failures = 0
  for (const name of ['logo_linux_clut224', 'logo_linux_clut224_data', 'logo_linux_clut224_clut']) {
    const lines = symbols.split('\n').filter(line => line.trim().split(/\s+/).at(-1) === name)
    if (lines.length !== 1) throw new Error(`ValueError: expected one symbol line for ${name}, found ${lines.length}`)
    const line = lines[0]!
    const retained = !line.includes('.init') && line.includes('.rodata')
    console.log(`${retained ? 'PASS' : 'FAIL'} retained read-only artwork: ${line}`)
    failures += retained ? 0 : 1
  }

  const fbmem = readFileSync(join(root, 'drivers/video/fbdev/core/fbmem.c'), 'utf8')
  const fbcon = readFileSync(join(root, 'drivers/video/fbdev/core/fbcon.c'), 'utf8')
  const rockchip = readFileSync(join(root, 'drivers/gpu/drm/rockchip/rockchip_drm_fb.c'), 'utf8')
  const index = (s: string, needle: string): number => { const i = s.indexOf(needle); if (i < 0) throw new Error(`ValueError: substring not found: ${needle}`); return i }
  // The complete existing logo renderer, including palette and rotation code.
  let renderer = fbmem.slice(index(fbmem, 'static inline unsigned safe_shift('), index(fbmem, '\n#else\nint fb_prepare_logo('))
  renderer = fn(fbmem, 'fb_get_color_depth') + '\n' + renderer
  let redraw = ''
  if (fbcon.includes('static bool fbcon_show_idle_logo(')) redraw += fn(fbcon, 'fbcon_show_idle_logo') + '\n'
  redraw += fn(fbcon, 'fbcon_switch') + '\n'
  redraw += fn(fbcon, 'fbcon_modechanged') + '\n'
  redraw += fn(fbcon, 'fbcon_set_all_vcs') + '\n'
  redraw += fn(fbcon, 'fbcon_update_vcs') + '\n'
  const prepare = fbcon.slice(index(fbcon, '#else\nstatic void fbcon_prepare_logo('))
  redraw += fn(prepare, 'fbcon_prepare_logo') + '\n'
  redraw += fn(rockchip, 'rockchip_drm_output_poll_changed')
  let fixture = readFileSync(join(import.meta.dir, 'display-logo-fixture.c'), 'utf8')
  fixture = fixture.replace('/* VENDOR_RENDERER */', () => renderer)
  fixture = fixture.replace('/* VENDOR_REDRAW */', () => redraw)
  writeFileSync(join(evidence, 'display-test.c'), fixture)
  run(['gcc', '-std=gnu11', '-g', '-O1', '-Wall', '-Wextra', '-Werror',
    '-Wno-unused-parameter', '-Wno-unused-function', '-Wno-sign-compare',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-no-pie',
    '-DCONFIG_LOGO_LINUX_CLUT224', '-I', evidence,
    join(evidence, 'display-test.c'), join(logoDir, 'logo.c'), join(evidence, 'logo.o'), '-o', join(evidence, 'display-test')])
  const result = Bun.spawnSync([join(evidence, 'display-test')], { stdout: 'inherit', stderr: 'inherit', timeout: 10000 })
  return failures > 0 || result.exitCode !== 0 ? 1 : 0
}

process.exit(main())
