// The time contract of PLAN-044: the composed root carries systemd-timesyncd,
// enabled, under the pinned base policy, and keeps its default timezone UTC.
//
// Four checks, four different failures. The package can be absent while the
// drop-in ships (a manifest edit lost the package), the drop-in can drift while
// the package installs (someone "tuned" a value that is base policy, not a
// setting), the enablement symlink can be lost without either (a payload edit),
// and a timezone can reach /etc while all three hold (machine time must stay
// UTC; the timezone is presentation, owned by the settings surface, and never
// this file's).
//
// The policy values are TRANSCRIBED from the shipped drop-in rather than read
// out of it, for checks-fixture.ts's ORACLE_BUILTIN_MARKUP reason: a check
// seeded from the very file it asserts would move with that file and stay
// green. These four numbers are PLAN-044's, fixed by decision on 2026-08-31,
// and an image disagreeing with them is the failure whichever side was edited.

import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckCase } from './checks.ts'
import type { CheckResult } from './parity.ts'
import { entry, ETC_UNITS, packedRoot, wantsLink } from './checks-root.ts'
import { verdict } from './verdict.ts'

/** An independent transcription; checks-root.ts keeps its own. */
const MANIFEST_PATH = '/usr/share/mica/manifest.tsv'
const DROPIN_PATH = '/etc/systemd/timesyncd.conf.d/50-mica.conf'
const UNIT = 'systemd-timesyncd.service'

/**
 * The pinned base policy, in the drop-in's own key order.
 *
 * Exactly these four, no more: the drop-in is base policy and everything in it
 * is a decision PLAN-044 made once. A fifth key arriving there is either a new
 * decision (then it lands here in the same change) or someone routing a setting
 * around the settings surface -- and the check cannot tell which, so it goes
 * red and says what it found.
 */
const PINNED: ReadonlyArray<readonly [string, string]> = [
  ['PollIntervalMinSec', '32'],
  ['PollIntervalMaxSec', '2048'],
  ['ConnectionRetrySec', '30'],
  ['SaveIntervalSec', '60'],
]

/**
 * The `[Time]` assignments of an ini-ish drop-in, in file order.
 *
 * Sections are tracked because systemd does: a `PollIntervalMinSec=` line
 * outside `[Time]` is silently ignored by timesyncd, so a drop-in that moved
 * its keys above the header would apply NOTHING while a section-blind reader
 * called it correct. Assignments outside `[Time]` are returned under their own
 * section name so the failure can name where the line actually is.
 */
function assignments(text: string): ReadonlyArray<{ section: string, key: string, value: string }> {
  const out: { section: string, key: string, value: string }[] = []
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out.push({ section, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() })
  }
  return out
}

export const TIME_CHECKS: readonly CheckCase[] = [
  {
    // The package, asked of the shipped bill of materials -- the finalizer
    // purges the dpkg database, so manifest.tsv is the one record on the device
    // of what was installed. Row shape and stamp discipline are
    // packed-mica-manifest's; this check asks only whether the row EXISTS.
    id: 'packed-timesyncd-installed',
    shell: {
      pass: 'systemd-timesyncd is in the shipped manifest',
      fail: 'systemd-timesyncd is not in the image',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const st = entry(root, MANIFEST_PATH)
      if (st === undefined || !st.isFile()) {
        return [verdict('packed-timesyncd-installed', false,
          `systemd-timesyncd is not in the image's bill of materials: ${MANIFEST_PATH} is not a `
          + `regular file in the packed root, so there is no record it was ever installed`)]
      }
      const rows = readFileSync(join(root, MANIFEST_PATH), 'latin1')
        .split('\n')
        .filter(l => l !== '' && !l.startsWith('#'))
      const found = rows.find(l => l.split('\t')[0] === 'systemd-timesyncd')
      if (found === undefined) {
        return [verdict('packed-timesyncd-installed', false,
          `systemd-timesyncd is not in the image's bill of materials: ${MANIFEST_PATH} records `
          + `${rows.length} package(s) and none of them is it. An image without the daemon never `
          + `synchronizes its clock, however correct the drop-in and the symlink beside it are`)]
      }
      return [verdict('packed-timesyncd-installed', true,
        `systemd-timesyncd is in the shipped manifest (${(found.split('\t')[1] ?? '').trim() || 'no version recorded'})`)]
    },
  },

  {
    // Enablement is package-owned symlink payload in this tree, and the unit's
    // own [Install] says WantedBy=sysinit.target -- but the check searches the
    // whole /etc tree the way sq_enabled does rather than naming the target
    // directory, so a link systemd would honour from another target reports the
    // path it found instead of a second failure about where it sits.
    id: 'packed-timesyncd-enabled',
    shell: {
      pass: `${UNIT} is enabled (`,
      fail: `${UNIT} enablement symlink missing`,
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const link = wantsLink(await packedRoot(ctx), ETC_UNITS, UNIT)
      return [verdict(
        'packed-timesyncd-enabled',
        link !== undefined,
        link !== undefined
          ? `${UNIT} is enabled (${link})`
          : `${UNIT} enablement symlink missing (no *.wants entry under /etc/systemd/system)`,
      )]
    },
  },

  {
    // The drop-in, held to EXACTLY the four pinned values -- present, in
    // [Time], each once, at PLAN-044's number, and nothing else assigned. The
    // failure prints the whole diff in one sentence because the likeliest
    // editor is someone who believed one of these was a setting.
    id: 'packed-timesyncd-policy',
    shell: {
      pass: 'the timesyncd drop-in pins the base sync policy',
      fail: 'timesyncd base policy drop-in',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const st = entry(root, DROPIN_PATH)
      if (st === undefined || !st.isFile()) {
        return [verdict('packed-timesyncd-policy', false,
          `timesyncd base policy drop-in ${DROPIN_PATH} is not a regular file in the packed root. `
          + `Without it timesyncd runs on its compiled defaults -- 32-2048s polling but a 30s `
          + `ConnectionRetrySec and 60s SaveIntervalSec nobody pinned`)]
      }
      const got = assignments(readFileSync(join(root, DROPIN_PATH), 'utf8'))
      const wrong: string[] = []
      for (const [key, value] of PINNED) {
        const inTime = got.filter(a => a.section === 'Time' && a.key === key)
        if (inTime.length === 0) wrong.push(`${key} is not assigned in [Time]`)
        else if (inTime.length > 1) wrong.push(`${key} is assigned ${inTime.length} times`)
        else if (inTime[0]?.value !== value) wrong.push(`${key}=${inTime[0]?.value ?? ''}, pinned ${value}`)
      }
      for (const a of got) {
        if (a.section === 'Time' && PINNED.some(([key]) => key === a.key)) continue
        wrong.push(`${a.key}=${a.value} in [${a.section}] is not part of the pinned policy`)
      }
      if (wrong.length > 0) {
        return [verdict('packed-timesyncd-policy', false,
          `timesyncd base policy drop-in ${DROPIN_PATH} does not carry exactly the four pinned `
          + `values: ${wrong.join('; ')}. These are PLAN-044 base policy, not settings; an image `
          + `disagreeing with them was edited around that decision`)]
      }
      return [verdict('packed-timesyncd-policy', true,
        'the timesyncd drop-in pins the base sync policy '
        + '(PollIntervalMinSec=32, PollIntervalMaxSec=2048, ConnectionRetrySec=30, SaveIntervalSec=60)')]
    },
  },

  {
    // Machine, RTC, API and log time are UTC by contract; the timezone is
    // presentation and lives with the settings surface, never in the signed
    // root. /etc/localtime absent and /etc/localtime -> .../UTC both spell
    // that; anything else is a zone baked into every device this image reaches.
    id: 'packed-localtime-utc',
    shell: {
      pass: 'image default timezone is UTC (',
      fail: '/etc/localtime ',
    },
    run: async (ctx): Promise<readonly CheckResult[]> => {
      const root = await packedRoot(ctx)
      const st = entry(root, '/etc/localtime')
      if (st === undefined) {
        return [verdict('packed-localtime-utc', true,
          'image default timezone is UTC (/etc/localtime is absent, so glibc and systemd fall back to UTC)')]
      }
      if (!st.isSymbolicLink()) {
        return [verdict('packed-localtime-utc', false,
          '/etc/localtime is not a symlink. A copied zone file cannot be read back to a zone name, '
          + 'so what timezone this image bakes in cannot even be reported; the contract is UTC, as '
          + 'a link into zoneinfo or as absence')]
      }
      const target = readlinkSync(join(root, '/etc/localtime'))
      const zone = target.split('/').pop() ?? ''
      return [verdict(
        'packed-localtime-utc',
        zone === 'UTC',
        zone === 'UTC'
          ? `image default timezone is UTC (/etc/localtime -> ${target})`
          : `/etc/localtime -> ${target}, which is not UTC. Machine/RTC/API/log time is UTC by `
            + `contract; a timezone is presentation, applied by the settings surface at runtime and `
            + `never baked into the signed root`,
      )]
    },
  },
]
