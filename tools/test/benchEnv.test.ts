import { type EnvSample, judgeEnv, QUIET_LOAD1, sampleEnv, startEnvSampler } from '../src/benchEnv'

const AC =
  "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"
const BATT =
  "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t83%; discharging; 4:10 remaining present: true\n"

const probe = (load1: number, pmset: string) => ({
  load1: () => load1,
  pmset: async () => pmset,
  now: () => new Date('2026-11-06T10:00:00.000Z'),
})

const sample = (o: Partial<EnvSample> = {}): EnvSample => ({
  at: '2026-11-06T10:00:00.000Z',
  load1: 1.2,
  onAC: true,
  power: 'ac',
  ...o,
})

describe('sampleEnv', () => {
  it('pmset parser reads AC and battery', async () => {
    expect(await sampleEnv(probe(1.5, AC))).toEqual({
      at: '2026-11-06T10:00:00.000Z',
      load1: 1.5,
      onAC: true,
      power: 'ac',
    })
    const b = await sampleEnv(probe(1.5, BATT))
    expect(b.onAC).toBe(false)
    expect(b.power).toBe('battery')
  })

  it('a machine with no pmset is unknown power, which is not mains', async () => {
    const s = await sampleEnv(probe(0.5, ''))
    expect(s.power).toBe('unknown')
    expect(s.onAC).toBe(false)
  })
})

describe('judgeEnv', () => {
  it('is valid when every sample is quiet and on mains', () => {
    const v = judgeEnv([sample(), sample({ load1: 3.9 })])
    expect(v).toEqual({
      valid: true,
      reason: null,
      maxLoad1: 3.9,
      onACThroughout: true,
      samples: 2,
    })
  })

  it('verdict is invalid when any sample has load1 ≥ 4', () => {
    const v = judgeEnv([sample(), sample({ load1: 6.2, at: 'T2' }), sample({ load1: QUIET_LOAD1 })])
    expect(v.valid).toBe(false)
    expect(v.reason).toBe('load 6.2 at T2')
    expect(v.maxLoad1).toBe(6.2)
  })

  it('a load of exactly 4 is not quiet', () => {
    expect(judgeEnv([sample({ load1: 4 })]).valid).toBe(false)
  })

  it('verdict is invalid when any sample is on battery', () => {
    const v = judgeEnv([sample(), sample({ onAC: false, power: 'battery', at: 'T2' })])
    expect(v.valid).toBe(false)
    expect(v.onACThroughout).toBe(false)
    expect(v.reason).toBe('battery at T2')
  })

  it('names both causes when both hold', () => {
    const v = judgeEnv([sample({ load1: 5, onAC: false, power: 'battery', at: 'T' })])
    expect(v.reason).toBe('load 5.0 at T; battery at T')
  })

  it('unknown power is invalid, named as such', () => {
    expect(judgeEnv([sample({ onAC: false, power: 'unknown', at: 'T' })]).reason).toBe(
      'power unknown at T',
    )
  })

  it('no samples is no evidence of a quiet run', () => {
    expect(judgeEnv([])).toMatchObject({ valid: false, reason: 'no samples', samples: 0 })
  })
})

describe('startEnvSampler', () => {
  afterEach(() => vi.useRealTimers())

  it('samples at once and every interval, and stop returns the verdict of them all', async () => {
    vi.useFakeTimers()
    const loads = [1, 2, 7]
    let i = 0
    const take = vi.fn(async () => sample({ load1: loads[i++] ?? 1 }))
    const s = startEnvSampler(5000, take)
    await vi.advanceTimersByTimeAsync(0)
    expect(take).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(take).toHaveBeenCalledTimes(3)
    const v = s.stop()
    expect(v.samples).toBe(3)
    expect(v.valid).toBe(false)
    expect(v.maxLoad1).toBe(7)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(take).toHaveBeenCalledTimes(3)
  })
})
