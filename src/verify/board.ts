import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseBoardEnv } from './board-env.ts'
import { BACKENDS } from '../image/backends/index.ts'
import { loadLayout, type FileLayout } from '../image/file-layout.ts'
import { loadFlashLayout, storageOf } from '../image/flash-layout.ts'
export function boardNameForPath(path: string): string { return basename(path) === 'board.env' ? basename(dirname(path)) : basename(path) }
export function loadBoard(path: string, storageLayout = '') {
  const source = readFileSync(path, 'utf8'), env = parseBoardEnv(source, path)
  const get = (key: string) => env.values.get(key)
  const list = (key: string) => (get(key) ?? '').split(/\s+/).filter(Boolean)
  // A gpt board's disk is its layout.tsv, a ubi board's flash its flash.tsv; each has the one.
  const storage = storageOf(env.values, path), name = get('LAYOUT_BOARD') ?? ''
  const layout = storage === 'gpt' ? loadLayout(dirname(path), storageLayout) : undefined
  const flash = storage === 'ubi' ? loadFlashLayout(dirname(path), name) : undefined
  const backend = get('BOOT_BACKEND') ?? ''
  if (!(backend in BACKENDS)) throw new Error(`${path}: BOOT_BACKEND '${backend}' is not a boot backend`)
  const partitions = (layout?.partitions ?? []).map(p => ({ ...p, partnum: p.number }))
  return { path, name, env, storage, layout, flash, get, declared: (key: string) => env.values.has(key), partitions,
    partition: (name: string) => partitions.find(p => p.name === name),
    // The hardware's capabilities are BOARD_FEATURES;
    // radios, the status LED and the display are readings of it.
    features: list('BOARD_FEATURES'),
    arch: get('MICA_ARCH'), bootloader: backend as FileLayout['backend'], radios: list('BOARD_FEATURES').filter(f => f === 'wifi' || f === 'bluetooth') as string[], hwinitConfs: list('BOARD_HWINIT_CONFS'),
    firmwareFiles: list('BOARD_FIRMWARE_FILES'), hasStatusLed: list('BOARD_FEATURES').includes('status-led') ? '1' : '0', hasDisplay: list('BOARD_FEATURES').includes('display') ? '1' : '0',
    releaseTarget: get('BOARD_RELEASE_TARGET'), dramUsableBase: get('BOARD_DRAM_USABLE_BASE'), cmdlineArgs: get('BOARD_CMDLINE_ARGS') }
}
export type Board = ReturnType<typeof loadBoard>
