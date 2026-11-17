import { defineConfig } from 'vitest/config'

/**
 * Rows that time real work on this machine (a wall time, a step's time): never in `pnpm test`
 * (`pnpm test:timing` runs them), and there one file at a time, so no parallel worker is in their
 * numbers (under load, `pnpm -r test` failed on them). Never a looser bound.
 */
export const TIMING_ROWS = [
  'test/perf.test.ts',
  'test/perf/scale.timing.test.ts',
  'test/book/holdSteps.timing.test.ts',
  'test/pmap.timing.test.ts',
]

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['test/setup.ts'],
    // The fast-check properties run long when the machine is loaded.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'core', include: ['test/**/*.test.ts'], exclude: TIMING_ROWS },
      },
      // The timing rows: a file at a time.
      {
        extends: true,
        test: { name: 'timing', include: TIMING_ROWS, fileParallelism: false },
      },
    ],
  },
})
