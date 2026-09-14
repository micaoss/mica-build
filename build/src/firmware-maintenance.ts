import { loadBoardFacts } from './board-facts.ts'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { authenticateFirmware, type Firmware } from './firmware.ts'

export interface FirmwareMaintenance {
  board: string
  input: string
  installed: string
  keys: string[]
  recovery: string
  esp?: string
  rkdeveloptool?: string
}

function read(path: string, limit: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid bounded firmware file: ${path}`)
  return readFileSync(path)
}

function verify(bytes: Buffer, manifest: Firmware, name: string) {
  if (bytes.length !== manifest.artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.artifact.sha256) {
    throw new Error(`${name} differs from the signed firmware manifest`)
  }
}

function sync(path: string) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function save(path: string, bytes: Buffer) {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  sync(path)
}

/** Offline maintenance only: the guest is stopped, or RockUSB owns the board. */
export function maintainFirmware(options: FirmwareMaintenance): Firmware {
  const envelope = read(join(options.input, 'firmware.json'), 16384)
  const facts = loadBoardFacts(options.board)
  const candidate = authenticateFirmware(envelope.toString('utf8'), options.keys, facts)
  const installedEnvelope = read(options.installed, 16384)
  const installed = authenticateFirmware(installedEnvelope.toString('utf8'), options.keys, facts)
  if (candidate.board !== options.board || installed.board !== options.board) throw new Error('Firmware maintenance board mismatch')
  if (candidate.target.format === 'amlogic-boot0') throw new Error('Amlogic boot0 maintenance requires the board recovery package')
  const efi = candidate.target.format === 'efi'
  if (efi ? !options.esp || !!options.rkdeveloptool : !options.rkdeveloptool || !!options.esp) throw new Error('Select exactly the board firmware destination')
  if (efi) {
    const recovery = join(realpathSync(dirname(options.recovery)), basename(options.recovery))
    const within = relative(realpathSync(options.esp!), recovery)
    if (within === '' || (within !== '..' && !within.startsWith('../'))) throw new Error('Recovery must be outside the ESP')
  }
  const filename = candidate.target.format === 'efi' ? candidate.target.path.split('/').at(-1)! : 'u-boot-rockchip.bin'
  const bytes = read(join(options.input, filename), candidate.artifact.bytes)
  verify(bytes, candidate, 'candidate firmware')

  // mkdir refuses an existing recovery directory. Every attempt keeps its own evidence.
  mkdirSync(options.recovery)
  sync(dirname(options.recovery))
  const rk = (...args: string[]) => {
    const result = spawnSync(options.rkdeveloptool!, args, { encoding: 'utf8', timeout: 180000, killSignal: 'SIGKILL' })
    if (result.status !== 0) throw new Error(`RockUSB ${args[0]} failed: ${result.error?.message ?? result.stderr}`)
  }
  let destination = ''
  let original: Buffer
  if (candidate.target.format === 'efi') {
    let path = options.esp!
    for (const segment of ['.', 'EFI', 'BOOT']) {
      path = join(path, segment)
      if (!lstatSync(path).isDirectory()) throw new Error('EFI destination contains a non-directory or symlink')
    }
    destination = join(options.esp!, candidate.target.path)
    original = read(destination, 4 * 1048576)
  } else {
    rk('rl', '64', '36800', join(options.recovery, 'before.bin'))
    original = read(join(options.recovery, 'before.bin'), 36800 * 512)
    if (original.length !== 36800 * 512) throw new Error('Incomplete FIRMWARE readback')
  }
  const previous = efi ? original : original.subarray(0, installed.artifact.bytes)
  verify(previous, installed, 'installed firmware')
  save(join(options.recovery, filename), previous)
  save(join(options.recovery, 'firmware.json'), installedEnvelope)
  sync(options.recovery)

  if (efi) {
    const staged = `${destination}.new`
    save(staged, bytes)
    renameSync(staged, destination)
    sync(dirname(destination))
    verify(read(destination, candidate.artifact.bytes), candidate, 'EFI readback')
  } else {
    const sectors = Math.ceil(bytes.length / 512)
    if (sectors * 512 > 16744448) throw new Error('Aligned firmware write exceeds the loader range')
    const padded = Buffer.alloc(sectors * 512)
    bytes.copy(padded)
    const payload = join(options.recovery, 'write.bin')
    save(payload, padded)
    rk('wl', '64', payload)
    rk('rl', '64', '36800', join(options.recovery, 'readback.bin'))
    const readback = read(join(options.recovery, 'readback.bin'), 36800 * 512)
    if (readback.length !== original.length) throw new Error('Incomplete FIRMWARE readback')
    verify(readback.subarray(0, bytes.length), candidate, 'RockUSB readback')
    if (!readback.subarray(0, padded.length).equals(padded)) throw new Error('RockUSB write padding differs')
    if (!readback.subarray(padded.length).equals(original.subarray(padded.length))) throw new Error('Changed bytes outside firmware write')
    sync(join(options.recovery, 'readback.bin'))
  }
  // Keep the next receipt with the readback evidence. RockUSB never resets here.
  save(join(options.recovery, 'installed.json'), envelope)
  sync(options.recovery)
  return candidate
}
