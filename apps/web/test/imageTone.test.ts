import { averageColor, createToneCache } from '../src/lib/imageTone'

describe('averageColor', () => {
  it('averages opaque pixels into #rrggbb, weighting by alpha', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0])
    expect(averageColor(px)).toBe('#800080')
    expect(averageColor(new Uint8ClampedArray([16, 32, 48, 255]))).toBe('#102030')
  })

  it('gives undefined when nothing is opaque', () => {
    expect(averageColor(new Uint8ClampedArray([1, 2, 3, 0]))).toBeUndefined()
    expect(averageColor(new Uint8ClampedArray([]))).toBeUndefined()
  })
})

describe('createToneCache', () => {
  it('answers undefined without a DOM, and asks only once per file', () => {
    let calls = 0
    const toneOf = createToneCache(() => calls++)
    expect(toneOf('asset_01JBPR0T0SAMP1E000000PR1NT')).toBeUndefined()
    expect(toneOf('asset_01JBPR0T0SAMP1E000000PR1NT')).toBeUndefined()
    expect(calls).toBe(0)
  })
})
