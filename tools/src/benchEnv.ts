import { execFile } from 'node:child_process'
import { loadavg } from 'node:os'
import { promisify } from 'node:util'
import { powerSource, QUIET_LOAD1 } from './benchJudge'

/**
 * The machine's state over a whole bench run, sampled every few seconds by the Playwright global
 * setup (`e2e/bench/envSetup.ts`). `benchJudge.hygiene` judges the start of a test; this judges
 * every moment of the run, and the report marks the run's rows invalid when it fails.
 */

export { QUIET_LOAD1 }

export interface EnvSample {
  at: string
  load1: number
  /** On mains power. Unknown power (no `pmset`) is not mains. */
  onAC: boolean
  power: 'ac' | 'battery' | 'unknown'
}

export interface EnvVerdict {
  valid: boolean
  reason: string | null
  maxLoad1: number
  onACThroughout: boolean
  samples: number
}

/** What a sample reads; swapped in the tests. */
export interface EnvProbe {
  load1(): number
  /** The output of `pmset -g batt`; empty when there is no `pmset`. */
  pmset(): Promise<string>
  now(): Date
}

const run = promisify(execFile)

const realProbe: EnvProbe = {
  load1: () => loadavg()[0] ?? Number.NaN,
  pmset: async () => {
    try {
      return (await run('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 4000 })).stdout
    } catch {
      return ''
    }
  },
  now: () => new Date(),
}

export async function sampleEnv(probe: EnvProbe = realProbe): Promise<EnvSample> {
  const at = probe.now().toISOString()
  const load1 = probe.load1()
  const power = powerSource(await probe.pmset())
  return { at, load1, onAC: power === 'ac', power }
}

/**
 * Valid when no sample had a load of `QUIET_LOAD1` or more and every one was on mains power.
 * The reason names the worst load and the first sample off mains.
 */
export function judgeEnv(samples: readonly EnvSample[]): EnvVerdict {
  if (samples.length === 0)
    return {
      valid: false,
      reason: 'no samples',
      maxLoad1: Number.NaN,
      onACThroughout: false,
      samples: 0,
    }
  let worst = samples[0] as EnvSample
  for (const s of samples) if (s.load1 > worst.load1) worst = s
  const offMains = samples.find((s) => !s.onAC)
  const reasons: string[] = []
  if (!(worst.load1 < QUIET_LOAD1)) reasons.push(`load ${worst.load1.toFixed(1)} at ${worst.at}`)
  if (offMains !== undefined)
    reasons.push(`${offMains.power === 'unknown' ? 'power unknown' : 'battery'} at ${offMains.at}`)
  return {
    valid: reasons.length === 0,
    reason: reasons.length === 0 ? null : reasons.join('; '),
    maxLoad1: worst.load1,
    onACThroughout: offMains === undefined,
    samples: samples.length,
  }
}

/**
 * Sample now and every `intervalMs`; `verdict()` judges what has been seen so far and `stop()`
 * ends the sampling and judges all of it.
 */
export function startEnvSampler(
  intervalMs = 5000,
  take: () => Promise<EnvSample> = sampleEnv,
): { verdict(): EnvVerdict; stop(): EnvVerdict } {
  const seen: EnvSample[] = []
  let stopped = false
  const tick = () => {
    take().then(
      (s) => {
        if (!stopped) seen.push(s)
      },
      () => {},
    )
  }
  tick()
  const timer = setInterval(tick, intervalMs)
  return {
    verdict: () => judgeEnv(seen),
    stop() {
      stopped = true
      clearInterval(timer)
      return judgeEnv(seen)
    },
  }
}
