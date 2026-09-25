// The layout lint: every shipped board's layout.tsv against the rules of src/image/file-layout.ts, and its loader
// region against where its firmware facts place the loader (make os-layout-lint; the board contract test runs it
// over boards/<board>/).
//
// UNTIL P3b OF mica:docs/plan/20260921-1142-merge-boards-into-build.md, board.env still declares the geometry
// for the one reader left, producers/board/render.sh (the device's repart set, fstab and ESP mount). Two
// declarations of one disk are one that is not enforced, so while board.env carries them this lint also holds
// them to the table, field for field; the comparison is deleted with the keys.
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { boardFactsFrom } from '../image/board-facts.ts'
import { loadLayout, regionOf, type FileLayout } from '../image/file-layout.ts'
import { checkLoaderPlacement } from '../image/regions.ts'
import { parseBoardEnv } from './board-env.ts'
import { boardEnvPath, requireShippedBoards } from './paths.ts'

/** Where the board.env geometry of render.sh differs from layout.tsv; empty when it carries none or agrees. */
export function legacyDisagreement(envText: string, layout: FileLayout): string[] {
  const env = parseBoardEnv(envText, 'board.env').values
  const partitionsList = env.get('LAYOUT_PARTITIONS')
  if (partitionsList === undefined) return []
  const out: string[] = []
  const same = (what: string, a: string | number | undefined, b: string | number | undefined) => {
    if (String(a ?? '').toLowerCase() !== String(b ?? '').toLowerCase()) out.push(`${what}: board.env ${a ?? '(none)'}, layout.tsv ${b ?? '(none)'}`)
  }
  same('the disk guid', env.get('DISK_GUID'), layout.diskGuid)
  same('the alignment', env.get('GPT_ALIGN_SECTORS'), layout.alignSectors)
  const names = partitionsList.split(/\s+/).filter(Boolean)
  same('the partition count', names.length, layout.partitions.length)
  for (const [i, name] of names.entries()) {
    const p = layout.partitions[i]
    const v = (suffix: string) => env.get(`${name}_${suffix}`)
    const start = v('START_SECTOR') ?? String(Number(v('START_MIB')) * 2048), size = v('SIZE_SECTORS') ?? String(Number(v('SIZE_MIB')) * 2048)
    same(`${name} number`, v('PARTNUM'), p?.number)
    same(`${name} name`, v('LABEL'), p?.name)
    same(`${name} start`, start, p?.startSector)
    same(`${name} size`, size, p?.sizeSectors)
    same(`${name} type`, v('TYPECODE'), p?.type)
    same(`${name} guid`, v('GUID'), p?.guid)
    if (v('FS_UUID') !== undefined) same(`${name} filesystem uuid`, v('FS_UUID'), p?.fsUuid)
    if (name === 'ESP') same('ESP volume id', env.get('ESP_FAT_VOLUME_ID'), p?.volumeId)
  }
  if (env.has('UENV_A_OFFSET_BYTES')) {
    same('records-a', env.get('UENV_A_OFFSET_BYTES'), regionOf(layout, 'records-a')?.diskOffset)
    same('records-b', env.get('UENV_B_OFFSET_BYTES'), regionOf(layout, 'records-b')?.diskOffset)
    same('the record size', env.get('UENV_SIZE_BYTES'), regionOf(layout, 'records-a')?.size)
  }
  if (env.has('UBOOT_SEEK_SECTOR')) same('the loader', Number(env.get('UBOOT_SEEK_SECTOR')) * 512, regionOf(layout, 'loader')?.diskOffset)
  return out
}

if (import.meta.main) {
  const args = Bun.argv.slice(2)
  const files = args.length ? args : requireShippedBoards().map(boardEnvPath)
  for (const file of files) {
    try {
      const layout = loadLayout(dirname(file))
      checkLoaderPlacement(layout, boardFactsFrom(file))
      const drift = legacyDisagreement(readFileSync(file, 'utf8'), layout)
      if (drift.length > 0) throw new Error(`board.env and layout.tsv declare two disks: ${drift.join('; ')}`)
      console.log(`PASS: ${layout.board} ${layout.backend} layout: ${layout.partitions.map(p => `${p.name}:${p.role}`).join(' ')}`)
    }
    catch (error) { console.error(`FAIL: ${file}: ${String(error)}`); process.exitCode = 1 }
  }
}
