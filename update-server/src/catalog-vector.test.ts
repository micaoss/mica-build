import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { authenticatePayload } from '../../build/src/components'

/**
 * The SHARED catalog vector, verified by the server that serves catalogues.
 *
 * tests/component-contracts/ is mica-core's contract copy and this tree keeps it
 * byte-identical at the commit of the pinned release; tools/deploy-pool.sh
 * --check refuses a divergence. That proves the BYTES are the same on both
 * sides. It does not prove that both sides READ them the same way, and the
 * protocol is exactly where two implementations drift: mica-fleet speaks
 * catalog/v1 with the pre-rename board vocabulary while this tree speaks v2.
 *
 * So the vector is authenticated here with the reader the update server itself
 * uses on every upload. The envelope is stored in the fixture with its fields
 * SORTED, which is not the wire form -- the canonical order is schema, keyId,
 * payload, signature, and authenticatePayload refuses anything else by
 * comparing its own re-serialisation against the bytes it was given. Rebuilding
 * that order here is part of what the vector tests.
 */
const vector = JSON.parse(readFileSync(new URL('../../tests/component-contracts/catalog.json', import.meta.url), 'utf8'))
function wire(envelope: Record<string, string>): string {
  return JSON.stringify({ schema: envelope.schema, keyId: envelope.keyId, payload: envelope.payload, signature: envelope.signature })
}

test('the shared catalog vector authenticates with this tree\'s envelope reader', () => {
  const payload = JSON.parse(authenticatePayload(wire(vector.envelope), [vector.publicKey]))
  expect(payload.schema).toBe('mica/catalog/v2')
  expect(payload.channels).toEqual([{ board: 'uefi-x64', channel: 'stable', generation: 1, product: 'uefi-x64-dev', releaseId: 'release-1' }])
  // The board name is the CURRENT vocabulary: a v1 catalogue would carry x64.
  expect(payload.channels.map((c: { board: string }) => c.board)).not.toContain('x64')
  // `now` is the vector's own observation time, so the document is live at it.
  expect(Date.parse(payload.expiresAt)).toBeGreaterThan(vector.now * 1000)
})

test('a tampered catalog vector is refused rather than read', () => {
  const signature = vector.envelope.signature as string
  const flipped = { ...vector.envelope, signature: (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1) }
  expect(() => authenticatePayload(wire(flipped), [vector.publicKey])).toThrow()
  // And the sorted form the fixture stores is not the wire form: the reader
  // refuses it, which is why rebuilding the order above is part of the test.
  expect(() => authenticatePayload(JSON.stringify(vector.envelope), [vector.publicKey])).toThrow()
})
