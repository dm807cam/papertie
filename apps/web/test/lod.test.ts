import fc from 'fast-check'
import { ZOOM_MAX } from '../src/canvas/Camera'
import { LOD, type LodMode, nextLod } from '../src/canvas/lod'

describe('LOD', () => {
  it('uses the planned thresholds', () => {
    expect(LOD).toEqual({
      lite: { enterBelow: 0.35, exitAtOrAbove: 0.38 },
      overview: { enterBelow: 0.15, exitAtOrAbove: 0.18 },
    })
  })

  it('full and lite keep their hysteresis', () => {
    expect(nextLod('full', 0.36)).toBe('full')
    expect(nextLod('full', 0.34)).toBe('lite')
    expect(nextLod('lite', 0.37)).toBe('lite')
    expect(nextLod('lite', 0.38)).toBe('full')
  })

  it('lite and overview have their own gap', () => {
    expect(nextLod('lite', 0.151)).toBe('lite')
    expect(nextLod('lite', 0.149)).toBe('overview')
    expect(nextLod('overview', 0.179)).toBe('overview')
    expect(nextLod('overview', 0.18)).toBe('lite')
  })

  it('a jump skips the level in between, either way', () => {
    expect(nextLod('full', 0.02)).toBe('overview')
    expect(nextLod('full', 0.149)).toBe('overview')
    expect(nextLod('overview', 1)).toBe('full')
    // From overview, lite's exit threshold applies: inside lite's gap it lands in lite.
    expect(nextLod('overview', 0.37)).toBe('lite')
    expect(nextLod('overview', 0.38)).toBe('full')
  })

  it('every reading zoom draws full detail, real text and not greeked bars, from any level', () => {
    // Reading distance runs from 0.6 (16 px text at about 10 px) to the closest zoom, 2×.
    for (const z of [0.6, 1, 1.5, ZOOM_MAX]) {
      for (const m of ['full', 'lite', 'overview'] as const) expect(nextLod(m, z)).toBe('full')
    }
    // Full detail holds over the whole reading range, with lite's gap below it.
    expect(LOD.lite.exitAtOrAbove).toBeLessThanOrEqual(0.6)
  })

  it('keeps the current mode for a non-finite zoom', () => {
    for (const m of ['full', 'lite', 'overview'] as const) {
      expect(nextLod(m, Number.NaN)).toBe(m)
      expect(nextLod(m, Number.POSITIVE_INFINITY)).toBe(m)
    }
  })

  it('every mode stays inside its band, and only a move past a gap flips it', () => {
    const band: Record<LodMode, [number, number]> = {
      overview: [0, LOD.overview.exitAtOrAbove],
      lite: [LOD.overview.enterBelow, LOD.lite.exitAtOrAbove],
      full: [LOD.lite.enterBelow, Number.POSITIVE_INFINITY],
    }
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.02, max: ZOOM_MAX, noNaN: true }), { maxLength: 60 }),
        (zs) => {
          let m: LodMode = 'full'
          for (const z of zs) {
            const next = nextLod(m, z)
            const [lo, hi] = band[next]
            expect(z >= lo && z < hi).toBe(true)
            // Inside the band of the current mode, nothing flips.
            if (z >= band[m][0] && z < band[m][1]) expect(next).toBe(m)
            m = next
          }
        },
      ),
    )
  })
})
