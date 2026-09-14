// How systemd would resolve a unit's enablement in a packed root: where its
// unit file may live, what the shipped presets say about it, and which `.wants`
// or `.requires` links name it.
//
// ONE IMPLEMENTATION, IMPORTED TWICE. This began as private helpers inside
// `checks-firewall.ts` for `nftables.service`, and `checks-display.ts` needs
// exactly the same predicate for `getty@tty1.service`. A second copy would be
// two readers of one systemd rule, free to disagree about masking or ordering
// while both stayed green -- and the rule they encode is subtle enough that the
// disagreement would not be obvious. So it moved here whole rather than being
// re-transcribed.
//
// THE SUBTLETY, and it is why none of this can be a grep. Preset files mask by
// BASENAME across /etc, /run and /usr/lib; the merged set is then read in
// lexicographic order of that basename; and the FIRST rule matching the unit
// wins. A `grep -q 'disable getty@.service'` finds the line it is looking for
// on an image where an `enable getty@*` in an earlier-sorting file has already
// decided the question the other way.

import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs'
import { pathInRoot } from './checks-root.ts'

/**
 * Where a unit file may live, in the order systemd would find one.
 *
 * Exported because "the unit exists" is what makes a disabled-ness check a
 * statement about something: a root that lost the unit -- renamed, dropped from
 * Depends, or never unpacked -- satisfies "no link names it" and "no preset
 * enables it" trivially, and reports green over an image the check has nothing
 * to say about.
 */
export const UNIT_DIRS: readonly string[] = ['/etc/systemd/system', '/usr/lib/systemd/system']

/**
 * The preset directories, in systemd's own precedence order.
 *
 * Highest precedence first. A file in an earlier directory MASKS a same-named
 * file in a later one, and within the merged set the rules are read in
 * lexicographic order of basename with the FIRST MATCH WINNING.
 */
export const PRESET_DIRS: readonly string[] = [
  '/etc/systemd/system-preset',
  '/run/systemd/system-preset',
  '/usr/lib/systemd/system-preset',
]

/** One preset rule, in the order it would be consulted. */
export interface PresetRule {
  /** The file it came from, image-absolute, for the verdict to name. */
  readonly file: string
  readonly verb: 'enable' | 'disable'
  readonly pattern: string
}

/**
 * Every preset rule in the root, in systemd's consultation order.
 *
 * Masking is by BASENAME across the directories, which is what systemd does and
 * what makes /etc a place an operator could override policy from; the merged
 * set is then sorted by that basename.
 */
export function presetRules(root: string): PresetRule[] {
  const byName = new Map<string, string>()
  for (const dir of PRESET_DIRS) {
    let names: string[]
    try {
      names = readdirSync(pathInRoot(root, dir))
    }
    catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.preset')) continue
      if (!byName.has(name)) byName.set(name, `${dir}/${name}`)
    }
  }
  const out: PresetRule[] = []
  for (const name of [...byName.keys()].sort()) {
    const file = byName.get(name) as string
    let body: string
    try {
      body = readFileSync(pathInRoot(root, file), 'utf8')
    }
    catch {
      continue
    }
    for (const raw of body.split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
      const m = /^(enable|disable)[ \t]+(\S+)/.exec(line)
      if (m === null) continue
      out.push({ file, verb: m[1] as 'enable' | 'disable', pattern: m[2] as string })
    }
  }
  return out
}

/** A systemd preset glob (`*`, `?`) as a whole-string matcher. */
export function globMatches(pattern: string, unit: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(unit)
}

/**
 * The first rule that claims `unit`, or undefined when none does.
 *
 * Undefined is NOT "disabled". systemd's fallback for a unit no rule matches is
 * ENABLE -- measured in a clean trixie root, `systemctl preset nftables.service`
 * with the stock rule set creates `sysinit.target.wants/nftables.service` -- so
 * a caller that treated the absence of a rule as a decision would have it
 * exactly backwards.
 */
export function presetFor(root: string, unit: string): PresetRule | undefined {
  return presetRules(root).find(r => globMatches(r.pattern, unit))
}

/**
 * The preset rule that decides a TEMPLATE INSTANCE, e.g. `getty@tty1.service`.
 *
 * systemd resolves an instance against rules written for the instance and rules
 * written for the template it comes from, so `disable getty@.service` governs
 * `getty@tty1.service`. A caller that only asked `presetFor(root, instance)`
 * would miss the template rule and report an image as undecided when its policy
 * file is right there. The instance's own rule is consulted first, because a
 * rule naming it exactly is the more specific statement.
 */
export function presetForInstance(root: string, instance: string): PresetRule | undefined {
  const at = instance.indexOf('@')
  if (at < 0) return presetFor(root, instance)
  const dot = instance.lastIndexOf('.')
  const template = `${instance.slice(0, at + 1)}${dot > at ? instance.slice(dot) : ''}`
  return presetRules(root).find(r => globMatches(r.pattern, instance) || globMatches(r.pattern, template))
}

/**
 * Every `.wants` or `.requires` symlink under the unit trees whose basename is
 * `unit`.
 *
 * Both suffixes, because both are enablement: an `[Install]` section can name
 * either, and a check that knew only the first would miss half of the mechanism
 * it exists to find.
 *
 * Resolved through `pathInRoot` with `followLeaf: false`: the directory chain is
 * followed INSIDE the image, so an absolute symlink on the way to a `.wants`
 * directory cannot escape to the verifier's own filesystem, while the leaf is
 * left alone because the leaf IS the subject -- these entries are symlinks by
 * construction and a dangling one must be reported rather than skipped.
 */
export function wantsLinksNaming(root: string, unit: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(pathInRoot(root, dir))
    }
    catch {
      return
    }
    for (const name of names) {
      const path = `${dir}/${name}`
      let st: Stats
      try {
        st = lstatSync(pathInRoot(root, path, false))
      }
      catch {
        continue
      }
      if (st.isDirectory()) {
        visit(path)
        continue
      }
      if (name === unit && (dir.endsWith('.wants') || dir.endsWith('.requires'))) out.push(path)
    }
  }
  for (const dir of UNIT_DIRS) visit(dir)
  return out
}
