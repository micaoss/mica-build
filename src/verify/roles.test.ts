import { expect, test } from 'bun:test'
import { ROLE_NAMES } from '../image/file-layout.ts'
import { ROLES } from '../image/roles/index.ts'
import { VERIFY_ROLES } from './roles.ts'

// The verifier's registry is its own, and it must still be keyed by the one list of roles the layout rules
// accept, as the engine's is: a role the engine builds and the verifier cannot read is an image nobody checks.
test('the verifier carries exactly the roles the rules know and the engine builds', () => {
  expect(Object.keys(VERIFY_ROLES).sort()).toEqual([...ROLE_NAMES].sort())
  expect(Object.keys(VERIFY_ROLES).sort()).toEqual(Object.keys(ROLES).sort())
})
