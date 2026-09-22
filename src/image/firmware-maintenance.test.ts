import { afterEach, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Signer } from '../shared/update-envelope.ts'
import { artifactFile } from './component-build.ts'
import { canonicalJson, componentId } from './components.ts'
import { maintainFirmware } from './firmware-maintenance.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture(board: 'uefi-x64' | 'cx3576') {
  const directory = mkdtempSync(join(tmpdir(), 'mica-firmware-maintenance-'))
  directories.push(directory)
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, false)
  const filename = board === 'uefi-x64' ? 'BOOTX64.EFI' : 'u-boot-rockchip.bin'
  const bytes = (generation: number) => Buffer.alloc(1024, generation)
  const pack = (generation: number) => {
    const path = join(directory, `package-${generation}`)
    mkdirSync(path)
    writeFileSync(join(path, filename), bytes(generation))
    const manifest = { schema: 'mica/firmware/v1', id: '', board, arch: board === 'uefi-x64' ? 'amd64' : 'arm64', generation,
      version: String(generation), artifact: artifactFile(join(path, filename)), target: board === 'uefi-x64'
        ? { format: 'efi', partition: 1, path: `EFI/BOOT/${filename}` }
        : { format: 'rockchip-loader', diskOffset: 32768, maxBytes: 16744448 } }
    manifest.id = componentId(manifest)
    writeFileSync(join(path, 'firmware.json'), JSON.stringify(signer.sign(JSON.parse(canonicalJson(manifest)))))
    return path
  }
  const current = pack(1)
  const candidate = pack(2)
  return { directory, current, candidate, filename, bytes, keys: [signer.publicKey], board }
}

test('offline EFI replacement verifies readback and saves an authenticated recovery package', () => {
  const f = fixture('uefi-x64')
  const esp = join(f.directory, 'esp')
  mkdirSync(join(esp, 'EFI/BOOT'), { recursive: true })
  writeFileSync(join(esp, 'EFI/BOOT', f.filename), f.bytes(1))
  writeFileSync(join(esp, 'unrelated'), 'counter state')
  const recovery = join(f.directory, 'recovery')
  maintainFirmware({ board: f.board, input: f.candidate, installed: join(f.current, 'firmware.json'), keys: f.keys, recovery, esp })
  expect(readFileSync(join(esp, 'EFI/BOOT', f.filename))).toEqual(f.bytes(2))
  expect(readFileSync(join(recovery, f.filename))).toEqual(f.bytes(1))
  expect(readFileSync(join(recovery, 'firmware.json'))).toEqual(readFileSync(join(f.current, 'firmware.json')))
  maintainFirmware({ board: f.board, input: recovery, installed: join(f.candidate, 'firmware.json'), keys: f.keys, recovery: join(f.directory, 'second-recovery'), esp })
  expect(readFileSync(join(esp, 'EFI/BOOT', f.filename))).toEqual(f.bytes(1))
  expect(readFileSync(join(esp, 'unrelated'), 'utf8')).toBe('counter state')
})

test('untrusted input and changed installed EFI refuse before modifying the destination', () => {
  const f = fixture('uefi-x64')
  const esp = join(f.directory, 'esp')
  mkdirSync(join(esp, 'EFI/BOOT'), { recursive: true })
  const destination = join(esp, 'EFI/BOOT', f.filename)
  writeFileSync(destination, f.bytes(1))
  const options = { board: f.board, input: f.candidate, installed: join(f.current, 'firmware.json'), keys: f.keys, recovery: join(f.directory, 'recovery'), esp }
  expect(() => maintainFirmware({ ...options, keys: [Buffer.alloc(32).toString('base64')] })).toThrow()
  expect(readFileSync(destination)).toEqual(f.bytes(1))
  writeFileSync(destination, 'corrupt')
  expect(() => maintainFirmware(options)).toThrow('installed firmware')
  expect(readFileSync(destination, 'utf8')).toBe('corrupt')
})

function rockusb(f: ReturnType<typeof fixture>, corrupt = false) {
  const device = join(f.directory, 'medium.bin')
  const before = Buffer.alloc(36800 * 512, 37)
  f.bytes(1).copy(before)
  writeFileSync(device, before)
  const executable = join(f.directory, 'rkdeveloptool')
  writeFileSync(executable, `#!/usr/bin/env python3
import pathlib, sys
p=pathlib.Path(${JSON.stringify(device)})
v=sys.argv[1:]
with open(${JSON.stringify(join(f.directory, 'calls'))}, 'a') as log: log.write(' '.join(v)+'\\n')
if v[0]=='rl':
 assert v[1:3]==['64','36800']
 pathlib.Path(v[3]).write_bytes(p.read_bytes())
elif v[0]=='wl':
 assert v[1]=='64'
 a=bytearray(p.read_bytes()); b=pathlib.Path(v[2]).read_bytes(); a[:len(b)]=b
 ${corrupt ? 'a[16744448] ^= 1' : 'pass'}
 p.write_bytes(a)
else: raise Exception('unexpected command')
`, { mode: 0o755 })
  return { device, before, executable }
}

test('RockUSB maintenance verifies the entire reserved partition and preserves counter bytes', () => {
  const f = fixture('cx3576')
  const usb = rockusb(f)
  const recovery = join(f.directory, 'recovery')
  maintainFirmware({ board: f.board, input: f.candidate, installed: join(f.current, 'firmware.json'), keys: f.keys, recovery, rkdeveloptool: usb.executable })
  const after = readFileSync(usb.device)
  expect(after.subarray(0, 1024)).toEqual(f.bytes(2))
  expect(after.subarray(1024)).toEqual(usb.before.subarray(1024))
  expect(readFileSync(join(recovery, f.filename))).toEqual(f.bytes(1))
  expect(readFileSync(join(f.directory, 'calls'), 'utf8').trim().split('\n').map(line => line.split(' ')[0])).toEqual(['rl', 'wl', 'rl'])
})

test('RockUSB out-of-range damage is refused, retains evidence and never resets the board', () => {
  const f = fixture('cx3576')
  const usb = rockusb(f, true)
  const recovery = join(f.directory, 'recovery')
  expect(() => maintainFirmware({ board: f.board, input: f.candidate, installed: join(f.current, 'firmware.json'), keys: f.keys, recovery, rkdeveloptool: usb.executable })).toThrow('outside firmware write')
  expect(readFileSync(join(recovery, 'readback.bin'))).toEqual(readFileSync(usb.device))
  expect(readFileSync(join(f.directory, 'calls'), 'utf8')).not.toContain('rd')
})

test('EFI recovery must be outside the destination, including a symlinked parent', () => {
  const f = fixture('uefi-x64')
  const esp = join(f.directory, 'esp')
  mkdirSync(join(esp, 'EFI/BOOT'), { recursive: true })
  const destination = join(esp, 'EFI/BOOT', f.filename)
  writeFileSync(destination, f.bytes(1))
  const alias = join(f.directory, 'alias')
  symlinkSync(esp, alias)
  for (const recovery of [join(esp, 'recovery'), join(alias, 'recovery')]) {
    expect(() => maintainFirmware({ board: f.board, input: f.candidate, installed: join(f.current, 'firmware.json'), keys: f.keys, recovery, esp })).toThrow('outside the ESP')
    expect(readFileSync(destination)).toEqual(f.bytes(1))
  }
})
