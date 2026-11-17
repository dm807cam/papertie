import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { hygiene, powerSource, topProcesses } from '../../tools/src/benchJudge'

/** What every bench file shares: the machine's hygiene, and one results file per run. */

/** The repository root. */
export const repo = () => join(test.info().project.testDir, '..')

// --- Results: one JSON per run (`BENCH_RUN`, set in the config), one section per test. ----------

export const RUN = process.env.BENCH_RUN ?? new Date().toISOString()

const resultsDir = () => join(repo(), 'e2e/bench/results')

function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: repo(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

export type Machine = ReturnType<typeof machine>

/**
 * The machine now: commit, power, 1-minute load and the busiest processes (bench hygiene). Read before a test's first row, so the bench's own work is not in it.
 */
export function machine() {
  const load1 = loadavg()[0] ?? Number.NaN
  const power = powerSource(sh('pmset -g batt'))
  const top = topProcesses(sh('top -l 2 -n 5 -o cpu -stats pid,cpu,command'))
  return {
    at: new Date().toISOString(),
    commit: sh('git rev-parse --short HEAD'),
    dirty: sh('git status --porcelain --untracked-files=no') !== '',
    load1,
    power,
    top,
    ...hygiene(load1, power, top),
  }
}

export const hygieneLine = (m: Machine) =>
  `${m.valid ? 'VALID' : 'NOT VALID'} run: load ${m.load1.toFixed(2)}, power ${m.power}, top ${
    m.top
      .slice(0, 3)
      .map((p) => `${p.command} ${p.cpu.toFixed(0)}%`)
      .join(', ') || 'unread'
  } (at ${m.at})`

/**
 * Print and record the start-of-test hygiene, and fail softly when it makes the numbers invalid.
 */
export function checkHygiene(m: Machine): void {
  console.log(hygieneLine(m))
  test
    .info()
    .annotations.push({ type: m.valid ? 'hygiene' : 'warning', description: hygieneLine(m) })
  expect.soft(m.valid, `bench hygiene at start: ${hygieneLine(m)}`).toBe(true)
}

/** This run's results so far. */
export function loadRun(): Record<string, unknown> {
  const file = join(resultsDir(), `${RUN}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
}

/**
 * The run's environment verdict so far, from the sampler the Playwright global setup started
 * (`envSetup.ts`): the commit and whether the load and the power stayed quiet throughout.
 */
function loadEnv(): unknown {
  const file = join(resultsDir(), `${RUN}.env.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
}

/** Merge `data` into this run's results file under `section`, with the run's `env`. */
export function save(section: string, data: unknown): void {
  const dir = resultsDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${RUN}.json`)
  const env = loadEnv()
  const all = { ...loadRun(), run: RUN, ...(env === undefined ? {} : { env }), [section]: data }
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
}
