// veritysetup, against the real cryptsetup, driven from the failing side.
//
// The shape is rootfs/compose/90-pack.Dockerfile's: a squashfs-sized payload, the hash
// tree APPENDED to the same file at --hash-offset, a pinned salt and a pinned
// UUID, and the root hash read off stdout. `veritysetup verify` then walks the
// tree in userspace -- no device-mapper, no losetup, no mount -- which is what
// makes it safe here.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { openSync, closeSync, readFileSync, readSync, writeSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBoardEnv } from '../verify-package.ts'
import { makeWorkDir, REPO_ROOT } from '../paths.ts'
import { OPEN_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../testing.ts'
import { Toolbox, ToolError } from '../toolbox.ts'
import { VERITY } from '../toolsets.ts'
import { format, formatArgs, parseRootHash, verify } from './veritysetup.ts'

const DATA_BLOCK = 4096n
const HASH_BLOCK = 4096n
const PAYLOAD_BYTES = 4 * 1048576
/** The salt both boards pin, out of the definitions rather than written down here. */
const SALT = parseBoardEnv(readFileSync(join(REPO_ROOT, '_out/boards/cx3576/board.env'), 'utf8'), 'board.env').values.get('VERITY_SALT')!
const UUID = '5ac35760-0002-4000-8000-0000000001ff'

let tb: Toolbox
let work = ''

beforeAll(async () => {
  work = makeWorkDir('verity')
  tb = await Toolbox.open(VERITY, { mounts: [REPO_ROOT], cwd: work })
}, OPEN_TIMEOUT_MS)
afterAll(async () => {
  await tb?.close()
  if (work !== '') rmSync(work, { recursive: true, force: true })
}, OPEN_TIMEOUT_MS)

/** A deterministic payload with room after it for the hash tree. */
function makePayload(name: string, fill = 0x5a): string {
  const path = join(work, name)
  const buf = Buffer.alloc(PAYLOAD_BYTES + 4 * 1048576)
  buf.fill(fill, 0, PAYLOAD_BYTES)
  writeFileSync(path, buf)
  return path
}

function spec(path: string) {
  return {
    dataFile: path,
    hashFile: path,
    hashAlgorithm: 'sha256',
    dataBlockSize: DATA_BLOCK,
    hashBlockSize: HASH_BLOCK,
    dataBlocks: BigInt(PAYLOAD_BYTES) / DATA_BLOCK,
    hashOffset: BigInt(PAYLOAD_BYTES),
    salt: SALT,
    uuid: UUID,
  }
}

describe('the argv shape', () => {
  test('the shape rootfs/compose/90-pack.Dockerfile uses, with the salt and uuid pinned', () => {
    expect(formatArgs(spec('/out/rootfs-verity.img'))).toEqual([
      'veritysetup', 'format', '/out/rootfs-verity.img', '/out/rootfs-verity.img',
      '--hash=sha256', '--data-block-size=4096', '--hash-block-size=4096',
      '--data-blocks=1024', '--hash-offset=4194304',
      `--salt=${SALT}`, `--uuid=${UUID}`,
    ])
  })

  test('the salt comes out of the board definition and is the same on both boards', () => {
    expect(SALT).toMatch(/^[0-9a-f]{64}$/)
    expect(parseBoardEnv(readFileSync(join(REPO_ROOT, '_out/boards/x64/board.env'), 'utf8'), 'board.env').values.get('VERITY_SALT')!).toBe(SALT)
  })

  test('a salt that is not hex is refused: veritysetup would draw a RANDOM one', () => {
    expect(() => formatArgs({ ...spec('x'), salt: 'not hex' })).toThrow(/draws a RANDOM one/)
  })

  test('an empty uuid is refused: it is written INTO the superblock', () => {
    expect(() => formatArgs({ ...spec('x'), uuid: '  ' })).toThrow(/differ every build/)
  })

  test('zero data blocks is refused: veritysetup reads it as "the whole device"', () => {
    expect(() => formatArgs({ ...spec('x'), dataBlocks: 0n })).toThrow(/hash the hash tree along with the data/)
  })
})

describe('against the real veritysetup', () => {
  test('a payload formats, and the same inputs give the same root hash twice', async () => {
    const a = makePayload('a.img')
    const b = makePayload('b.img')
    const ha = await format(tb, spec(a))
    const hb = await format(tb, spec(b))
    expect(ha).toMatch(/^[0-9a-f]{64}$/)
    // Pinned salt and pinned uuid: identical inputs, identical hash. Without
    // either, veritysetup draws a random one and these would differ.
    expect(ha).toBe(hb)
  }, TOOL_TIMEOUT_MS)

  test('...and a DIFFERENT payload gives a different hash, so that comparison means something', async () => {
    const c = makePayload('c.img', 0x5b)
    expect(await format(tb, spec(c))).not.toBe(await format(tb, spec(join(work, 'a.img'))))
  }, TOOL_TIMEOUT_MS)

  test('the formatted payload verifies against its own root hash', async () => {
    const p = makePayload('v.img')
    const hash = await format(tb, spec(p))
    const r = await verify(tb, { dataFile: p, hashFile: p, rootHash: hash, hashOffset: BigInt(PAYLOAD_BYTES) })
    expect(r.ok).toBe(true)
  }, TOOL_TIMEOUT_MS)

  test('a payload with ONE byte changed does not verify -- and that is a verdict, not a throw', async () => {
    // The distinction matters for the caller: a payload that fails to verify is
    // something the verifier REPORTS, and a veritysetup that could not run at
    // all is an error. The verification contract reports the first as a fail line.
    const p = makePayload('t.img')
    const hash = await format(tb, spec(p))
    const fd = openSync(p, 'r+')
    try {
      const one = Buffer.alloc(1)
      readSync(fd, one, 0, 1, 1024)
      one[0] = (one[0]! ^ 0xff)
      writeSync(fd, one, 0, 1, 1024)
    } finally { closeSync(fd) }

    const r = await verify(tb, { dataFile: p, hashFile: p, rootHash: hash, hashOffset: BigInt(PAYLOAD_BYTES) })
    expect(r.ok).toBe(false)
    expect(r.output.length).toBeGreaterThan(0)
  }, TOOL_TIMEOUT_MS)

  test('a root hash that is not hex is refused before veritysetup runs', async () => {
    // Left to the tool, the failure reads as the PAYLOAD being corrupt.
    const p = join(work, 'v.img')
    await expect(verify(tb, { dataFile: p, hashFile: p, rootHash: '', hashOffset: 0n }))
      .rejects.toThrow(/which is not hex/)
    await expect(verify(tb, { dataFile: p, hashFile: p, rootHash: 'zz', hashOffset: 0n }))
      .rejects.toThrow(/as the hash being unreadable/)
  })
})

describe('every failure is reported', () => {
  test('formatting a file that is not there is a ToolError carrying veritysetup\'s words', async () => {
    let err: ToolError | undefined
    try { await format(tb, spec(join(work, 'absent.img'))) } catch (e) { err = e as ToolError }
    expect(err).toBeInstanceOf(ToolError)
    expect(err!.message).toContain('absent.img')
    expect(err!.exitCode).not.toBe(0)
  }, TOOL_TIMEOUT_MS)

  test('asking for more data blocks than the file holds fails rather than truncating', async () => {
    const p = makePayload('short.img')
    await expect(format(tb, { ...spec(p), dataBlocks: 1_000_000n })).rejects.toThrow(/could not format a hash tree/)
  }, TOOL_TIMEOUT_MS)

  test('a format that printed no root hash is a failure, and the parse says so', () => {
    // Reachable only from here: no argument makes the real veritysetup exit 0
    // and print no hash, so this is the guard that would otherwise never run.
    expect(parseRootHash('Root hash:      abc123\n')).toBe('abc123')
    expect(parseRootHash('VERITY header information for x\nSalt:  00\n')).toBeUndefined()
    expect(parseRootHash('')).toBeUndefined()
    // ...and the positive control that it reads the REAL tool's shape, taken
    // from veritysetup's own output rather than invented.
    expect(parseRootHash('Hash algorithm: sha256\nSalt:           0000\nRoot hash:      DEADBEEF\n')).toBe('deadbeef')
  })
})
