// ext4: a board's own ext4 partition (a vendor or configuration partition), seeded from partitions/<name>/ of
// the board directory, empty without one. The seed is staged beside the partition image, inside the tree the
// toolbox mounts.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import type { RoleBuilder } from './context.ts'
import { seedDirectory } from './context.ts'
import { finishExt4, makeExt4 } from './ext4-common.ts'

export const ext4: RoleBuilder = {
  async build(ctx, partition, output) {
    const seed = seedDirectory(ctx.bundle, partition), staged = `${output}.seed`
    if (existsSync(seed)) cpSync(seed, staged, { recursive: true })
    else mkdirSync(staged)
    await makeExt4(ctx.tb, partition, output, staged)
    await finishExt4(ctx.tb, output)
  },
}
