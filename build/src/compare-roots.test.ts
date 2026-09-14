// What the comparator refuses, what it classifies, and what the ledger's two
// hard rules do.
//
// The refusals are the half that matters most here: every one of them is a
// shape in which a comparison would report "no differences" while having looked
// at nothing, and each is driven from the failing side. The classifier's
// individual branches are unit-tested against fixtures, which is what fixtures
// are for -- but a comparator proven ONLY on fixtures has been tested against
// the fixtures' author, so the acceptance evidence is the run against two real
// x64 roots recorded in tests/dual-build-sanctions.md.

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LEDGER } from './compare-roots-cli.ts'
import {
  byteCompare,
  canonicalDiff,
  compareRoots,
  DIFF_CLASSES,
  type Difference,
  diffTrees,
  type Entry,
  extractOciRoot,
  formatReport,
  MIN_PATHS,
  parseLedger,
  readFileCaps,
  readTree,
  sanctionMatches,
  type Tree,
} from './compare-roots.ts'
import { makeWorkDir, SRC_DIR } from './paths.ts'

const CLI = join(SRC_DIR, 'compare-roots-cli.ts')

/** A ledger holding exactly the stanzas a test needs, written where the test can point at it. */
function ledger(dir: string, body: string, name = 'sanctions.md'): string {
  const path = join(dir, name)
  writeFileSync(path, `# fixture\n\n## Sanctions\n\n${body}`)
  return path
}

/** A minimal root: enough paths to say something, far under the shipped floor on purpose. */
function fixtureRoot(dir: string, name: string): string {
  const root = join(dir, name)
  mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
  mkdirSync(join(root, 'etc'), { recursive: true })
  writeFileSync(join(root, 'usr', 'bin', 'micad'), 'ELF-ish\n')
  writeFileSync(join(root, 'etc', 'passwd'), 'root:x:0:0::/root:/bin/sh\n')
  symlinkSync('/run/mica/shadow', join(root, 'etc', 'shadow'))
  return root
}

function withWork<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = makeWorkDir(prefix)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Run the real CLI, because the exit-code contract is what the future gate driver reads. */
function cli(args: readonly string[]): { code: number, out: string } {
  const r = Bun.spawnSync([process.execPath, 'run', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
  }
}

const NO_SANCTIONS = '## Sanctions\n'

describe('the refusals: every shape in which a comparison would examine nothing', () => {
  test('a side that does not exist is refused by name, both sides', () => {
    withWork('cmp-missing', dir => {
      const a = fixtureRoot(dir, 'a')
      const l = ledger(dir, '')
      expect(() => compareRoots({ a: join(dir, 'nope'), b: a, ledgerPath: l, minPaths: 1 }))
        .toThrow(/side A is .*nope, which does not exist/)
      expect(() => compareRoots({ a, b: join(dir, 'nope'), ledgerPath: l, minPaths: 1 }))
        .toThrow(/side B is .*nope, which does not exist/)
    })
  })

  test('a side that is a FILE rather than a directory is refused by name', () => {
    withWork('cmp-notdir', dir => {
      const a = fixtureRoot(dir, 'a')
      const file = join(dir, 'archive.oci')
      writeFileSync(file, 'not a tree')
      expect(() => compareRoots({ a: file, b: a, ledgerPath: ledger(dir, ''), minPaths: 1 }))
        .toThrow(/side A is .*archive\.oci, which is not a directory/)
    })
  })

  test('an EMPTY side is refused, and not reported as agreement', () => {
    withWork('cmp-empty', dir => {
      const a = fixtureRoot(dir, 'a')
      const empty = join(dir, 'empty')
      mkdirSync(empty)
      expect(() => compareRoots({ a: empty, b: a, ledgerPath: ledger(dir, ''), minPaths: 1 }))
        .toThrow(/side A .* is EMPTY/)
      // Both sides empty is the one that would otherwise print a perfect green.
      const empty2 = join(dir, 'empty2')
      mkdirSync(empty2)
      expect(() => compareRoots({ a: empty, b: empty2, ledgerPath: ledger(dir, ''), minPaths: 1 }))
        .toThrow(/is EMPTY/)
    })
  })

  test('a side under the path floor is refused, with the floor and the count', () => {
    withWork('cmp-floor', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      // The DEFAULT floor, not a test-chosen one: this is the number the CLI
      // and therefore the gate actually runs with.
      expect(() => compareRoots({ a, b, ledgerPath: ledger(dir, '') }))
        .toThrow(new RegExp(`side A .* holds 6 paths, under the floor of ${MIN_PATHS}`))
    })
  })

  test('the floor sits far below a real root and far above every mis-extraction', () => {
    // A number nobody has reasoned about is a number that will be lowered until
    // it stops firing. 500 is over an order of magnitude under the 9,240-entry
    // x64 factory root tests/factory-root-gate walks, and two orders over an
    // OCI-layout directory handed across in place of an extracted root.
    expect(MIN_PATHS).toBe(500)
  })

  test('the two sides being ONE directory is refused, including through a symlink', () => {
    withWork('cmp-same', dir => {
      const a = fixtureRoot(dir, 'a')
      const l = ledger(dir, '')
      expect(() => compareRoots({ a, b: a, ledgerPath: l, minPaths: 1 }))
        .toThrow(/side A and side B are the same directory/)
      const link = join(dir, 'also-a')
      symlinkSync(a, link)
      expect(() => compareRoots({ a, b: link, ledgerPath: l, minPaths: 1 }))
        .toThrow(/side A and side B are the same directory/)
    })
  })

  test('a ledger that is not there is refused: there is no run without one', () => {
    withWork('cmp-noledger', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      expect(() => compareRoots({ a, b, ledgerPath: join(dir, 'nothing.md'), minPaths: 1 }))
        .toThrow(/nothing\.md does not exist/)
    })
  })
})

describe('the ledger parser refuses what it cannot read', () => {
  test('a file with no Sanctions heading, which would otherwise parse as zero stanzas', () => {
    expect(() => parseLedger('# notes\n\nsome prose\n', 'x.md')).toThrow(/has no '## Sanctions' heading/)
  })

  test('a stanza with no reason, and one with an empty reason', () => {
    expect(() => parseLedger(`${NO_SANCTIONS}### /a\n- classes: added\n`, 'x.md'))
      .toThrow(/stanza '\/a' has no 'reason:' text/)
    expect(() => parseLedger(`${NO_SANCTIONS}### /a\n- classes: added\n- reason:\n`, 'x.md'))
      .toThrow(/stanza '\/a' has no 'reason:' text/)
  })

  test('a stanza with no classes', () => {
    expect(() => parseLedger(`${NO_SANCTIONS}### /a\n- reason: because\n`, 'x.md'))
      .toThrow(/stanza '\/a' has no 'classes:' line/)
  })

  test('a class this comparator does not report', () => {
    expect(() => parseLedger(`${NO_SANCTIONS}### /a\n- classes: mtime\n- reason: because\n`, 'x.md'))
      .toThrow(/names the class 'mtime', which this comparator does not report/)
  })

  test('an unknown key -- a condition its author believed they had written down', () => {
    expect(() => parseLedger(`${NO_SANCTIONS}### /a\n- classes: added\n- reason: r\n- unless: friday\n`, 'x.md'))
      .toThrow(/carries the unknown key 'unless'/)
  })

  test('one pattern sanctioned twice', () => {
    const text = `${NO_SANCTIONS}### /a\n- classes: added\n- reason: r\n\n### /a\n- classes: removed\n- reason: r\n`
    expect(() => parseLedger(text, 'x.md')).toThrow(/'\/a' is sanctioned twice/)
  })

  test('a bad status, and a key before any stanza', () => {
    expect(() => parseLedger(`${NO_SANCTIONS}### /a\n- classes: added\n- status: later\n- reason: r\n`, 'x.md'))
      .toThrow(/has status 'later'/)
    expect(() => parseLedger(`${NO_SANCTIONS}- classes: added\n`, 'x.md'))
      .toThrow(/appears before any '### <pattern>' stanza heading/)
  })

  test('prose above the heading is prose, and backticks around a pattern are not part of it', () => {
    const text = '# title\n\n### /not-a-stanza\n- classes: nonsense\n\n## Sanctions\n\n'
      + '### `/usr/share/doc/**`\n- classes: added, content\n- status: pending\n- reason: because\n'
    const s = parseLedger(text, 'x.md')
    expect(s.length).toBe(1)
    expect(s[0]?.pattern).toBe('/usr/share/doc/**')
    expect(s[0]?.classes).toEqual(['added', 'content'])
    expect(s[0]?.status).toBe('pending')
  })
})

describe('the classifier, over real trees on disk', () => {
  test('added, removed, type, mode, symlink and content are each reported', () => {
    withWork('cmp-classes', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      writeFileSync(join(b, 'usr', 'bin', 'newthing'), 'x\n') // added
      rmSync(join(a, 'etc', 'passwd')) // gone from A, so: added
      writeFileSync(join(b, 'etc', 'motd'), 'hello\n') // added
      rmSync(join(b, 'usr', 'bin', 'micad'))
      mkdirSync(join(b, 'usr', 'bin', 'micad')) // type: file -> dir
      writeFileSync(join(a, 'etc', 'hosts'), 'a\n')
      writeFileSync(join(b, 'etc', 'hosts'), 'b\n') // content
      chmodSync(join(a, 'etc', 'hosts'), 0o600) // mode
      chmodSync(join(b, 'etc', 'hosts'), 0o644) // pinned on both sides: umask is not a fixture
      rmSync(join(b, 'etc', 'shadow'))
      symlinkSync('/run/mica/elsewhere', join(b, 'etc', 'shadow')) // symlink target

      const diffs = diffTrees(readTree(a).tree, readTree(b).tree)
      const seen = new Map(diffs.map(d => [`${d.path} ${d.cls}`, d]))
      expect([...seen.keys()].sort()).toEqual([
        '/etc/hosts content',
        '/etc/hosts mode',
        '/etc/motd added',
        '/etc/passwd added',
        '/etc/shadow symlink',
        // A file that became a directory changed its mode too, and both are
        // reported: they are separate claims and a ledger sanctions them
        // separately.
        '/usr/bin/micad mode',
        '/usr/bin/micad type',
        '/usr/bin/newthing added',
      ])
      expect(seen.get('/usr/bin/micad type')?.a).toBe('file')
      expect(seen.get('/usr/bin/micad type')?.b).toBe('dir')
      expect(seen.get('/etc/hosts mode')?.a).toBe('0600')
      expect(seen.get('/etc/hosts mode')?.b).toBe('0644')
      expect(seen.get('/etc/shadow symlink')?.b).toBe('/run/mica/elsewhere')
    })
  })

  test('a path missing from B is a removal, not an addition', () => {
    withWork('cmp-removed', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      rmSync(join(b, 'etc', 'passwd'))
      const diffs = diffTrees(readTree(a).tree, readTree(b).tree)
      expect(diffs.map(d => `${d.path} ${d.cls}`)).toEqual(['/etc/passwd removed'])
      expect(diffs[0]?.a).toBe('file')
      expect(diffs[0]?.b).toBeUndefined()
    })
  })

  test('uid and gid are reported -- driven at the map layer, where no chown is needed', () => {
    // Ownership differences need root to CREATE on disk and nothing at all to
    // compare, so the branch is driven where it lives. The real ownership read
    // is exercised by every other test in this file (readTree fills uid/gid
    // from lstat on real files) and by the x64 run in the ledger.
    const base: Entry = { kind: 'file', mode: 0o644, uid: 0, gid: 0, hash: 'h' }
    const a: Tree = new Map([['/x', base]])
    const b: Tree = new Map([['/x', { ...base, uid: 970, gid: 969 }]])
    expect(diffTrees(a, b).map(d => `${d.cls} ${d.a}->${d.b}`)).toEqual(['uid 0->970', 'gid 0->969'])
  })

  test('a type difference does not also produce a content or symlink difference', () => {
    // Two records for one fact would need two sanctions, and the second would
    // be a sanction for a comparison that was never made.
    const a: Tree = new Map([['/x', { kind: 'file', mode: 0o644, uid: 0, gid: 0, hash: 'h' }]])
    const b: Tree = new Map([['/x', { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target: '/y' }]])
    expect(diffTrees(a, b).map(d => d.cls)).toEqual(['type', 'mode'])
  })

  test('the output order is C-locale by path, then by class', () => {
    const e: Entry = { kind: 'file', mode: 0o644, uid: 0, gid: 0, hash: 'h' }
    const a: Tree = new Map([['/b', e], ['/a', e], ['/A', e]])
    const b: Tree = new Map([['/b', { ...e, hash: 'i', mode: 0o600 }], ['/a', { ...e, hash: 'i' }]])
    expect(diffTrees(a, b).map(d => `${d.path} ${d.cls}`)).toEqual([
      '/A removed', '/a content', '/b mode', '/b content',
    ])
    // Byte order, not UTF-16 code-unit order, and this pair is where the two
    // disagree: U+10000 is a surrogate pair (D800 DC00) that sorts BELOW U+FFFD
    // by code unit and ABOVE it by UTF-8 byte. Every other listing in this
    // repository is `LC_ALL=C sort`ed, so the byte answer is the one that
    // matches.
    expect(byteCompare('/a', '/A')).toBeGreaterThan(0)
    expect(byteCompare('/\u{10000}', '/\uFFFD')).toBeGreaterThan(0)
    expect('/\u{10000}' < '/\uFFFD').toBe(true)
  })

  test('every class this comparator declares can be produced by it', () => {
    // A class in the vocabulary that nothing emits is a class a ledger can
    // sanction forever without ever covering anything.
    const f: Entry = { kind: 'file', mode: 0o644, uid: 0, gid: 0, hash: 'h' }
    const l: Entry = { kind: 'symlink', mode: 0o777, uid: 0, gid: 0, target: '/one' }
    const a: Tree = new Map([['/gone', f], ['/link', l], ['/x', f]])
    const b: Tree = new Map([
      ['/new', f],
      ['/link', { ...l, target: '/other' }],
      ['/x', { kind: 'symlink', mode: 0o600, uid: 1, gid: 2, target: '/t', caps: 'cap_net_raw=ep' } as Entry],
    ])
    const produced = new Set(diffTrees(a, b).map(d => d.cls))
    const contentOnly = diffTrees(new Map([['/x', f]]), new Map([['/x', { ...f, hash: 'i' }]]))
    for (const c of contentOnly) produced.add(c.cls)
    expect([...produced].sort()).toEqual([...DIFF_CLASSES].sort())
  })
})

describe('file capabilities, through the real getcap', () => {
  test('a tree with no capabilities reads as zero, and the count says so out loud', () => {
    withWork('cmp-caps-zero', dir => {
      const a = fixtureRoot(dir, 'a')
      const r = readTree(a)
      expect(readFileCaps(a).size).toBe(0)
      expect(r.capCount).toBe(0)
      expect(r.tree.size).toBeGreaterThan(0)
    })
  })

  test('a capability on a path the walk never saw is refused, not dropped', () => {
    // The two readers have to agree about what is in the tree, because the walk
    // is what every other dimension is computed from. A capability quietly
    // dropped here is a capability difference that can never be reported.
    withWork('cmp-caps-unseen', dir => {
      const a = fixtureRoot(dir, 'a')
      expect(() => readTree(a, { caps: new Map([['/usr/bin/ghost', 'cap_net_raw=ep']]) }))
        .toThrow(/but the walk found 0 of them. Unmatched: \/usr\/bin\/ghost/)
    })
  })

  test('a capability set with setcap is seen by getcap and reported as a difference', () => {
    withWork('cmp-caps', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      const target = join(b, 'usr', 'bin', 'micad')
      const set = Bun.spawnSync(['setcap', 'cap_net_bind_service=ep', target], { stdout: 'pipe', stderr: 'pipe' })
      if (set.exitCode !== 0) {
        // Setting one needs CAP_SETFCAP and a filesystem that stores it;
        // READING one needs neither, and the reader is what this comparator
        // depends on. So the assertion falls back to the reader's other real
        // direction rather than to a fabricated getcap output: on a host that
        // cannot set a capability, no file has one, and that is what it must
        // report.
        expect(readFileCaps(b).size).toBe(0)
        expect(new TextDecoder().decode(set.stderr)).not.toBe('')
        return
      }
      expect(readFileCaps(b).get('/usr/bin/micad')).toBe('cap_net_bind_service=ep')
      const r = compareRoots({ a, b, ledgerPath: ledger(dir, ''), minPaths: 1 })
      expect(r.counts.capsA).toBe(0)
      expect(r.counts.capsB).toBe(1)
      expect(r.unsanctioned.map(d => `${d.path} ${d.cls}`)).toEqual(['/usr/bin/micad caps'])
      expect(r.exitCode).toBe(1)
    })
  })
})

describe("the ledger's two hard rules", () => {
  test('an unsanctioned difference fails; a sanction covering it turns the run green', () => {
    withWork('cmp-rule1', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      writeFileSync(join(b, 'usr', 'share-doc'), 'copyright\n')
      const bare = compareRoots({ a, b, ledgerPath: ledger(dir, '', 'empty.md'), minPaths: 1 })
      expect(bare.exitCode).toBe(1)
      expect(bare.unsanctioned.map(d => `${d.path} ${d.cls}`)).toEqual(['/usr/share-doc added'])

      const covered = compareRoots({
        a,
        b,
        ledgerPath: ledger(dir, '### /usr/share-doc\n- classes: added\n- reason: proof material\n', 'covered.md'),
        minPaths: 1,
      })
      expect(covered.exitCode).toBe(0)
      expect(covered.counts.sanctioned).toBe(1)
      expect(covered.counts.unsanctioned).toBe(0)
    })
  })

  test('a sanction that matched NOTHING fails the run, named with its line', () => {
    withWork('cmp-rule2', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      writeFileSync(join(b, 'usr', 'share-doc'), 'copyright\n')
      const path = ledger(
        dir,
        '### /usr/share-doc\n- classes: added\n- reason: real\n\n'
        + '### /var/lib/never\n- classes: content\n- reason: stale\n',
      )
      const r = compareRoots({ a, b, ledgerPath: path, minPaths: 1 })
      expect(r.exitCode).toBe(1)
      expect(r.unsanctioned.length).toBe(0)
      expect(r.unused.map(s => s.pattern)).toEqual(['/var/lib/never'])
      expect(formatReport(r)).toContain(`UNUSED SANCTION ${path}:9 '/var/lib/never'`)
    })
  })

  test('the class must match too: sanctioning the mode does not sanction the bytes', () => {
    withWork('cmp-class-match', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      writeFileSync(join(a, 'etc', 'hosts'), 'a\n')
      writeFileSync(join(b, 'etc', 'hosts'), 'b\n')
      const r = compareRoots({
        a,
        b,
        ledgerPath: ledger(dir, '### /etc/hosts\n- classes: mode\n- reason: only the mode\n'),
        minPaths: 1,
      })
      expect(r.unsanctioned.map(d => d.cls)).toEqual(['content'])
      expect(r.unused.map(s => s.pattern)).toEqual(['/etc/hosts'])
    })
  })

  test('a pending stanza sanctions nothing, and fails the run once it starts matching', () => {
    withWork('cmp-pending', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      const body = '### /usr/share/doc/**\n- classes: added\n- status: pending\n- reason: not yet\n'
      // Nothing matches it: the shipped state, and it must pass.
      const quiet = compareRoots({ a, b, ledgerPath: ledger(dir, body, 'quiet.md'), minPaths: 1 })
      expect(quiet.exitCode).toBe(0)
      expect(quiet.unused.length).toBe(0)
      expect(quiet.livePending.length).toBe(0)

      // The difference arrives. It is BOTH unsanctioned and a promotion the
      // author now owes -- a pending stanza is written down, not in force.
      mkdirSync(join(b, 'usr', 'share', 'doc', 'mica-system'), { recursive: true })
      writeFileSync(join(b, 'usr', 'share', 'doc', 'mica-system', 'copyright'), 'Apache-2.0\n')
      const live = compareRoots({ a, b, ledgerPath: ledger(dir, body, 'live.md'), minPaths: 1 })
      expect(live.exitCode).toBe(1)
      expect(live.livePending.map(s => s.pattern)).toEqual(['/usr/share/doc/**'])
      expect(live.unsanctioned.map(d => d.path)).toContain('/usr/share/doc/mica-system/copyright')
      expect(formatReport(live)).toContain('PENDING SANCTION NOW LIVE')
    })
  })
})

describe('the counters, and the report they are printed in', () => {
  test('every counter appears, on a passing run as well as a failing one', () => {
    withWork('cmp-counts', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      writeFileSync(join(b, 'etc', 'motd'), 'x\n')
      const r = compareRoots({
        a,
        b,
        ledgerPath: ledger(dir, '### /etc/motd\n- classes: added\n- reason: proof\n'),
        minPaths: 1,
      })
      const text = formatReport(r)
      expect(r.exitCode).toBe(0)
      for (const line of [
        'paths on A:        6',
        'paths on B:        7',
        'paths in union:    7',
        'capability-bearing files: A=0 B=0',
        'differences found: 1',
        '  sanctioned:      1',
        '  unsanctioned:    0',
        'RESULT: PASS',
      ]) expect(text).toContain(line)
    })
  })
})

describe('the CLI, and the exit-code contract the gate driver reads', () => {
  test('0 for a green comparison, 1 for a ledger that does not account for it, 2 for a refusal', () => {
    withWork('cmp-cli', dir => {
      const a = fixtureRoot(dir, 'a')
      const b = fixtureRoot(dir, 'b')
      // 500 paths a side, because the CLI runs with the shipped floor and no
      // way to lower it -- which is the point of the floor.
      for (const root of [a, b]) {
        for (let i = 0; i < MIN_PATHS; i += 1) writeFileSync(join(root, 'etc', `f${i}`), 'x\n')
      }
      writeFileSync(join(b, 'etc', 'motd'), 'x\n')

      const red = cli(['--sanctions', ledger(dir, '', 'none.md'), a, b])
      expect(red.code).toBe(1)
      expect(red.out).toContain('UNSANCTIONED /etc/motd added')
      expect(red.out).toContain('RESULT: FAIL')

      const green = cli([
        '--sanctions',
        ledger(dir, '### /etc/motd\n- classes: added\n- reason: proof material\n', 'ok.md'),
        a,
        b,
      ])
      expect(green.code).toBe(0)
      expect(green.out).toContain('RESULT: PASS')
      expect(green.out).toContain('paths in union:    507')

      // A run that examined ZERO paths exits non-zero whatever the diff says.
      const empty = join(dir, 'empty')
      mkdirSync(empty)
      const refused = cli(['--sanctions', ledger(dir, '', 'none2.md'), empty, b])
      expect(refused.code).toBe(2)
      expect(refused.out).toContain('is EMPTY')
      expect(refused.out).not.toContain('RESULT: PASS')

      // And a tree that is merely too small refuses with the same status.
      const small = fixtureRoot(dir, 'small')
      expect(cli(['--sanctions', ledger(dir, '', 'none3.md'), small, b]).code).toBe(2)
      expect(cli([a, b, 'and-a-third']).code).toBe(2)
      expect(cli(['--sanctions', join(dir, 'absent.md'), a, b]).code).toBe(2)
    })
  })

  test('an unknown argument is refused rather than ignored', () => {
    const r = cli(['--board', 'x64'])
    expect(r.code).toBe(2)
    expect(r.out).toContain('unknown argument "--board"')
  })

  test('the usage text carries the seam: both directory arguments and all three exit codes', () => {
    // The composer L3 writes the gate driver against this text. A contract that
    // is only in a commit message is a contract the next reader reinvents.
    const r = cli(['--help'])
    expect(r.code).toBe(0)
    for (const needle of ['DIR_A', 'DIR_B', '--sanctions FILE', '--extract-oci', 'exit codes']) {
      expect(r.out).toContain(needle)
    }
  })
})

describe('the OCI extraction that turns a factory-root.oci into a comparable directory', () => {
  /** A one-layer OCI layout around a real tar of `root`, in the shape buildkit exports. */
  function makeArchive(dir: string, root: string): string {
    const layout = join(dir, 'layout')
    mkdirSync(join(layout, 'blobs', 'sha256'), { recursive: true })
    const layerTar = join(dir, 'layer.tar')
    const t = Bun.spawnSync(['tar', '-cf', layerTar, '-C', root, '.'], { stdout: 'pipe', stderr: 'pipe' })
    expect(t.exitCode).toBe(0)
    const put = (bytes: Uint8Array): string => {
      const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
      writeFileSync(join(layout, 'blobs', 'sha256', digest), bytes)
      return `sha256:${digest}`
    }
    const layer = put(readFileSync(layerTar))
    const manifest = put(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 2,
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: layer }],
    })))
    writeFileSync(join(layout, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}')
    writeFileSync(join(layout, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ digest: manifest }] }))
    const archive = join(dir, 'factory-root.oci')
    const a = Bun.spawnSync(['tar', '-cf', archive, '-C', layout, '.'], { stdout: 'pipe', stderr: 'pipe' })
    expect(a.exitCode).toBe(0)
    return archive
  }

  test('a layer round-trips back into the tree it was made from', () => {
    withWork('cmp-oci', dir => {
      const root = fixtureRoot(dir, 'root')
      const archive = makeArchive(dir, root)
      const dest = join(dir, 'extracted')
      const r = extractOciRoot(archive, dest)
      expect(r.layers).toBe(1)
      expect(r.paths).toBe(6)
      expect(diffTrees(readTree(root).tree, readTree(dest).tree)).toEqual([])
    })
  })

  test('an unapplied whiteout marker is refused rather than compared', () => {
    // tar writes a .wh. entry as a FILE instead of deleting what it names, so a
    // tree carrying one holds a path the image deletes and a file the image
    // does not have -- differences in both directions, invented by the reader.
    withWork('cmp-oci-wh', dir => {
      const root = fixtureRoot(dir, 'root')
      writeFileSync(join(root, 'etc', '.wh.resolv.conf'), '')
      expect(() => extractOciRoot(makeArchive(dir, root), join(dir, 'extracted')))
        .toThrow(/is an unapplied OCI whiteout marker/)
    })
  })

  test('an archive that is not an OCI layout, and a destination that already holds a tree', () => {
    withWork('cmp-oci-refuse', dir => {
      const root = fixtureRoot(dir, 'root')
      const notLayout = join(dir, 'plain.tar')
      Bun.spawnSync(['tar', '-cf', notLayout, '-C', root, '.'])
      expect(() => extractOciRoot(notLayout, join(dir, 'x'))).toThrow(/has no index\.json/)
      expect(() => extractOciRoot(join(dir, 'absent.oci'), join(dir, 'y'))).toThrow(/does not exist/)

      const archive = makeArchive(dir, root)
      const dest = join(dir, 'extracted')
      extractOciRoot(archive, dest)
      expect(() => extractOciRoot(archive, dest)).toThrow(/already exists and is not empty/)
    })
  })
})

// A sanction is otherwise a (pattern, class) pair, which is too coarse for a
// content difference that is benign for a reason the pattern cannot express.
// The measured case: /etc/passwd differs between the two x64 roots only because
// two service accounts are created in the opposite order -- an artefact of
// having two assembly paths -- while a bare `content` stanza over that path
// would equally cover an account VANISHING from the composed root, which is the
// failure the whole comparison exists to catch.
//
// Every case below is driven from the FAILING side, because the value of this
// mechanism is entirely in what it still refuses.
describe('expect-diff: a content sanction narrowed to one exact difference', () => {
  // Two accounts, transposed -- the shape of the real difference, small enough
  // to read. Line 1 is common so the fixture is not two files that share
  // nothing.
  const A_PASSWD = 'root:x:0:0::/root:/bin/sh\nmica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin\nmica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin\n'
  const B_PASSWD = 'root:x:0:0::/root:/bin/sh\nmica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin\nmica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin\n'
  const TRANSPOSED = [
    '2 -mica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin',
    '2 +mica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin',
    '3 -mica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin',
    '3 +mica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin',
  ]

  function stanza(rows: readonly string[]): string {
    return `### /etc/passwd\n- classes: content\n- status: active\n- expect-diff: |\n`
      + rows.map(r => `    ${r}`).join('\n')
      + `\n- reason: two service accounts created in the opposite order by two assembly paths.\n`
  }

  /** Two roots whose /etc/passwd is the caller's, and identical everywhere else. */
  function roots(dir: string, aText: string, bText: string): { a: string, b: string } {
    const a = fixtureRoot(dir, 'a')
    const b = fixtureRoot(dir, 'b')
    writeFileSync(join(a, 'etc', 'passwd'), aText)
    writeFileSync(join(b, 'etc', 'passwd'), bText)
    return { a, b }
  }

  test('canonicalDiff is positional, and says nothing about files that agree', () => {
    expect(canonicalDiff('x\ny\n', 'x\ny\n')).toBe('')
    expect(canonicalDiff(A_PASSWD, B_PASSWD).split('\n')).toEqual(TRANSPOSED)
    // A line removed shifts every line after it, which is exactly why a
    // vanished account cannot masquerade as a transposition. The last pair is
    // the trailing-newline element -- `split` yields one for a file that ends
    // in a newline, and A has one line more than B, so the shift runs off the
    // end and `(no line)` is what an absent side renders as.
    expect(canonicalDiff('a\nb\nc\n', 'a\nc\n').split('\n')).toEqual([
      '2 -b', '2 +c', '3 -c', '3 +', '4 -', '4 +(no line)',
    ])
  })

  test('GREEN: the difference is covered when the diff is the one named', () => {
    withWork('cmp-xd-green', dir => {
      const { a, b } = roots(dir, A_PASSWD, B_PASSWD)
      const r = compareRoots({ a, b, ledgerPath: ledger(dir, stanza(TRANSPOSED)), minPaths: 1 })
      expect(r.counts.differences).toBe(1)
      expect(r.counts.unsanctioned).toBe(0)
      expect(r.diffMismatches).toEqual([])
      expect(r.unused).toEqual([])
      expect(r.exitCode).toBe(0)
    })
  })

  test('RED: an account VANISHING from B is not covered by the transposition stanza', () => {
    withWork('cmp-xd-vanish', dir => {
      // The case L1 named. B loses mica-mqtt-broker entirely.
      const vanished = 'root:x:0:0::/root:/bin/sh\nmica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin\n'
      const { a, b } = roots(dir, A_PASSWD, vanished)
      const r = compareRoots({ a, b, ledgerPath: ledger(dir, stanza(TRANSPOSED)), minPaths: 1 })
      expect(r.counts.unsanctioned).toBe(1)
      expect(r.unsanctioned[0]?.path).toBe('/etc/passwd')
      expect(r.diffMismatches.length).toBe(1)
      expect(r.exitCode).toBe(1)
      // And the stanza is reported as UNUSED as well, because a narrowed
      // sanction whose difference is no longer there is a stale one.
      expect(r.unused.map(u => u.pattern)).toEqual(['/etc/passwd'])
      expect(formatReport(r)).toContain('EXPECTED DIFF MISMATCH')
    })
  })

  test('RED: a THIRD line moving is not covered either', () => {
    withWork('cmp-xd-third', dir => {
      const a = 'root:x:0:0::/root:/bin/sh\nmica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin\nmica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin\nsshd:x:105:65534::/run/sshd:/usr/sbin/nologin\n'
      const b = 'sshd:x:105:65534::/run/sshd:/usr/sbin/nologin\nroot:x:0:0::/root:/bin/sh\nmica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin\nmica-mqttd:x:970:970::/nonexistent:/usr/sbin/nologin\n'
      const r0 = roots(dir, a, b)
      const r = compareRoots({ a: r0.a, b: r0.b, ledgerPath: ledger(dir, stanza(TRANSPOSED)), minPaths: 1 })
      expect(r.counts.unsanctioned).toBe(1)
      expect(r.diffMismatches.length).toBe(1)
      expect(r.exitCode).toBe(1)
    })
  })

  test('RED: a field changing INSIDE a transposed line is not covered', () => {
    withWork('cmp-xd-field', dir => {
      // The same transposition, except mica-mqttd's uid moved 970 -> 971.
      const b = 'root:x:0:0::/root:/bin/sh\nmica-mqtt-broker:x:969:969::/nonexistent:/usr/sbin/nologin\nmica-mqttd:x:971:970::/nonexistent:/usr/sbin/nologin\n'
      const { a, b: bRoot } = roots(dir, A_PASSWD, b)
      const r = compareRoots({ a, b: bRoot, ledgerPath: ledger(dir, stanza(TRANSPOSED)), minPaths: 1 })
      expect(r.counts.unsanctioned).toBe(1)
      expect(r.diffMismatches.length).toBe(1)
      expect(r.exitCode).toBe(1)
    })
  })

  test('the parser refuses expect-diff on anything but a lone content class', () => {
    withWork('cmp-xd-class', dir => {
      const body = `### /etc/passwd\n- classes: content, mode\n- status: active\n- expect-diff: |\n    1 -x\n    1 +y\n- reason: r\n`
      expect(() => parseLedger(readFileSync(ledger(dir, body), 'utf8'), 'L'))
        .toThrow(/belongs to a stanza whose only class is 'content'/)
    })
  })

  test('the parser refuses a one-line expect-diff and an empty block', () => {
    withWork('cmp-xd-form', dir => {
      const inline = `### /etc/passwd\n- classes: content\n- expect-diff: 1 -x\n- reason: r\n`
      expect(() => parseLedger(readFileSync(ledger(dir, inline), 'utf8'), 'L'))
        .toThrow(/It takes a block and only a block/)
      const empty = `### /etc/passwd\n- classes: content\n- expect-diff: |\n- reason: r\n`
      expect(() => parseLedger(readFileSync(ledger(dir, empty), 'utf8'), 'L'))
        .toThrow(/its block is empty/)
    })
  })

  test('the parser refuses a mis-indented continuation rather than truncating the diff', () => {
    withWork('cmp-xd-indent', dir => {
      // Two rows, the second indented by two spaces instead of four. Tolerated,
      // this stanza would silently expect HALF the diff it was written with.
      const body = `### /etc/passwd\n- classes: content\n- expect-diff: |\n    1 -x\n  1 +y\n- reason: r\n`
      expect(() => parseLedger(readFileSync(ledger(dir, body), 'utf8'), 'L'))
        .toThrow(/would silently truncate the expected diff/)
    })
  })
})

describe('the shipped ledger is self-consistent under its own rules', () => {
  test('it parses, every stanza carries a reason, and there is at least one', () => {
    expect(existsSync(DEFAULT_LEDGER)).toBe(true)
    const stanzas = parseLedger(readFileSync(DEFAULT_LEDGER, 'utf8'), DEFAULT_LEDGER)
    // Counted, and a zero refused: a ledger this read as empty would satisfy
    // every assertion below by having nothing to assert them against.
    expect(stanzas.length).toBeGreaterThan(0)
    for (const s of stanzas) {
      expect(s.reason.length).toBeGreaterThan(20)
      expect(s.classes.length).toBeGreaterThan(0)
    }
  })

  // THIS TEST REPLACED ONE WHOSE PREMISE EXPIRED, and the premise is worth
  // recording because it was correct when it was written: "every shipped stanza
  // is pending, so the unused-sanction rule cannot fail it" -- true while the
  // composed path did not exist, because an `active` stanza could match nothing
  // and rule 2 would fail every run. The composer landed, the two
  // `/usr/share/doc` stanzas were promoted with a measurement behind them, and
  // a run against two real roots reported 0 unused sanctions. So that guard has
  // done its job and cannot be restated; what a unit test can still hold is
  // rule 3, which arrived with the same measurement.
  test('no shipped stanza sanctions the class `removed`', () => {
    // Rule 3. A removed path is one the CHAIN ships and no package owns, so a
    // stanza there records the composed image missing a file the device needs
    // and calls it accounted for. The first instance found was a cx3576
    // serial-console drop-in reaching the image through a wholesale overlay
    // copy that no package reproduces -- the file that makes serial login work.
    // The retired dual-build gate refused on the same condition; this is the
    // half that does not need two roots to run, and the half that outlived it.
    const stanzas = parseLedger(readFileSync(DEFAULT_LEDGER, 'utf8'), DEFAULT_LEDGER)
    expect(stanzas.length).toBeGreaterThan(0)
    expect(stanzas.filter(s => s.classes.includes('removed')).map(s => s.pattern)).toEqual([])
  })

  test('and no shipped stanza covers a proof-material path', () => {
    // The intent of the test this replaces, with an instrument that can carry
    // it. That one asserted the Sanctions section does not contain the
    // substring "mqtt", which was a proxy for "the proof-material stanzas are
    // not shipped" -- and a proxy that fails on a legitimate stanza about
    // /usr/bin/mica-mqttd, which is a BINARY and not one of the eight account
    // files the proof material covered.
    //
    // The claim itself is unchanged and is what matters: no shipped stanza may
    // cover a path from the proof material, because those describe two builds
    // of the SAME path -- an mqtt-declined root against a full one -- which is
    // not the difference this gate judges. Shipping one would pre-sanction a
    // payload's disappearance from the composed root. The three L1 named as
    // never-sanctionable are in the list for the same reason.
    //
    // Matched with sanctionMatches, the comparator's own matcher, over every
    // class: a pattern test written here would be a second implementation of
    // the globbing and could disagree with the one that judges real runs.
    const stanzas = parseLedger(readFileSync(DEFAULT_LEDGER, 'utf8'), DEFAULT_LEDGER)
    expect(stanzas.length).toBeGreaterThan(0)
    const proofMaterial = [
      '/etc/passwd', '/etc/passwd-',
      '/etc/group', '/etc/group-',
      '/etc/gshadow', '/etc/gshadow-',
      '/etc/shadow-', '/usr/share/factory/etc/shadow',
      // No /boot/initrd.img-* here since PLAN-074. It was proof material
      // because it was the measured non-reproducible surface of the stage
      // chain -- 182 of 183 cpio entries differing in inode number and 70 in
      // mtime, content identical. There is no initrd in an x64 root any more,
      // and a forbidden-to-sanction path that cannot exist forbids nothing.
      // aux-cache below is the surviving one, so this list is not empty.
      '/usr/share/factory/var/cache/ldconfig/aux-cache',
    ]
    // NARROWED, not relaxed, and the narrowing is L1's ruling. A stanza may
    // cover a proof-material path when it carries an EXPECTED DIFF, because
    // that stanza cannot hide the thing the rule was written about: the diff it
    // names is the only one it covers, so a vanished account or a returning
    // build date produces different rows and still fails. A stanza WITHOUT one
    // covers every content difference at the path and is still forbidden.
    const covered: string[] = []
    for (const path of proofMaterial) {
      for (const cls of DIFF_CLASSES) {
        const d: Difference = { path, cls, a: 'x', b: 'y' }
        for (const st of stanzas) {
          if (!sanctionMatches(st, d)) continue
          if (st.expectDiff !== undefined) continue
          covered.push(`${st.pattern} (${cls}) covers ${path} with no expected diff`)
        }
      }
    }
    expect(covered).toEqual([])
    // And the other direction, so this cannot pass by the shipped ledger simply
    // having no stanza over these paths at all: the eight account files ARE
    // covered today, every one of them by a narrowed stanza.
    const narrowed = stanzas.filter(st => st.expectDiff !== undefined).map(st => st.pattern)
    expect(narrowed.length).toBeGreaterThan(0)
    for (const pattern of narrowed) {
      expect(stanzas.find(st => st.pattern === pattern)?.classes).toEqual(['content'])
    }
    // Counted, so that a run in which the loop above examined nothing cannot
    // reach the same green as one in which it examined everything.
    expect(proofMaterial.length * DIFF_CLASSES.length).toBe(81)
  })
})
