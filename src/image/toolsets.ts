import type { Toolset } from './toolbox.ts'

export const VERITY: Toolset = {
  key: 'verity',
  imageKey: 'upstream:alpine:3.24.1',
  manager: 'apk',
  packages: ['cryptsetup'],
  tools: ['veritysetup'],
}

export const COREUTILS: Toolset = {
  key: 'coreutils',
  imageKey: 'upstream:alpine:3.24.1',
  manager: 'apk',
  packages: ['coreutils'],
  tools: ['dd', 'truncate'],
}

// ubinize and mkfs.ubifs: a ubi board's flash image, its UBI device and the UBIFS of SYSTEM (src/image/flash-image.ts).
// GNU tar stages the SYSTEM tree in name order; BusyBox's tar has no --sort.
export const MTD_UTILS: Toolset = {
  key: 'mtd-utils',
  imageKey: 'upstream:alpine:3.24.1',
  manager: 'apk',
  packages: ['mtd-utils-ubi', 'tar'],
  tools: ['ubinize', 'mkfs.ubifs', 'tar'],
}
