// Compile the real vendor init/remove functions against controlled OPP services.
//
//   bun boards/cx3576/kernel/tests/rkvenc-devfreq-test.ts <kernel-source>
//
// Run against 372ce582b94a3360a29727c3c49c88bb7509da22 before and after patches. The missing-table stub models
// rockchip_init_opp_info's of_parse_phandle failure; it does not stand in for the fixed-rate selection under
// test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fn(source: string, name: string): string {
  const start = source.indexOf(`static int ${name}(`)
  if (start < 0) throw new Error(`ValueError: substring not found: static int ${name}(`)
  const brace = source.indexOf('{', start)
  let depth = 1, end = brace + 1
  while (depth > 0) {
    depth += (source[end] === '{' ? 1 : 0) - (source[end] === '}' ? 1 : 0)
    end += 1
  }
  return source.slice(start, end)
}

function run(args: string[], timeout: number): void {
  const r = Bun.spawnSync(args, { stdout: 'inherit', stderr: 'inherit', timeout })
  if (r.exitCode !== 0) throw new Error(`Command '${JSON.stringify(args)}' returned non-zero exit status ${r.exitCode}.`)
}

const source = readFileSync(join(Bun.argv[2]!, 'drivers/video/rockchip/mpp/mpp_rkvenc2.c'), 'utf8')
const fixture = readFileSync(join(import.meta.dir, 'rkvenc-devfreq-fixture.c'), 'utf8')
const functions = ['rkvenc_devfreq_init', 'rkvenc_devfreq_remove'].map(name => fn(source, name)).join('\n')
const temporary = mkdtempSync(join(tmpdir(), 'mica-rkvenc-test-'))
try {
  writeFileSync(join(temporary, 'test.c'), fixture.replace('/* VENDOR_FUNCTIONS */', () => functions))
  run(['gcc', '-std=gnu11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', join(temporary, 'test.c'), '-o', join(temporary, 'test')], 20000)
  run([join(temporary, 'test')], 10000)
}
finally { rmSync(temporary, { recursive: true, force: true }) }
