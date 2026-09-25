// vfat: a board's own FAT partition (a vendor recovery or configuration partition), seeded from
// partitions/<name>/ of the board directory, labelled with the partition's name. The seed is staged and its
// times pinned first, as the esp tree is, so the partition does not carry the checkout's mtimes.
import { cpSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RoleBuilder } from './context.ts'
import { seedDirectory } from './context.ts'
import { FAKE_TIME } from './ext4-common.ts'

export const fatLabel = (name: string) => name.toUpperCase().replace(/-/g, '_').slice(0, 11)

export const vfat: RoleBuilder = {
  async build(ctx, partition, output) {
    await ctx.tb.must(['truncate', '-s', String(partition.sizeSectors * 512), output])
    await ctx.tb.must(['mkfs.vfat', '--invariant', '-F', '32', '-i', partition.volumeId!, '-n', fatLabel(partition.name), output])
    const seed = seedDirectory(ctx.bundle, partition)
    if (!existsSync(seed)) return
    const staged = `${output}.seed`
    cpSync(seed, staged, { recursive: true })
    await ctx.tb.must(['find', staged, '-exec', 'touch', '-h', '-d', `@${FAKE_TIME}`, '{}', '+'])
    for (const name of readdirSync(staged).sort()) await ctx.tb.must(['mcopy', '-s', '-m', '-i', output, join(staged, name), '::/'])
  },
}
