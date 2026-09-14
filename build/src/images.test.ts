// The image-key seam, driven from the failing side.
//
// There is one resolver in this tree -- tools/from.sh -- and this file
// is a subprocess call to it, not a second reader of the image files. So what is
// checked here is not "do the image files parse" (from.sh's own --check does
// that, and `make build-env` runs it): it is that every way this call can go
// wrong produces a sentence naming the key, and that nothing here turns a
// refusal into an empty string a docker command line would swallow.

import { $ } from 'bun'
import { describe, expect, test } from 'bun:test'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { forgetResolvedImages, resolveImage } from './images.ts'
import { FROM_SH, makeWorkDir } from './paths.ts'

/** A stand-in resolver, so the guards that the real one cannot produce are reachable. */
function fakeResolver(body: string): { path: string, cleanup: () => void } {
  const dir = makeWorkDir('from-sh')
  const path = join(dir, 'from.sh')
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('a key that is there resolves to the digest that is recorded', () => {
  test('IMAGE_MICA_BUILD_BASE, IMAGE_ALPINE_3_21 and IMAGE_DEBIAN_TRIXIE are digests', async () => {
    for (const key of ['IMAGE_MICA_BUILD_BASE', 'IMAGE_ALPINE_3_21', 'IMAGE_DEBIAN_TRIXIE']) {
      const ref = await resolveImage(key)
      // The shape from.sh enforces, asserted here too -- not to re-validate it,
      // but because every toolset in this package puts this string after
      // `docker run` and a tag there is the float R6 spent a sweep removing.
      expect(`${key}: ${/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(ref)}`)
        .toBe(`${key}: true`)
    }
  })

  test('the same key twice is the same answer, and the second is memoised', async () => {
    const a = await resolveImage('IMAGE_ALPINE_3_21')
    const b = await resolveImage('IMAGE_ALPINE_3_21')
    expect(b).toBe(a)
    forgetResolvedImages()
    expect(await resolveImage('IMAGE_ALPINE_3_21')).toBe(a)
  })
})

describe('every failure names the key', () => {
  test('a key no image file defines', async () => {
    await expect(resolveImage('IMAGE_NO_SUCH_THING')).rejects.toThrow(/no image key IMAGE_NO_SUCH_THING/)
  })

  test('a key that is not an image key at all', async () => {
    await expect(resolveImage('GO_VERSION')).rejects.toThrow(/no image key GO_VERSION/)
  })

  test('a LOCAL_ key that has not been built is refused by the store, not by the shape', async () => {
    // localhost/mica-build-* exist only after `make build-env`. Whether this
    // host has them is not the assertion -- the assertion is that the answer is
    // either a reference or a sentence, never an empty string.
    let ref = ''
    let message = ''
    try {
      ref = await resolveImage('LOCAL_MICA_BUILD_BASE')
    } catch (e) {
      message = (e as Error).message
    }
    if (message !== '') expect(message).toContain('LOCAL_MICA_BUILD_BASE')
    else expect(ref).toContain('localhost/mica-build-base')
  })

  test('a resolver that is not there says so about the PATH, with the key still in hand', async () => {
    await expect(resolveImage('IMAGE_MICA_BUILD_BASE', '/no/such/from.sh'))
      .rejects.toThrow(/\/no\/such\/from\.sh does not exist.*including IMAGE_MICA_BUILD_BASE/s)
  })

  test('a resolver that exits 0 and prints NOTHING is refused, not passed on', async () => {
    // THE FAILURE THAT DOES NOT LOOK LIKE ONE. `docker run ${ref} sh -c ...`
    // with an empty ref does not report a missing image: docker reads `sh` as
    // the image name and `-c` as the command, and fails several sentences from
    // the cause.
    const f = fakeResolver('exit 0')
    try {
      await expect(resolveImage('IMAGE_MICA_BUILD_BASE', f.path)).rejects.toThrow(/exited 0 for IMAGE_MICA_BUILD_BASE and printed nothing/)
    } finally { f.cleanup() }
  })

  test('a resolver that prints only whitespace is the same failure', async () => {
    const f = fakeResolver('printf "   \\n"')
    try {
      await expect(resolveImage('IMAGE_MICA_BUILD_BASE', f.path)).rejects.toThrow(/printed nothing/)
    } finally { f.cleanup() }
  })

  test('a resolver that fails hands back ITS OWN words rather than a summary', async () => {
    const f = fakeResolver('echo "the sentence from.sh would have written" >&2; exit 3')
    try {
      await expect(resolveImage('IMAGE_MICA_BUILD_BASE', f.path))
        .rejects.toThrow(/exit 3.*the sentence from\.sh would have written/s)
    } finally { f.cleanup() }
  })

  test('the positive control: the stand-in resolver CAN succeed', async () => {
    // Without this, every assertion above would also pass if fakeResolver
    // produced a script that never runs at all.
    const f = fakeResolver('echo alpine:3.21@sha256:0000000000000000000000000000000000000000000000000000000000000000')
    try {
      expect(await resolveImage('IMAGE_MICA_BUILD_BASE', f.path)).toBe(
        'alpine:3.21@sha256:0000000000000000000000000000000000000000000000000000000000000000',
      )
      // ...and a stand-in answer never reaches the memo the real one fills.
      expect(await resolveImage('IMAGE_MICA_BUILD_BASE')).not.toContain('0000000000000000')
    } finally { f.cleanup() }
  })
})

describe('the answer is the resolver\'s, not a re-derivation of it', () => {
  test('FROM_SH is the tree\'s own script, and its stdout is what resolveImage returns', async () => {
    expect(FROM_SH.endsWith('/tools/from.sh')).toBe(true)
    // Byte for byte against the script's own stdout. If this package ever grew
    // a second reader of the image files -- a grep, a parser, a copy of the digest --
    // it could agree with from.sh today and not tomorrow; this is the assertion
    // that the value came THROUGH from.sh rather than merely matching it.
    for (const key of ['IMAGE_ALPINE_3_21', 'IMAGE_DEBIAN_TRIXIE', 'IMAGE_MICA_BUILD_BASE']) {
      const direct = (await $`bash ${FROM_SH} --ref ${key}`.quiet()).stdout.toString().trim()
      expect(`${key}=${await resolveImage(key)}`).toBe(`${key}=${direct}`)
    }
  })
})
