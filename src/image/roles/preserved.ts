// A factory image carries zeros for vendor slots; installation must never write these placeholders.
import { truncateSync, writeFileSync } from 'node:fs'
import type { RoleBuilder } from './context.ts'

export const preserved: RoleBuilder = {
  async build(_ctx, partition, output) {
    writeFileSync(output, '', { flag: 'wx' })
    truncateSync(output, partition.sizeSectors * 512)
  },
}
