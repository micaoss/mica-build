// The emergency BusyBox binary (RFCT-281/PLAN-045), and the four things it must
// NOT have become.
//
// The image gains one file, /usr/bin/busybox, and an operator reaches an applet
// by naming it: `busybox sh`, `busybox ls`. Everything else about this package
// is a negative -- no applet link, no PATH entry, no /build/bin, no initramfs
// role, no init role, no GNU command quietly re-pointed at it -- and a negative
// is exactly the shape of assertion that passes by finding nothing.
//
// SO EVERY CHECK HERE REPORTS THE SIZE OF THE SPACE IT SEARCHED, and refuses
// when that space is empty. `packedRoot` already refuses an unpacked tree with
// no entries in it, which is the coarse version of the same guard; these are the
// per-check ones. `packed-busybox-unexpanded` fails outright when the binary is
// absent rather than reporting "nothing links to it", because with no binary in
// the root there is nothing an applet link could point at and the conclusion
// would be true of every image ever built, including one that ships no busybox
// at all. checks-busybox.test.ts drives each of them red from a fixture that is
// green first.
//
// The counterpart assertions are elsewhere and are deliberately not repeated
// here: the PRODUCER (mica-system-base:debs/mica-busybox/Dockerfile) asserts its staged
// payload is exactly two files with no link of any kind, which is the stronger
// statement because no applet link can reach an image without passing through
// it; and stages/compose/scripts/pack-export-boot.sh asserts the EXPORTED initramfs
// carries no busybox, which is the one question a packed root cannot answer
// because the initrd is on the ESP and outside it.
//
// No matcher here is a substring of another batch's conclusion: every one of
// them names BusyBox, and this is the only family in the register that mentions
// it.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { entry, packedRoot } from './checks-root.ts'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { verdict } from './verdict.ts'

/** The one path this package ships an executable at. */
export const BUSYBOX_PATH = '/usr/bin/busybox'

/**
 * The build tree PLAN-045 rejected as a place for applets, asserted absent.
 *
 * Alternative 1 in that plan was "install applets under /build/bin at the end of
 * PATH", rejected because a production image should not expose a build path or
 * silent fallback semantics. The rejection is worth a check rather than only a
 * paragraph: `/build` is not otherwise a path this image has any reason to hold,
 * so its presence means somebody took the rejected alternative.
 */
const BUILD_PREFIX = '/build'

/**
 * Where a login or service PATH is actually decided in this root.
 *
 * A file OR a directory; a missing one is skipped, because the shipped set
 * differs per board and per Debian revision -- /etc/environment.d and
 * /etc/systemd/system.conf.d are absent from today's uefi-x64 root and present in
 * plenty of Debian systems. What is NOT tolerated is all of them being absent at
 * once: the check would then be reading nothing and reporting that nothing puts
 * busybox on PATH.
 */
const PATH_SOURCES: readonly string[] = [
  '/etc/environment',
  '/etc/environment.d',
  '/usr/lib/environment.d',
  '/etc/profile',
  '/etc/profile.d',
  '/etc/login.defs',
  '/etc/systemd/system.conf.d',
  '/usr/lib/systemd/system.conf.d',
]

/**
 * The image's own bill of materials -- the file every release record is built
 * from.
 *
 * `src/image/release-manifest.ts` derives the SBOM, the licence inventory and
 * the source offer from these rows and from nothing else, because the finalizer
 * purges the dpkg database and this is the only record left on the device. So
 * "the SBOM includes BusyBox" is, on the image side, exactly "this file has a
 * mica-busybox row".
 */
const MANIFEST_PATH = '/usr/share/mica/manifest.tsv'

/** The package that ships the binary, and the name a release record carries. */
const BUSYBOX_PACKAGE = 'mica-busybox'

/** The trees whose files decide what goes INTO an initramfs. */
const INITRAMFS_TREES: readonly string[] = [
  '/usr/share/initramfs-tools',
  '/etc/initramfs-tools',
]

/** The trees whose files decide what init STARTS or execs. */
const INIT_TREES: readonly string[] = [
  '/usr/lib/systemd/system',
  '/etc/systemd/system',
  '/usr/lib/systemd/system-generators',
  '/etc/systemd/system-generators',
  '/usr/lib/systemd/system-preset',
  '/etc/systemd/system-preset',
  '/usr/lib/mica',
]

/** The directories a bare command name is looked up in, in PATH order. */
const PATH_DIRS: readonly string[] = [
  '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
]

/**
 * The GNU commands BusyBox has an applet for and this image must keep.
 *
 * Chosen from the applets busybox actually offers -- all twenty are in its
 * `--list` -- and from packages this root ships unconditionally: coreutils and
 * dash (kept by decision, `stages/compose/90-pack.Dockerfile`'s purge notes say
 * why), util-linux, tar, grep, sed and hostname. A name here that the image
 * stopped shipping is a FAIL and not a skip: "the GNU command resolves as
 * before" cannot be concluded from a command that is no longer there.
 */
const GNU_COMMANDS: readonly string[] = [
  'sh', 'ls', 'cat', 'cp', 'mv', 'rm', 'ln', 'mkdir', 'chmod', 'date',
  'dd', 'grep', 'sed', 'tar', 'mount', 'umount', 'dmesg', 'hostname', 'sync', 'sleep',
]

interface Walked {
  /** The path as the image sees it, e.g. `/usr/bin/busybox`. */
  readonly path: string
  readonly stat: Stats
}

/**
 * Every path under the unpacked root, lstat'd -- links are entries, never
 * followed.
 *
 * Written here rather than reusing `checks-root.ts`'s `shippedUnder`, which
 * answers a different question (the first five paths under one prefix, as
 * prose). This walk has to see the WHOLE tree, because an applet link may be
 * put anywhere -- /usr/bin, a directory of its own, /usr/local -- and a walk
 * scoped to the places one expects them is a walk that finds them there.
 */
function walk(root: string): Walked[] {
  const out: Walked[] = []
  const visit = (abs: string): void => {
    let stat: Stats
    try {
      stat = lstatSync(abs)
    }
    catch {
      return
    }
    if (abs !== root) out.push({ path: abs.slice(root.length), stat })
    if (!stat.isDirectory()) return
    for (const name of readdirSync(abs)) visit(join(abs, name))
  }
  visit(root)
  return out
}

/** Where a symlink at `path` points, as an image-absolute path. */
function linkTarget(root: string, path: string): string {
  const raw = readlinkSync(join(root, path))
  return raw.startsWith('/') ? resolve(raw) : resolve(dirname(path), raw)
}

/**
 * Follow `path`'s symlink chain INSIDE the root, or undefined if it dangles.
 *
 * The "inside the root" half is not a nicety. An image symlink's target is
 * image-absolute -- /etc/profile.d/70-systemd-shell-extra.sh points at
 * /usr/lib/systemd/profile.d/... -- so handing that path to readFileSync would
 * read the VERIFIER HOST's file of that name. The verdict would then be about
 * this machine, and on a host that happened to have a busybox-mentioning file
 * there it would be a red about somebody else's system.
 */
function insideRoot(root: string, path: string): string | undefined {
  let at = path
  // Bounded for the reason `resolveCommand` is: a link cycle in the image is
  // not this check's subject, and an unbounded follow would hang the run.
  for (let hop = 0; hop < 16; hop++) {
    const st = entry(root, at)
    if (st === undefined) return undefined
    if (!st.isSymbolicLink()) return at
    at = linkTarget(root, at)
  }
  return undefined
}

/**
 * Every readable entry at or under each of `trees`, as image-absolute paths.
 *
 * TWO SHAPES BOTH COUNT, and each was measured absent from an earlier spelling
 * of this function against the real roots:
 *
 * - A tree entry may be a FILE rather than a directory. /etc/login.defs is one
 *   file and /etc/profile.d is a directory of them, and a version that only
 *   descended directories scanned none of the single files -- caught here as a
 *   login.defs whose PATH named a busybox directory passing the check.
 * - A leaf may be a SYMLINK. On both shipped boards
 *   /etc/profile.d/70-systemd-shell-extra.sh and
 *   /usr/lib/environment.d/99-environment.conf are links, and so is every
 *   enablement link under the unit trees. Skipping them left the real PATH
 *   drop-in this image ships unread.
 */
function filesUnder(root: string, trees: readonly string[]): string[] {
  const out: string[] = []
  const readable = (st: Stats): boolean => st.isFile() || st.isSymbolicLink()
  for (const tree of trees) {
    const st = entry(root, tree)
    if (st === undefined) continue
    if (readable(st)) {
      out.push(tree)
      continue
    }
    for (const w of walk(join(root, tree)))
      if (readable(w.stat)) out.push(`${tree}${w.path}`)
  }
  return out
}

/** A path's bytes as text, resolved inside the root; '' when there are none. */
function text(root: string, path: string): string {
  const real = insideRoot(root, path)
  if (real === undefined) return ''
  if (entry(root, real)?.isFile() !== true) return ''
  try {
    return readFileSync(join(root, real), 'latin1')
  }
  catch {
    return ''
  }
}

/**
 * What a bare command name resolves to in this root, following symlinks.
 *
 * The lookup is the image's own: the PATH directories in order, then the link
 * chain, resolved INSIDE the root so that an absolute target names an image path
 * rather than the verifier host's. `undefined` means the name is not there at
 * all, which is a different failure from "it resolves to busybox" and gets a
 * different sentence.
 */
function resolveCommand(root: string, name: string): string | undefined {
  let found: string | undefined
  for (const dir of PATH_DIRS) {
    const candidate = `${dir}/${name}`
    if (entry(root, candidate) !== undefined) {
      found = candidate
      break
    }
  }
  if (found === undefined) return undefined
  // Bounded: a link cycle in the image is not this check's subject, and an
  // unbounded follow would hang the run rather than report one.
  for (let hop = 0; hop < 16; hop++) {
    const st = entry(root, found)
    if (st === undefined) return found
    if (!st.isSymbolicLink()) return found
    found = linkTarget(root, found)
  }
  return found
}

export const BUSYBOX_CHECKS: readonly CheckCase[] = [
  {
    // Acceptance clause 1. A regular file, not a link to one, and executable:
    // an operator in an emergency has to be able to run it, and a mode that
    // lost its execute bit is a package that shipped and does nothing.
    id: 'packed-busybox-present',
    shell: {
      pass: 'the emergency BusyBox binary ships at ',
      fail: 'the emergency BusyBox binary is not ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const st = entry(root, BUSYBOX_PATH)
      if (st === undefined || !st.isFile()) {
        return [verdict('packed-busybox-present', false,
          `the emergency BusyBox binary is not at ${BUSYBOX_PATH} as a regular file. mica-busybox `
          + 'ships exactly that path, so an image without it has no tool an operator can reach when '
          + 'the normal userland is damaged')]
      }
      const mode = st.mode & 0o777
      if ((mode & 0o111) === 0) {
        return [verdict('packed-busybox-present', false,
          `the emergency BusyBox binary is not executable: ${BUSYBOX_PATH} is mode `
          + `0${mode.toString(8)}. It is the one thing this package ships and nothing else in the `
          + 'image can run it on an operator\'s behalf')]
      }
      return [verdict('packed-busybox-present', true,
        `the emergency BusyBox binary ships at ${BUSYBOX_PATH}, mode 0${mode.toString(8)}, `
        + `${st.size} bytes`)]
    },
  },

  {
    // Acceptance clause 2, first half: NO generated applet links, anywhere.
    //
    // Symlinks AND hard links, because the two are different mechanisms and only
    // one of them is the obvious one. `busybox --install` makes symlinks;
    // Debian's own initramfs hook makes HARD links, and a hard-linked applet
    // farm is invisible to a symlink-only test while being exactly as much of a
    // second userland. Hard links are found by inode identity against the binary
    // itself rather than by name, so an applet called anything at all is caught.
    //
    // ABSENCE OF THE BINARY IS A FAIL, not a pass. This is the check that would
    // otherwise be green over an image with no busybox in it, over an image
    // whose root failed to unpack, and over a directory that was never a root --
    // "nothing points at a file that is not there" is true and says nothing.
    id: 'packed-busybox-unexpanded',
    shell: {
      pass: 'no BusyBox applet link is in the packed root',
      fail: 'BusyBox applet link(s) in the packed root',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const bb = entry(root, BUSYBOX_PATH)
      if (bb === undefined || !bb.isFile()) {
        return [verdict('packed-busybox-unexpanded', false,
          `${BUSYBOX_PATH} is not a regular file in the packed root, so "no applet link points at `
          + 'it" is a statement about nothing -- it would be true of every image, including one '
          + 'that ships no BusyBox at all. The applet-link search needs the binary to search for')]
      }
      const all = walk(root)
      const links: string[] = []
      for (const w of all) {
        if (w.stat.isSymbolicLink()) {
          if (linkTarget(root, w.path) === BUSYBOX_PATH) links.push(`${w.path} -> ${BUSYBOX_PATH}`)
          continue
        }
        if (!w.stat.isFile() || w.path === BUSYBOX_PATH) continue
        if (w.stat.ino === bb.ino && w.stat.dev === bb.dev) links.push(`${w.path} (hard link)`)
      }
      const shown = links.slice(0, 5).join(' ')
      const more = links.length > 5 ? ` (+${links.length - 5} more)` : ''
      return [verdict(
        'packed-busybox-unexpanded',
        links.length === 0,
        links.length === 0
          ? `no BusyBox applet link is in the packed root: ${all.length} paths walked, none of them `
          + `a symlink to ${BUSYBOX_PATH} and none sharing its inode. An applet is reached by `
          + 'naming it -- `busybox sh` -- and never by a name of its own'
          : `${links.length} BusyBox applet link(s) in the packed root: ${shown}${more}. `
            + 'Two hundred and seventy applet names beside the GNU tools re-decide what those '
            + 'commands mean for every script in this image; PLAN-045 ships the binary and not '
            + 'the farm',
      )]
    },
  },

  {
    // Acceptance clause 2, second half: no PATH change and no /build/bin.
    //
    // Two facts, one check, because they are one decision -- PLAN-045's
    // alternative 1 was applets under /build/bin at the end of PATH, and either
    // half of it arriving alone is that alternative being taken. The failure
    // they share is a fallback that resolves without anybody typing `busybox`.
    //
    // The PATH sources are read for the LITERAL busybox, not for a PATH= line
    // that mentions any directory: an image whose /etc/profile.d ships a
    // drop-in prepending a busybox applet directory is the failure, and the name
    // of that directory is not something this check can know in advance.
    id: 'packed-busybox-no-path-change',
    shell: {
      pass: 'nothing in the packed root puts BusyBox on PATH',
      fail: 'BusyBox is on PATH in the packed root',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const build = entry(root, BUILD_PREFIX)
      if (build !== undefined) {
        return [verdict('packed-busybox-no-path-change', false,
          `BusyBox is on PATH in the packed root: it ships ${BUILD_PREFIX}, which PLAN-045 `
          + 'rejected as the place for applets -- a production image exposes no build path and no '
          + 'silent fallback semantics')]
      }
      const scanned = filesUnder(root, PATH_SOURCES)
      if (scanned.length === 0) {
        return [verdict('packed-busybox-no-path-change', false,
          `none of the ${PATH_SOURCES.length} PATH sources (${PATH_SOURCES.join(' ')}) holds a `
          + 'single readable entry in this root, so this check read nothing and would report that '
          + 'nothing puts BusyBox on PATH whatever the image did')]
      }
      const hits = scanned.filter(p => /busybox|\/build\/bin/i.test(text(root, p)))
      return [verdict(
        'packed-busybox-no-path-change',
        hits.length === 0,
        hits.length === 0
          ? `nothing in the packed root puts BusyBox on PATH: ${scanned.length} path(s) across the `
          + `PATH sources name neither busybox nor ${BUILD_PREFIX}/bin, and there is no `
          + `${BUILD_PREFIX} at all`
          : `BusyBox is on PATH in the packed root: ${hits.join(' ')} name(s) it. An applet that `
            + 'resolves without being asked for by name has replaced a GNU command for every '
            + 'script in the image, which is the change PLAN-045 exists to prevent',
      )]
    },
  },

  {
    // Acceptance clause 3, second half: BusyBox is not an initramfs or an init
    // dependency.
    //
    // WHY THE INITRAMFS HALF IS NOT A CONTENT GREP. `BUSYBOX` appears in the
    // shipped root already -- initramfs.conf carries `BUSYBOX=auto` and
    // initramfs-tools' own klibc-utils hook reads `${BUSYBOXDIR}` -- so a check
    // for the word would be red on a correct image. What actually decides
    // whether busybox enters an initrd is narrower and is what is asserted: a
    // FILE NAMED for busybox under the initramfs trees (Debian's package ships
    // hooks/zz-busybox and conf-hooks.d/busybox, and the hook is what copies the
    // binary in and hard-links every applet beside it), an assignment of
    // BUSYBOXDIR (which is the whole content of that conf fragment and what
    // makes mkinitramfs look), or BUSYBOX=y (which makes it mandatory). None of
    // the three is in this image, and each of them arriving is the mechanism.
    //
    // The init half IS a literal search, over units, generators, presets and
    // Mica OS's own /usr/lib/mica scripts, because nothing in that set legitimately
    // mentions busybox -- measured at 267 files on the composed uefi-x64 root, zero
    // hits. A unit that execs it, conditions on it or is ordered against it has
    // made an emergency tool part of the boot contract.
    id: 'packed-busybox-not-early-boot',
    shell: {
      pass: 'BusyBox has no initramfs and no init role',
      fail: 'BusyBox has an initramfs or init role',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const initramfs = filesUnder(root, INITRAMFS_TREES)
      const init = filesUnder(root, INIT_TREES)
      if (init.length === 0) {
        return [verdict('packed-busybox-not-early-boot', false,
          `none of the init trees (${INIT_TREES.join(' ')}) holds a readable entry in this root. A root `
          + 'with no unit in it is not one this check can conclude anything about, and reporting that '
          + 'BusyBox has no init role would be reporting on an empty search')]
      }
      const named = initramfs.filter(p => /busybox/i.test(p))
      const configured = initramfs.filter((p) => {
        const body = text(root, p)
        return /^[ \t]*BUSYBOXDIR=/m.test(body) || /^[ \t]*BUSYBOX=y[ \t]*$/m.test(body)
      })
      // COMMENTS ARE NOT A ROLE. A drop-in that explains, in a `#` line, which
      // busybox invocation the BSP bring-up rootfs proved is a unit that names
      // the word and executes nothing -- and cx3576 ships two of them, so a
      // whole-body match reports an init role on a correct image. What makes
      // BusyBox part of the boot contract is a DIRECTIVE naming it: something
      // execs it, conditions on it, or is ordered against it. Match the value
      // side of `Key=`, with comment lines removed first.
      const directivesNaming = (body: string): boolean => body
        .split('\n')
        .filter(line => !/^[ \t]*[#;]/.test(line))
        .some(line => /^[ \t]*[A-Za-z][A-Za-z0-9]*[ \t]*=.*busybox/i.test(line))
      const execing = init.filter(p => directivesNaming(text(root, p)))
      const faults = [
        ...named.map(p => `${p} (an initramfs file named for busybox)`),
        ...configured.map(p => `${p} (sets BUSYBOXDIR or BUSYBOX=y)`),
        ...execing.map(p => `${p} (an init file naming busybox)`),
      ]
      // THE initramfs SEARCH SPACE SURVIVED PLAN-074, and it was worth checking
      // rather than assuming. Removing initramfs-tools from this board looked
      // like it would empty INITRAMFS_TREES and leave this half searching
      // nothing -- green forever over an absent directory. It does not:
      // /usr/share/initramfs-tools is still populated, by udev, kmod and
      // dmsetup, which ship hooks there without depending on the package that
      // reads them. Measured at 5 files on the composed uefi-x64 root. So the count
      // below is a real count and this half still asks a real question.
      return [verdict(
        'packed-busybox-not-early-boot',
        faults.length === 0,
        faults.length === 0
          ? 'BusyBox has no initramfs and no init role: '
          + `${initramfs.length} initramfs-tools path(s) carry no hook or conf fragment named `
          + `for it and set no BUSYBOXDIR, and ${init.length} unit, generator, preset and `
          + '/usr/lib/mica path(s) name it in no directive'
          : `BusyBox has an initramfs or init role: ${faults.join(' ')}. A tool early boot or a `
            + 'normal service depends on is part of the boot contract, not an emergency tool, and '
            + 'it would be a part nobody tested',
      )]
    },
  },

  {
    // Acceptance clause 5, from the image side: the SBOM, the licence inventory
    // and the source offer include the shipped package.
    //
    // Those three are generated by src/image/release-manifest.ts out of
    // /usr/share/mica/manifest.tsv and nothing else, so nothing about them needs
    // teaching about BusyBox -- which is the point, and is also why the fact
    // worth checking is upstream of them. What this asserts is that the BINARY
    // in the root and the ROW in the bill of materials are the same fact.
    //
    // They can come apart, and only in one direction that matters: a file that
    // arrived any way other than through a package -- copied in by a compose
    // stage, left in the overlay -- is in the image and in no row, so the
    // release ships a GPL-2 binary that its own licence inventory and source
    // offer do not mention. That is a compliance failure whose every other
    // check is green, and it is exactly the shape `mica-ca-trust`'s keyring
    // check was written for on the trust side.
    id: 'packed-busybox-in-manifest',
    shell: {
      pass: 'the shipped manifest lists BusyBox',
      fail: 'the shipped manifest does not list BusyBox',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const st = entry(root, MANIFEST_PATH)
      if (st === undefined || !st.isFile()) {
        return [verdict('packed-busybox-in-manifest', false,
          `the shipped manifest does not list BusyBox: there is no ${MANIFEST_PATH} in the packed `
          + 'root at all. The purge takes /var/lib/dpkg away, so without it the release has no '
          + 'inventory to derive an SBOM, a licence list or a source offer from')]
      }
      const rows = readFileSync(join(root, MANIFEST_PATH), 'latin1')
        .split('\n')
        .filter(l => l !== '' && !l.startsWith('#'))
      const row = rows.find(l => (l.split('\t')[0] as string) === BUSYBOX_PACKAGE)
      const shipped = entry(root, BUSYBOX_PATH) !== undefined
      if (row === undefined) {
        return [verdict('packed-busybox-in-manifest', false,
          `the shipped manifest does not list BusyBox: ${rows.length} row(s) in ${MANIFEST_PATH} `
          + `and none of them is ${BUSYBOX_PACKAGE}, while ${BUSYBOX_PATH} is `
          + `${shipped ? 'IN the root' : 'absent too'}. `
          + (shipped
            ? 'A binary in the image and no row for it means the file arrived outside the package '
            + 'system, so the SBOM, the licence inventory and the source offer generated from '
            + 'this file all omit a GPL-2 binary the release ships'
            : 'The package is in no image and in no record, which is a composition that never '
              + 'installed it'))]
      }
      const [name, version, architecture] = row.split('\t') as [string, string, string]
      if (!shipped) {
        return [verdict('packed-busybox-in-manifest', false,
          `the shipped manifest does not list BusyBox consistently: it records ${name} `
          + `${version} ${architecture} and ${BUSYBOX_PATH} is not in the root. The inventory `
          + 'a compliance request is answered from would name a binary this image does not have')]
      }
      return [verdict('packed-busybox-in-manifest', true,
        `the shipped manifest lists BusyBox: ${name} ${version} ${architecture}, among `
        + `${rows.length} row(s), and ${BUSYBOX_PATH} is in the root. The SBOM, the licence `
        + 'inventory and the source offer are derived from these rows, so the package is in all '
        + 'three without any of them naming it')]
    },
  },

  {
    // Acceptance clause 3, first half: the existing GNU commands still resolve
    // as before.
    //
    // Resolution and not existence: an applet farm shadows a command by putting
    // a link EARLIER in PATH or by replacing the file, and both end at
    // /usr/bin/busybox once the chain is followed. So the check follows the
    // chain the shell would and compares the endpoint. /bin/sh is the case that
    // makes this the right predicate rather than "is a regular file" -- it is a
    // symlink to dash today and correct.
    id: 'packed-gnu-commands-unshadowed',
    shell: {
      pass: 'every GNU command resolves past BusyBox',
      fail: 'GNU command(s) no longer resolve past BusyBox',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const faults: string[] = []
      const resolved: string[] = []
      for (const name of GNU_COMMANDS) {
        const to = resolveCommand(root, name)
        if (to === undefined) {
          faults.push(`${name} is not in PATH at all`)
          continue
        }
        if (to === BUSYBOX_PATH) {
          faults.push(`${name} resolves to ${BUSYBOX_PATH}`)
          continue
        }
        if (!existsSync(join(root, to))) {
          faults.push(`${name} resolves to ${to}, which is not in the image`)
          continue
        }
        resolved.push(`${name}=${to}`)
      }
      return [verdict(
        'packed-gnu-commands-unshadowed',
        faults.length === 0,
        faults.length === 0
          ? `every GNU command resolves past BusyBox: all ${GNU_COMMANDS.length} of `
          + `${resolved.join(' ')}`
          : `${faults.length} GNU command(s) no longer resolve past BusyBox: ${faults.join('; ')}. `
            + 'BusyBox applets take fewer options and differ in behaviour from their GNU cousins, '
            + 'so a shadowed command changes what every script in this image and in the verifier '
            + 'does, and nothing else would report it',
      )]
    },
  },
]
