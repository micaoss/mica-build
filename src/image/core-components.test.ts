import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectCores } from './core-components.ts'

/** A pool directory of core components: each a record and the image it names. */
function pool(components: { package: string, version?: string, features: string[], needs?: object[], root?: object }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-cores-'))
  for (const c of components) {
    const version = c.version ?? '0.0.10'
    const image = Buffer.alloc(8192, c.package.length)
    writeFileSync(join(dir, `${c.package}_${version}_amd64.core.img`), image)
    writeFileSync(join(dir, `${c.package}_${version}_amd64.core.json`), JSON.stringify({ schema: 'mica/core/v1', arch: 'amd64', package: c.package, version,
      features: c.features, needs: c.needs ?? [], root: c.root ?? { min: 1 },
      content: { image: { bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') } } }))
  }
  return dir
}

test('the features select the components that serve them, in package order', () => {
  const dir = pool([{ package: 'micad', features: ['micad'] }, { package: 'mica-apid-ui', features: ['ui'], needs: [{ package: 'micad', min: '0.0.10', max: '0.0.10' }] }])
  try {
    expect(selectCores(dir, 'amd64', ['micad', 'ui', 'ssh']).map(s => s.record.package)).toEqual(['mica-apid-ui', 'micad'])
    expect(selectCores(dir, 'amd64', ['micad']).map(s => s.record.package)).toEqual(['micad'])
    expect(selectCores(dir, 'amd64', [])).toEqual([])
    expect(() => selectCores(dir, 'amd64', ['ui'])).toThrow('needs micad, which the features')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a component beyond this tree\'s root interface level, or needing another version, is refused', () => {
  const beyond = pool([{ package: 'micad', features: ['micad'], root: { min: 2 } }])
  const range = pool([{ package: 'micad', features: ['micad'] }, { package: 'mica-apid-ui', features: ['ui'], needs: [{ package: 'micad', min: '0.0.11' }] }])
  try {
    expect(() => selectCores(beyond, 'amd64', ['micad'])).toThrow('root interface levels 2..')
    expect(selectCores(beyond, 'amd64', ['micad'], 2).length).toBe(1)
    expect(() => selectCores(range, 'amd64', ['micad', 'ui'])).toThrow('needs micad 0.0.11..; the pool carries 0.0.10')
  }
  finally { for (const d of [beyond, range]) rmSync(d, { recursive: true, force: true }) }
})
