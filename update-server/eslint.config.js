import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: ['.generated/**', 'dist/**', 'drizzle/**', 'coverage/**'],
  typescript: true,
  formatters: false,
  rules: { 'no-console': 'error' },
}, {
  files: ['src/index.ts', 'scripts/*.ts', 'web/app.ts'],
  rules: { 'antfu/no-top-level-await': 'off' },
})
