// What a partition role builds from: the assembly's staged trees and objects, and the board's layout.
import type { BoardFacts } from '../board-facts.ts'
import type { FileLayout, FilePartition } from '../file-layout.ts'
import type { FitBootRecord } from '../fit-environment.ts'
import type { Toolbox } from '../toolbox.ts'

/** The factory seed's name at the root of the esp, where mica-provisioning-import reads it on first boot. */
export const PROVISIONING_DOCUMENT = 'mica-provisioning.toml'

export interface RoleContext {
  tb: Toolbox
  layout: FileLayout
  facts: BoardFacts
  /** The staged trees: the deployments store, the boot medium's tree, the DATA tree. */
  trees: { system: string, esp: string, data: string }
  /** The authenticated loader file. */
  firmware: string
  /** The factory boot records, newest first. */
  records: FitBootRecord[]
  /** The fetched board bundle, where a seed directory or a region file is read from. */
  bundle: string
  /** The largest deployment's bytes on system, and its boot object's; the boot object lives on system when
   * the layout has no esp. */
  systemBytes: number
  bootBytes: number
  /** A factory seed for the esp (mica-provisioning.toml). */
  provisioning?: string
}

/** A role: how the engine builds a partition of it into `output`, a file of the partition's size. */
export interface RoleBuilder {
  build(ctx: RoleContext, partition: FilePartition, output: string): Promise<void>
}

/** The seed directory of a vfat or ext4 partition: `partitions/<name>/` of the board directory, if it has one. */
export const seedDirectory = (bundle: string, partition: FilePartition): string => `${bundle}/partitions/${partition.name}`
