import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALPHABET, apPsk, developmentSecret, deviceCode, DeviceCodeError, parseCode, printed, qrPayload, secretBytes, ssid } from './device-code.ts'
import { label, main } from './label.ts'

// Computed by an independent implementation of mica-core:docs/factory-ap-key.md; replaced by that document's vectors
// when it publishes them.
const SECRET = Buffer.from('vector-secret-0123456789abcdef0123')
const VECTORS = [
  { source: 'emmc-cid', raw: '150100524a52345a5034c3d1f2a1b3c4\n', code: 'LWUSTVLVVPD', ssid: 'mica-LVVP', psk: 'ANVTRYVAFYEGJS5T' },
  { source: 'dmi-serial', raw: 'PF3XYZ12', code: 'HRC8ZXE9FYG', ssid: 'mica-E9FY', psk: '62LZNJGY3UYG488J' },
  { source: 'mac', raw: '02:11:22:33:44:55', code: 'RA9DDRY5Y7Q', ssid: 'mica-Y5Y7', psk: 'SJ2HZVAYG9D8VKXZ' },
]

test('the code, SSID and key of each vector', () => {
  for (const v of VECTORS) {
    expect(deviceCode(v.source, v.raw)).toBe(v.code)
    expect(ssid(v.code)).toBe(v.ssid)
    expect(apPsk(SECRET, v.code)).toBe(v.psk)
  }
})

test('the raw value is read with the whitespace around it removed, and the source is part of the code', () => {
  expect(deviceCode('dmi-serial', ' PF3XYZ12\n')).toBe(deviceCode('dmi-serial', 'PF3XYZ12'))
  expect(deviceCode('dmi-uuid', 'PF3XYZ12')).not.toBe(deviceCode('dmi-serial', 'PF3XYZ12'))
  expect(() => deviceCode('serial', 'x')).toThrow(DeviceCodeError)
})

test('a printed code reads back; the check refuses every single wrong character and every adjacent swap', () => {
  const code = VECTORS[0]!.code
  expect(printed(code)).toBe('LWUS-TVLV-VPD')
  expect(parseCode('lwus-tvlv-vpd')).toBe(code)
  expect(parseCode(code)).toBe(code)
  for (let i = 0; i < 11; i++) {
    for (const c of ALPHABET) {
      if (c === code[i]) continue
      expect(() => parseCode(code.slice(0, i) + c + code.slice(i + 1))).toThrow(DeviceCodeError)
    }
    if (i < 10 && code[i] !== code[i + 1]) expect(() => parseCode(code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2))).toThrow(DeviceCodeError)
  }
  expect(() => parseCode('LWUS-TVLV-VP')).toThrow(DeviceCodeError)
  expect(() => parseCode('LWUS-TVLV-VP0')).toThrow(DeviceCodeError)
})

test('the key is 16 characters of the alphabet, a WPA2 passphrase, and the QR payload names SSID and key', () => {
  const psk = apPsk(developmentSecret('cx3576.full'), VECTORS[0]!.code)
  expect(psk).toMatch(/^[23456789A-HJ-NP-Z]{16}$/)
  expect(qrPayload('mica-LVVP', psk)).toBe(`WIFI:T:WPA;S:mica-LVVP;P:${psk};;`)
  expect(developmentSecret('cx3576.full')).toHaveLength(32)
  expect(developmentSecret('cx3576.full').equals(developmentSecret('s905x5m.sd-full'))).toBe(false)
})

test('a secret is the file without one trailing newline, at least 32 bytes', () => {
  expect(secretBytes(Buffer.from(`${'a'.repeat(32)}\n`), 'f')).toEqual(Buffer.from('a'.repeat(32)))
  expect(secretBytes(Buffer.from(`${'a'.repeat(32)}\n\n`), 'f')).toHaveLength(33)
  expect(() => secretBytes(Buffer.from(`${'a'.repeat(31)}\n`), 'f')).toThrow(DeviceCodeError)
})

test('label prints the code, SSID, key and QR payload of a printed code', async () => {
  const v = VECTORS[1]!
  expect(label(SECRET, printed(v.code))).toBe(`code\t${printed(v.code)}\nssid\t${v.ssid}\npsk\t${v.psk}\nqr\tWIFI:T:WPA;S:${v.ssid};P:${v.psk};;\n`)
  const dir = mkdtempSync(join(tmpdir(), 'label-'))
  try {
    writeFileSync(join(dir, 'short'), 'x'.repeat(31))
    expect(await main(['--secret', join(dir, 'short'), v.code])).toBe(1)
    expect(await main(['--secret', join(dir, 'absent'), v.code])).toBe(1)
    expect(await main(['--development', 'cx3576.full', 'nonsense'])).toBe(1)
    expect(await main([v.code])).toBe(1)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
