import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { componentId } from '../../build/src/components'

export const image = Buffer.alloc(12288, 42)
export const small = Buffer.from('0123456789')
export const artifact = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
export function deployment(generation = 1, board = 'x64') {
  const d = JSON.parse(readFileSync(new URL('../../tests/component-contracts/deployment.json', import.meta.url), 'utf8'))
  d.board = board
  d.kernel.board = board
  d.arch = board === 'x64' ? 'amd64' : 'arm64'
  d.kernel.arch = d.arch
  d.rootfs.arch = d.arch
  d.kernel.boot.format = board === 'cx3576' ? 'fit' : 'uki'
  d.generation = generation
  d.version = `test-${generation}`
  d.kernel.boot.artifact = artifact(small)
  for (const content of [d.kernel.support, d.rootfs.content]) {
    content.image = artifact(image)
    content.signature = artifact(small)
    content.verity.dataBlocks = 2
    content.verity.hashOffset = 8192
  }
  d.kernel.id = componentId(d.kernel)
  d.rootfs.id = componentId(d.rootfs)
  return d
}
