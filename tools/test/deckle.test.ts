import {
  DECKLE_MAX_BITE,
  DECKLE_MIN_BITE,
  DECKLE_SLICE,
  deckleProfile,
  generateDeckleSvg,
} from '../src/textures/deckle'
import { TEXTURE_SEED } from '../src/textures/set'

const indices = [1, 2, 3, 4, 5, 6, 7, 8] as const

describe('deckle masks', () => {
  it('has 8 distinct masks, files only', () => {
    const svgs = indices.map((i) => generateDeckleSvg(i, TEXTURE_SEED))
    expect(new Set(svgs).size).toBe(8)
    for (const s of svgs) {
      expect(s).toMatch(/viewBox="0 0 128 128"/)
      // An intrinsic size, so a 9-slice mask cuts 12 px slices of a 128 px image on every note.
      expect(s).toMatch(/^<svg [^>]*width="128" height="128"/)
      expect(s).not.toMatch(/NaN|data:/)
    }
  })

  it('is deterministic', () => {
    expect(generateDeckleSvg(3, TEXTURE_SEED)).toBe(generateDeckleSvg(3, TEXTURE_SEED))
  })

  it('edge profile repeats over the 104-unit middle slice and bites deep, inside the band', () => {
    expect(DECKLE_MAX_BITE).toBeLessThan(DECKLE_SLICE)
    for (const i of indices) {
      const p = deckleProfile(i, TEXTURE_SEED)
      expect(Math.abs(p(0) - p(104))).toBeLessThan(1e-9)
      expect(Math.abs(p(10.5) - p(114.5))).toBeLessThan(1e-9)
      let deepest = 0
      for (let s = 0; s <= 128; s += 0.25) {
        expect(p(s)).toBeGreaterThanOrEqual(DECKLE_MIN_BITE)
        expect(p(s)).toBeLessThanOrEqual(DECKLE_MAX_BITE)
        deepest = Math.max(deepest, p(s))
      }
      // Strongly torn: every mask has bites well past the old 5 px.
      expect(deepest).toBeGreaterThan(6)
    }
  })

  it('draws a translucent fringe and fibre wisps that stay inside the edge band', () => {
    for (const i of indices) {
      const svg = generateDeckleSvg(i, TEXTURE_SEED)
      // Valid shape: one svg element, a fringe, the opaque paper and a group of fibre strokes.
      expect(svg).toMatch(/^<svg [^>]*>.*<\/svg>\n$/s)
      expect(svg.match(/<svg /g)).toHaveLength(1)
      expect(svg).toMatch(/<path fill="#fff" fill-opacity="0\.\d+" d="M[^"]+Z"\/>/)
      expect(svg.match(/<path fill="#fff" d="M[^"]+Z"\/>/g)).toHaveLength(1)
      const fibres = [
        ...svg.matchAll(/<path d="M([^"]+)" stroke-width="([\d.]+)" stroke-opacity="([\d.]+)"\/>/g),
      ]
      expect(fibres.length).toBeGreaterThan(60)
      for (const [, d, width, alpha] of fibres) {
        expect(Number(width)).toBeGreaterThan(0)
        expect(Number(width)).toBeLessThan(1)
        expect(Number(alpha)).toBeGreaterThan(0)
        expect(Number(alpha)).toBeLessThan(1)
        const nums = (d as string).split(/[MQ ]/).filter(Boolean).map(Number)
        expect(nums).toHaveLength(6)
        for (let k = 0; k < nums.length; k += 2) {
          const x = nums[k] as number
          const y = nums[k + 1] as number
          const fromEdge = Math.min(x, y, 128 - x, 128 - y)
          expect(fromEdge).toBeGreaterThanOrEqual(0.25)
          expect(fromEdge).toBeLessThanOrEqual(DECKLE_SLICE)
        }
      }
    }
  })
})
