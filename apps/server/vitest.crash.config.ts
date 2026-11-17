import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    include: ['test/crash/**/*.test.ts'],
    testTimeout: 120_000,
  },
})
