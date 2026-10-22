import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absentInputs } from './flash-inputs.ts'

const MIB = 1048576
const dir = mkdtempSync(join(tmpdir(), 'flash-inputs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('the absent inputs are the input variables of flash.tsv the environment leaves unset or empty', () => {
  expect(absentInputs(dir, 'demo', {})).toEqual([])
  writeFileSync(join(dir, 'flash.tsv'), ['# mica flash layout v1', `flash\tnand\t262144\t2048\t2048\t2048\t${32 * MIB}`, `mtd\tu-boot\tloader\t0\t${MIB}\tloader`,
    `mtd\tvendor\tfixed\t${MIB}\t${MIB}\tinput:MICA_DEMO_VENDOR:${'a'.repeat(64)}`, `mtd\tubi\tubi\t${2 * MIB}\t${30 * MIB}\t-`,
    'volume\tsystem\t24', 'volume\tdata\t24', 'reserve\tsystem\t1', 'reserve\tdata\t1', ''].join('\n'))
  expect(absentInputs(dir, 'demo', {})).toEqual(['MICA_DEMO_VENDOR'])
  expect(absentInputs(dir, 'demo', { MICA_DEMO_VENDOR: '' })).toEqual(['MICA_DEMO_VENDOR'])
  expect(absentInputs(dir, 'demo', { MICA_DEMO_VENDOR: '/some/file' })).toEqual([])
})
