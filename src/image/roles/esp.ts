// esp: the EFI System Partition a systemd-boot board boots from -- FAT32 (FAT16 below 64 MiB, fatBits) with the loader tree, the boot entries
// and the factory seed the assembly staged, labelled MICAESP, with the board's volume id.
import { join } from 'node:path'
import { fatBits } from '../tools/mtools.ts'
import { PROVISIONING_DOCUMENT, type RoleBuilder } from './context.ts'

export const esp: RoleBuilder = {
  async build(ctx, partition, output) {
    await ctx.tb.must(['truncate', '-s', String(partition.sizeSectors * 512), output])
    await ctx.tb.must(['mkfs.vfat', '--invariant', '-F', String(fatBits(partition.sizeSectors * 512)), '-i', partition.volumeId!, '-n', 'MICAESP', output])
    for (const name of ['EFI', 'loader', ...(ctx.provisioning !== undefined ? [PROVISIONING_DOCUMENT] : [])]) await ctx.tb.must(['mcopy', '-s', '-m', '-i', output, join(ctx.trees.esp, name), '::/'])
  },
}
