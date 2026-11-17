import {
  createPinSprites,
  drawStrand,
  HOOK,
  PIN_HEAD,
  pinRadiusPx,
  spriteRadius,
  strandWidthPx,
  YARN_STYLE,
} from '../src/canvas/drawYarn'
import { recordingContext } from './helpers/recordingContext'

const pts = [
  { x: 0, y: 0 },
  { x: 50, y: 20 },
  { x: 100, y: 0 },
]

describe('strand width', () => {
  it('is a little finer than the mockup cord: 7.2 px at zoom 1, scaled by zoom, 1.5-17 px', () => {
    // First drawn 9.5-10.5 px across, then thinned by 28 %.
    expect(strandWidthPx(1)).toBeCloseTo(7.2)
    expect(strandWidthPx(0.5)).toBeCloseTo(3.6)
    expect(strandWidthPx(2)).toBeCloseTo(14.4)
    expect(strandWidthPx(0.1)).toBe(1.5)
    expect(strandWidthPx(4)).toBe(17)
  })

  it('twists only from 4.5 px across, a turn every 8.2 px at zoom 1 as on the mockup cord', () => {
    // Finer plies than these are sub-pixel noise, and the finer cord would draw more of them.
    expect(YARN_STYLE.twistMinPx).toBe(4.5)
    expect(YARN_STYLE.twist * strandWidthPx(1)).toBeCloseTo(8.2, 1)
  })

  it('meets overview threads at the lite handover (1.5 px at zoom 0.15)', () => {
    expect(strandWidthPx(0.15)).toBeCloseTo(1.5)
  })

  it('is finite for bad zoom values', () => {
    for (const z of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const w = strandWidthPx(z)
      expect(Number.isFinite(w)).toBe(true)
      expect(w).toBeGreaterThanOrEqual(YARN_STYLE.minPx)
      expect(w).toBeLessThanOrEqual(YARN_STYLE.maxPx)
    }
  })
})

describe('pinRadiusPx', () => {
  it('sizes each kind from its world radius, clamped to [3, 2x], or [1.5, 3] in lite mode', () => {
    // An edge pin is a hanging pin's size; a tag's is smaller.
    expect(PIN_HEAD.edge).toBe(PIN_HEAD.top)
    expect(PIN_HEAD.tag).toBeLessThan(PIN_HEAD.edge)
    // A head is twice the cord across, so the cord ends under it.
    expect(2 * PIN_HEAD.edge).toBeGreaterThanOrEqual(2 * YARN_STYLE.widthWorld)
    expect(2 * PIN_HEAD.tag).toBeGreaterThan(YARN_STYLE.widthWorld)
    expect(pinRadiusPx(1, false)).toBe(PIN_HEAD.top)
    expect(pinRadiusPx(1, false, 'edge')).toBe(PIN_HEAD.edge)
    expect(pinRadiusPx(0.1, false)).toBe(3)
    expect(pinRadiusPx(4, false)).toBe(2 * PIN_HEAD.top)
    expect(pinRadiusPx(4, false, 'edge')).toBe(2 * PIN_HEAD.edge)
    expect(pinRadiusPx(0.1, true)).toBe(1.5)
    expect(pinRadiusPx(0.2, true)).toBe(2)
    expect(pinRadiusPx(4, true)).toBe(3)
    // The tag hook keeps its own size.
    expect(pinRadiusPx(1, false, 'hook')).toBe(5.5)
  })

  it('is finite for bad zoom values', () => {
    for (const z of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const kind of ['top', 'edge', 'tag', 'hook'] as const) {
        expect(Number.isFinite(pinRadiusPx(z, false, kind))).toBe(true)
        expect(Number.isFinite(pinRadiusPx(z, true, kind))).toBe(true)
      }
    }
  })
})

const strokes = (calls: { name: string }[]) => calls.filter((c) => c.name === 'stroke').length
/** A full-detail strand: shadow, base, groove, lit ply and the crown highlight. */
const FULL_STROKES = 5

describe('drawStrand', () => {
  it('never touches shadowBlur or filter', () => {
    for (const lite of [false, true]) {
      for (const selected of [false, true]) {
        const { ctx, sets, calls } = recordingContext()
        drawStrand(ctx, pts, { color: '#2E4B7A', zoom: 1.5, lite, selected, alpha: 0.5 })
        expect(sets.filter((s) => s.prop === 'shadowBlur' || s.prop === 'filter')).toEqual([])
        expect(calls.filter((c) => c.name === 'createLinearGradient')).toEqual([])
      }
    }
  })

  it('full mode strokes shadow, base, two plies and the lit crown (no glow); lite once', () => {
    const full = recordingContext()
    drawStrand(full.ctx, pts, { color: '#2E4B7A', zoom: 1 })
    expect(strokes(full.calls)).toBe(FULL_STROKES)
    const lite = recordingContext()
    drawStrand(lite.ctx, pts, { color: '#2E4B7A', zoom: 1, lite: true })
    expect(strokes(lite.calls)).toBe(1)
  })

  it('skips the twist on strands thinner than twistMinPx', () => {
    const thin = recordingContext()
    const perZoom = YARN_STYLE.widthWorld
    drawStrand(thin.ctx, pts, { color: '#2E4B7A', zoom: (YARN_STYLE.twistMinPx - 0.1) / perZoom })
    expect(strokes(thin.calls)).toBe(2)
    const enough = recordingContext()
    drawStrand(enough.ctx, pts, { color: '#2E4B7A', zoom: YARN_STYLE.twistMinPx / perZoom })
    expect(strokes(enough.calls)).toBe(FULL_STROKES)
  })

  it('draws shadow, base, a dark groove and a lit ply of the given widths, at full alpha', () => {
    const { ctx, calls, sets } = recordingContext()
    drawStrand(ctx, pts, { color: '#2E4B7A', zoom: 1 })
    const w = strandWidthPx(1)
    const widths = sets.filter((s) => s.prop === 'lineWidth').map((s) => s.value as number)
    expect(widths[0]).toBeCloseTo(w)
    expect(widths[1]).toBeCloseTo(w)
    expect(widths[2]).toBeCloseTo(YARN_STYLE.grooveWidth * w)
    expect(widths[3]).toBeCloseTo(YARN_STYLE.plyWidth * w)
    const styles = sets.filter((s) => s.prop === 'strokeStyle').map((s) => s.value)
    expect(styles[0]).toBe(YARN_STYLE.shadow)
    expect(styles[1]).toBe('#2E4B7A')
    // The groove is darker than the dye, the ply lighter.
    const sum = (c: unknown) => (String(c).match(/\d+/g) ?? []).map(Number).reduce((x, y) => x + y)
    const dye = 0x2e + 0x4b + 0x7a
    expect(sum(styles[2])).toBeLessThan(dye)
    expect(sum(styles[3])).toBeGreaterThan(dye)
    // Last, the lit crown: a narrow lighter line along the cord.
    expect(widths[4]).toBeCloseTo(YARN_STYLE.crownWidth * w)
    expect(sum(styles[4])).toBeGreaterThan(dye)
    // No glow: nothing is stroked fainter than the strand itself, and no dashes.
    const alphas = sets.filter((s) => s.prop === 'globalAlpha').map((s) => s.value as number)
    expect(alphas).toEqual([1])
    expect(calls.filter((c) => c.name === 'setLineDash')).toEqual([])
  })

  it('offsets the shadow down-right; the twist is slanted stripes across the strand, a period apart', () => {
    const { ctx, calls } = recordingContext()
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    drawStrand(ctx, line, { color: '#000000', zoom: 1 })
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args as number[])
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args as number[])
    const w = strandWidthPx(1)
    expect(moves[0]?.[0]).toBeCloseTo(YARN_STYLE.shadowOffset[0] * w)
    expect(moves[0]?.[1]).toBeCloseTo(YARN_STYLE.shadowOffset[1] * w)
    expect(moves[1]).toEqual([0, 0])
    // The crown is the path again, nudged toward the light (up and left).
    const crown = moves.at(-1) ?? []
    expect(crown[0]).toBeCloseTo(YARN_STYLE.crownOffset[0] * w)
    expect(crown[1]).toBeCloseTo(YARN_STYLE.crownOffset[1] * w)
    expect(YARN_STYLE.crownOffset[0]).toBeLessThanOrEqual(0)
    expect(YARN_STYLE.crownOffset[1]).toBeLessThan(0)
    const period = YARN_STYLE.twist * w
    // Lit stripes start at 0, grooves half a period on; each crosses from above to below.
    const stripes = moves.slice(2, -1)
    const perStroke = Math.floor(100 / period) + 1
    expect(stripes.length).toBeGreaterThanOrEqual(2 * perStroke - 2)
    const reach = YARN_STYLE.plyReach * w
    const lean = YARN_STYLE.plyLean * w
    const ends = lines.slice(lines.length - stripes.length - 1, -1)
    stripes.forEach((m, k) => {
      expect(m[1]).toBeCloseTo(-reach)
      expect(ends[k]?.[1]).toBeCloseTo(reach)
      expect((ends[k]?.[0] ?? 0) - (m[0] ?? 0)).toBeCloseTo(2 * lean)
    })
    const xs = stripes.map((m) => (m[0] ?? 0) + lean)
    expect(xs.slice(0, 2)).toEqual([period / 2, (3 * period) / 2].map((n) => expect.closeTo(n, 9)))
  })

  it('selected strands are 1.35x wider', () => {
    const base = recordingContext()
    drawStrand(base.ctx, pts, { color: '#2E4B7A', zoom: 1, lite: true })
    const sel = recordingContext()
    drawStrand(sel.ctx, pts, { color: '#2E4B7A', zoom: 1, lite: true, selected: true })
    const w = (r: typeof base) => r.sets.find((s) => s.prop === 'lineWidth')?.value as number
    expect(w(sel) / w(base)).toBeCloseTo(1.35)
  })

  it('applies alpha and balances save/restore', () => {
    const { ctx, calls, sets } = recordingContext()
    drawStrand(ctx, pts, { color: '#2E4B7A', zoom: 1, alpha: 0.4 })
    expect(sets.filter((s) => s.prop === 'globalAlpha').map((s) => s.value)).toEqual([0.4])
    const n = (name: string) => calls.filter((c) => c.name === name).length
    expect(n('save')).toBe(n('restore'))
  })

  it('does nothing for fewer than two points and survives odd colours and alpha', () => {
    const empty = recordingContext()
    drawStrand(empty.ctx, [], { color: '#fff', zoom: 1 })
    drawStrand(empty.ctx, [{ x: 0, y: 0 }], { color: '#fff', zoom: 1 })
    expect(strokes(empty.calls)).toBe(0)
    const odd = recordingContext()
    drawStrand(odd.ctx, pts, { color: 'rebeccapurple', zoom: Number.NaN, alpha: Number.NaN })
    expect(strokes(odd.calls)).toBe(FULL_STROKES)
    for (const s of odd.sets) {
      if (s.prop === 'lineWidth' || s.prop === 'globalAlpha' || s.prop === 'lineDashOffset') {
        expect(Number.isFinite(s.value as number)).toBe(true)
      }
    }
  })

  it('draws coincident points without error, plies finite', () => {
    const { ctx, calls } = recordingContext()
    const p = { x: 10, y: 10 }
    drawStrand(ctx, [p, p, p], { color: '#C8492F', zoom: 1 })
    expect(strokes(calls)).toBe(FULL_STROKES)
    for (const c of calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo')) {
      for (const v of c.args as number[]) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('pin sprites', () => {
  /** Sprite canvases record into one log, so the dome's own drawing can be checked too. */
  const spriteSets: Array<{ prop: string }> = []
  beforeAll(() => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          const r = recordingContext()
          spriteSets.push(...r.sets)
          const gradient = () => ({ addColorStop() {} })
          return new Proxy(r.ctx, {
            get(t, prop) {
              if (prop === 'createRadialGradient' || prop === 'createLinearGradient')
                return gradient
              return Reflect.get(t, prop)
            },
            set(t, prop, v) {
              spriteSets.push({ prop: String(prop) })
              return Reflect.set(t, prop, v)
            },
          })
        }
      },
    )
  })
  afterAll(() => vi.unstubAllGlobals())

  it('caches one dome per kind and radius and never blurs or filters', () => {
    const { ctx, calls, sets } = recordingContext()
    const sprites = createPinSprites(2)
    sprites.draw(ctx, { x: 10, y: 10 }, 1)
    sprites.draw(ctx, { x: 40, y: 10 }, 1)
    sprites.draw(ctx, { x: 70, y: 10 }, 1, { kind: 'tag' })
    const images = calls.filter((c) => c.name === 'drawImage')
    expect(images).toHaveLength(3)
    expect(images[0]?.args[0]).toBe(images[1]?.args[0])
    expect(images[2]?.args[0]).not.toBe(images[0]?.args[0])
    expect(sets.filter((s) => s.prop === 'shadowBlur' || s.prop === 'filter')).toEqual([])
    expect(spriteSets.length).toBeGreaterThan(0)
    expect(spriteSets.filter((s) => s.prop === 'shadowBlur' || s.prop === 'filter')).toEqual([])
    // The sprite's pin point is its centre: drawn so the head centres on the point.
    const [, x = 0, y = 0, w = 0, h = 0] = (images[0]?.args ?? []) as number[]
    expect(x + w / 2).toBeCloseTo(10)
    expect(y + h / 2).toBeCloseTo(10)
  })

  it('caches heads on a 10% radius ladder and scales them to the exact size', () => {
    for (const r of [1, 3, 5.5, 8, 10, 19.5, 20]) {
      const rs = spriteRadius(r)
      expect(rs).toBeGreaterThanOrEqual(r - 1e-9)
      expect(rs).toBeLessThan(r * 1.1 + 1e-9)
    }
    expect(spriteRadius(Number.NaN)).toBe(1)
    const sizes = new Set<number>()
    for (let r = 3; r <= 20; r += 0.5) sizes.add(spriteRadius(r))
    expect(sizes.size).toBeLessThan(22)
    const { ctx, calls } = recordingContext()
    const sprites = createPinSprites(1)
    // Edge-pin radii 10 and 10.5 px (heads snap to half px) share the 10.835 px sprite.
    const full = PIN_HEAD.edge
    const more = full + 0.5
    expect(spriteRadius(more)).toBe(spriteRadius(full))
    sprites.draw(ctx, { x: 0, y: 0 }, more / full, { kind: 'edge' })
    sprites.draw(ctx, { x: 0, y: 0 }, 1, { kind: 'edge' })
    const [a, b] = calls.filter((c) => c.name === 'drawImage')
    expect(a?.args[0]).toBe(b?.args[0])
    expect((a?.args[3] as number) / (b?.args[3] as number)).toBeCloseTo(more / full, 6)
  })

  it('warm works within an idle deadline: nothing when out of time, the rest later', () => {
    const before = spriteSets.length
    const sprites = createPinSprites(1)
    expect(sprites.warm(() => 0)).toBe(false)
    expect(spriteSets.length).toBe(before)
    let budget = 3
    expect(sprites.warm(() => budget--)).toBe(false)
    const some = spriteSets.length
    expect(some).toBeGreaterThan(before)
    expect(sprites.warm(() => 50)).toBe(true)
    expect(spriteSets.length).toBeGreaterThan(some)
    const all = spriteSets.length
    expect(sprites.warm(() => 50)).toBe(true)
    expect(spriteSets.length).toBe(all)
  })

  it('warm renders every ladder size once, then drawing renders none', () => {
    const before = spriteSets.length
    const sprites = createPinSprites(1)
    expect(sprites.warm()).toBe(true)
    const warmed = spriteSets.length
    expect(warmed).toBeGreaterThan(before)
    const { ctx } = recordingContext()
    for (let z = 0.35; z <= 4; z *= 1.03) {
      sprites.draw(ctx, { x: 0, y: 0 }, z)
      sprites.draw(ctx, { x: 0, y: 0 }, z, { kind: 'edge' })
      sprites.draw(ctx, { x: 0, y: 0 }, z, { hook: true })
    }
    expect(spriteSets.length).toBe(warmed)
  })

  it('lite pins are a flat disc of the kind', () => {
    const { ctx, calls } = recordingContext()
    createPinSprites(1).draw(ctx, { x: 5, y: 5 }, 0.2, { lite: true, kind: 'edge' })
    const arc = calls.find((c) => c.name === 'arc')
    expect(arc?.args[2]).toBe(Math.round(pinRadiusPx(0.2, true, 'edge') * 2) / 2)
  })
})

describe('tag hook', () => {
  it('rises from the eyelet: a shank above the pin point, never blurred or filtered', () => {
    expect(HOOK.shankUp).toBeGreaterThan(2)
    expect(HOOK.shankWidth).toBeGreaterThan(0.4)
    expect(HOOK.shankWidth).toBeLessThan(1)
  })

  it('a lite hook is a flat eyelet plus a flat shank above it', () => {
    const { ctx, calls, sets } = recordingContext()
    createPinSprites(2).draw(ctx, { x: 50, y: 60 }, 0.2, { lite: true, hook: true })
    expect(sets.filter((s) => s.prop === 'shadowBlur' || s.prop === 'filter')).toEqual([])
    const arc = calls.find((c) => c.name === 'arc')
    expect(arc?.args.slice(0, 2)).toEqual([50, 60])
    const rect = calls.find((c) => c.name === 'fillRect')
    const r = pinRadiusPx(0.2, true, 'hook')
    const [x = 0, y = 0, w = 0, h = 0] = (rect?.args ?? []) as number[]
    expect(x + w / 2).toBeCloseTo(50)
    expect(y).toBeCloseTo(60 - HOOK.shankUp * r)
    expect(y + h).toBeCloseTo(60)
  })

  it('a lite dome pin draws no shank', () => {
    const { ctx, calls } = recordingContext()
    createPinSprites(1).draw(ctx, { x: 5, y: 5 }, 0.2, { lite: true })
    expect(calls.filter((c) => c.name === 'fillRect')).toEqual([])
  })
})

describe('drawStrand on a long thread', () => {
  /** A context over a 400 × 300 canvas drawn at `dpr`, recording its stripes. */
  const onCanvas = (clip: boolean) => {
    const r = recordingContext()
    if (clip) {
      ;(r.ctx as unknown as { canvas: unknown }).canvas = { width: 800, height: 600 }
      ;(r.ctx as unknown as { getTransform: unknown }).getTransform = () => ({
        a: 2,
        b: 0,
        c: 0,
        d: 2,
        e: 0,
        f: 0,
      })
    }
    return r
  }
  // 100,000 px across, through the canvas in the middle: as a thread between clusters at 2×.
  const pts = Array.from({ length: 2001 }, (_, i) => ({ x: -50_000 + i * 50, y: 150 }))
  const stripes = (calls: { name: string; args: unknown[] }[]) =>
    calls.filter((c) => c.name === 'moveTo').map((c) => c.args as number[])

  it('traces only the stripes on or near the canvas, and those exactly as before', () => {
    const all = onCanvas(false)
    const cut = onCanvas(true)
    drawStrand(all.ctx, pts, { color: '#2E4B7A', zoom: 2 })
    drawStrand(cut.ctx, pts, { color: '#2E4B7A', zoom: 2 })
    const near = (p: number[]) => (p[0] as number) > -5 && (p[0] as number) < 405
    expect(stripes(cut.calls).length).toBeLessThan(stripes(all.calls).length / 50)
    // The same stripes, but for the float drift of adding the period 1,000 times over (1e-9 px).
    const round = (ps: number[][]) => ps.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6))
    expect(round(stripes(cut.calls).filter(near))).toEqual(round(stripes(all.calls).filter(near)))
  })
})
