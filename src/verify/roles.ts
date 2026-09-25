// The verifier's side of the partition roles: what a partition of each role must be, read out of the extracted
// partition and the board's layout.tsv. It is the verifier's own registry, keyed by the same role names as the
// engine's (src/image/roles/index.ts) and written apart from it, so an assembly that drifted from its layout is
// found by a reader that did not share its code. The board contract test holds both registries to the one list
// of roles (ROLE_NAMES, src/image/file-layout.ts).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileLayout, FilePartition, Role } from '../image/file-layout.ts'
import { e2fsckClean, ext4Super, fatVolumeLabel, fatVolumeSerial } from './image.ts'
import type { ToolRuntime } from './tools.ts'

export interface VerifyContext { tools: ToolRuntime, layout: FileLayout, bundle: string }

function requireFact(ok: boolean, fact: string): asserts ok {
  if (!ok) throw new Error(fact)
}

async function ext4(ctx: VerifyContext, p: FilePartition, file: string, quota = false): Promise<void> {
  const fs = await ext4Super(ctx.tools, file)
  requireFact(fs.uuid.toLowerCase() === p.fsUuid && fs.volumeName === p.name
    && fs.blockSize === 4096 && fs.blockCount * fs.blockSize === p.sizeSectors * 512
    && fs.features.includes('has_journal') && !fs.features.includes('needs_recovery')
    && !fs.features.includes('orphan_file') && !fs.features.includes('metadata_csum_seed'), `${p.name} filesystem identity, geometry or features mismatch`)
  const checked = await e2fsckClean(ctx.tools, file)
  requireFact(checked.clean, `${p.name} filesystem is not clean: ${checked.report.join('; ')}`)
  if (quota) requireFact(fs.features.includes('project') && fs.features.includes('quota'), `${p.name} project quotas absent`)
}

/** Every file region of a raw partition holds its file's bytes; the loader and record regions are read by the
 * checks that know the firmware receipt and the deployments. */
async function raw(ctx: VerifyContext, p: FilePartition, file: string): Promise<void> {
  const bytes = readFileSync(file)
  for (const r of ctx.layout.regions.filter(x => x.partition === p.name && x.source.startsWith('file:'))) {
    const path = join(ctx.bundle, r.source.slice('file:'.length))
    requireFact(existsSync(path), `region ${r.name}: ${path} does not exist`)
    const want = readFileSync(path)
    requireFact(bytes.subarray(r.offset, r.offset + want.length).equals(want) && bytes.subarray(r.offset + want.length, r.offset + r.size).every(b => b === 0),
      `region ${r.name} of ${p.name} does not hold ${r.source.slice('file:'.length)}`)
  }
}

async function vfat(ctx: VerifyContext, p: FilePartition, file: string): Promise<void> {
  const slot = { image: file, offsetBytes: 0 }
  requireFact((await fatVolumeSerial(ctx.tools, slot)).toUpperCase() === p.volumeId, `${p.name} FAT volume id mismatch`)
  requireFact(await fatVolumeLabel(ctx.tools, slot) === p.name.toUpperCase().replace(/-/g, '_').slice(0, 11), `${p.name} FAT label mismatch`)
}

/** What each role's extracted partition must be. The esp's contents are the boot checks' (entries, loader). */
export const VERIFY_ROLES: Readonly<Record<Role, (ctx: VerifyContext, p: FilePartition, file: string) => Promise<void>>> = {
  esp: async () => {},
  system: (ctx, p, file) => ext4(ctx, p, file),
  data: (ctx, p, file) => ext4(ctx, p, file, true),
  raw,
  vfat,
  ext4: (ctx, p, file) => ext4(ctx, p, file),
}
