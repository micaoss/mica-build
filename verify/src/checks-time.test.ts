// The time contract, driven from the failing side.
//
// Same discipline as checks-root.test.ts: the fixture is seeded green, every
// case asserts that green FIRST and then makes ONE edit, because a check that
// cannot fail reports the same agreement as one that passes. The mutations are
// the shapes the real failures take -- a manifest that lost the package while
// the drop-in still ships, a value someone "tuned" in a file that is policy and
// not settings, an enablement link that landed in the vendor tree, a timezone
// baked into the root.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadBoard } from './board.ts'
import { packedRootFixture, type RootFixture } from './checks-fixture.ts'
import { TIME_CHECKS } from './checks-time.ts'
import type { CheckCase } from './checks.ts'
import { boardEnvPath } from './paths.ts'
import type { CheckResult, Verdict } from './parity.ts'

const cx3576 = loadBoard(boardEnvPath('cx3576'))

const DROPIN = 'etc/systemd/timesyncd.conf.d/50-mica.conf'
const WANTS = 'etc/systemd/system/sysinit.target.wants/systemd-timesyncd.service'
const MANIFEST = 'usr/share/mica/manifest.tsv'

function checkNamed(id: string): CheckCase {
  const found = TIME_CHECKS.find(c => c.id === id)
  if (found === undefined) {
    throw new Error(`no time check is registered as '${id}'. Registered: `
      + TIME_CHECKS.map(c => c.id).join(', '))
  }
  return found
}

async function verdictOf(fx: RootFixture, id: string): Promise<Verdict> {
  const got = await checkNamed(id).run(fx.ctx)
  expect(got.length).toBe(1)
  return (got[0] as CheckResult).verdict
}

async function messageOf(fx: RootFixture, id: string): Promise<string> {
  const got = await checkNamed(id).run(fx.ctx)
  return (got[0] as CheckResult).message
}

/** Seed, assert the check GREEN, mutate, hand back -- checks-root.test.ts's shape. */
async function mutated(id: string, mutate: (root: string) => void): Promise<RootFixture> {
  const fx = packedRootFixture(cx3576)
  expect(await verdictOf(fx, id)).toBe('pass')
  mutate(fx.root)
  return fx
}

describe('the healthy fixture', () => {
  test('every time check PASSES on the unmutated fixture, exactly once each', async () => {
    const fx = packedRootFixture(cx3576)
    try {
      for (const c of TIME_CHECKS) {
        const got = await c.run(fx.ctx)
        expect({ id: c.id, n: got.length }).toEqual({ id: c.id, n: 1 })
        expect({ id: c.id, verdict: (got[0] as CheckResult).verdict })
          .toEqual({ id: c.id, verdict: 'pass' })
      }
      expect(TIME_CHECKS.length).toBe(4)
    }
    finally {
      fx.dispose()
    }
  })
})

describe('packed-timesyncd-installed -- the manifest row is the record', () => {
  test('the row is GONE while the drop-in and the symlink still ship', async () => {
    const fx = await mutated('packed-timesyncd-installed', (root) => {
      const kept = readFileSync(join(root, MANIFEST), 'latin1')
        .split('\n')
        .filter(l => !l.startsWith('systemd-timesyncd\t'))
        .join('\n')
      writeFileSync(join(root, MANIFEST), kept)
    })
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-installed')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-installed')).toContain('none of them is it')
      // ONE check went red: the drop-in and the enablement link are untouched,
      // which is the exact half-shipped state this check exists to name.
      expect(await verdictOf(fx, 'packed-timesyncd-policy')).toBe('pass')
      expect(await verdictOf(fx, 'packed-timesyncd-enabled')).toBe('pass')
    }
    finally {
      fx.dispose()
    }
  })

  test('the manifest itself is GONE', async () => {
    const fx = await mutated('packed-timesyncd-installed', root =>
      rmSync(join(root, MANIFEST)))
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-installed')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-installed')).toContain('is not a regular file')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('packed-timesyncd-enabled -- a wants link under /etc', () => {
  test('the symlink is GONE', async () => {
    const fx = await mutated('packed-timesyncd-enabled', root => rmSync(join(root, WANTS)))
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-enabled')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-enabled'))
        .toContain('enablement symlink missing')
    }
    finally {
      fx.dispose()
    }
  })

  test('the symlink moved to the VENDOR tree -- enablement here is /etc payload', async () => {
    const fx = await mutated('packed-timesyncd-enabled', (root) => {
      rmSync(join(root, WANTS))
      const dir = join(root, 'usr/lib/systemd/system/sysinit.target.wants')
      mkdirSync(dir, { recursive: true })
      symlinkSync('/lib/systemd/system/systemd-timesyncd.service',
        join(dir, 'systemd-timesyncd.service'))
    })
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-enabled')).toBe('fail')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('packed-timesyncd-policy -- exactly the four pinned values', () => {
  test('the drop-in is GONE', async () => {
    const fx = await mutated('packed-timesyncd-policy', root => rmSync(join(root, DROPIN)))
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-policy')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-policy')).toContain('is not a regular file')
    }
    finally {
      fx.dispose()
    }
  })

  test('one value was "tuned" -- the likeliest real edit', async () => {
    const fx = await mutated('packed-timesyncd-policy', (root) => {
      const text = readFileSync(join(root, DROPIN), 'utf8')
        .replace('PollIntervalMaxSec=2048', 'PollIntervalMaxSec=1024')
      writeFileSync(join(root, DROPIN), text)
    })
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-policy')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-policy'))
        .toContain('PollIntervalMaxSec=1024, pinned 2048')
    }
    finally {
      fx.dispose()
    }
  })

  test('a key sits ABOVE [Time] -- timesyncd would silently ignore it', async () => {
    const fx = await mutated('packed-timesyncd-policy', (root) => {
      const text = readFileSync(join(root, DROPIN), 'utf8')
        .replace('[Time]\nPollIntervalMinSec=32\n', 'PollIntervalMinSec=32\n[Time]\n')
      writeFileSync(join(root, DROPIN), text)
    })
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-policy')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-policy'))
        .toContain('PollIntervalMinSec is not assigned in [Time]')
    }
    finally {
      fx.dispose()
    }
  })

  test('a FIFTH assignment arrived -- policy grown without a decision', async () => {
    const fx = await mutated('packed-timesyncd-policy', root =>
      writeFileSync(join(root, DROPIN),
        `${readFileSync(join(root, DROPIN), 'utf8')}NTP=pool.example.org\n`))
    try {
      expect(await verdictOf(fx, 'packed-timesyncd-policy')).toBe('fail')
      expect(await messageOf(fx, 'packed-timesyncd-policy'))
        .toContain('NTP=pool.example.org in [Time] is not part of the pinned policy')
    }
    finally {
      fx.dispose()
    }
  })
})

describe('packed-localtime-utc -- machine time stays UTC', () => {
  test('a timezone was baked in', async () => {
    const fx = await mutated('packed-localtime-utc', (root) => {
      rmSync(join(root, 'etc/localtime'))
      symlinkSync('/usr/share/zoneinfo/Asia/Shanghai', join(root, 'etc/localtime'))
    })
    try {
      expect(await verdictOf(fx, 'packed-localtime-utc')).toBe('fail')
      expect(await messageOf(fx, 'packed-localtime-utc'))
        .toContain('/usr/share/zoneinfo/Asia/Shanghai, which is not UTC')
    }
    finally {
      fx.dispose()
    }
  })

  test('a COPIED zone file instead of a link -- unreportable, so refused', async () => {
    const fx = await mutated('packed-localtime-utc', (root) => {
      rmSync(join(root, 'etc/localtime'))
      writeFileSync(join(root, 'etc/localtime'), 'TZif2...\n')
    })
    try {
      expect(await verdictOf(fx, 'packed-localtime-utc')).toBe('fail')
      expect(await messageOf(fx, 'packed-localtime-utc')).toContain('not a symlink')
    }
    finally {
      fx.dispose()
    }
  })

  test('ABSENCE is the other correct spelling', async () => {
    const fx = await mutated('packed-localtime-utc', root => rmSync(join(root, 'etc/localtime')))
    try {
      expect(await verdictOf(fx, 'packed-localtime-utc')).toBe('pass')
      expect(await messageOf(fx, 'packed-localtime-utc')).toContain('is absent')
    }
    finally {
      fx.dispose()
    }
  })
})
