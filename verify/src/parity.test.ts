// The parity harness, driven from every failing side it has.
//
// THIS FILE IS THE ANSWER TO "A GUARD YOU CANNOT DRIVE RED IS NOT A GUARD".
// The harness's whole job is to notice a difference between two verifiers, and
// the way it fails is by NOT noticing -- which produces exactly the same output
// as agreement. So every outcome it can report is produced here on purpose,
// including the ones that should never happen in a healthy run: an ambiguous
// register, an orphaned result, a check that fired on neither side.
//
// The shell transcripts below are the real thing, copied out of the runs
// against the real cx3576 and x64 images on 2026-08-25, prose and all. A
// transcript this file invented would test this file's idea of what the
// verifier prints -- the same objection the image fixture contract raises to
// an fstab fixture it authored itself.

import { describe, expect, test } from 'bun:test'
import {
  diffParity,
  formatReport,
  parseShellRun,
  type CheckResult,
  type RegisteredCheck,
} from './parity.ts'

/** Four real conclusions and a real summary line, cx3576, 2026-08-25. */
const REAL = [
  'PASS: default path is a symlink to cx3576-mica-1787661246.img',
  'PASS: disk GUID is 5AC35760-0002-4000-8000-000000000000',
  'PASS: p1 PARTLABEL is \'loader\'',
  'PASS: p2 PARTLABEL is \'uenv-a\'',
  'SKIP: the ESP assertions (bootloader=uboot): U-Boot is firmware, so this board has no EFI system partition and its boot pair is the whole boot chain',
  'RESULT: PASS (4/4 checks, 1 skipped (cx3576/uboot; each named above))',
  '',
].join('\n')

function shell(lines: readonly string[], summary: string): string {
  return `${[...lines, summary].join('\n')}\n`
}

describe('parseShellRun reads what the verifier printed, or refuses', () => {
  test('a real run: four conclusions, one skip, and the summary agrees', () => {
    const run = parseShellRun(REAL)
    expect(run.lines).toHaveLength(5)
    expect(run.lines.filter(l => l.verdict === 'pass')).toHaveLength(4)
    expect(run.lines.filter(l => l.verdict === 'skip')).toHaveLength(1)
    expect(run.summary).toEqual({ result: 'PASS', passed: 4, total: 4, skipped: 1 })
    // The message keeps its prose and loses only the prefix.
    expect(run.lines[1]?.message).toBe('disk GUID is 5AC35760-0002-4000-8000-000000000000')
    expect(run.lines[1]?.line).toBe(2)
  })

  test('a FAIL run parses too, and a FAIL is a conclusion like any other', () => {
    const run = parseShellRun(shell(
      ['PASS: disk GUID is X', 'FAIL: exactly 11 partitions'],
      'RESULT: FAIL (1/2 checks)',
    ))
    expect(run.summary).toEqual({ result: 'FAIL', passed: 1, total: 2, skipped: 0 })
    expect(run.lines.map(l => l.verdict)).toEqual(['pass', 'fail'])
  })

  test('no RESULT line: the run died mid-check and its conclusions are a prefix', () => {
    expect(() => parseShellRun('PASS: a\nPASS: b\n')).toThrow(/printed no "RESULT:" line/)
  })

  test('a summary shape this parser does not know is refused, not ignored', () => {
    expect(() => parseShellRun('PASS: a\nRESULT: MAYBE (some checks)\n')).toThrow(/not a shape this parser knows/)
  })

  test('more PASS lines than the verifier counted: the parser is over-reading', () => {
    expect(() => parseShellRun(shell(['PASS: a', 'PASS: b'], 'RESULT: PASS (1/1 checks)')))
      .toThrow(/2 PASS lines, summary says 1/)
  })

  test('fewer conclusions than the verifier counted: the parser MISSED some', () => {
    // The dangerous direction. A message with an embedded newline, a truncated
    // capture -- and every "agreement" after it is agreement about the part
    // that was read.
    expect(() => parseShellRun(shell(['PASS: a'], 'RESULT: PASS (3/3 checks)')))
      .toThrow(/1 PASS lines, summary says 3/)
  })

  test('a skip the parser did not see is refused by the same rule', () => {
    expect(() => parseShellRun(shell(['PASS: a'], 'RESULT: PASS (1/1 checks, 2 skipped (x/y))')))
      .toThrow(/0 SKIP lines, summary says 2/)
  })

  test('a RESULT line and no conclusions at all is refused', () => {
    expect(() => parseShellRun('RESULT: PASS (0/0 checks)\n'))
      .toThrow(/agrees with everything/)
  })
})

// ---------------------------------------------------------------------------

const GUID: RegisteredCheck = { id: 'gpt-disk-guid', shell: { pass: 'disk GUID is' } }
const LABEL: RegisteredCheck = {
  id: 'gpt-partlabel',
  cardinality: 'many',
  instance: /^p(\d+) PARTLABEL is/,
  shell: { pass: 'PARTLABEL is' },
}
const ESP: RegisteredCheck = {
  id: 'esp-assertions',
  shell: { pass: 'the ESP is present', skip: 'the ESP assertions (bootloader=uboot)' },
}

function result(id: string, verdict: CheckResult['verdict'], instance?: string): CheckResult {
  return { id, verdict, message: `${id} says ${verdict}`, ...(instance === undefined ? {} : { instance }) }
}

function run(
  checks: readonly RegisteredCheck[],
  results: readonly CheckResult[],
  stdout: string = REAL,
  board = 'cx3576',
): ReturnType<typeof diffParity> {
  return diffParity({ board, image: '/x.img', shell: parseShellRun(stdout), checks, results })
}

describe('the diff pairs by identity, and says so when it cannot', () => {
  test('agreement is agreement, and it is not the only thing reported', () => {
    const report = run([GUID], [result('gpt-disk-guid', 'pass')])
    expect(report.counts.agree).toBe(1)
    expect(report.counts.diverge).toBe(0)
    // Four other conclusions are still unclaimed, so this is NOT parity.
    expect(report.counts['not-ported']).toBe(4)
    expect(report.conclusion).toBe('INCOMPLETE')
  })

  test('full parity is PASS, and only when nothing is left over', () => {
    const report = run(
      [GUID, LABEL, ESP, { id: 'symlink', shell: { pass: 'default path is a symlink' } }],
      [
        result('gpt-disk-guid', 'pass'),
        result('gpt-partlabel', 'pass', '1'),
        result('gpt-partlabel', 'pass', '2'),
        result('esp-assertions', 'skip'),
        result('symlink', 'pass'),
      ],
    )
    expect(report.counts).toMatchObject({ agree: 5, diverge: 0, 'not-ported': 0, orphan: 0, unfired: 0 })
    expect(report.conclusion).toBe('PASS')
  })

  test('PASS against FAIL is a divergence, named, with both messages', () => {
    const report = run([GUID], [result('gpt-disk-guid', 'fail')])
    const row = report.rows.find(r => r.outcome === 'diverge')
    expect(row?.id).toBe('gpt-disk-guid')
    expect(row?.shell).toBe('pass')
    expect(row?.ts).toBe('fail')
    expect(row?.detail).toContain('disk GUID is 5AC35760')
    expect(report.conclusion).toBe('FAIL')
  })

  test('PASS against SKIP is a divergence -- a skip is NOT a pass', () => {
    // The failure the shell verifier's own SKIP_N exists to prevent, on the
    // other side of the port: 3 skips on cx3576 and 22 on x64 are real, and a
    // check that quietly became one must not read as agreement.
    const report = run([GUID], [result('gpt-disk-guid', 'skip')])
    expect(report.counts.diverge).toBe(1)
    expect(report.rows.find(r => r.outcome === 'diverge')?.ts).toBe('skip')
    expect(report.conclusion).toBe('FAIL')
  })

  test('a SKIP the register does not claim stays unclaimed, with SKIP written on it', () => {
    // ESP is registered here WITHOUT a skip matcher, so its skip line does not
    // match its pass matcher and does not silently compare as a pass.
    const noSkip: RegisteredCheck = { id: 'esp-assertions', shell: { pass: 'the ESP assertions' } }
    const report = run([noSkip], [])
    const row = report.rows.find(r => r.shell === 'skip')
    expect(row?.outcome).toBe('not-ported')
    expect(report.counts.unfired).toBe(1)
  })

  test('a check that fires many times is compared per instance, not by count', () => {
    const report = run([LABEL], [result('gpt-partlabel', 'pass', '1'), result('gpt-partlabel', 'fail', '2')])
    const rows = report.rows.filter(r => r.id === 'gpt-partlabel')
    expect(rows.map(r => `${r.instance}:${r.outcome}`).sort()).toEqual(['1:agree', '2:diverge'])
  })

  test('the same COUNT of firings with different identities is still a divergence', () => {
    // Two results, two shell lines -- and one of them names an instance the
    // shell never produced. A count would call this parity.
    const report = run([LABEL], [result('gpt-partlabel', 'pass', '1'), result('gpt-partlabel', 'pass', '9')])
    expect(report.counts.agree).toBe(1)
    expect(report.counts.orphan).toBe(1)
    expect(report.counts['ts-silent']).toBe(1)
    expect(report.conclusion).toBe('FAIL')
  })

  test('two checks claiming one line is a register fault, not a verdict', () => {
    const twin: RegisteredCheck = { id: 'gpt-guid-twin', shell: { pass: 'disk GUID' } }
    const report = run([GUID, twin], [])
    const row = report.rows.find(r => r.outcome === 'ambiguous')
    expect(row?.id).toBe('gpt-disk-guid + gpt-guid-twin')
    expect(report.conclusion).toBe('FAIL')
  })

  test('one single-firing check claiming two lines is a register fault', () => {
    const loose: RegisteredCheck = { id: 'loose', shell: { pass: 'PARTLABEL is' } }
    const report = run([loose], [])
    expect(report.counts.ambiguous).toBe(1)
    expect(report.rows.find(r => r.outcome === 'ambiguous')?.detail).toContain('matched a second shell line')
  })

  test("a 'many' check whose instance pattern misses gives that firing no identity", () => {
    const wrong: RegisteredCheck = { ...LABEL, instance: /^partition (\d+)/ }
    const report = run([wrong], [])
    expect(report.counts.ambiguous).toBe(2)
  })

  test("'many' with no instance pattern at all is refused before any comparison", () => {
    expect(() => run([{ id: 'x', cardinality: 'many', shell: { pass: 'PARTLABEL' } }], []))
      .toThrow(/could only be compared by COUNT/)
  })

  test('two checks registered under one id are refused', () => {
    expect(() => run([GUID, { id: 'gpt-disk-guid', shell: { pass: 'other' } }], []))
      .toThrow(/two checks are registered as/)
  })

  test('a result for an unregistered id is an orphan, not an agreement', () => {
    const report = run([GUID], [result('gpt-disk-guid', 'pass'), result('invented', 'pass')])
    expect(report.counts.orphan).toBe(1)
    expect(report.rows.find(r => r.outcome === 'orphan')?.id).toBe('invented')
  })

  test('a registered check the port answered but the shell never printed is an orphan', () => {
    const ghost: RegisteredCheck = { id: 'ghost', shell: { pass: 'nothing prints this' } }
    const report = run([ghost], [result('ghost', 'pass')])
    expect(report.counts.orphan).toBe(1)
    expect(report.rows.find(r => r.outcome === 'orphan')?.detail).toContain('does not appear in what the shell actually prints')
  })

  test('the shell concluded, the port stayed silent: ts-silent, never agreement', () => {
    const report = run([GUID], [])
    expect(report.counts['ts-silent']).toBe(1)
    expect(report.counts.agree).toBe(0)
    expect(report.conclusion).toBe('FAIL')
  })

  test('registered, applicable, and silent on BOTH sides is `unfired`', () => {
    const ghost: RegisteredCheck = { id: 'ghost', shell: { pass: 'nothing prints this' } }
    const report = run([ghost], [])
    expect(report.counts.unfired).toBe(1)
    expect(report.rows.find(r => r.outcome === 'unfired')?.detail).toContain('runs nowhere')
  })

  test('a check scoped to another board is neither unfired nor compared here', () => {
    const x64Only: RegisteredCheck = { id: 'esp', boards: ['x64'], shell: { pass: 'the ESP is present' } }
    const report = run([x64Only], [])
    expect(report.counts.unfired).toBe(0)
    expect(report.registered).toBe(0)
  })

  test('the same check IS measured on the board it is scoped to', () => {
    const x64Only: RegisteredCheck = { id: 'esp', boards: ['x64'], shell: { pass: 'the ESP is present' } }
    const report = run([x64Only], [], REAL, 'x64')
    expect(report.registered).toBe(1)
    expect(report.counts.unfired).toBe(1)
  })
})

describe('the report cannot be read as agreement when nothing was compared', () => {
  test('an empty register: every conclusion unclaimed, and the headline says so', () => {
    const report = run([], [])
    expect(report.conclusion).toBe('INCOMPLETE')
    expect(report.counts['not-ported']).toBe(5)
    const text = formatReport(report)
    expect(text).toContain('not-ported  5')
    expect(text).toContain('of which PASS 4, FAIL 0, SKIP 1')
    expect(text).toContain('This is NOT agreement')
    expect(text).not.toContain('PARITY cx3576: PASS')
  })

  test('the unclaimed list is capped, and says how many it did not print', () => {
    expect(formatReport(run([], []), { maxNotPorted: 2 })).toContain('and 3 more')
  })

  test('full parity says PASS and says what it compared', () => {
    const only: RegisteredCheck = { id: 'one', shell: { pass: 'X' } }
    const report = diffParity({
      board: 'cx3576',
      image: '/x.img',
      shell: parseShellRun(shell(['PASS: X happened'], 'RESULT: PASS (1/1 checks)')),
      checks: [only],
      results: [result('one', 'pass')],
    })
    expect(formatReport(report)).toContain('PARITY cx3576: PASS')
    expect(formatReport(report)).toContain('nothing left unclaimed')
  })

  test('a divergence is named in the report body, not only counted', () => {
    const text = formatReport(run([GUID], [result('gpt-disk-guid', 'fail')]))
    expect(text).toContain('gpt-disk-guid: shell PASS / TypeScript FAIL')
  })
})
