export const FAULT_POINTS = [
  'snapshot:partial-tmp',
  'snapshot:after-tmp-write',
  'snapshot:after-tmp-fsync',
  'snapshot:after-link',
  'snapshot:after-rename',
  'snapshot:after-dir-fsync',
  'backup:after-write',
  'journal:partial-append',
  'journal:after-append',
  'journal:after-next',
  'journal:after-rotate',
  'recovery:after-notice',
  'recovery:after-snapshot',
  'restore:after-intent',
  'import:after-asset-move',
  'asset:after-files',
  'asset-sweep:after-commit',
  'staged:after-part',
] as const

export type FaultPoint = (typeof FAULT_POINTS)[number]

/** Crash-injection seam. Production code calls `hit` at named points; only tests make it do anything. */
export interface Faults {
  hit(point: FaultPoint): void
}

export const noFaults: Faults = { hit() {} }

/** SIGKILL ourselves, then block so no further code (and no pending I/O callback) can run. */
function killSelf(): void {
  process.kill(process.pid, 'SIGKILL')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

/**
 * The crash tests' seam: `PAPERTIE_FAULT="<point>@<n>"` kills the process at the n-th hit of that
 * point. A malformed spec throws, so a crash test never silently runs without its fault. `kill` is injectable for unit tests only.
 */
export function faultsFromEnv(
  env: Record<string, string | undefined>,
  kill: () => void = killSelf,
): Faults {
  const spec = env.PAPERTIE_FAULT
  if (spec === undefined || spec === '') return noFaults
  const m = /^([a-z:-]+)@([1-9][0-9]*)$/.exec(spec)
  const point = m?.[1] as FaultPoint | undefined
  if (!m || !point || !FAULT_POINTS.includes(point)) {
    throw new Error('PAPERTIE_FAULT must be "<point>@<n>" with a known point and n >= 1')
  }
  const target = Number(m[2])
  let count = 0
  return {
    hit(p) {
      if (p === point && ++count === target) kill()
    },
  }
}
