import { loadBoardFacts } from './board-facts.ts'
import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import golden from '../../tests/component-contracts/firmware.json'
import { Signer } from '../../shared/update-envelope.ts'
import { canonicalJson, componentId } from './components.ts'
import { authenticateFirmware, parseFirmware, type Firmware } from './firmware.ts'

test('S905X5M firmware binds a framed eMMC boot0 payload, never a GPT write', () => {
  const value = { ...fixture(), board: 's905x5m',
    target: { format: 'amlogic-boot0', payloadOffset: 512, maxBytes: 4193792 } }
  value.id = componentId(value)
  expect(canonicalJson(parseFirmware(canonicalJson(value), loadBoardFacts('s905x5m')))).toBe(canonicalJson(value))
  for (const change of [
    { payloadOffset: 0 }, { payloadOffset: 32768 }, { maxBytes: 4194304 },
    { format: 'amlogic-boot1' }, { device: '/dev/mmcblk0' },
  ]) {
    const bad = { ...value, target: { ...value.target, ...change } }
    bad.id = componentId(bad)
    expect(() => parseFirmware(canonicalJson(bad), loadBoardFacts('s905x5m'))).toThrow()
  }
})

function fixture(board: Firmware['board'] = 'cx3576') {
  const value: Firmware = { schema: 'mos/firmware/v1', id: '', board, arch: board === 'x64' ? 'amd64' : 'arm64', generation: 1,
    version: 'firmware-1', artifact: { bytes: 1048576, sha256: 'a'.repeat(64) },
    target: board === 'cx3576'
      ? { format: 'rockchip-loader', diskOffset: 32768, maxBytes: 16744448 }
      : { format: 'efi', partition: 1, path: `EFI/BOOT/${board === 'x64' ? 'BOOTX64.EFI' : 'BOOTAA64.EFI'}` },
  }
  value.id = componentId(value)
  return value
}

test('firmware manifests bind independent board-specific maintenance ranges', () => {
  for (const board of ['x64', 'virt-arm64', 'cx3576'] as const) {
    const value = fixture(board)
    expect(parseFirmware(canonicalJson(value))).toEqual(value)
  }
  for (const record of golden.records) {
    expect(canonicalJson(authenticateFirmware(record.envelope, [golden.publicKey]))).toBe(canonicalJson(record.manifest))
  }
})

test('firmware metadata cannot select SYSTEM, the environment, or arbitrary EFI paths', () => {
  const changes = [
    { target: { format: 'rockchip-loader', diskOffset: 32768, maxBytes: 17 * 1048576 } },
    { target: { format: 'rockchip-loader', diskOffset: 16 * 1048576, maxBytes: 65536 } },
    { artifact: { bytes: 16744449, sha256: 'a'.repeat(64) } },
    { board: 'unknown' }, { arch: 'amd64' }, { generation: 0 }, { online: true },
  ]
  // Judged against the board's facts: a target that is not exactly what
  // board.env declares is refused, however well-formed.
  for (const change of changes) {
    const value = { ...fixture(), ...change }
    value.id = componentId(value)
    expect(() => parseFirmware(canonicalJson(value), loadBoardFacts('cx3576'))).toThrow()
  }
  for (const target of [
    { format: 'efi', partition: 2, path: 'EFI/BOOT/BOOTX64.EFI' },
    { format: 'efi', partition: 1, path: '../BOOTX64.EFI' },
    { format: 'efi', partition: 1, path: 'EFI/BOOT/BOOTAA64.EFI' },
  ]) {
    const value = { ...fixture('x64'), target }; value.id = componentId(value)
    expect(() => parseFirmware(canonicalJson(value), loadBoardFacts('x64'))).toThrow()
  }
})

test('firmware signatures reject unknown keys, tampering and deployment substitution', () => {
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, true)
  const value = fixture()
  const signed = JSON.stringify(signer.sign(JSON.parse(canonicalJson(value))))
  expect(authenticateFirmware(signed, [signer.publicKey])).toEqual(value)
  expect(() => authenticateFirmware(signed, [Buffer.alloc(32).toString('base64')])).toThrow()
  expect(() => authenticateFirmware(signed.replace(/"signature":"[^"]+"/, `"signature":"${Buffer.alloc(64).toString('base64')}"`), [signer.publicKey])).toThrow()
  expect(() => authenticateFirmware(JSON.stringify(signer.sign({ schema: 'mos/deployment/v1' })), [signer.publicKey])).toThrow()
  expect(() => parseFirmware(`${canonicalJson(value)}\n`)).toThrow()
  expect(() => parseFirmware(canonicalJson(value).replace('"generation":1', '"generation":2,"generation":1'))).toThrow()
})
