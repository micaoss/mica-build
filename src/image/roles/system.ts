// system: the ext4 deployments store -- the roots, kernels and signed records of both factory deployments, and
// the boot objects too where the layout has no esp -- checked to retain two full deployments with reserve.
import { checkSystemFilesystemCapacity } from '../file-layout.ts'
import { dumpe2fsHeader } from '../tools/e2fsprogs.ts'
import type { RoleBuilder } from './context.ts'
import { finishExt4, makeExt4 } from './ext4-common.ts'

export const system: RoleBuilder = {
  async build(ctx, partition, output) {
    await makeExt4(ctx.tb, partition, output, ctx.trees.system)
    const bootOnSystem = !ctx.layout.partitions.some(p => p.role === 'esp')
    checkSystemFilesystemCapacity(await dumpe2fsHeader(ctx.tb, output), ctx.systemBytes + (bootOnSystem ? ctx.bootBytes : 0))
    await finishExt4(ctx.tb, output)
  },
}
