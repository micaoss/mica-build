import { lstatSync, readdirSync, readlinkSync, type Stats } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import type { ImageContext } from './checks.ts'
import { ToolOutputError } from './tools.ts'

export async function packedRoot(ctx: ImageContext): Promise<string> {
  const root = await ctx.unpackRoot()
  if (readdirSync(root).length === 0) {
    throw new ToolOutputError(
      `${root} is empty. unsquashfs exited 0 and unpacked nothing, so every "is this path in the `
      + `image?" check below would answer no and every "is this path ABSENT?" check would answer `
      + `yes -- a whole batch of green about an image that was never read.`,
    )
  }
  return root
}

/**
 * `lstat`, or undefined. Never follows a link AT the path: what is at the path
 * is the question, and a symlink is its own answer.
 *
 * The DIRECTORY CHAIN leading to it is resolved inside the root, so a parent
 * component that is an absolute symlink cannot turn this into an lstat of a
 * host path -- see `resolveInRoot` for what that difference costs.
 *
 * Exported for M4d: the board-conditional families read the same tree through
 * the same predicate, and a second spelling of "a regular file and not a link
 * to one" beside this one is how two batches come to disagree about a path.
 */
export function entry(root: string, path: string): Stats | undefined {
  const at = resolveInRoot(root, path, false)
  if (at === undefined) return undefined
  try {
    return lstatSync(at)
  }
  catch {
    return undefined
  }
}

/** Linux's own ELOOP ceiling, so a cycle ends the walk where the kernel ends it. */
const SYMLINK_HOPS = 40

/**
 * `path`, resolved THE WAY THE DEVICE WOULD -- every symlink followed INSIDE
 * the unpacked root, absolute targets re-rooted, `..` clamped at the root as a
 * chroot clamps it, the walk bounded at Linux's own ELOOP ceiling -- returned
 * as a path on THIS host. undefined when a hop on the way is missing.
 *
 * THIS IS THE VERIFIER'S ONLY PATH RESOLVER, and it exists because the obvious
 * spelling is wrong in a way that reads correct. `statSync(join(root, path))`
 * hands the whole path to the HOST kernel: a relative symlink inside the root
 * resolves correctly by accident, because the host resolves it relative to
 * where it sits, but an ABSOLUTE one is resolved against the host's `/`, and
 * the answer for such a path is a fact about the machine running the verifier.
 *
 * Measured, and it is the reason this exists: Debian's `wireless-regdb`
 * registers its database through update-alternatives, so a shipped root
 * carries `/usr/lib/firmware/regulatory.db -> /etc/alternatives/regulatory.db
 * -> /lib/firmware/regulatory.db-debian` -- two absolute hops and a merged-usr
 * one. The file is present and correct; `statSync` reported it missing,
 * because the host has no `/etc/alternatives/regulatory.db`. On a host that
 * happened to have one it would have reported the HOST's database as the
 * image's, which is the direction no failing check would ever announce.
 *
 * With `followLeaf: false` the walk stops one component short: the directory
 * chain is resolved and the last component is not, which is the question an
 * lstat asks.
 */
function resolveInRoot(root: string, path: string, followLeaf: boolean): string | undefined {
  let current = path.startsWith('/') ? path : `/${path}`
  for (let hop = 0; hop <= SYMLINK_HOPS; hop += 1) {
    // Normalised first, so a `..` in a link target is collapsed the way the
    // kernel collapses it -- and, because the walk always starts at `/`, a
    // target that climbs past the root is clamped there rather than escaping
    // into the host, which is what a chroot does with the same path.
    const parts = normalize(current).split('/').filter(p => p !== '')
    let walked = ''
    let followed = false
    for (let i = 0; i < parts.length; i += 1) {
      const next = `${walked}/${parts[i]}`
      let st: Stats
      try {
        st = lstatSync(join(root, next))
      }
      catch {
        return undefined
      }
      if (st.isSymbolicLink() && (followLeaf || i < parts.length - 1)) {
        let target: string
        try {
          target = readlinkSync(join(root, next))
        }
        catch {
          return undefined
        }
        const head = target.startsWith('/') ? target : `${walked}/${target}`
        current = [head, ...parts.slice(i + 1)].join('/')
        followed = true
        break
      }
      walked = next
    }
    if (!followed) return join(root, walked)
  }
  return undefined
}

/**
 * `stat`, following every link INSIDE the root: what `[ -e ]`, `[ -d ]` and
 * `stat -c` on the device would each read, and undefined where they would fail.
 *
 * `lstatSync` and not `statSync` on the resolved path, and that is not a
 * detail: `resolveInRoot` has already followed every link, so the path handed
 * to the host carries none -- there is nothing left for the host resolver to
 * interpret, which is the whole property this module is here to keep.
 */
export function statInRoot(root: string, path: string): Stats | undefined {
  const at = resolveInRoot(root, path, true)
  if (at === undefined) return undefined
  try {
    return lstatSync(at)
  }
  catch {
    return undefined
  }
}

/**
 * `readlink`: the RAW target stored at `path`, with the directory chain leading
 * to it resolved inside the root. undefined when `path` is not a symlink.
 *
 * The target is returned exactly as it is stored -- unresolved, absolute or
 * relative -- because every caller here is asking what the image WROTE, not
 * where it lands.
 */
export function linkTargetInRoot(root: string, path: string): string | undefined {
  const at = resolveInRoot(root, path, false)
  if (at === undefined) return undefined
  try {
    return lstatSync(at).isSymbolicLink() ? readlinkSync(at) : undefined
  }
  catch {
    return undefined
  }
}

/** A regular file at `path` after resolving it inside the root, as `[ -f ]` asks. */
export function regularFileInRoot(root: string, path: string): boolean {
  return statInRoot(root, path)?.isFile() === true
}

/**
 * The host path to READ `path` out of the root with, every hop resolved inside
 * it. The reading spelling of `statInRoot`, for `readFileSync`/`readdirSync`.
 *
 * It THROWS when a hop is missing, and the throw is the interface. Every caller
 * already wraps its read in the try/catch that turns an unreadable path into
 * that reader's own answer for absence -- `''`, `[]`, `undefined` -- so the
 * refusal arrives exactly where absence is already handled. Falling back to
 * `join(root, path)` instead would put the host resolver back on precisely the
 * paths that failed to resolve inside the root: the defect, reintroduced in
 * its most dangerous form.
 *
 * `followLeaf: false` is for the caller whose subject IS the link -- a walk
 * that must report a dangling entry rather than skip it. The directory chain is
 * still resolved; only the last component is left alone.
 */
export function pathInRoot(root: string, path: string, followLeaf = true): string {
  const at = resolveInRoot(root, path, followLeaf)
  if (at === undefined) {
    throw new Error(`${path} does not resolve to an entry inside ${root}`)
  }
  return at
}

// sq_regular

/**
 * The paths the oracle asserts on EVERY board, in its own order.
 *
 * `[ -f "${ROOT}$1" ] && [ ! -L "${ROOT}$1" ]` is what it tests, and a single
 * `lstat().isFile()` is the same predicate rather than a re-spelling of it:
 * `-f` follows a symlink and `-L` catches it, so the pair means "a regular file
 * and not a link to one" -- which is what lstat reports directly. A symlink
 * pointing at a regular file fails both.
 *
 * Board-invariant by measurement, not by reading the source. Every path here
 * produces the identical conclusion on cx3576 and on x64; the ones the oracle
 * guards with a board condition are M4d's and are not in this list.
 */
export const ETC_UNITS = ['/etc/systemd/system'] as const
export const ANY_UNITS = ['/etc/systemd/system', '/usr/lib/systemd/system'] as const

/**
 * The first `*.wants/<unit>` under any of `trees`, as a root-relative path.
 *
 * `find ... -name UNIT -path '*.wants/*'`, in the same order and taking the
 * same first line: the oracle prints the path it found and so does this, so a
 * unit enabled from a different target produces the same message on both sides
 * rather than a divergence about which of two true paths to name.
 */
export function wantsLink(root: string, trees: readonly string[], unit: string): string | undefined {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    }
    catch {
      return
    }
    for (const name of entries.sort()) {
      const full = join(dir, name)
      let st: Stats
      try {
        st = lstatSync(full)
      }
      catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (name === unit && basename(dirname(full)).endsWith('.wants')) found.push(full)
    }
  }
  // The WALK never follows a link -- it lstats every entry and recurses only
  // into real directories -- so only its entry point needs resolving, and it
  // is resolved rather than joined: a tree reached through an absolute symlink
  // would otherwise be enumerated on the host.
  for (const tree of trees) {
    let at: string
    try {
      at = pathInRoot(root, tree)
    }
    catch {
      continue
    }
    walk(at)
  }
  const first = found[0]
  return first === undefined ? undefined : first.slice(root.length)
}
