import { defineConfig } from 'vitest/config'

/**
 * Rows that time real work on this machine (a longest task, a slice's length, a wall time): never
 * in `pnpm test` (`pnpm test:timing` runs them), and there one file at a time, so no parallel
 * worker is in their numbers (under seven busy cores the writer's mount row's
 * longest task went from 7 ms to 10–20 ms, its GC pauses from 2.4 ms to 4–7 ms; alone it passes
 * every time). Never a looser bound. Each is a `*.timing.test.{ts,tsx}` beside the file it came
 * from, which keeps every row's untimed proof in `node` or `dom` (no wall-time
 * assert in the default run).
 * Floors (a task at least so long: load only lengthens it) stay in the default run.
 */
export const TIMING_ROWS = ['test/**/*.timing.test.{ts,tsx}']

export default defineConfig({
  test: {
    globals: true,
    // Plain modules run in node; React screens (`.test.tsx`) get a DOM.
    projects: [
      // `test/setup/chunks.ts`: the chunks the board loads at idle, in (see the file).
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/cold/**', ...TIMING_ROWS],
          setupFiles: ['test/setup/chunks.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['test/**/*.test.tsx'],
          exclude: ['test/cold/**', ...TIMING_ROWS],
          environment: 'jsdom',
          setupFiles: ['test/setup/chunks.ts'],
        },
      },
      // The picker before its chunk is in (or when it cannot load): without the setup.
      {
        extends: true,
        test: { name: 'cold', include: ['test/cold/**/*.test.{ts,tsx}'], environment: 'jsdom' },
      },
      // The timing rows: once the rest is done, a file at a time.
      {
        extends: true,
        test: {
          name: 'timing',
          include: TIMING_ROWS,
          environment: 'jsdom',
          setupFiles: ['test/setup/chunks.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
