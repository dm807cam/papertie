import { defineConfig, devices } from '@playwright/test'

const PROTO_URL = 'http://localhost:5174'
const BENCH_URL = 'http://localhost:4174'

/**
 * Playwright's `webServer` is global, so servers are chosen from the CLI's `--project`
 * selection: `--project=proto` never builds the bench bundle, and vice versa.
 * With no `--project`, both start.
 */
function selectedProjects(argv: string[]): Set<string> {
  const picked = new Set<string>()
  argv.forEach((arg, i) => {
    if (arg.startsWith('--project=')) picked.add(arg.slice('--project='.length))
    else if (arg === '--project' || arg === '-p') {
      for (const name of argv.slice(i + 1)) {
        if (name.startsWith('-')) break
        picked.add(name)
      }
    }
  })
  return picked
}

const picked = selectedProjects(process.argv)

// One id for a whole bench run, set before the workers start so a restarted worker (after a
// failed row) writes into the same results file.
process.env.BENCH_RUN ??= new Date().toISOString()
const wants = (name: string) => picked.size === 0 || picked.has(name)
/** The `bench` project samples the machine's load and power for the whole run (`bench/envSetup.ts`). */
const benching = picked.has('bench')

const servers = [
  wants('proto') && {
    command: 'pnpm --filter @papertie/web exec vite --port 5174 --strictPort',
    url: PROTO_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  wants('bench') && {
    command:
      'VITE_DEV_ROUTES=1 pnpm --filter @papertie/web build && pnpm --filter @papertie/web exec vite preview --port 4174 --strictPort',
    url: BENCH_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
].filter((s) => s !== false)

export default defineConfig({
  outputDir: 'test-results',
  reporter: 'list',
  webServer: servers,
  // Starts the sampler; the function it returns is the teardown, which writes the verdict.
  globalSetup: benching ? './bench/envSetup.ts' : undefined,
  projects: [
    {
      name: 'proto',
      testMatch: '*.spec.ts',
      testIgnore: ['app/**', 'desktop/**'],
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: true,
        baseURL: PROTO_URL,
      },
    },
    // The app's journeys, in the built desktop app: each test launches Papertie on a data folder
    // of its own (`app/helpers/app.ts`). `pnpm e2e:app` builds the web app and the desktop app
    // first. One worker, so the machine's load stays out of the timed checks.
    {
      name: 'app',
      testMatch: 'app/**/*.spec.ts',
      workers: 1,
      timeout: 60_000,
    },
    // The desktop app: the built Electron app (`apps/desktop/dist`), which
    // each spec launches itself (`_electron`) on a userData of its own; no server to start.
    // `pnpm e2e:desktop` builds the web app and the desktop app first.
    {
      name: 'desktop',
      testMatch: 'desktop/**/*.spec.ts',
      workers: 1,
      timeout: 180_000,
      // PAPERTIE_E2E_EXPECT_MS: a longer wait for each expectation on a slow machine (the release
      // runner, about 35 times slower than a Mac, sets 30 s). The assertions are the same.
      expect: { timeout: Number(process.env.PAPERTIE_E2E_EXPECT_MS ?? 5000) },
    },
    // The speed targets in the packaged desktop app: `PAPERTIE_DESKTOP_EXE`
    // names it; its data is seeded through the app in the bench's own process. `pnpm bench:desktop`.
    {
      name: 'desktop-bench',
      testMatch: 'desktop/**/*.bench.ts',
      workers: 1,
      retries: 0,
    },
    {
      name: 'bench',
      testMatch: 'bench/**/*.bench.ts',
      workers: 1,
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        headless: false,
        baseURL: BENCH_URL,
        viewport: { width: 1200, height: 720 },
        deviceScaleFactor: 2,
        launchOptions: {
          args: [
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
          ],
        },
      },
    },
  ],
})
