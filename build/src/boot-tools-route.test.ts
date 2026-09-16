import { expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packBootFirmware } from './kernel-package.ts'

test.each([
  ['uefi-x64', 'amd64', 'BOOTX64.EFI'],
  ['uefi-arm64', 'arm64', 'BOOTAA64.EFI'],
] as const)('%s firmware uses its target boot tools', (board, arch, filename) => {
  const work = mkdtempSync(join(tmpdir(), 'mica-boot-route-'))
  const previous = process.env.PATH
  try {
    writeFileSync(join(work, 'docker'), `#!/bin/sh
printf '%s\\n' "$@" > '${work}/argv'
printf 'signed firmware fixture' > '${work}/firmware.building/${filename}'
`, { mode: 0o755 })
    const key = join(work, 'metadata.pem')
    writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    process.env.PATH = `${work}:${previous}`
    packBootFirmware({ board, output: join(work, 'firmware'), metadataKey: key,
      generation: 1, version: 'test', bootSigning: { key: join(work, 'boot.key'), certificate: join(work, 'boot.crt') } })
    const args = readFileSync(join(work, 'argv'), 'utf8').trim().split('\n')
    expect(args).toContain(`ai-agent/mica-boot-tools-${arch}`)
    expect(args.slice(-2)).toEqual(['firmware', board === 'uefi-x64' ? 'x64' : 'aa64'])
  } finally {
    process.env.PATH = previous
    rmSync(work, { recursive: true, force: true })
  }
})
