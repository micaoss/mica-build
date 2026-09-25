// raw: bytes placed by the partition's region rows over zeros (src/image/regions.ts).
import { writeRawPartition } from '../regions.ts'
import type { RoleBuilder } from './context.ts'

export const raw: RoleBuilder = {
  async build(ctx, partition, output) {
    writeRawPartition(ctx.layout, partition, { facts: ctx.facts, loader: ctx.firmware, records: ctx.records, bundle: ctx.bundle }, output)
  },
}
