import type { Toolset } from './toolbox.ts'

export const VERITY: Toolset = {
  key: 'verity',
  imageKey: 'IMAGE_ALPINE_3_21',
  manager: 'apk',
  packages: ['cryptsetup'],
  tools: ['veritysetup'],
}

export const COREUTILS: Toolset = {
  key: 'coreutils',
  imageKey: 'IMAGE_ALPINE_3_21',
  manager: 'apk',
  packages: ['coreutils'],
  tools: ['dd', 'truncate'],
}
