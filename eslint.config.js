import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  // Build outputs, scratch, the source cache, the boards' vendor trees, and the fleet-protocol fixture validator.
  // boards/ is vendor trees and board inputs, except the boards' own host-side tests.
  { ignores: ['_out/**', '.tmp/**', '.work/**', 'tmp/**', 'repos/**', 'boards/**', '!boards/', '!boards/*/', '!boards/*/kernel/', '!boards/*/kernel/tests/', '!boards/*/kernel/tests/*.ts', 'node_modules/**', 'tests/fixtures/fleet-protocol/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  stylistic.configs.customize({ indent: 2, quotes: 'single', semi: false, jsx: false }),
  {
    rules: {
      'curly': ['error', 'multi-or-nest', 'consistent'],
      '@typescript-eslint/consistent-type-imports': 'error',
      // A leading underscore names a value that is deliberately unused (a destructured field set aside).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', caughtErrors: 'none' }],
      // The tree packs a pair of statements on one line where they are one thought; the verifier's
      // checks test for NUL and control bytes on purpose; type members are delimited as written.
      '@stylistic/max-statements-per-line': 'off',
      '@stylistic/member-delimiter-style': 'off',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
)
