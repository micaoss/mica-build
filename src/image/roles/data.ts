// data: the ext4 DATA tree with project quotas, grown at first boot (the last partition).
import type { RoleBuilder } from './context.ts'
import { FAKE_TIME, finishExt4, makeExt4 } from './ext4-common.ts'

export const data: RoleBuilder = {
  async build(ctx, partition, output) {
    await makeExt4(ctx.tb, partition, output, ctx.trees.data, { quota: true })
    // mke2fs initializes quota accounting before importing the seed tree.
    // Account for those files before publishing the complete factory image. e2fsck takes its clock from
    // E2FSCK_TIME, not E2FSPROGS_FAKE_TIME: with only the latter it stamped the superblock's write and check
    // times with the build's wall clock, and two assemblies of the same inputs differed (2026-09-25).
    const checked = await ctx.tb.run(['env', `E2FSPROGS_FAKE_TIME=${FAKE_TIME}`, `E2FSCK_TIME=${FAKE_TIME}`, 'e2fsck', '-fy', output])
    if (![0, 1].includes(checked.exitCode)) throw new Error(`Factory quota initialization failed: ${checked.stderr}`)
    await finishExt4(ctx.tb, output)
  },
}
