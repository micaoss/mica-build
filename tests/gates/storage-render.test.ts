import { expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'
import { discover } from '../../src/pool/producers.ts'
import { resolve } from '../../src/rootfs/resolve.ts'

const root = pathResolve(import.meta.dir, '../..')

test('the producer discovers one package per layout and the renderer protects preserved slots', async () => {
  mkdirSync(join(root, 'tmp'), { recursive: true })
  const dir = mkdtempSync(join(root, 'tmp/storage-render.'))
  try {
    for (const name of ['Makefile', 'common', 'boards/uefi-x64']) cpSync(join(root, name), join(dir, name), { recursive: true })
    const board = join(dir, 'boards/uefi-x64')
    const layout = readFileSync(join(board, 'layout.tsv'), 'utf8')
    writeFileSync(join(board, 'layout-vendor.tsv'), layout.replace('part\t1\tesp', 'discard\tno\npart\t4\tvendor_slot\tpreserved\t34\t1\t0FC63DAF-8483-4772-8E79-3D69D8477DE4\t5AC35760-0999-4000-8000-000000000004\t-\npart\t1\tesp'))
    // The renderer consumes an already validated table; the layout engine checks alignment separately.
    const producer = discover(dir).find(p => p.name === 'board@uefi-x64')!
    expect(producer.packages).toEqual(['mica-board-uefi-x64', 'mica-board-uefi-x64-vendor'])
    const src = join(dir, 'render-input')
    cpSync(board, src, { recursive: true })
    cpSync(join(root, 'common/package'), join(src, 'common'), { recursive: true })
    cpSync(join(board, 'package/overlay'), join(src, 'overlay'), { recursive: true })
    const output = join(dir, 'rendered')
    const run = Bun.spawnSync(['bash', join(root, 'common/board/render.sh'), src, output, 'layout-vendor.tsv'])
    expect(run.exitCode).toBe(0)
    expect(readFileSync(join(output, 'systemd-repart.service.d/10-data.conf'), 'utf8')).toContain('--discard=no')
    expect([...new Bun.Glob('*.conf').scanSync({ cwd: join(output, 'repart.d') })].sort()).toEqual(['10-esp.conf', '20-system.conf', '30-data.conf'])
    const declared = new Set(['base', 'init', 'mica-board-fixture', 'mica-board-fixture-vendor'])
    const engine = join(dir, 'engine'), manifests = join(dir, 'manifests')
    mkdirSync(engine); mkdirSync(manifests)
    writeFileSync(join(engine, 'common.pkgs'), 'base\n')
    writeFileSync(join(engine, 'init-systemd.pkgs'), 'init\n')
    writeFileSync(join(manifests, 'board.pkgs'), 'mica-board-fixture\n')
    expect(await resolve({ board: 'fixture', boardDir: manifests, features: '', storageLayout: 'vendor', packagesDir: engine, declared })).toEqual(['base', 'init', 'mica-board-fixture-vendor'])
    expect(await resolve({ board: 'fixture', boardDir: manifests, features: '', packagesDir: engine, declared })).toEqual(['base', 'init', 'mica-board-fixture'])
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
