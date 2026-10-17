import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifest } from './inputs.ts'

// The manifest records a certificate's hash only; any file stands in for one.
const dir = mkdtempSync(join(tmpdir(), 'board-inputs.'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const cert = join(dir, 'signer.cert.pem')
writeFileSync(cert, 'certificate\n')
const certs = { verity: cert, fit: cert }

test('a ubi board\'s flash.tsv is an input of its board component', () => {
  expect(manifest('qemu-armhf', 'board', undefined, certs).some(l => l.startsWith('file flash.tsv '))).toBe(true)
})

test('where a ubi board\'s loader reads the FIT is an input of its uboot component, and no other board\'s', () => {
  const lines = manifest('qemu-armhf', 'uboot', undefined, certs)
  for (const line of ['env BOOT_TRUST none', 'env UBOOT_UBI_MTD nor1', 'env FIT_UBI_ADDRESS 0x44000000', 'env FIT_UBI_LIMIT 33554432']) expect(lines).toContain(line)
  expect(manifest('cx3576', 'uboot', undefined, certs).filter(l => l.startsWith('env '))).toEqual([])
})
