import { defineConfig } from 'vitest/config'

/**
 * Rows that time real work on this machine (a wall time): never in `pnpm test` (`pnpm
 * test:timing` runs them), and there one file at a time (under load, `pnpm -r test`
 * failed on them). Never a looser bound.
 */
export const TIMING_ROWS = ['test/genBoard.timing.test.ts']

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'tools',
          include: ['test/**/*.test.ts'],
          exclude: TIMING_ROWS,
          // Generating the lifetime board again runs long when the machine is loaded (as core's
          // properties): its own time bound is a timing row's.
          testTimeout: 30_000,
        },
      },
      // The timing rows: a file at a time.
      {
        extends: true,
        test: { name: 'timing', include: TIMING_ROWS, fileParallelism: false },
      },
    ],
  },
})
