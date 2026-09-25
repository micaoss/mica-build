// The shared kernel floor over every board's committed configuration, the boards discovered: a UEFI board's
// config is kernel/config/<board>.config and its post-olddefconfig gate its kernel/Dockerfile; a FIT board (one
// with a bsp.env) names its config there (KERNEL_CONFIG) and its gate is its kernel/configure.sh. Then a board's
// own guest requirements (kernel/config/<board>.required): `builtin` =y, `runtime` =y or =m.
//
//   bun src/cli.ts kernel-config-test          (make kernel-config-test)
//
// The floor itself is common/kernel/kernel-config-test.sh, run once per board. The port of
// tools/kernel-config-test.sh (deleted 2026-09-25), message for message.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../pool/producers.ts'

export class KernelConfigError extends Error {}

function die(message: string): never {
  throw new KernelConfigError(`error: ${message}`)
}

/** The committed config a board's kernel build starts from, and the file whose loop re-asserts it. */
export function configOf(board: string, root = REPO_ROOT): { config: string, gate: string } {
  const bsp = join(root, 'boards', board, 'bsp.env')
  if (!existsSync(bsp)) return { config: `boards/${board}/kernel/config/${board}.config`, gate: `boards/${board}/kernel/Dockerfile` }
  const name = /^KERNEL_CONFIG=(.*)$/m.exec(readFileSync(bsp, 'utf8'))?.[1] ?? ''
  if (name === '') die(`boards/${board}/bsp.env declares no KERNEL_CONFIG`)
  return { config: `boards/${board}/kernel/config/${name}`, gate: `boards/${board}/kernel/configure.sh` }
}

/** A board's .required rows against its committed config: the PASS line, a refusal naming what is not held. */
export function required(board: string, config: string, root = REPO_ROOT): string | undefined {
  const file = `boards/${board}/kernel/config/${board}.required`
  if (!existsSync(join(root, file))) return undefined
  const lines = new Set(readFileSync(join(root, config), 'utf8').split('\n'))
  const value = (symbol: string) => [...lines].find(l => l.startsWith(`CONFIG_${symbol}=`))?.slice(`CONFIG_${symbol}=`.length) ?? ''
  let held = 0
  const missing: string[] = []
  for (const raw of readFileSync(join(root, file), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const [kind = '', ...rest] = line.split(/\s+/)
    const symbol = rest.join(' ')
    const want = kind === 'builtin' ? ['y'] : kind === 'runtime' ? ['y', 'm'] : die(`${file}: '${kind}' is not builtin or runtime`)
    if (want.some(w => lines.has(`CONFIG_${symbol}=${w}`))) held++
    else missing.push(`${kind}:${symbol}=${value(symbol)}`)
  }
  if (held === 0) die(`${file} lists no symbol; the check above asserted nothing`)
  if (missing.length > 0) throw new KernelConfigError(`FAIL: ${board}: ${config} does not hold what ${file} requires: ${missing.join(' ')}`)
  return `PASS: ${board}: all ${held} symbols of ${file} are held`
}

export function main(argv: string[]): number {
  if (argv.length !== 0) { console.error('usage: bun src/cli.ts kernel-config-test'); return 2 }
  try {
    const boards = readdirSync(join(REPO_ROOT, 'boards')).filter(b => existsSync(join(REPO_ROOT, 'boards', b, 'board.env'))).sort()
    if (boards.length === 0) die('no board.env found; the loop above checked nothing')
    for (const board of boards) {
      const { config, gate } = configOf(board)
      const r = Bun.spawnSync(['bash', 'common/kernel/kernel-config-test.sh', board, config, gate], { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit' })
      if (r.exitCode !== 0) return r.exitCode
      const pass = required(board, config)
      if (pass !== undefined) console.log(pass)
    }
    console.log(`kernel-config-test: ${boards.length} board(s)`)
    return 0
  }
  catch (e) {
    if (e instanceof KernelConfigError) { console.error(e.message); return 1 }
    throw e
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)))
