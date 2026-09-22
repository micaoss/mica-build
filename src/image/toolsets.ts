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
