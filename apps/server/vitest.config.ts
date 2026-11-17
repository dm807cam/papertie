import { defineConfig } from 'vitest/config'

/**
 * Rows that time real work on this machine (the event loop's longest turn, a slice's CPU, a wall
 * time): never in `pnpm test` (`pnpm test:timing` runs them; `test:server` with the server's own),
 * and there one file at a time, so the suite's own parallel workers are not in their numbers
 * (beside seven busy cores the cold load's longest slice went to 8.8 ms CPU
 * against its 8; alone it passes every time). Never a looser bound. Each is a `*.timing.test.ts` beside the file it came from, which
 * keeps every row's untimed proof in `server`. Rows timed only from below (the auth response floor: load only lengthens it) stay in
 * `server`; a Raspberry Pi's count of a long step moved out too (its step is wall time
 * and its count CPU, so load shortens the count).
 */
/**
 * The V8 heap flags the timing rows were set under: a small semi-space (short scavenges while a
 * cold load keeps nearly all it allocates) and an old generation with room for a loaded
 * 100,000-note board from the start (no mark-compact at the heap's first growth).
 */
const NODE_FLAGS = ['--max-semi-space-size=8', '--initial-old-space-size=384']

export const TIMING_ROWS = ['test/**/*.timing.test.ts']

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    // The asset HEAD regression test forces GC: an undrained file stream closed by GC is fatal.
    execArgv: ['--expose-gc', ...NODE_FLAGS],
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: ['test/**/*.test.ts'],
          exclude: ['test/crash/**', '**/node_modules/**', ...TIMING_ROWS],
        },
      },
      // The timing rows: once the rest is done, a file at a time.
      {
        extends: true,
        test: {
          name: 'timing',
          include: TIMING_ROWS,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
