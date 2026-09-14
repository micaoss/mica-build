import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseBoardEnv } from './board-env.ts'
import { parseFileLayout } from '../../build/src/file-layout.ts'
export function boardNameForPath(path: string): string { return basename(path) === 'board.env' ? basename(dirname(path)) : basename(path) }
export function loadBoard(path: string) {
 const source = readFileSync(path, 'utf8'), env = parseBoardEnv(source, path), layout = parseFileLayout(source)
 const get = (key: string) => env.values.get(key)
 const list = (key: string) => (get(key) ?? '').split(/\s+/).filter(Boolean)
 const partitions = layout.partitions.map(p => ({ ...p, partnum: p.number, role: get(`${p.name}_ROLE`), get: (suffix: string) => get(`${p.name}_${suffix}`) }))
 return { path, name: layout.board, env, layout, get, declared: (key: string) => env.values.has(key), partitions,
  partition: (name: string) => partitions.find(p => p.name === name),
  // The hardware's capabilities are BOARD_FEATURES (plan 20260913-0416, C1);
  // radios, the status LED and the display are readings of it.
  features: list('BOARD_FEATURES'),
  arch: get('MICA_ARCH'), bootloader: layout.backend, radios: list('BOARD_FEATURES').filter(f => f === 'wifi' || f === 'bluetooth') as string[], hwinitConfs: list('BOARD_HWINIT_CONFS'),
  firmwareFiles: list('BOARD_FIRMWARE_FILES'), hasStatusLed: list('BOARD_FEATURES').includes('status-led') ? '1' : '0', hasDisplay: list('BOARD_FEATURES').includes('display') ? '1' : '0',
  releaseTarget: get('BOARD_RELEASE_TARGET'), dramUsableBase: get('BOARD_DRAM_USABLE_BASE'), cmdlineArgs: get('BOARD_CMDLINE_ARGS') }
}
export type Board = ReturnType<typeof loadBoard>
export function loadBoards(directory: string, names: readonly string[]): Board[] { return names.map(n => loadBoard(join(directory, n, 'board.env'))) }
