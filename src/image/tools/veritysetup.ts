// veritysetup: the dm-verity hash tree.
//
// FAILURE SIGNAL. Its exit status -- and, for `format`, ONE MORE that the exit
// status does not carry: the root hash is its ANSWER, printed on stdout, and a
// run that produced no readable one has failed whatever it exited with.
// rootfs/compose/90-pack.Dockerfile parses it and then asserts `test -n
// "${root_hash}"`, and that assertion is the whole reason this wrapper parses
// rather than returning text: an empty root hash propagates into a kernel
// cmdline, and a device that cannot assemble /dev/dm-0 stops at "ALERT!
// /dev/dm-0 does not exist" with nothing to say why.
//
// REPRODUCIBILITY. `--salt` and `--uuid` both default to RANDOM values, and the
// UUID lands in the verity superblock at the hash offset -- so leaving either
// unset makes the image differ on every run. Both are required fields here.
//
// WHOSE TOOL THIS IS. Neither disk assembler runs veritysetup: the rootfs build
// formats the tree (M5) and the image verifier walks it (M4), and the
// assemblers only dd the finished image into a slot. It is wrapped here because
// M6a's scope names it and because the two callers that will want it are both
// in this campaign; it has its own toolset for the same reason (see
// src/toolsets.ts).

import type { Toolbox } from '../toolbox.ts'
import { ToolError } from '../toolbox.ts'

export interface VerityFormatSpec {
  /** The data device -- and, with hashOffset, the hash device too: one file. */
  readonly dataFile: string
  readonly hashFile: string
  readonly hashAlgorithm: string
  readonly dataBlockSize: bigint
  readonly hashBlockSize: bigint
  readonly dataBlocks: bigint
  /** Where the hash tree is appended, when it shares the file with the data. */
  readonly hashOffset?: bigint
  /** Pinned. Random by default, which would make the image differ every build. */
  readonly salt: string
  /** Pinned. Random by default, and it lands IN the superblock. */
  readonly uuid: string
}

export function formatArgs(spec: VerityFormatSpec): string[] {
  if (spec.dataBlocks <= 0n) {
    // `--data-blocks=0` means "the whole device" to veritysetup, which for a
    // file that already contains its own hash tree is a tree over the tree.
    throw new Error(
      `veritysetup was asked to format ${spec.dataBlocks} data blocks of ${spec.dataFile}. Zero is `
      + `veritysetup's spelling for "the whole device", so this would not fail -- it would hash the `
      + `hash tree along with the data.`,
    )
  }
  if (!/^[0-9a-fA-F]+$/.test(spec.salt)) {
    throw new Error(
      `veritysetup was given --salt="${spec.salt}" for ${spec.dataFile}, which is not hex. The salt `
      + `is pinned in the board definition (VERITY_SALT) because veritysetup draws a RANDOM one `
      + `otherwise, and a random salt makes the rootfs image differ on every build.`,
    )
  }
  if (spec.uuid.trim() === '') {
    throw new Error(
      `veritysetup was given an empty --uuid for ${spec.dataFile}. It defaults to a random UUID, and `
      + `that UUID is written INTO the verity superblock -- so the image would differ every build.`,
    )
  }
  const argv = [
    'veritysetup', 'format', spec.dataFile, spec.hashFile,
    `--hash=${spec.hashAlgorithm}`,
    `--data-block-size=${spec.dataBlockSize}`,
    `--hash-block-size=${spec.hashBlockSize}`,
    `--data-blocks=${spec.dataBlocks}`,
  ]
  if (spec.hashOffset !== undefined) argv.push(`--hash-offset=${spec.hashOffset}`)
  argv.push(`--salt=${spec.salt}`, `--uuid=${spec.uuid}`)
  return argv
}

/**
 * The root hash out of `veritysetup format`'s output, or undefined.
 *
 * Exported so the refusal below is REACHABLE without a veritysetup that
 * misbehaves: no argument makes the real tool exit 0 and print no hash, so a
 * guard against it could otherwise never be run -- and this campaign has twice
 * found a guard that was itself unreachable, each time only by mutating it.
 */
export function parseRootHash(stdout: string): string | undefined {
  const m = /^Root hash:\s+([0-9a-fA-F]+)\s*$/m.exec(stdout)
  if (m === null || m[1] === undefined) return undefined
  return m[1].toLowerCase()
}

/**
 * Format the hash tree and return the root hash.
 *
 * @throws ToolError when veritysetup fails, AND when it succeeds without
 *   printing a root hash this can read. The second is the failure the exit
 *   status does not carry.
 */
export async function format(tb: Toolbox, spec: VerityFormatSpec): Promise<string> {
  const r = await tb.must(formatArgs(spec), {
    note: `veritysetup could not format a hash tree over ${spec.dataFile}`,
  })
  const hash = parseRootHash(r.stdout)
  if (hash === undefined) {
    throw new ToolError(
      r,
      `veritysetup format exited 0 over ${spec.dataFile} and printed no readable "Root hash:" line. `
      + `The root hash IS the answer -- it goes into the kernel cmdline -- so an unreadable one is a `
      + `failed format however it exited. A device handed an empty hash stops at "ALERT! /dev/dm-0 `
      + `does not exist"`,
    )
  }
  return hash
}

export interface VerityVerifySpec {
  readonly dataFile: string
  readonly hashFile: string
  readonly rootHash: string
  readonly hashOffset?: bigint
}

/**
 * `veritysetup verify` -- walks the tree in USERSPACE.
 *
 * the verification contract's note is worth keeping attached to it: it "never
 * creates a device-mapper target, never calls losetup and never mounts
 * anything, which is what makes this safe to run against the host."
 *
 * Returns true or false rather than throwing on a mismatch: a payload that does
 * not verify is a VERDICT the caller reports, not an error in running the tool.
 * A tool that could not run at all still throws.
 */
export async function verify(tb: Toolbox, spec: VerityVerifySpec): Promise<{ ok: boolean, output: string }> {
  if (!/^[0-9a-fA-F]+$/.test(spec.rootHash)) {
    // An empty or malformed hash makes veritysetup fail for the wrong reason,
    // and "verification failed" would then be reported about the payload.
    throw new Error(
      `veritysetup verify was given the root hash "${spec.rootHash}" for ${spec.dataFile}, which is `
      + `not hex. It would fail -- and the failure would read as the payload being corrupt rather `
      + `than as the hash being unreadable.`,
    )
  }
  const argv = ['veritysetup', 'verify', spec.dataFile, spec.hashFile, spec.rootHash]
  if (spec.hashOffset !== undefined) argv.push(`--hash-offset=${spec.hashOffset}`)
  const r = await tb.run(argv)
  return { ok: r.ok, output: `${r.stdout}${r.stderr}` }
}
