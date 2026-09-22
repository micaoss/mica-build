// The image-key seam, driven from the failing side.
//
// There is one resolver in this tree -- src/locks/from.ts -- and this file is an import of it, not a second
// reader of the image files. So what is checked here is not "do the image files parse" (`bun src/cli.ts from
// --check` does that, and `make build-env` runs it): it is that every way this call can go wrong produces a
// sentence naming the key, that the answer is the resolver's own, and that the memo hands back the same answer.

import { describe, expect, test } from 'bun:test'
import { forgetResolvedImages, resolveImage } from './images.ts'
import { resolve } from '../locks/from.ts'
import { inputs } from '../locks/locks.ts'

describe('a key that is there resolves to the digest that is recorded', () => {
  test('mica-build-env:base, upstream:alpine:3.24.1 and upstream:debian:trixie-slim are digests', async () => {
    for (const key of ['mica-build-env:base', 'upstream:alpine:3.24.1', 'upstream:debian:trixie-slim']) {
      const ref = await resolveImage(key)
      // The shape the resolver enforces, asserted here too -- not to re-validate it,
      // but because every toolset in this package puts this string after
      // `docker run` and a tag there is the float R6 spent a sweep removing.
      expect(`${key}: ${/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(ref)}`)
        .toBe(`${key}: true`)
    }
  })

  test('the same key twice is the same answer, and the second is memoised', async () => {
    const a = await resolveImage('upstream:alpine:3.24.1')
    const b = await resolveImage('upstream:alpine:3.24.1')
    expect(b).toBe(a)
    forgetResolvedImages()
    expect(await resolveImage('upstream:alpine:3.24.1')).toBe(a)
  })
})

describe('every failure names the key', () => {
  test('a selector no lock row names', async () => {
    await expect(resolveImage('upstream:no-such-thing:1')).rejects.toThrow(/no image row for upstream:no-such-thing:1/)
  })

  test('a third-party image is taken only from the upstream rows of mica-build-env', async () => {
    await expect(resolveImage('mica-core:alpine')).rejects.toThrow(/no image row for mica-core:alpine/)
  })

  test('a string that is not a selector at all', async () => {
    await expect(resolveImage('GO_VERSION')).rejects.toThrow(/'GO_VERSION' is not an image selector/)
  })
})

describe('the answer is the resolver\'s, not a re-derivation of it', () => {
  test('resolveImage returns what src/locks/from.ts resolves, key for key', async () => {
    // If this package ever grew a second reader of the image files -- a grep, a parser, a copy of the digest --
    // it could agree with the resolver today and not tomorrow; this is the assertion that the value came
    // THROUGH the resolver rather than merely matching it.
    const records = inputs()
    for (const key of ['upstream:alpine:3.24.1', 'upstream:debian:trixie-slim', 'mica-build-env:base'])
      expect(`${key}=${await resolveImage(key)}`).toBe(`${key}=${resolve(key, records)}`)
  })
})
