import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALPHABET, apPsk, developmentSecret, deviceCode, DeviceCodeError, parseCode, printed, qrPayload, secretBytes, ssid } from './device-code.ts'
import { label, main } from './label.ts'

// mica-core:docs/factory-ap-key.md, "Test vectors": the secret is the 32 bytes 0x00..0x1f.
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const VECTORS = [
  { source: 'emmc-cid', raw: '150100444a54443452a1b2c3d4e5f600', code: 'DFN4L34CT8N', ssid: 'mica-789Z', psk: 'U8A5TU7RT6A6E8TV' },
  { source: 'dt-serial', raw: 'a5f2c3d4e5f60718', code: 'LSZJ2L3TWFG', ssid: 'mica-95SV', psk: 'PNA6B6H4FP6VTCR7' },
  { source: 'dmi-serial', raw: 'MXQ1234567', code: 'Y9E349ETBKD', ssid: 'mica-XE9C', psk: 'ZYGL2RYLNSEMMJ6E' },
  { source: 'dmi-uuid', raw: '4c4c4544-0042-3510-8051-b4c04f4e3332', code: 'LVVABBQD8Y4', ssid: 'mica-2Y83', psk: 'S8QLYFJDZT7BFJ44' },
  { source: 'mac', raw: '00:1a:2b:3c:4d:5e', code: 'RYP73EEMS8X', ssid: 'mica-VST3', psk: 'WL2K6GAUJMRJWE6U' },
]

test('the code, SSID and key of each vector', () => {
  for (const v of VECTORS) {
    expect(deviceCode(v.source, v.raw)).toBe(v.code)
    expect(ssid(v.code)).toBe(v.ssid)
    expect(apPsk(SECRET, v.code)).toBe(v.psk)
  }
})

test('the raw value is read with the whitespace around it removed, and the source is part of the code', () => {
  expect(deviceCode('dmi-serial', ' MXQ1234567\n')).toBe('Y9E349ETBKD')
  expect(deviceCode('dt-serial', 'a5f2c3d4e5f60718\0')).toBe('LSZJ2L3TWFG')
  expect(deviceCode('dmi-uuid', 'MXQ1234567')).not.toBe('Y9E349ETBKD')
  expect(() => deviceCode('serial', 'x')).toThrow(DeviceCodeError)
})

test('a printed code reads back; the check refuses every single wrong character and every adjacent swap', () => {
  const code = VECTORS[0]!.code
  expect(printed(code)).toBe('DFN4-L34C-T8N')
  expect(parseCode('dfn4-l34c-t8n')).toBe(code)
  expect(parseCode('DFN4 L34C T8N')).toBe(code)
  expect(parseCode(code)).toBe(code)
  for (let i = 0; i < 11; i++) {
    for (const c of ALPHABET) {
      if (c === code[i]) continue
      expect(() => parseCode(code.slice(0, i) + c + code.slice(i + 1))).toThrow(DeviceCodeError)
    }
    if (i < 10 && code[i] !== code[i + 1]) expect(() => parseCode(code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2))).toThrow(DeviceCodeError)
  }
  expect(() => parseCode('DFN4-L34C-T8')).toThrow(DeviceCodeError)
  expect(() => parseCode('DFN4-L34C-T80')).toThrow(DeviceCodeError)
})

test('the key is 16 characters of the alphabet, a WPA2 passphrase, and the QR payload names SSID and key', () => {
  const psk = apPsk(developmentSecret('cx3576.full'), VECTORS[0]!.code)
  expect(psk).toMatch(/^[23456789A-HJ-NP-Z]{16}$/)
  expect(qrPayload('mica-789Z', psk)).toBe(`WIFI:T:WPA;S:mica-789Z;P:${psk};;`)
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
