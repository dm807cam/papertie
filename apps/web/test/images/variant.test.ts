import { noteSizeFor } from '../../src/images/upload'
import { setZoomBand, variantFor, zoomBand, zoomBandOf } from '../../src/images/variant'
import { createToneCache, primeTone } from '../../src/lib/imageTone'

describe('variantFor', () => {
  it('is the smallest variant at least noteW x zoom x dpr wide', () => {
    expect(variantFor(1, 2, 300)).toBe(1024)
    expect(variantFor(0.3, 2, 300)).toBe(256)
    expect(variantFor(4, 2, 400)).toBe(2560)
  })

  it('takes a variant that is exactly enough', () => {
    expect(variantFor(1, 1, 256)).toBe(256)
    expect(variantFor(1, 1, 257)).toBe(1024)
    expect(variantFor(1, 1, 1024)).toBe(1024)
    expect(variantFor(1, 1, 1025)).toBe(2560)
  })

  it('never asks for more than the largest, and meets nonsense with the middle one', () => {
    expect(variantFor(50, 3, 2000)).toBe(2560)
    expect(variantFor(Number.NaN, 2, 300)).toBe(1024)
    expect(variantFor(1, 2, Number.POSITIVE_INFINITY)).toBe(1024)
  })
})

describe('zoom band', () => {
  it('rounds the zoom up to a half octave, so a variant is never too small', () => {
    expect(zoomBandOf(1)).toBe(1)
    expect(zoomBandOf(1.01)).toBeCloseTo(Math.SQRT2)
    expect(zoomBandOf(0.3)).toBeCloseTo(0.3535, 3)
    for (const z of [0.02, 0.3, 0.7, 1, 1.4, 2.9, 4])
      expect(zoomBandOf(z)).toBeGreaterThanOrEqual(z)
    expect(zoomBandOf(0)).toBe(1)
    expect(zoomBandOf(Number.NaN)).toBe(1)
  })

  it('tells listeners only when the band changes', () => {
    let heard = 0
    const off = zoomBand.subscribe(() => heard++)
    setZoomBand(1)
    const before = heard
    setZoomBand(0.98) // still the band that ends at 1
    setZoomBand(0.97)
    expect(heard).toBe(before)
    setZoomBand(2)
    expect(heard).toBe(before + 1)
    expect(zoomBand.get()).toBe(2)
    off()
    setZoomBand(1)
  })
})

describe('noteSizeFor', () => {
  it('makes the long edge 320 and keeps the aspect', () => {
    expect(noteSizeFor(4000, 3000)).toEqual({ w: 320, h: 240 })
    expect(noteSizeFor(3000, 4000)).toEqual({ w: 240, h: 320 })
    expect(noteSizeFor(100, 100)).toEqual({ w: 320, h: 320 })
  })

  it('clamps to the note limits', () => {
    expect(noteSizeFor(10_000, 100).h).toBe(60)
    expect(noteSizeFor(100, 10_000).w).toBe(120)
  })
})

describe('primed tones', () => {
  it("gives the overview a photo's tone before its file is fetched", () => {
    primeTone('asset_PRIMED', '#102030')
    const toneOf = createToneCache(() => {})
    expect(toneOf('asset_PRIMED')).toBe('#102030')
  })
})
