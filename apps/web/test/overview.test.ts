import { type BoardState, PALETTE } from '@papertie/core'
import { benchBoard } from '@papertie/tools/gen-board'
import { boardFrames, createAttach, type SegmentRef, topologyOf } from '../src/canvas/attach'
import { type Camera, screenMapper } from '../src/canvas/Camera'
import { noteBounds, pinPosition } from '../src/canvas/geometry'
import { type PaperShape, paperBounds } from '../src/canvas/layering'
import {
  type CardPaint,
  cardFill,
  cardPaints,
  cardShape,
  drawCards,
  drawThreads,
  OVERVIEW,
  overviewPinRadius,
  overviewYarnAlpha,
  overviewYarnWidth,
} from '../src/canvas/overview'
import { rectsIntersect } from '../src/canvas/types'
import { STATIC_MARGIN, type YarnFrameInput, YarnRenderer } from '../src/canvas/YarnRenderer'
import { bezierBounds, restSagPoint, segmentBezier } from '../src/canvas/yarnGeometry'
import { noteRotationDeg } from '../src/lib/seed'
import { type RecordedCall, recordingContext } from './helpers/recordingContext'

const count = (calls: RecordedCall[], name: string) => calls.filter((c) => c.name === name).length

describe('overview primitives', () => {
  const shape: PaperShape = {
    rect: { x: 0, y: 0, w: 200, h: 150 },
    pivot: { x: 100, y: 14 },
    deg: 0,
  }
  const id = (p: { x: number; y: number }) => p

  it('fills a card with its palette paper, or a print with white stock and its image tone', () => {
    expect(cardFill({ paper: 'indigo', style: 'rustic' })).toBe(PALETTE.indigo.paper)
    expect(cardFill({ paper: 'ink', style: 'smooth' })).toBe(PALETTE.ink.paper)
    expect(cardFill({ paper: 'indigo', style: 'print' })).toBe(OVERVIEW.printStock)
    const print = { paper: 'apricot', style: 'print', text: 'x' } as const
    const [paper, image] = cardPaints(print, cardShape(print, shape), id, '#123456')
    expect(paper?.fill).toBe(OVERVIEW.printStock)
    expect(image?.fill).toBe('#123456')
    // Inside the 12 px border, above the caption band.
    expect(image?.corners).toEqual([
      { x: 12, y: 12 },
      { x: 188, y: 12 },
      { x: 188, y: 150 - 12 - OVERVIEW.printCaptionWorld },
      { x: 12, y: 150 - 12 - OVERVIEW.printCaptionWorld },
    ])
    const fibre = { paper: 'apricot', style: 'rustic', text: '' } as const
    expect(cardPaints(fibre, cardShape(fibre, shape), id)).toHaveLength(1)
  })

  it('turns the card with the note about its pin', () => {
    const n = { paper: 'cream', style: 'rustic', text: '' } as const
    const [p] = cardPaints(n, cardShape(n, { ...shape, deg: 90 }), id)
    // The top-left corner turned 90° clockwise about (100, 14).
    expect(p?.corners[0]?.x).toBeCloseTo(114, 9)
    expect(p?.corners[0]?.y).toBeCloseTo(-86, 9)
  })

  /** A 10 px square card at (x, y) in `fill`, optionally with a print's inner paint. */
  const square = (x: number, y: number, fill: string, inner?: string): CardPaint[] => {
    const sq = (x0: number, y0: number, w: number) => [
      { x: x0, y: y0 },
      { x: x0 + w, y: y0 },
      { x: x0 + w, y: y0 + w },
      { x: x0, y: y0 + w },
    ]
    const paper = { fill, corners: sq(x, y, 10) }
    return inner === undefined ? [paper] : [paper, { fill: inner, corners: sq(x + 2, y + 2, 6) }]
  }
  const fillOrder = (sets: { prop: string; value: unknown }[]) =>
    sets.filter((s) => s.prop === 'fillStyle').map((s) => s.value)

  it('batches cards that overlap nothing by colour: shadows, papers, then print images', () => {
    const { ctx, calls, sets } = recordingContext()
    const cards = [
      square(0, 0, '#a'),
      square(20, 0, '#b', '#i'),
      square(40, 0, '#a'),
      square(60, 0, '#b'),
    ]
    expect(drawCards(ctx, cards)).toBe(4)
    expect(count(calls, 'fill')).toBe(4)
    expect(fillOrder(sets)).toEqual([OVERVIEW.shadow, '#a', '#b', '#i'])
    expect(drawCards(ctx, [])).toBe(0)
  })

  it('builds fill paths without closePath, which Chrome makes quadratic in subpaths', () => {
    const { ctx, calls } = recordingContext()
    const cards = Array.from({ length: 50 }, (_, k) => square(20 * k, 0, k % 2 ? '#a' : '#b'))
    drawCards(ctx, cards)
    expect(count(calls, 'closePath')).toBe(0)
    expect(count(calls, 'moveTo')).toBe(100)
    expect(count(calls, 'lineTo')).toBe(300)
  })

  it('keeps z order where cards overlap: each overlap starts a new level, shadow and all', () => {
    const { ctx, sets } = recordingContext()
    // b overlaps a, c overlaps b; d overlaps nothing and joins the first level.
    const cards = [
      square(0, 0, '#a'),
      square(5, 5, '#b'),
      square(12, 12, '#a'),
      square(50, 0, '#b'),
    ]
    expect(drawCards(ctx, cards)).toBe(7)
    expect(fillOrder(sets)).toEqual([
      OVERVIEW.shadow,
      '#a',
      '#b',
      OVERVIEW.shadow,
      '#b',
      OVERVIEW.shadow,
      '#a',
    ])
  })

  it('counts a card touching only another card shadow as overlapping it', () => {
    const { ctx, sets } = recordingContext()
    // 10.5 px to the right of a 10 px card: clear of the paper, inside its shadow's reach.
    expect(drawCards(ctx, [square(0, 0, '#a'), square(10.5, 0, '#a')])).toBe(4)
    expect(fillOrder(sets)).toEqual([OVERVIEW.shadow, '#a', OVERVIEW.shadow, '#a'])
  })

  it('strokes threads once per dye, without shadowBlur or filter', () => {
    const { ctx, calls, sets } = recordingContext()
    const c = segmentBezier({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 4 })
    const t = (color: string) => ({ curve: c, color, alpha: 1, width: 1 })
    expect(drawThreads(ctx, [t('#a'), t('#b'), t('#a'), t('#a'), t('#b')])).toBe(2)
    expect(count(calls, 'stroke')).toBe(2)
    expect(count(calls, 'bezierCurveTo')).toBe(5)
    expect(sets.some((s) => s.prop === 'shadowBlur' || s.prop === 'filter')).toBe(false)
  })

  it('fades threads toward the bottom of the zoom range, so the cards read through', () => {
    expect(overviewYarnAlpha(0.02)).toBeCloseTo(OVERVIEW.yarnAlphaAtMin, 12)
    expect(overviewYarnAlpha(0.15)).toBe(1)
    expect(overviewYarnAlpha(0.3)).toBe(1)
    expect(overviewYarnAlpha(0.01)).toBeCloseTo(OVERVIEW.yarnAlphaAtMin, 12)
    let prev = 0
    for (let z = 0.02; z <= 0.15; z *= 1.05) {
      const a = overviewYarnAlpha(z)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
  })

  it('sizes pins and threads from world size, meeting lite at the threshold', () => {
    expect(overviewPinRadius(0.02)).toBe(0.75)
    expect(overviewPinRadius(0.15)).toBe(1.5)
    expect(overviewYarnWidth(0.02)).toBe(1)
    expect(overviewYarnWidth(0.15)).toBe(1.5)
    expect(overviewYarnWidth(Number.NaN)).toBe(1.5)
  })
})

interface Fake {
  canvas: HTMLCanvasElement
  calls: RecordedCall[]
  sets: { prop: string; value: unknown }[]
}

function fakeCanvas(): Fake {
  const { ctx, calls, sets } = recordingContext()
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return { canvas: canvas as unknown as HTMLCanvasElement, calls, sets }
}

const endsFor = (state: BoardState) => {
  const attach = createAttach(topologyOf(state), boardFrames(state.notes, { rotation: true }))
  return (ref: SegmentRef) => attach.ends(ref)
}

describe('YarnRenderer in overview', () => {
  const state = benchBoard(1000)
  const viewport = { width: 800, height: 600 }
  // Zoom 0.1 towards the board's far corner: the static area covers part of it.
  const camera: Camera = { x: 6000, y: 5000, zoom: 0.1 }
  const shapeOf = (id: string): (PaperShape & { z: number }) | undefined => {
    const n = state.notes.get(id)
    if (n === undefined) return undefined
    return { rect: noteBounds(n), pivot: pinPosition(n), deg: noteRotationDeg(n), z: n.z }
  }
  const ends = endsFor(state)
  const allSegments = [...state.yarns.keys()].flatMap((y) => [
    ...(topologyOf(state).byYarn.get(y) ?? []),
  ])
  const byZ = [...state.notes.values()].sort((a, b) => a.z - b.z).map((n) => n.id)
  /** The static layer's world area: the viewport plus `STATIC_MARGIN` of it on every side. */
  const area = {
    x: camera.x - (STATIC_MARGIN * viewport.width) / camera.zoom,
    y: camera.y - (STATIC_MARGIN * viewport.height) / camera.zoom,
    w: ((1 + 2 * STATIC_MARGIN) * viewport.width) / camera.zoom,
    h: ((1 + 2 * STATIC_MARGIN) * viewport.height) / camera.zoom,
  }
  const inArea = byZ.filter((id) => {
    const s = shapeOf(id)
    return s !== undefined && rectsIntersect(paperBounds(s), area)
  })
  const segsInArea = allSegments.filter((ref) => {
    const e = ends(ref)
    if (e === undefined) return false
    return rectsIntersect(bezierBounds(segmentBezier(e.a, e.b, restSagPoint(e.a, e.b))), area)
  })

  function setup(over: Partial<YarnFrameInput> = {}) {
    const yarn = fakeCanvas()
    const pins = fakeCanvas()
    const made: Fake[] = []
    const r = new YarnRenderer(yarn.canvas, pins.canvas, () => {
      const f = fakeCanvas()
      made.push(f)
      return f.canvas
    })
    r.resize(viewport, 1)
    const input: YarnFrameInput = {
      state,
      camera,
      viewport,
      dpr: 1,
      lod: 'overview',
      // Deliberately unculled: the renderer culls to its static area itself.
      segments: allSegments,
      visibleNotes: byZ,
      pinOf: (id) => {
        const n = state.notes.get(id)
        return n && pinPosition(n)
      },
      endsOf: ends,
      sagOf: (_ref, a, b) => restSagPoint(a, b),
      dynamicKeys: new Set(),
      dynamicNotes: new Set(),
      paperOf: shapeOf,
      ...over,
    }
    const [staticYarn, staticPins] = made as [Fake, Fake]
    return { r, input, yarn, pins, staticYarn, staticPins }
  }

  it('draws only the cards, threads and pins inside its static area', () => {
    expect(inArea.length).toBeGreaterThan(20)
    expect(inArea.length).toBeLessThan(state.notes.size / 2)
    const { r, input, staticYarn, staticPins } = setup()
    const stats = r.render(input)
    expect(stats.staticRedrawn).toBe(true)
    expect(stats.cards).toBe(inArea.length)
    expect(stats.pins).toBe(inArea.length)
    expect(stats.segmentsStatic).toBe(segsInArea.length)
    expect(count(staticPins.calls, 'arc')).toBe(inArea.length)
    expect(count(staticYarn.calls, 'bezierCurveTo')).toBe(segsInArea.length)
    // Cards and threads only: no sprites, no images, no twist stripes.
    expect(count(staticYarn.calls, 'drawImage') + count(staticPins.calls, 'drawImage')).toBe(0)
    const map = screenMapper(camera, 1)
    for (const call of staticPins.calls.filter((c) => c.name === 'arc')) {
      const [x, y] = call.args as [number, number]
      expect(x).toBeGreaterThan(-STATIC_MARGIN * viewport.width - 40)
      expect(x).toBeLessThan((1 + STATIC_MARGIN) * viewport.width + 40)
      expect(y).toBeGreaterThan(-STATIC_MARGIN * viewport.height - 40)
      expect(y).toBeLessThan((1 + STATIC_MARGIN) * viewport.height + 40)
    }
    // The first card's pin sits where the camera maps it.
    const first = state.notes.get(inArea[0] as string)
    const p = map(pinPosition(first as NonNullable<typeof first>))
    const [x0, y0] = (staticPins.calls.find((c) => c.name === 'arc')?.args ?? []) as number[]
    expect([x0, y0]).toEqual([p.x, p.y])
  })

  it('fills cards in palette colours and prints in their measured tone', () => {
    const { r, input, staticYarn } = setup({ toneOf: () => '#123456' })
    r.render(input)
    const fills = new Set(staticYarn.sets.filter((s) => s.prop === 'fillStyle').map((s) => s.value))
    const papers = new Set(inArea.map((id) => cardFill(state.notes.get(id) as never)))
    for (const f of papers) expect(fills.has(f)).toBe(true)
    expect(inArea.some((id) => state.notes.get(id)?.style === 'print')).toBe(true)
    expect(fills.has('#123456')).toBe(true)
  })

  it('blits while panning inside the margin and redraws on a zoom', () => {
    const { r, input } = setup()
    r.render(input)
    const pan = { ...camera, x: camera.x + 100 / camera.zoom }
    expect(r.render({ ...input, camera: pan }).staticRedrawn).toBe(false)
    expect(r.render({ ...input, camera: { ...pan, zoom: 0.06 } }).staticRedrawn).toBe(true)
  })

  it('redraws when the level changes to or from overview', () => {
    const { r, input } = setup()
    r.render(input)
    expect(r.render({ ...input, lod: 'lite' }).staticRedrawn).toBe(true)
    expect(r.render(input).staticRedrawn).toBe(true)
  })

  it('draws a dragged card and its threads on top every frame, not in the cache', () => {
    const id = inArea[Math.floor(inArea.length / 2)] as string
    const touching = segsInArea.filter((s) => s.aNoteId === id || s.bNoteId === id)
    const { r, input, yarn, pins, staticPins } = setup({ dynamicNotes: new Set([id]) })
    const stats = r.render(input)
    expect(count(staticPins.calls, 'arc')).toBe(inArea.length - 1)
    expect(stats.segmentsDynamic).toBe(touching.length)
    expect(count(yarn.calls, 'bezierCurveTo')).toBe(touching.length)
    expect(count(pins.calls, 'arc')).toBe(1)
    const fill = cardFill(state.notes.get(id) as never)
    expect(yarn.sets.some((s) => s.prop === 'fillStyle' && s.value === fill)).toBe(true)
  })

  it('caches world geometry under the geometry key: a redraw reads no paper or ends again', () => {
    let reads = 0
    const counted = {
      paperOf: (id: string) => {
        reads++
        return shapeOf(id)
      },
      endsOf: (ref: SegmentRef) => {
        reads++
        return ends(ref)
      },
    }
    const key = {}
    const { r, input } = setup({ ...counted, geometryKey: key })
    r.render(input)
    expect(reads).toBeGreaterThan(inArea.length)
    reads = 0
    // A zoom redraws the static layer, from the cached geometry.
    expect(r.render({ ...input, camera: { ...camera, zoom: 0.11 } }).staticRedrawn).toBe(true)
    expect(reads).toBe(0)
    // A new key (the board, an override, a height or the tilt changed) reads them afresh.
    r.render({ ...input, geometryKey: {} })
    expect(reads).toBeGreaterThan(inArea.length)
  })

  it('draws the same picture from cached geometry as without it', () => {
    const z = { ...camera, zoom: 0.11 }
    const plain = setup()
    plain.r.render({ ...plain.input, camera: z })
    const cached = setup({ geometryKey: {} })
    cached.r.render(cached.input)
    cached.staticYarn.calls.length = 0
    cached.staticPins.calls.length = 0
    cached.r.render({ ...cached.input, camera: z })
    expect(cached.staticYarn.calls).toEqual(plain.staticYarn.calls)
    expect(cached.staticPins.calls).toEqual(plain.staticPins.calls)
  })

  it('outlines the selection and the hovered card over the cache, without redrawing it', () => {
    const [a, b] = inArea as [string, string]
    const { r, input, pins } = setup()
    r.render(input)
    pins.sets.length = 0
    const stats = r.render({ ...input, selectedNotes: new Set([a]), hoverNoteId: b })
    expect(stats.staticRedrawn).toBe(false)
    const strokes = pins.sets.filter((s) => s.prop === 'strokeStyle').map((s) => s.value)
    expect(strokes).toEqual([OVERVIEW.selected, OVERVIEW.hover])
  })
})
