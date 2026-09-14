import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { Signer } from '../../shared/update-envelope.ts'
import { parseFileLayout } from '../../build/src/file-layout.ts'
import { authenticateFactoryRecords, checkFactoryGpt } from './file-image.ts'
import type { GptTable } from './image.ts'

const layout = parseFileLayout(readFileSync(`${import.meta.dir}/../../_out/boards/x64/board.env`, 'utf8'))
const partitions = layout.partitions.map(p => ({ number: p.number, firstSector: p.startSector,
  lastSector: p.startSector + p.sizeSectors - 1, sizeSectors: p.sizeSectors,
  typeGuid: p.type, uniqueGuid: p.guid, name: p.name, attributeFlags: '0000000000000000' }))
const table: GptTable = { image: 'fixture', sectorSize: 512, diskGuid: layout.diskGuid,
  totalSectors: layout.sizeSectors, partitions, partition: n => partitions[n - 1] }

test('factory GPT requires exactly the current geometry and identities', () => {
  expect(() => checkFactoryGpt(layout, table, layout.sizeSectors * 512)).not.toThrow()
  for (const mutation of [
    { diskGuid: 'wrong' }, { sectorSize: 4096 }, { totalSectors: table.totalSectors + 1 },
    { partitions: [...partitions, partitions[0]!] },
    ...['firstSector', 'lastSector', 'sizeSectors', 'typeGuid', 'uniqueGuid', 'name', 'attributeFlags'].map(key => ({
      partitions: partitions.map((p, i) => i ? p : { ...p, [key]: key.endsWith('Sector') || key === 'sizeSectors' ? 123 : 'wrong' }),
    })),
  ]) expect(() => checkFactoryGpt(layout, { ...table, ...mutation } as GptTable, layout.sizeSectors * 512)).toThrow()
  expect(() => checkFactoryGpt(layout, table, 4096)).toThrow()
})

test('factory deployments reject empty, duplicate, unsigned and wrong-board records', () => {
  const fixture = JSON.parse(readFileSync(`${import.meta.dir}/../../tests/component-contracts/envelope.json`, 'utf8'))
  const envelope = typeof fixture.envelope === 'string' ? fixture.envelope : JSON.stringify(fixture.envelope)
  expect(() => authenticateFactoryRecords([], [], 'x64')).toThrow()
  expect(() => authenticateFactoryRecords([envelope, envelope], [fixture.publicKey], 'x64')).toThrow()
  expect(() => authenticateFactoryRecords(['{}', '{}'], [], 'x64')).toThrow()
  const signer = new Signer(generateKeyPairSync('ed25519').privateKey, true)
  const deployment = JSON.parse(Buffer.from(fixture.envelope.payload, 'base64').toString())
  const pair = [1, 2].map(generation => JSON.stringify(signer.sign({ ...deployment, generation })))
  expect(authenticateFactoryRecords(pair, [signer.publicKey], 'x64').map(r => r.deployment.generation)).toEqual([2, 1])
  expect(() => authenticateFactoryRecords(pair, [fixture.publicKey], 'x64')).toThrow()
  expect(() => authenticateFactoryRecords(pair, [signer.publicKey], 'cx3576')).toThrow()
})
