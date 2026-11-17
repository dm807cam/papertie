import { defineConfig } from 'vitest/config'

/** The desktop host's pure parts (the protocol bridge, window state, menu, file open), in Node. */
export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
})
