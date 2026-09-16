// Two unpacked roots, one written sanction ledger, and the classified set of
// differences between them.
//
// PLAN-036 section 6 ends with the gate this exists to serve: before the old
// rootfs stage chain is deleted, uefi-x64 is built through BOTH paths -- the chain
// and the package composer -- and their unpacked trees are compared. Package
// documentation and the package composition record are expected additions;
// "every other difference requires an explicit explanation". This module is
// where "an explicit explanation" stops being a sentence in a plan and becomes
// a file that fails a build when it is missing.
//
// The gate driver that builds both paths is not here -- it lands with the
// composer. What is here is the seam it calls: two directories, a ledger, and
// an exit code. src/compare-roots-cli.ts states that contract in its usage text
// and tests/dual-build-sanctions.md states it again in its header, because
// the caller reads one of the two and should not have to find the other.
//
// Two rules make this an instrument rather than a report:
//   - a difference no sanction covers fails the run, named;
//   - a sanction that covered nothing ALSO fails the run, named. A stale
//     sanction that silently matches nothing is how this stops asking the
//     question it was built for -- the tree changes, the sanction goes on
//     sanctioning an absence, and the run stays green by comparing less.

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** What a path IS. Compared before anything else: a directory that became a symlink shares no other field. */
export type EntryKind = 'file' | 'dir' | 'symlink' | 'fifo' | 'socket' | 'chardev' | 'blockdev' | 'unknown'

/**
 * One path, as this comparator sees it.
 *
 * There is deliberately no mtime. Both trees are SOURCE_DATE_EPOCH-pinned, so
 * an mtime difference between two builds of one tree would be interesting -- but
 * that is not what would be measured here. These trees arrive by extraction,
 * and no step of that is guaranteed to carry a timestamp through: tar restores
 * mtime only when asked and only for the entries it holds, the intermediate
 * directories it creates get the extraction's own clock, and a copy in between
 * resets everything. A comparison of mtimes here would report facts about tar
 * and about when the extraction ran, dressed as facts about the image. The
 * pinning is checked where it can be checked -- against the archives, by the
 * reproducibility gates -- and not here.
 */
export interface Entry {
  readonly kind: EntryKind
  /** Permission and setuid/setgid/sticky bits only; the type lives in `kind`. */
  readonly mode: number
  readonly uid: number
  readonly gid: number
  /** Symlinks only: the target as stored, never resolved. */
  readonly target?: string
  /** Regular files only: sha256 of the contents. */
  readonly hash?: string
  /** From getcap, on the files that carry one. Absent means no file capability. */
  readonly caps?: string
}

/** A whole root, keyed by path relative to it, with a leading slash: `/usr/bin/micad`. */
export type Tree = ReadonlyMap<string, Entry>

/**
 * The dimensions a difference can be in, and the vocabulary the ledger writes.
 *
 * `added` is present in B and absent in A, `removed` the other way round, which
 * fixes what the two arguments mean: A is the path being replaced and B is the
 * one replacing it. PLAN-036's sentence -- "expected ADDITIONS are package
 * documentation and the package composition record" -- is a statement about the
 * composed root, so the composed root is B.
 */
export const DIFF_CLASSES = ['added', 'removed', 'type', 'mode', 'uid', 'gid', 'symlink', 'content', 'caps'] as const
export type DiffClass = (typeof DIFF_CLASSES)[number]

export interface Difference {
  readonly path: string
  readonly cls: DiffClass
  /** The rendered value on each side; undefined where the path is not there at all. */
  readonly a: string | undefined
  readonly b: string | undefined
}

/** `active` must match at least one difference; `pending` must match none. See the ledger header. */
export type SanctionStatus = 'active' | 'pending'

export interface Sanction {
  readonly pattern: string
  readonly classes: readonly DiffClass[]
  readonly status: SanctionStatus
  readonly reason: string
  /**
   * The EXACT difference this stanza allows, or undefined for a stanza that
   * allows any difference in its classes.
   *
   * A sanction is otherwise a (pattern, class) pair, and that is too coarse for
   * a `content` difference which is benign for a reason the pattern cannot
   * express. Measured case: `/etc/passwd` differs between the two uefi-x64 roots
   * only because two service accounts are created in the opposite order, which
   * is an artefact of having two assembly paths and not a defect in either --
   * but a bare `content` stanza over that path would equally cover an account
   * VANISHING from the composed root, which is the failure the whole comparison
   * exists to catch. With this set, the stanza covers the difference only when
   * the two files differ in exactly this way and in no other, so an account
   * disappearing, a third line moving, or a field changing inside a transposed
   * line each produce a different canonical diff and each still FAIL.
   *
   * Held as the canonical diff text, newline-separated, without a trailing
   * newline. `canonicalDiff` is what produces it and says what the form is.
   */
  readonly expectDiff?: string
  /** 1-based line of the stanza's heading, so a message can name it in an editor. */
  readonly line: number
}

/**
 * A comparison that could not be made at all, as opposed to one that was made
 * and found the ledger wanting.
 *
 * The distinction is the whole reason the CLI has three exit codes: a gate that
 * cannot tell "the roots agree" from "nothing was compared" is the gate this
 * module is trying not to be.
 */
export class CompareRefusal extends Error {}

/** A ledger that cannot be read. Also a refusal: an unparseable ledger sanctions nothing. */
export class LedgerError extends CompareRefusal {}

/**
 * The floor under a tree, below which this refuses to compare rather than
 * report agreement.
 *
 * A comparison over an empty or half-extracted tree finds no differences and
 * prints a green -- forever, and identically to a comparison of two correct
 * roots that really do agree. That is the single most likely way this
 * instrument becomes decorative, so the count is a precondition and not an
 * observation.
 *
 * 500 is chosen from both ends. The SMALLEST thing this is ever pointed at is a
 * Debian trixie base root, which is thousands of entries before Mica OS installs
 * anything -- the uefi-x64 factory root tests/factory-root-gate walks is 9,240 --
 * so 500 is over an order of magnitude below any legitimate input and cannot
 * fire on one. Every mis-extraction shape is far below it: an empty directory is
 * 0, an OCI-LAYOUT directory handed over in place of an extracted root is about
 * half a dozen (index.json, oci-layout, blobs/sha256/*), and a tar that died
 * partway leaves a fraction of a tree that is either obviously tiny or already
 * over the floor and then caught by the difference set itself.
 */
export const MIN_PATHS = 500

/**
 * C-locale ordering, over UTF-8 bytes.
 *
 * `sort()` and `<` in JavaScript order by UTF-16 code unit, which agrees with
 * byte order for ASCII and stops agreeing above it -- so a tree carrying a
 * non-ASCII path would come out in a different order here than under the
 * `LC_ALL=C sort` every other listing in this repository is written in, and two
 * runs of this comparator would be diffable against each other but not against
 * anything else. The comparison is over the encoded bytes so the answer is the
 * same one.
 */
export function byteCompare(x: string, y: string): number {
  return Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'))
}

function kindOf(mode: number): EntryKind {
  const fmt = mode & 0o170000
  if (fmt === 0o100000) return 'file'
  if (fmt === 0o040000) return 'dir'
  if (fmt === 0o120000) return 'symlink'
  if (fmt === 0o010000) return 'fifo'
  if (fmt === 0o140000) return 'socket'
  if (fmt === 0o020000) return 'chardev'
  if (fmt === 0o060000) return 'blockdev'
  return 'unknown'
}

/**
 * Every file capability in a tree, in one pass, read with getcap.
 *
 * Shelling out rather than reading the xattr directly, because there is no
 * xattr API in bun or node and one getcap over the whole tree costs one process
 * where a per-file probe would cost tens of thousands.
 *
 * A missing getcap is a REFUSAL and not an empty answer. On a root that carries
 * no capabilities the two are indistinguishable -- both report zero -- and the
 * failure that matters is a binary that lost a privilege it needs between the
 * two paths, which is exactly what an empty answer would hide.
 * tests/factory-root-gate says the same thing about the same dimension.
 *
 * Output is `<path> <caps>` on modern libcap and `<path> = <caps>` on older
 * ones, so both are accepted. The path is split off at the separator rather
 * than by taking the first token, so a path containing a space keeps its name.
 */
export function readFileCaps(root: string): Map<string, string> {
  let out: string
  try {
    const r = Bun.spawnSync(['getcap', '-r', '.'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) {
      throw new CompareRefusal(
        `getcap -r . exited ${r.exitCode} in ${root}: ${new TextDecoder().decode(r.stderr).trim() || '(no message)'}`,
      )
    }
    out = new TextDecoder().decode(r.stdout)
  } catch (e) {
    if (e instanceof CompareRefusal) throw e
    throw new CompareRefusal(
      `could not run getcap over ${root}: ${e instanceof Error ? e.message : String(e)}. `
      + `File capabilities are an xattr, and a comparison that could not read them would report `
      + `agreement on every root that carries none -- which is most of them -- while a binary `
      + `that gained or lost one between the two paths passed unmentioned. Install libcap `
      + `(Debian: libcap2-bin, Alpine: libcap libcap-setcap), or run this where verify's tool `
      + `container already carries it.`,
    )
  }
  const caps = new Map<string, string>()
  for (const line of out.split('\n')) {
    if (line === '') continue
    const eq = line.indexOf(' = ')
    const [raw, value] = eq >= 0
      ? [line.slice(0, eq), line.slice(eq + 3)]
      : [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)]
    if (raw === '' || value === '') continue
    caps.set(raw.startsWith('./') ? raw.slice(1) : raw.startsWith('/') ? raw : `/${raw}`, value.trim())
  }
  return caps
}

export interface ReadTreeResult {
  readonly tree: Tree
  /** How many of the entries carry a file capability. Printed, so a zero is visible rather than assumed. */
  readonly capCount: number
}

/**
 * Walk one extracted root.
 *
 * `lstat`, never `stat`: a symlink is a thing with its own mode and its own
 * target, and following it would compare the target twice and the link never --
 * on a root where /etc/shadow points into /run and dangles by design, following
 * would also compare nothing on both sides and call that agreement.
 */
export function readTree(root: string, opts: { readonly caps?: Map<string, string> } = {}): ReadTreeResult {
  const caps = opts.caps ?? readFileCaps(root)
  const tree = new Map<string, Entry>()
  const stack: string[] = ['']
  let capCount = 0
  while (stack.length > 0) {
    const rel = stack.pop() as string
    for (const dirent of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = `${rel}/${dirent.name}`
      const abs = join(root, path)
      const st = lstatSync(abs)
      const kind = kindOf(st.mode)
      const cap = caps.get(path)
      if (cap !== undefined) capCount += 1
      tree.set(path, {
        kind,
        mode: st.mode & 0o7777,
        uid: st.uid,
        gid: st.gid,
        ...(kind === 'symlink' ? { target: readlinkSync(abs) } : {}),
        ...(kind === 'file' ? { hash: createHash('sha256').update(readFileSync(abs)).digest('hex') } : {}),
        ...(cap !== undefined ? { caps: cap } : {}),
      })
      if (kind === 'dir') stack.push(path)
    }
  }
  // A capability getcap reported on a path the walk never saw means the two
  // disagree about what is in this tree, and the walk is what every other
  // dimension is computed from. Named here rather than dropped, because a
  // dropped one is a capability difference that can never be reported.
  if (capCount !== caps.size) {
    const unseen = [...caps.keys()].filter(p => !tree.has(p)).sort(byteCompare)
    throw new CompareRefusal(
      `getcap reported ${caps.size} capability-bearing paths under ${root} but the walk found `
      + `${capCount} of them. Unmatched: ${unseen.slice(0, 5).join(', ')}${unseen.length > 5 ? ', ...' : ''}. `
      + `The walk is what every other comparison is computed from, so a path only one of the two `
      + `can see is a hole in all of them.`,
    )
  }
  return { tree, capCount }
}

function renderMode(m: number): string {
  return m.toString(8).padStart(4, '0')
}

/**
 * The classified difference set, one record per (path, dimension).
 *
 * Per dimension rather than per path, because that is the granularity a
 * sanction is written at: "documentation is added" and "this binary's bytes
 * changed" are different claims about different paths, and a sanction that
 * covered a whole path would sanction dimensions nobody looked at. A path that
 * differs in three dimensions produces three records and needs three sanctions,
 * or one sanction naming three classes.
 *
 * The order is fixed -- paths in C order, dimensions in DIFF_CLASSES order --
 * so the output of two runs is diffable.
 */
export function diffTrees(a: Tree, b: Tree): Difference[] {
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort(byteCompare)
  const out: Difference[] = []
  for (const path of paths) {
    const x = a.get(path)
    const y = b.get(path)
    if (x === undefined && y === undefined) continue
    if (x === undefined) {
      out.push({ path, cls: 'added', a: undefined, b: y === undefined ? undefined : y.kind })
      continue
    }
    if (y === undefined) {
      out.push({ path, cls: 'removed', a: x.kind, b: undefined })
      continue
    }
    if (x.kind !== y.kind) out.push({ path, cls: 'type', a: x.kind, b: y.kind })
    if (x.mode !== y.mode) out.push({ path, cls: 'mode', a: renderMode(x.mode), b: renderMode(y.mode) })
    if (x.uid !== y.uid) out.push({ path, cls: 'uid', a: String(x.uid), b: String(y.uid) })
    if (x.gid !== y.gid) out.push({ path, cls: 'gid', a: String(x.gid), b: String(y.gid) })
    // Target and content are only comparable where both sides are that kind of
    // thing; where they are not, the `type` record above already carries the
    // whole difference and a second record would be a second name for it.
    if (x.kind === 'symlink' && y.kind === 'symlink' && x.target !== y.target) {
      out.push({ path, cls: 'symlink', a: x.target, b: y.target })
    }
    if (x.kind === 'file' && y.kind === 'file' && x.hash !== y.hash) {
      out.push({ path, cls: 'content', a: x.hash, b: y.hash })
    }
    if (x.caps !== y.caps) out.push({ path, cls: 'caps', a: x.caps ?? '(none)', b: y.caps ?? '(none)' })
  }
  return out
}

// --- the ledger ------------------------------------------------------------

/** The heading the parser reads stanzas under. Prose above it is free-form; see the ledger's own header. */
export const SANCTIONS_HEADING = '## Sanctions'

/**
 * Read the written sanctions out of the ledger.
 *
 * Markdown, and parsed strictly, because the file is BOTH the machine's input
 * and the place a person writes down why a difference is allowed. A format that
 * only a program could read would be a format nobody explains anything in; one
 * that only a person could read would be one the gate cannot enforce.
 *
 * Everything before `## Sanctions` is prose and is not parsed. Inside it, each
 * `### <pattern>` opens a stanza and its `- key: value` lines fill it. An
 * unknown key, a missing `classes` or `reason`, an empty reason, an unknown
 * class and a repeated pattern are each refused by name: a stanza this could
 * not read is a difference this would silently not sanction, or worse, one it
 * would sanction for a reason nobody wrote.
 */
export function parseLedger(text: string, path: string): Sanction[] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === SANCTIONS_HEADING)
  if (start < 0) {
    throw new LedgerError(
      `${path} has no '${SANCTIONS_HEADING}' heading. That heading is where the stanzas live, and a `
      + `ledger without it parses as zero sanctions -- which reads exactly like a ledger that `
      + `deliberately sanctions nothing.`,
    )
  }
  const out: Sanction[] = []
  // Filled by the block reader below and consumed by close(), keyed on the
  // stanza's pattern because that is what close() has in hand.
  const expectDiffs = new Map<string, string>()
  let current: { pattern: string, line: number, keys: Map<string, string> } | undefined
  const close = () => {
    if (current === undefined) return
    const { pattern, line, keys } = current
    current = undefined
    const classesRaw = keys.get('classes')
    const reason = keys.get('reason')
    if (classesRaw === undefined) throw new LedgerError(`${path}:${line}: stanza '${pattern}' has no 'classes:' line`)
    if (reason === undefined || reason === '') {
      throw new LedgerError(
        `${path}:${line}: stanza '${pattern}' has no 'reason:' text. The reason is the whole point of a `
        + `written sanction: a difference allowed with no explanation is a difference nobody decided about.`,
      )
    }
    const classes = classesRaw.split(',').map(s => s.trim()).filter(s => s !== '')
    if (classes.length === 0) throw new LedgerError(`${path}:${line}: stanza '${pattern}' lists no class`)
    for (const c of classes) {
      if (!(DIFF_CLASSES as readonly string[]).includes(c)) {
        throw new LedgerError(
          `${path}:${line}: stanza '${pattern}' names the class '${c}', which this comparator does not `
          + `report. The classes are: ${DIFF_CLASSES.join(', ')}.`,
        )
      }
    }
    const statusRaw = keys.get('status') ?? 'active'
    if (statusRaw !== 'active' && statusRaw !== 'pending') {
      throw new LedgerError(`${path}:${line}: stanza '${pattern}' has status '${statusRaw}'; it is 'active' or 'pending'`)
    }
    // `expect-diff` narrows a sanction from "any content difference at this
    // path" to one exact difference, so it is only meaningful where there are
    // two files to compare. A stanza that carried it alongside `added` would be
    // asking for the diff of a file against nothing, and the natural reading of
    // that -- silently ignore it for the other classes -- is a stanza whose
    // author believed they had narrowed something they had not.
    const expectDiff = expectDiffs.get(pattern)
    if (expectDiff !== undefined && !(classes.length === 1 && classes[0] === 'content')) {
      throw new LedgerError(
        `${path}:${line}: stanza '${pattern}' carries 'expect-diff:' and classes '${classes.join(', ')}'. `
        + `An expected difference is the diff of two files, so it belongs to a stanza whose only class is `
        + `'content'; on any other class there is nothing to diff and the narrowing would silently not apply.`,
      )
    }
    if (expectDiff !== undefined && expectDiff === '') {
      throw new LedgerError(
        `${path}:${line}: stanza '${pattern}' opens 'expect-diff: |' and its block is empty. An empty `
        + `expected diff matches only two byte-identical files, which are not a difference at all, so this `
        + `stanza could never cover anything -- and the unused-sanction rule would report it as stale `
        + `rather than as unwritten.`,
      )
    }
    if (out.some(s => s.pattern === pattern)) {
      throw new LedgerError(
        `${path}:${line}: '${pattern}' is sanctioned twice. Two stanzas for one pattern means one of them `
        + `can match nothing while the other covers the difference, and the unused-sanction rule would `
        + `then fire on a sanction that is doing no harm -- or not fire on one that is.`,
      )
    }
    out.push({ pattern, classes: classes as DiffClass[], status: statusRaw, reason, expectDiff, line })
  }
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.startsWith('## ')) {
      close()
      break
    }
    if (line.startsWith('### ')) {
      close()
      const pattern = line.slice(4).trim().replace(/^`|`$/g, '')
      if (pattern === '') throw new LedgerError(`${path}:${i + 1}: a stanza heading with no path pattern`)
      current = { pattern, line: i + 1, keys: new Map() }
      continue
    }
    const m = /^- ([a-z]+(?:-[a-z]+)*):[ \t]*(.*)$/.exec(line)
    if (m === null) continue
    const key = m[1] as string
    const value = (m[2] as string).trim()
    if (current === undefined) {
      throw new LedgerError(`${path}:${i + 1}: '- ${key}:' appears before any '### <pattern>' stanza heading`)
    }
    // THE ONE MULTI-LINE VALUE. `- expect-diff: |` opens a block whose lines are
    // indented by exactly four spaces and are taken VERBATIM, which is what lets
    // a stanza carry a diff rather than a description of one. The block ends at
    // the first line that is not so indented, and that line is re-read as an
    // ordinary key, so `- reason:` may follow it.
    if (key === 'expect-diff') {
      if (value !== '|') {
        throw new LedgerError(
          `${path}:${i + 1}: stanza '${current.pattern}' writes 'expect-diff: ${value}'. It takes a block `
          + `and only a block: 'expect-diff: |' followed by the diff, each line indented four spaces. One `
          + `spelling, because a diff squeezed onto the key's own line could not hold two lines of it.`,
        )
      }
      if (expectDiffs.has(current.pattern)) {
        throw new LedgerError(`${path}:${i + 1}: stanza '${current.pattern}' repeats 'expect-diff:'`)
      }
      const body: string[] = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const raw = lines[j] as string
        if (!raw.startsWith('    ')) break
        body.push(raw.slice(4))
      }
      // Refused rather than tolerated: a mis-indented continuation line would
      // end the block early, and the stanza would then hold a PREFIX of the
      // diff it was meant to carry -- narrower than intended, matching nothing,
      // and reported as a stale sanction rather than as a typo.
      const next = lines[j]
      if (next !== undefined && next.trim() !== '' && !next.startsWith('- ') && !next.startsWith('#')) {
        throw new LedgerError(
          `${path}:${j + 1}: stanza '${current.pattern}' has an 'expect-diff:' block followed by `
          + `'${next}', which is neither another '- key:' line, a heading, nor a blank line. A line that `
          + `is not indented four spaces ends the block, so this would silently truncate the expected diff.`,
        )
      }
      expectDiffs.set(current.pattern, body.join('\n'))
      i = j - 1
      continue
    }
    if (key !== 'classes' && key !== 'status' && key !== 'reason') {
      throw new LedgerError(
        `${path}:${i + 1}: stanza '${current.pattern}' carries the unknown key '${key}'. A key this parser `
        + `does not read is a condition the author believed they had written down. The keys are: `
        + `classes, status, reason, expect-diff.`,
      )
    }
    if (current.keys.has(key)) throw new LedgerError(`${path}:${i + 1}: stanza '${current.pattern}' repeats '${key}:'`)
    current.keys.set(key, value)
  }
  close()
  return out
}

/** Does this sanction cover this difference? Pattern by glob, class by name; both must hold. */
export function sanctionMatches(s: Sanction, d: Difference): boolean {
  if (!s.classes.includes(d.cls)) return false
  return new Bun.Glob(s.pattern).match(d.path)
}

/**
 * The canonical form of "how these two text files differ", for `expect-diff`.
 *
 * POSITIONAL, line by line, and deliberately not an LCS diff. For each 1-based
 * line number where the two sides are not byte-equal, one `-` row for A and one
 * `+` row for B, in line order, with an absent line rendered as `(no line)`:
 *
 *   24 -mica-mqttd:x:970:970:...
 *   24 +mica-mqtt-broker:x:969:969:...
 *
 * Why not `diff(1)` or a real alignment: an alignment algorithm is a second
 * thing that can change under this check -- two versions of diff can describe
 * one difference two ways, and then a stanza written against one of them
 * silently stops matching. A positional comparison has exactly one answer for
 * any pair of files, needs no external program (this module already refuses a
 * host with no getcap; it should not also require a diff), and is strictly
 * exact: any change to either file that the sanctioned one does not have
 * produces different rows.
 *
 * It is not compact for large edits, and that is the right trade. The compact
 * cases are the ones worth sanctioning -- a transposition touches two line
 * numbers -- while an account vanishing shifts every following line and yields
 * a large form that no stanza will match, which is the outcome that case needs.
 */
export function canonicalDiff(aText: string, bText: string): string {
  const aLines = aText.split('\n')
  const bLines = bText.split('\n')
  const rows: string[] = []
  const n = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < n; i += 1) {
    const x = aLines[i]
    const y = bLines[i]
    if (x === y) continue
    rows.push(`${i + 1} -${x ?? '(no line)'}`)
    rows.push(`${i + 1} +${y ?? '(no line)'}`)
  }
  return rows.join('\n')
}

// --- the comparison itself -------------------------------------------------

export interface CompareCounts {
  readonly pathsA: number
  readonly pathsB: number
  readonly union: number
  readonly capsA: number
  readonly capsB: number
  readonly differences: number
  readonly sanctioned: number
  readonly unsanctioned: number
}

/** A stanza whose expected diff no longer describes the difference at its path. */
export interface DiffMismatch {
  readonly path: string
  readonly sanction: Sanction
  readonly expected: string
  readonly actual: string
}

export interface CompareResult {
  readonly a: string
  readonly b: string
  readonly ledgerPath: string
  readonly counts: CompareCounts
  readonly sanctions: readonly Sanction[]
  readonly unsanctioned: readonly Difference[]
  /** Active stanzas that matched nothing: stale sanctions, and a failure. */
  readonly unused: readonly Sanction[]
  /** Narrowed stanzas whose expected diff did not match what the two roots hold. */
  readonly diffMismatches: readonly DiffMismatch[]
  /** Pending stanzas that DID match: the difference they describe has arrived, and they must be promoted. */
  readonly livePending: readonly Sanction[]
  /** 0 when the ledger accounts for the tree exactly; 1 when it does not. Refusals throw instead. */
  readonly exitCode: 0 | 1
}

export interface CompareOptions {
  readonly a: string
  readonly b: string
  readonly ledgerPath: string
  readonly minPaths?: number
}

function requireDirectory(path: string, side: string): void {
  if (!existsSync(path)) {
    throw new CompareRefusal(
      `${side} is ${path}, which does not exist. Both sides are ALREADY-EXTRACTED roots; this compares `
      + `directories, not archives (--extract-oci turns a factory-root.oci into one).`,
    )
  }
  if (!statSync(path).isDirectory()) {
    throw new CompareRefusal(`${side} is ${path}, which is not a directory.`)
  }
}

/**
 * Compare two extracted roots against a written ledger.
 *
 * Refuses -- rather than reporting agreement -- when it cannot be sure it
 * looked at anything: a side that is missing or is not a directory, a side that
 * is empty or under MIN_PATHS, and the two sides being one directory. The last
 * is the shape that reads most convincingly: a driver whose two build paths
 * both wrote to the same place would compare a root with itself, find nothing,
 * and print the same green as a successful migration.
 */
export function compareRoots(opts: CompareOptions): CompareResult {
  const minPaths = opts.minPaths ?? MIN_PATHS
  requireDirectory(opts.a, 'side A')
  requireDirectory(opts.b, 'side B')
  const realA = realpathSync(opts.a)
  const realB = realpathSync(opts.b)
  if (realA === realB) {
    throw new CompareRefusal(
      `side A and side B are the same directory (${realA}). A tree compared with itself differs from `
      + `itself in nothing, on every dimension, forever -- which is indistinguishable from two build `
      + `paths that agree.`,
    )
  }
  const ledgerText = existsSync(opts.ledgerPath)
    ? readFileSync(opts.ledgerPath, 'utf8')
    : (() => {
      throw new LedgerError(
        `${opts.ledgerPath} does not exist. Every difference this finds has to be either sanctioned in `
        + `writing or reported as unsanctioned, so there is no run without a ledger -- an empty one `
        + `(a file whose '${SANCTIONS_HEADING}' section holds no stanza) is the way to sanction nothing.`,
      )
    })()
  const sanctions = parseLedger(ledgerText, opts.ledgerPath)

  const a = readTree(realA)
  const b = readTree(realB)
  for (const [side, path, tree] of [['A', opts.a, a.tree], ['B', opts.b, b.tree]] as const) {
    if (tree.size === 0) {
      throw new CompareRefusal(
        `side ${side} (${path}) is EMPTY. An empty tree differs from anything in exactly the paths the `
        + `other side has, and from another empty tree in nothing at all -- so a comparison that `
        + `accepted one would report a green that is a fact about the extraction.`,
      )
    }
    if (tree.size < minPaths) {
      throw new CompareRefusal(
        `side ${side} (${path}) holds ${tree.size} paths, under the floor of ${minPaths}. The smallest `
        + `root this compares is a Debian base, which is thousands; this is the shape of a failed or `
        + `half-finished extraction, or of an OCI-LAYOUT directory handed over in place of an `
        + `extracted root.`,
      )
    }
  }

  const differences = diffTrees(a.tree, b.tree)
  const matchedBy = new Map<Sanction, number>(sanctions.map(s => [s, 0]))
  const unsanctioned: Difference[] = []
  const diffMismatches: DiffMismatch[] = []
  // Read once per path, however many stanzas ask about it, and only for paths a
  // stanza with an expected diff actually matches -- so a root of 9,000 files
  // costs nothing unless something is being narrowed.
  const canonicalCache = new Map<string, string>()
  const canonicalFor = (path: string): string => {
    const hit = canonicalCache.get(path)
    if (hit !== undefined) return hit
    const text = canonicalDiff(
      readFileSync(join(realA, path.slice(1)), 'utf8'),
      readFileSync(join(realB, path.slice(1)), 'utf8'),
    )
    canonicalCache.set(path, text)
    return text
  }
  for (const d of differences) {
    let covered = false
    for (const s of sanctions) {
      if (!sanctionMatches(s, d)) continue
      // THE NARROWING. A stanza with an expected diff covers this difference
      // only if the two files differ in exactly that way. It is NOT counted as
      // matched when the diff disagrees: a stanza whose expected difference has
      // stopped being the real one is a stanza describing something that is no
      // longer there, which is what the unused-sanction rule exists to report.
      if (s.expectDiff !== undefined) {
        let actual: string
        try {
          actual = canonicalFor(d.path)
        } catch (cause) {
          throw new CompareRefusal(
            `${opts.ledgerPath}:${s.line}: stanza '${s.pattern}' carries an expected diff for ${d.path}, `
            + `and that path could not be read on both sides to compare against it: ${String(cause)}. `
            + `A narrowed sanction that cannot read its own subject must not fall back to covering `
            + `everything at that path.`,
          )
        }
        if (actual !== s.expectDiff) {
          diffMismatches.push({ path: d.path, sanction: s, expected: s.expectDiff, actual })
          continue
        }
      }
      matchedBy.set(s, (matchedBy.get(s) ?? 0) + 1)
      // A pending stanza is a sanction that has been WRITTEN but is not yet in
      // force, so it is counted (its stanza is reported as live) and does not
      // cover anything. See the ledger header for why the two are separate.
      if (s.status === 'active') covered = true
    }
    if (!covered) unsanctioned.push(d)
  }
  const unused = sanctions.filter(s => s.status === 'active' && (matchedBy.get(s) ?? 0) === 0)
  const livePending = sanctions.filter(s => s.status === 'pending' && (matchedBy.get(s) ?? 0) > 0)

  return {
    a: realA,
    b: realB,
    ledgerPath: opts.ledgerPath,
    counts: {
      pathsA: a.tree.size,
      pathsB: b.tree.size,
      union: new Set([...a.tree.keys(), ...b.tree.keys()]).size,
      capsA: a.capCount,
      capsB: b.capCount,
      differences: differences.length,
      sanctioned: differences.length - unsanctioned.length,
      unsanctioned: unsanctioned.length,
    },
    sanctions,
    unsanctioned,
    unused,
    diffMismatches,
    livePending,
    exitCode: unsanctioned.length === 0 && unused.length === 0 && livePending.length === 0 ? 0 : 1,
  }
}

/**
 * The report, printed on every run including the green ones.
 *
 * The counters are the part that is not optional. "No differences" and "nothing
 * was examined" print the same verdict and mean opposite things, and the only
 * thing that separates them on the page is the number of paths each side
 * carried. The capability counts are there for the same reason one shelf down:
 * on a root with no file capabilities that whole dimension compares an empty
 * set with an empty set, and a printed zero is what says so out loud rather
 * than letting the silence read as agreement.
 */
export function formatReport(r: CompareResult): string {
  const out: string[] = []
  const active = r.sanctions.filter(s => s.status === 'active').length
  out.push('=== compare-roots ===')
  out.push(`A (baseline): ${r.a}`)
  out.push(`B (candidate): ${r.b}`)
  out.push(`sanctions: ${r.ledgerPath} (${r.sanctions.length} stanzas: ${active} active, ${r.sanctions.length - active} pending)`)
  out.push('')
  out.push(`paths on A:        ${r.counts.pathsA}`)
  out.push(`paths on B:        ${r.counts.pathsB}`)
  out.push(`paths in union:    ${r.counts.union}`)
  out.push(`capability-bearing files: A=${r.counts.capsA} B=${r.counts.capsB}`)
  out.push(`differences found: ${r.counts.differences}`)
  out.push(`  sanctioned:      ${r.counts.sanctioned}`)
  out.push(`  unsanctioned:    ${r.counts.unsanctioned}`)
  out.push('')
  for (const d of r.unsanctioned) {
    out.push(`UNSANCTIONED ${d.path} ${d.cls}: A=${d.a ?? '(absent)'} B=${d.b ?? '(absent)'}`)
  }
  for (const m of r.diffMismatches) {
    const exp = m.expected.split('\n')
    const act = m.actual.split('\n')
    out.push(`EXPECTED DIFF MISMATCH ${r.ledgerPath}:${m.sanction.line} '${m.sanction.pattern}' at ${m.path}`)
    out.push(`  the stanza expects ${exp.length} row(s):`)
    for (const l of exp.slice(0, 12)) out.push(`    ${l}`)
    out.push(`  the two roots hold ${act.length} row(s):`)
    for (const l of act.slice(0, 12)) out.push(`    ${l}`)
    if (act.length > 12) out.push(`    ... ${act.length - 12} more`)
    out.push('  A narrowed stanza covers its path ONLY for the diff it names, so this is unsanctioned.')
  }
  for (const s of r.unused) {
    out.push(
      `UNUSED SANCTION ${r.ledgerPath}:${s.line} '${s.pattern}' (${s.classes.join(', ')}) matched nothing`,
    )
  }
  for (const s of r.livePending) {
    out.push(
      `PENDING SANCTION NOW LIVE ${r.ledgerPath}:${s.line} '${s.pattern}' (${s.classes.join(', ')}) `
      + `matches a real difference; promote it to 'status: active'`,
    )
  }
  if (r.exitCode === 0) {
    out.push(`RESULT: PASS (${r.counts.differences} differences, all sanctioned; ${active} active sanctions, all used)`)
  } else {
    out.push(
      `RESULT: FAIL (${r.counts.unsanctioned} unsanctioned difference(s), ${r.unused.length} unused `
      + `sanction(s), ${r.livePending.length} pending sanction(s) now live)`,
    )
  }
  return out.join('\n')
}

// --- turning a factory-root.oci into a comparable directory ----------------

/**
 * Extract the packed root out of an OCI-layout archive.
 *
 * verify already extracts one of these and it is NOT reusable here:
 * `extractLayout` in verify/src/smoke.ts unpacks the archive into an OCI
 * LAYOUT directory for buildx to take as a context -- blobs and an index, not a
 * filesystem -- and verify is read-only this round in any case. So the
 * unpacking is done here with tar, in the same idiom
 * tests/factory-root-gate/inner.sh uses against the same archives:
 * `--numeric-owner` so uid and gid arrive as the numbers the image carries
 * rather than as whatever this host's /etc/passwd maps them to, and
 * `--xattrs --xattrs-include='*'` because file capabilities live in an xattr
 * and an extraction that dropped them would compare two empty sets and agree.
 *
 * The layer order comes from the manifest rather than from the filenames: blobs
 * are named by digest, sorting them is sorting hashes, and applying two layers
 * in the wrong order silently produces a tree neither build made.
 */
export function extractOciRoot(archive: string, dest: string): { readonly layers: number, readonly paths: number } {
  if (!existsSync(archive)) throw new CompareRefusal(`${archive} does not exist`)
  if (statSync(archive).size === 0) throw new CompareRefusal(`${archive} is empty`)
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw new CompareRefusal(
      `${dest} already exists and is not empty. Extracting over it would merge two roots into one tree, `
      + `and the result would be a comparison against something neither build produced.`,
    )
  }
  const layout = join(dirname(dest), `${basename(dest)}.oci-layout`)
  rmSync(layout, { recursive: true, force: true })
  mkdirSync(layout, { recursive: true })
  mkdirSync(dest, { recursive: true })
  run(['tar', '-xf', archive, '-C', layout], `unpack ${archive}`)

  const index = readJson(join(layout, 'index.json'), archive)
  const manifests = Array.isArray(index['manifests']) ? index['manifests'] as Array<Record<string, unknown>> : []
  if (manifests.length !== 1) {
    throw new CompareRefusal(
      `${archive}'s index.json names ${manifests.length} manifests; this reads an archive holding exactly `
      + `one image. Pick the one you mean before comparing, rather than comparing an arbitrary member.`,
    )
  }
  let descriptor = manifests[0] as Record<string, unknown>
  let doc = readJson(blobPath(layout, descriptor, archive), archive)
  // buildkit writes an image index above the manifest when it is asked for more
  // than one platform, and the same export on one platform writes the manifest
  // directly. One level of indirection is followed; a second would mean a
  // multi-platform archive, which is the case refused above.
  if (Array.isArray(doc['manifests'])) {
    const inner = doc['manifests'] as Array<Record<string, unknown>>
    if (inner.length !== 1) {
      throw new CompareRefusal(`${archive} holds a ${inner.length}-platform image index; compare one platform at a time.`)
    }
    descriptor = inner[0] as Record<string, unknown>
    doc = readJson(blobPath(layout, descriptor, archive), archive)
  }
  const layers = Array.isArray(doc['layers']) ? doc['layers'] as Array<Record<string, unknown>> : []
  if (layers.length === 0) {
    throw new CompareRefusal(
      `${archive}'s manifest declares no layers, so the extracted root would be empty and every `
      + `comparison against it green.`,
    )
  }
  for (const layer of layers) {
    run(
      ['tar', '-xpf', blobPath(layout, layer, archive), '-C', dest, '--numeric-owner', '--xattrs', '--xattrs-include=*'],
      `extract a layer of ${archive}`,
    )
  }
  rmSync(layout, { recursive: true, force: true })

  // Whiteouts are how a multi-layer image says "this path is deleted", and tar
  // does not apply them -- it writes the .wh. marker as a file. A tree still
  // carrying one is a tree where a deleted path is present and an extra path
  // has been invented, so it is refused rather than compared.
  const paths = countPaths(dest, dest)
  return { layers: layers.length, paths }
}

function countPaths(root: string, dir: string): number {
  let n = 0
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name.startsWith('.wh.')) {
      throw new CompareRefusal(
        `${join(dir, dirent.name)} is an unapplied OCI whiteout marker. tar writes these as files rather `
        + `than deleting what they name, so this tree holds a path the image deletes and a marker file `
        + `the image does not have.`,
      )
    }
    n += 1
    if (dirent.isDirectory() && !dirent.isSymbolicLink()) n += countPaths(root, join(dir, dirent.name))
  }
  return n
}

function blobPath(layout: string, descriptor: Record<string, unknown>, archive: string): string {
  const digest = descriptor['digest']
  if (typeof digest !== 'string' || !digest.includes(':')) {
    throw new CompareRefusal(`${archive} carries a descriptor with no usable digest: ${JSON.stringify(descriptor)}`)
  }
  const [algo, hex] = digest.split(':')
  const path = join(layout, 'blobs', algo as string, hex as string)
  if (!existsSync(path)) throw new CompareRefusal(`${archive} names the blob ${digest}, which is not in the archive`)
  return path
}

function readJson(path: string, archive: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new CompareRefusal(
      `${archive} has no ${basename(path)}; that is the entry point of an OCI layout, so whatever this `
      + `archive is, it is not one.`,
    )
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (e) {
    throw new CompareRefusal(`${path} in ${archive} is not readable JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function run(argv: readonly string[], what: string): void {
  const r = Bun.spawnSync(argv as string[], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) {
    throw new CompareRefusal(
      `could not ${what}: ${argv.join(' ')} exited ${r.exitCode}: ${new TextDecoder().decode(r.stderr).trim()}`,
    )
  }
}
