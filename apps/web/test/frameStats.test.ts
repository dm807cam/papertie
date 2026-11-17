import { FrameStats } from '../src/perf/frameStats'

describe('FrameStats', () => {
  it('fps is 1000/mean interval', () => {
    const s = new FrameStats()
    for (let i = 0; i < 60; i++) s.push(16.667)
    expect(s.snapshot().fps).toBeCloseTo(60, 1)
    expect(s.snapshot().frames).toBe(60)
  })

  it('p95 is nearest-rank and long frames count > 20 ms', () => {
    const s = new FrameStats()
    // 1..100 ms: nearest rank ceil(0.95 * 100) = 95 -> 95 ms.
    for (let i = 100; i >= 1; i--) s.push(i)
    const snap = s.snapshot()
    expect(snap.p95FrameMs).toBe(95)
    expect(snap.longFrames).toBe(80)
    const t = new FrameStats()
    for (const ms of [16, 17, 20, 20.5, 33]) t.push(ms)
    // ceil(0.95 * 5) = 5 -> the largest.
    expect(t.snapshot().p95FrameMs).toBe(33)
    expect(t.snapshot().longFrames).toBe(2)
    expect(snap.maxFrameMs).toBe(100)
    expect(t.snapshot().maxFrameMs).toBe(33)
  })

  it('the ring buffer keeps only the last capacity frames', () => {
    const s = new FrameStats(4)
    for (const ms of [100, 100, 100, 10, 10, 10, 10]) s.push(ms)
    const snap = s.snapshot()
    expect(snap.frames).toBe(4)
    expect(snap.fps).toBeCloseTo(100, 6)
    expect(snap.p95FrameMs).toBe(10)
    expect(snap.longFrames).toBe(0)
  })

  it('is empty after reset and before any frame', () => {
    const s = new FrameStats()
    expect(s.snapshot()).toEqual({ fps: 0, p95FrameMs: 0, maxFrameMs: 0, longFrames: 0, frames: 0 })
    s.push(16)
    s.reset()
    expect(s.snapshot()).toEqual({ fps: 0, p95FrameMs: 0, maxFrameMs: 0, longFrames: 0, frames: 0 })
  })

  it('ignores intervals that are not finite and positive', () => {
    const s = new FrameStats()
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0, 20]) s.push(ms)
    expect(s.snapshot()).toEqual({
      fps: 50,
      p95FrameMs: 20,
      maxFrameMs: 20,
      longFrames: 0,
      frames: 1,
    })
  })
})
