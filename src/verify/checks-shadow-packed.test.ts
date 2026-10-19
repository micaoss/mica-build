// factory-shadow-mode on a factory image: the mode and ownership squashfs
// carries, not what unpacking left on the disk. A shared host mount (Docker
// Desktop's) remaps ownership as unsquashfs writes, so the unpacked tree can
// say 1000:1000 while the image says 0:42.

import { describe, expect, test } from 'bun:test'
import { chownSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard } from './board.ts'
import { packedRootFixture } from './checks-fixture.ts'
import { SHADOW_CHECKS } from './checks-shadow.ts'
import type { ToolRuntime } from './tools.ts'
import type { CheckResult } from './check-types.ts'

const REPO_ROOT = join(import.meta.dir, '../..')
const board = loadBoard(join(REPO_ROOT, 'boards/cx3576/board.env'))
const check = SHADOW_CHECKS.find(c => c.id === 'factory-shadow-mode')!

/** `unsquashfs -lln` of the one path, as the packed image lists it. */
function listing(line: string): ToolRuntime {
  return {
    route: 'host', announce: 'fixture', dispose: async () => {},
    run: async (argv: readonly string[]) => {
      expect(argv.slice(0, 2)).toEqual(['unsquashfs', '-lln'])
      return { argv, code: 0, stdout: `${line} squashfs-root/usr/share/factory/etc/shadow\n`, stderr: '' }
    },
  } as unknown as ToolRuntime
}

async function verdictWith(tools: ToolRuntime): Promise<CheckResult> {
  const fx = packedRootFixture(board)
  // What the shared mount leaves on the unpacked copy.
  chownSync(join(fx.root, 'usr/share/factory/etc/shadow'), 1000, 1000)
  try {
    const got = await check.run({ ...fx.ctx, packedRootfs: '/image/rootfs.squashfs', tools })
    expect(got.length).toBe(1)
    return got[0]!
  }
  finally {
    fx.dispose()
  }
}

describe('factory-shadow-mode reads the packed image', () => {
  test('0640 root:shadow in the image passes, whatever the unpacked copy is owned by', async () => {
    expect((await verdictWith(listing('-rw-r----- 0/42 612 2026-09-29 00:00'))).verdict).toBe('pass')
  })
  test('the wrong group in the image fails', async () => {
    const r = await verdictWith(listing('-rw-r----- 0/0 612 2026-09-29 00:00'))
    expect(r.verdict).toBe('fail')
    expect(r.message).toContain('owner 0:0')
  })
  test('a world-readable template in the image fails', async () => {
    expect((await verdictWith(listing('-rw-r--r-- 0/42 612 2026-09-29 00:00'))).verdict).toBe('fail')
  })
})
