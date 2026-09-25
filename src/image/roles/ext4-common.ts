// The ext4 filesystems the roles make: the same maker, fixed time and feature floor, pinned times and a clean
// check, over a seed tree.
import { mke2fs } from '../tools/e2fsprogs.ts'
import { pinSeededTimes } from '../pin-seeded-times.ts'
import type { Toolbox } from '../toolbox.ts'
import type { FilePartition } from '../file-layout.ts'

export const EXT4_FEATURES = '^orphan_file,^metadata_csum_seed'
export const FAKE_TIME = '1577836800'

export async function makeExt4(tb: Toolbox, partition: FilePartition, output: string, seedDir: string, options: { quota?: boolean } = {}): Promise<void> {
  await tb.must(['truncate', '-s', String(partition.sizeSectors * 512), output])
  await mke2fs(tb, { image: output, label: partition.name, uuid: partition.fsUuid!, blockSize: 4096n,
    bytesPerInode: options.quota ? 16384 : undefined, features: `${options.quota ? 'project,quota,' : ''}${EXT4_FEATURES}`,
    fakeTime: FAKE_TIME, seedDir })
}

export async function finishExt4(tb: Toolbox, output: string): Promise<void> {
  await pinSeededTimes(tb, output, `@${FAKE_TIME}`)
  await tb.must(['e2fsck', '-fn', output])
}
