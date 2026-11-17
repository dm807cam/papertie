import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EnvVerdict, startEnvSampler } from '../../tools/src/benchEnv'

/**
 * Playwright's global setup for the `bench` project: sample the machine's load and power source
 * every 5 s for the whole run. The verdict is kept in `results/<run>.env.json`, rewritten as the
 * run goes (a test's `save()` reads it into its section's file), and the teardown, run last,
 * writes the final verdict there and into the run's results JSON as its top-level `env`.
 */

const dir = join(__dirname, 'results')
const run = () => process.env.BENCH_RUN ?? ''
const envFile = (name: string) => join(dir, `${name}.env.json`)

interface RunEnv {
  commit: string
  verdict: EnvVerdict
}

const commit = () => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const write = (name: string, env: RunEnv) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(envFile(name), `${JSON.stringify(env, null, 2)}\n`)
}

export default function setup(): () => void {
  const name = run()
  const sha = commit()
  const sampler = startEnvSampler()
  // At once, so a stale file from an earlier run of this id is never read.
  write(name, { commit: sha, verdict: sampler.verdict() })
  const timer = setInterval(() => write(name, { commit: sha, verdict: sampler.verdict() }), 5000)
  return () => {
    clearInterval(timer)
    const env: RunEnv = { commit: sha, verdict: sampler.stop() }
    write(name, env)
    const results = join(dir, `${name}.json`)
    if (existsSync(results)) {
      let all: object = {}
      try {
        all = JSON.parse(readFileSync(results, 'utf8'))
      } catch {
        // A corrupt results file: leave it, the report will not trust it.
        return
      }
      writeFileSync(results, `${JSON.stringify({ ...all, env }, null, 2)}\n`)
    }
  }
}
