// What can be asserted about the three negative tests WITHOUT docker.
//
// The cases themselves need a real image, a real container and a real mutated
// binary -- that is the whole point of them, and `make os-smoke-negative-test`
// is where they run. What lives here is everything that
// decides WHETHER THEY RUN AT ALL, because those decisions are exactly the ones
// that fail silently: an empty case list, a case naming an artifact the register
// does not have, a mutation body that is empty, a skew that is not a skew. Each
// of those produces a green run that measured nothing, and none of them needs a
// daemon to catch.
//
// The vacuity argument is `conclude`'s, one level up: `RESULT: PASS (3 of 3)` is
// invariant under a case list somebody emptied.

import { describe, expect, test } from 'bun:test'

import { ARTIFACTS } from './smoke-register.ts'
import { CASES, negativeRun, skewedFrom, versionSkewMutation, type NegativeCase } from './smoke-negative.ts'

describe('the declared case list', () => {
  test('the case list declares three negative cases, and names them', () => {
    // The clause says "three negative tests" and names the three shapes. A list
    // that drifted to two would still print `RESULT: PASS (2 of 2)`.
    expect(CASES.map(c => c.name).sort()).toEqual(['missing-soname', 'version-skew', 'wrong-arch'])
  })

  test('every case names a register entry that exists', () => {
    for (const c of CASES) {
      expect(ARTIFACTS.some(a => a.name === c.artifact), `${c.name} breaks '${c.artifact}'`).toBe(true)
    }
  })

  test('no case produces an empty mutation body', () => {
    // An empty body builds `FROM <root>` and nothing else -- the UNMUTATED root
    // -- so the case would run the real binary and report that the runner did
    // not notice a defect nobody made.
    for (const c of CASES) {
      const artifact = ARTIFACTS.find(a => a.name === c.artifact)!
      const body = c.mutation(artifact, artifact.pin())
      expect(body.length, `${c.name}`).toBeGreaterThan(0)
      expect(body, `${c.name}`).toContain(artifact.path)
    }
  })

  test('every mutation asserts its own before-and-after, so a no-op fails the image build', () => {
    // The `mutate()`-helper discipline, in the only medium a container offers.
    // Driven for real at M7c: writing 0x3e back instead of 0xb7 gives
    // `REFUSING: the write did not take` and the case reports DID NOT HOLD.
    for (const c of CASES) {
      const artifact = ARTIFACTS.find(a => a.name === c.artifact)!
      expect(c.mutation(artifact, artifact.pin()), `${c.name}`).toContain('REFUSING')
    }
  })

  test('each case names the MISDIAGNOSIS it rules out, not just that it must fail', () => {
    // Two of the three exist because the shipped map named the wrong cause. A
    // case asserting only `verdict === 'fail'` would have been green against it.
    for (const c of CASES) {
      expect(c.mustNotSay, c.name).toBeInstanceOf(RegExp)
      expect(c.mustNotSayWhy.length, c.name).toBeGreaterThan(40)
    }
  })

  test('an EMPTY case list concludes nothing and must not exit 0', async () => {
    // NO DAEMON, and that is the point of where the guard sits: `negativeRun`
    // refuses an empty list BEFORE it reads or loads an image, so this case runs
    // in the docker-free floor rather than only on a host that has just built
    // one. `exec` is never reached, and nothing here can start a container.
    const run = await negativeRun({ product: 'x64-dev', board: 'x64', cases: [], log: () => {} })
    expect(run.conclusion).toBe('FAIL')
    expect(run.exitCode).toBe(1)
    expect(run.outcomes).toEqual([])
    expect(run.line).toMatch(/EMPTY case list/)
  })

  test('...and the positive control: a non-empty list gets PAST that guard', async () => {
    // Without this, the case above passes just as well against a `negativeRun`
    // that refused EVERY list. It gets past the empty check and stops at the
    // next thing, which needs an image -- so what is asserted is that the
    // refusal it hits is a DIFFERENT one.
    const err = await negativeRun({ product: 'nosuchproduct', log: () => {} }).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/EMPTY case list/)
  })
})

describe('skewedFrom -- the version-skew case has to produce a DIFFERENT version', () => {
  test('it bumps the last component', () => {
    expect(skewedFrom('1.29.1')).toBe('1.29.2')
    expect(skewedFrom('1.13')).toBe('1.14')
    expect(skewedFrom('0.2.9')).toBe('0.2.10')
  })

  test('the result is never the input, which is the property the case rests on', () => {
    for (const v of ['1.29.1', '1.13', '0.1.0', '5.8.6', '2.1.0']) {
      expect(skewedFrom(v)).not.toBe(v)
    }
  })

  test('a version whose last component is not a number is REFUSED, not silently reused', () => {
    // `1.2.3-rc1` + 1 is not a version, and whatever a lenient implementation
    // produced would either equal the input -- a skew that is not one -- or be
    // a string the tokeniser reads as no version at all, which turns the case
    // green for the wrong reason.
    expect(() => skewedFrom('1.2.3-rc1')).toThrow(/is not a number/)
    expect(() => skewedFrom('latest')).toThrow(/cannot skew/)
  })
})

describe('versionSkewMutation -- the shim, and the pre-state it refuses to skew from', () => {
  const artifact = ARTIFACTS.find(a => a.name === 'crun')!

  test('it asserts the binary really reports the pin before replacing it', () => {
    const body = versionSkewMutation(artifact, '1.29.1', '1.29.2')
    expect(body).toContain("*'1.29.1'*")
    expect(body).toMatch(/REFUSING: .* does not contain the pinned 1\.29\.1/)
  })

  test('it asserts the shim took, and that it changed something', () => {
    const body = versionSkewMutation(artifact, '1.29.1', '1.29.2')
    expect(body).toMatch(/REFUSING: the shim did not take/)
    expect(body).toMatch(/REFUSING: the mutation changed nothing/)
  })

  test('the skewed version is what the shim prints, and it is not the pin', () => {
    const body = versionSkewMutation(artifact, '1.29.1', skewedFrom('1.29.1'))
    expect(body).toContain('echo "crun version 1.29.2"')
    expect(body).not.toContain('echo "crun version 1.29.1"')
  })
})

describe('the shipped cases, as they will actually be built', () => {
  // The positive control for "no case produces an empty mutation body": these
  // are the real bodies, with the real pin read from the real file, so a pin
  // that moved shows up here rather than inside a container.
  const shipped = (name: string): { c: NegativeCase; body: string } => {
    const c = CASES.find(x => x.name === name)!
    const a = ARTIFACTS.find(x => x.name === c.artifact)!
    return { c, body: c.mutation(a, a.pin()) }
  }

  test('wrong-arch moves exactly one byte, and says which', () => {
    const { body } = shipped('wrong-arch')
    expect(body).toContain('skip=18 count=1')
    expect(body).toContain("[ \"$before\" = '3e' ]")
    expect(body).toContain("[ \"$after\" = 'b7' ]")
  })

  test('missing-soname DERIVES the library path rather than writing it down', () => {
    // Written down, it would be x86-only and the cx3576 run -- the one nobody
    // has done yet -- would fail on the path instead of on the soname.
    const { body } = shipped('missing-soname')
    expect(body).toContain('ldd')
    expect(body).not.toContain('x86_64-linux-gnu')
    expect(body).toMatch(/does not NEED libgcc_s in this root/)
  })

  test('version-skew reads the pin from the file, so a legitimate bump refuses here', () => {
    const { body } = shipped('version-skew')
    const pin = ARTIFACTS.find(a => a.name === 'crun')!.pin()
    expect(body).toContain(`the pinned ${pin.expected}`)
    expect(body).toContain(`crun version ${skewedFrom(pin.expected)}`)
  })
})
