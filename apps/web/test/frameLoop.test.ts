import { FrameLoop } from '../src/canvas/FrameLoop'
import { fakeRaf } from './helpers/fakeRaf'

function setup() {
  const r = fakeRaf()
  return { r, loop: new FrameLoop(r.raf, r.now) }
}

describe('FrameLoop', () => {
  it('requests nothing while idle', () => {
    const { r, loop } = setup()
    loop.add(() => false)
    expect(r.pending).toBe(0)
    expect(loop.running).toBe(false)
    expect(loop.framesDrawn).toBe(0)
  })

  it('runs one frame per request', () => {
    const { r, loop } = setup()
    let calls = 0
    loop.add(() => {
      calls++
      return false
    })
    loop.request()
    loop.request()
    loop.request()
    expect(r.pending).toBe(1)
    expect(loop.running).toBe(true)
    r.frame()
    expect(calls).toBe(1)
    expect(loop.framesDrawn).toBe(1)
    expect(r.pending).toBe(0)
    expect(loop.running).toBe(false)
  })

  it('keeps running while a task returns true and stops when all return false', () => {
    const { r, loop } = setup()
    let left = 3
    let other = 0
    loop.add(() => left-- > 1)
    loop.add(() => {
      other++
      return false
    })
    loop.request()
    expect(r.drain()).toBe(3)
    expect(other).toBe(3)
    expect(loop.running).toBe(false)
  })

  it('a request() during a frame schedules exactly one more frame', () => {
    const { r, loop } = setup()
    let n = 0
    loop.add(() => {
      if (n++ === 0) {
        loop.request()
        loop.request()
      }
      return false
    })
    loop.request()
    r.frame()
    expect(r.pending).toBe(1)
    r.frame()
    expect(r.pending).toBe(0)
    expect(n).toBe(2)
  })

  it('first dt after idle is 1/60; a 5 s gap gives dt 5', () => {
    const { r, loop } = setup()
    const dts: number[] = []
    let keep = true
    loop.add((dt) => {
      dts.push(dt)
      return keep
    })
    loop.request()
    r.frame(16)
    r.frame(5000)
    keep = false
    r.frame(20)
    expect(dts[0]).toBeCloseTo(1 / 60, 12)
    expect(dts[1]).toBeCloseTo(5, 12)
    expect(dts[2]).toBeCloseTo(0.02, 12)
    loop.request()
    r.frame(3000)
    expect(dts[3]).toBeCloseTo(1 / 60, 12)
  })

  it('dt is never negative and never NaN', () => {
    let t = 0
    const queue: Array<(t: number) => void> = []
    const loop = new FrameLoop(
      (cb) => queue.push(cb),
      () => t,
    )
    const dts: number[] = []
    loop.add((dt) => {
      dts.push(dt)
      return dts.length < 3
    })
    loop.request()
    for (const next of [10, 5, Number.NaN]) {
      t = next
      queue.shift()?.(t)
    }
    expect(dts[1]).toBe(0)
    expect(dts[2]).toBe(0)
  })

  it('removing a task stops it from running; tasks see nowMs', () => {
    const { r, loop } = setup()
    const seen: number[] = []
    const remove = loop.add((_dt, now) => {
      seen.push(now)
      return true
    })
    loop.request()
    r.frame(16)
    remove()
    r.frame(16)
    expect(seen).toEqual([1016])
    expect(loop.running).toBe(false)
  })

  it('a throwing task does not stop the others or wedge the loop', () => {
    const { r, loop } = setup()
    const rethrown: Array<() => void> = []
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => {
      rethrown.push(fn)
    })
    let ran = 0
    loop.add(() => {
      throw new Error('boom')
    })
    loop.add(() => {
      ran++
      return false
    })
    loop.request()
    r.frame()
    spy.mockRestore()
    expect(ran).toBe(1)
    expect(loop.running).toBe(false)
    expect(rethrown).toHaveLength(1)
    expect(() => rethrown[0]?.()).toThrow('boom')
    loop.request()
    expect(r.pending).toBe(1)
  })
})
