/**
 * The far-zoom picture pyramid: its levels reach the zoom
 * floor 2× apart; a commit re-sends only what changed and redraws exactly the tiles its notes
 * touched, old rect and new, drawing the change over the stale tile until then; what is drawn
 * live is left out of the tiles; and the worker paints a tile as the card overview paints.
 */
import type { Note, PMap } from '@papertie/core'
import { generateBoard } from '@papertie/tools/gen-board'
import { ZOOM_MIN } from '../../src/canvas/Camera'
import { LOD } from '../../src/canvas/lod'
import {
  LEVELS,
  levelFor,
  levelScale,
  reachWorld,
  TILE_PX,
  tileKey,
  tileRange,
  tileRect,
  tileWorld,
} from '../../src/canvas/pyramid/levels'
import {
  createPyramid,
  frameBox,
  type NoteFrame,
  PATCH_CARDS,
  PATCH_RECTS,
  type Pyramid,
  type PyramidSource,
  type SegFrame,
  segRec,
} from '../../src/canvas/pyramid/pyramid'
import {
  type CardRec,
  type PyramidReply,
  type PyramidRequest,
  serve,
  tileCanvas,
} from '../../src/canvas/pyramid/worker'
import { SpatialIndex } from '../../src/canvas/spatialIndex'
import type { Rect } from '../../src/canvas/types'
import { recordingContext } from '../helpers/recordingContext'

describe('pyramid levels', () => {
  it('start where overview ends and reach the zoom floor, 2× apart', () => {
    expect(levelScale(0)).toBe(LOD.overview.exitAtOrAbove)
    expect(levelScale(1)).toBeCloseTo(levelScale(0) / 2, 12)
    // The last level's range (scale / 2, scale] holds the floor.
    expect(levelScale(LEVELS - 1)).toBeGreaterThanOrEqual(ZOOM_MIN)
    expect(levelScale(LEVELS - 1) / 2).toBeLessThan(ZOOM_MIN)
    expect(levelFor(ZOOM_MIN)).toBe(LEVELS - 1)
  })

  it('draw a zoom from the coarsest level rastered at or above it, never enlarged', () => {
    for (let k = 0; k < LEVELS; k++) {
      const s = levelScale(k)
      expect(levelFor(s)).toBe(k)
      expect(levelFor(s * 0.51)).toBe(k)
      if (k + 1 < LEVELS) expect(levelFor(s * 0.49)).toBe(k + 1)
    }
    for (let z = ZOOM_MIN; z < LOD.overview.exitAtOrAbove; z *= 1.07) {
      const s = levelScale(levelFor(z))
      expect(s).toBeGreaterThanOrEqual(z * (1 - 1e-9))
      expect(s).toBeLessThan(z * 2)
    }
    expect(levelFor(Number.NaN)).toBe(0)
  })

  it('tile the world in squares of TILE_PX device px at the level scale', () => {
    expect(tileWorld(0, 1) * levelScale(0)).toBeCloseTo(TILE_PX, 9)
    expect(tileWorld(2, 2)).toBeCloseTo(tileWorld(2, 1) / 2, 9)
    const w = tileWorld(1, 1)
    expect(tileRange(1, 1, { x: -1, y: 0, w: w, h: 0.5 })).toEqual({
      tx0: -1,
      tx1: 0,
      ty0: 0,
      ty1: 0,
    })
    expect(tileRect({ k: 1, tx: -1, ty: 2 }, 1)).toEqual({ x: -w, y: 2 * w, w, h: w })
  })
})

/** A note frame on a 400 × 300 grid, as the runtime makes them. */
function frame(id: string, x: number, y: number, over: Partial<NoteFrame> = {}): NoteFrame {
  return {
    id,
    x,
    y,
    w: 240,
    h: 160,
    z: 1,
    paper: 'cream',
    style: 'rustic',
    tag: false,
    deg: 0,
    pin: { x: x + 120, y: y + 12 },
    caption: false,
    asset: null,
    tone: null,
    ...over,
  }
}

const bitmap = () =>
  ({ width: TILE_PX, height: TILE_PX, close: () => {} }) as unknown as ImageBitmap

/**
 * A pyramid on a fake worker: every request is kept (`sent`) and answered by hand (`answer`),
 * the first build runs when `build` is called, and the source is a plain map. Like the worker,
 * it takes messages in order: a tile is drawn at the version of the last change sent before it
 * was asked for, whenever it is answered.
 */
function harness(notes: NoteFrame[], segs: SegFrame[] = []) {
  const board = new Map(notes.map((n) => [n.id, n]))
  const segments = new Map(segs.map((s) => [s.key, s]))
  const sent: PyramidRequest[] = []
  /** The version the worker is at when it takes each message in `sent`. */
  const at = new Map<PyramidRequest, number>()
  let v = 0
  const port = {
    onmessage: null as ((e: MessageEvent<PyramidReply>) => void) | null,
    postMessage(m: PyramidRequest) {
      sent.push(m)
      if (m.t === 'put') v = m.v
      at.set(m, v)
    },
  }
  const slices: Array<(d: { timeRemaining(): number }) => void> = []
  const meets = (a: Rect, b: Rect) =>
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  const source: PyramidSource = {
    note: (id) => board.get(id),
    segment: (key) => segments.get(key),
    notesIn: (r) => {
      queried.notes++
      const ids = [...board.values()].filter((n) => meets(frameBox(n), r)).map((n) => n.id)
      queried.found += ids.length
      return ids
    },
    segmentsIn: (r) =>
      [...segments.values()]
        .filter((sg) => {
          const c = segRec(sg).p
          const xs = [c[0], c[2], c[4], c[6]] as number[]
          const ys = [c[1], c[3], c[5], c[7]] as number[]
          const box = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            w: Math.max(...xs) - Math.min(...xs),
            h: Math.max(...ys) - Math.min(...ys),
          }
          return meets(box, r)
        })
        .map((sg) => sg.key),
  }
  /** Index queries the patch made, and the notes they found. */
  const queried = { notes: 0, found: 0 }
  let changes = 0
  const pyramid = createPyramid(board.values(), segments.values(), {
    source,
    dpr: 1,
    port,
    onChange: () => changes++,
    schedule: (slice) => {
      slices.push(slice)
      return () => {}
    },
  })
  const reply = (m: PyramidReply) => port.onmessage?.({ data: m } as MessageEvent<PyramidReply>)
  /**
   * Answer every request still open, in order, each at the version the worker had taken it at.
   * The coarsest level is rastered as the worker does: every tile a card is on.
   */
  const answer = (count = Number.POSITIVE_INFINITY): string[] => {
    const keys: string[] = []
    for (const m of sent.splice(0, count)) {
      const mv = at.get(m) ?? v
      at.delete(m)
      if (m.t === 'tile') {
        keys.push(tileKey(m.k, m.tx, m.ty))
        reply({ ...m, v: mv, bitmap: bitmap(), tones: [] })
      } else if (m.t === 'base') {
        const base = new Map<string, { tx: number; ty: number }>()
        for (const n of board.values()) {
          const g = tileRange(m.k, m.dpr, frameBox(n))
          for (let tx = g.tx0; tx <= g.tx1; tx++) {
            for (let ty = g.ty0; ty <= g.ty1; ty++) base.set(`${tx}/${ty}`, { tx, ty })
          }
        }
        const gen = (m as { gen?: number }).gen ?? 0
        for (const t of base.values()) {
          const id = -(gen + 1)
          reply({ t: 'tile', id, k: m.k, ...t, dpr: m.dpr, v: mv, bitmap: bitmap(), tones: [] })
        }
        reply({ t: 'base', k: m.k, dpr: m.dpr, v: mv, count: base.size, gen } as PyramidReply)
      }
    }
    return keys
  }
  const runSlices = () => {
    while (slices.length > 0) slices.shift()?.({ timeRemaining: () => 1000 })
  }
  const build = () => {
    runSlices()
    answer()
  }
  return {
    board,
    segments,
    sent,
    pyramid,
    answer,
    build,
    runSlices,
    queried,
    changes: () => changes,
  }
}

const view = (x: number, y: number, zoom: number) => ({
  camera: { x, y, zoom },
  anchor: { x: 0, y: 0 },
  dpr: 1,
  viewport: { width: 1280, height: 720 },
})

/** Draw until the pyramid asks for nothing more; returns every tile asked for meanwhile. */
function drawUntilQuiet(
  h: ReturnType<typeof harness>,
  v: ReturnType<typeof view>,
): { asked: Set<string>; last: ReturnType<Pyramid['draw']> } {
  const asked = new Set<string>()
  for (let i = 0; i < 500; i++) {
    const last = h.pyramid.draw(recordingContext().ctx, v)
    const keys = h.answer()
    for (const k of keys) asked.add(k)
    if (keys.length === 0) return { asked, last }
  }
  throw new Error('the pyramid kept asking')
}

describe('createPyramid', () => {
  // A 60 × 40 grid of notes, 400 × 300 apart: 24,000 × 12,000 world px.
  const grid = () => {
    const out: NoteFrame[] = []
    for (let r = 0; r < 40; r++) {
      for (let c = 0; c < 60; c++) out.push(frame(`n${r}-${c}`, c * 400, r * 300))
    }
    return out
  }

  it('builds in slices, then keeps its coarsest level whole before it is ready', () => {
    const h = harness(grid())
    expect(h.pyramid.ready).toBe(false)
    h.runSlices()
    const puts = h.sent.filter((m) => m.t === 'put')
    expect(puts.flatMap((m) => (m.t === 'put' ? m.cards : [])).length).toBe(2400)
    expect(h.sent.some((m) => m.t === 'base')).toBe(true)
    expect(h.pyramid.ready).toBe(false)
    h.answer()
    expect(h.pyramid.ready).toBe(true)
    expect(h.pyramid.stats().cards).toBe(2400)
  })

  it('a commit invalidates only the tiles its notes touch, old and new rects', () => {
    const h = harness(grid())
    h.build()
    const zoom = 0.06
    const k = levelFor(zoom)
    const at = view(0, 0, zoom)
    const before = drawUntilQuiet(h, at)
    expect(before.last.missing + before.last.fallback).toBe(0)
    expect(before.asked.size).toBeGreaterThan(8)

    // Move one note far, within the view.
    const moved = h.board.get('n5-5') as NoteFrame
    const oldBox = frameBox(moved)
    const next = frame(moved.id, 16_000, 9_000)
    h.board.set(moved.id, next)
    h.pyramid.changed([moved.id], [])
    const put = h.sent.filter((m) => m.t === 'put')
    expect(put).toHaveLength(1)
    const p = put[0] as Extract<PyramidRequest, { t: 'put' }>
    expect(p.cards.map((c: CardRec) => c.id)).toEqual([moved.id])
    expect(p.drop).toEqual([])
    h.sent.length = 0

    // Until its tiles are back, the old and new rects are drawn over them from the source.
    const stale = h.pyramid.draw(recordingContext().ctx, at)
    expect(stale.patched).toBeGreaterThanOrEqual(2)
    const { asked, last } = drawUntilQuiet(h, at)
    expect(last.patched).toBe(0)

    const touching = new Set<string>()
    const seen = { x: 0, y: 0, w: 1280 / zoom, h: 720 / zoom }
    const inView = tileRange(k, 1, seen)
    for (const box of [oldBox, frameBox(next)]) {
      const reach = reachWorld(k)
      const g = tileRange(k, 1, {
        x: box.x - reach,
        y: box.y - reach,
        w: box.w + 2 * reach,
        h: box.h + 2 * reach,
      })
      for (let tx = g.tx0; tx <= g.tx1; tx++) {
        for (let ty = g.ty0; ty <= g.ty1; ty++) {
          if (tx < inView.tx0 || tx > inView.tx1 || ty < inView.ty0 || ty > inView.ty1) continue
          touching.add(tileKey(k, tx, ty))
        }
      }
    }
    expect(touching.size).toBeGreaterThanOrEqual(2)
    expect([...asked].sort()).toEqual([...touching].sort())
    expect(h.pyramid.stats().redraws).toBe(touching.size)
  })

  it('a delete drops the card and stales its rect; a change to nothing drawn stales nothing', () => {
    const h = harness(grid())
    h.build()
    const at = view(0, 0, 0.06)
    drawUntilQuiet(h, at)
    h.board.delete('n1-1')
    h.pyramid.changed(['n1-1', 'not-a-note'], [])
    const put = h.sent.find((m) => m.t === 'put') as Extract<PyramidRequest, { t: 'put' }>
    expect(put.drop).toEqual(['n1-1'])
    expect(put.cards).toEqual([])
    h.sent.length = 0
    expect(drawUntilQuiet(h, at).asked.size).toBeGreaterThan(0)
    h.pyramid.changed(['not-a-note'], [])
    expect(h.sent).toEqual([])
    expect(drawUntilQuiet(h, at).asked.size).toBe(0)
  })

  it('leaves what is drawn live out of the tiles, and takes it back after', () => {
    const seg: SegFrame = { key: 'y1#0', a: { x: 120, y: 12 }, b: { x: 520, y: 12 }, color: '#a33' }
    const h = harness(grid(), [seg])
    h.build()
    h.sent.length = 0
    h.pyramid.setHidden(new Set(['n0-0']), new Set(['y1#0']))
    const hide = h.sent.find((m) => m.t === 'put') as Extract<PyramidRequest, { t: 'put' }>
    expect(hide.drop).toEqual(['n0-0'])
    expect(hide.dropSegs).toEqual(['y1#0'])
    h.sent.length = 0
    // While hidden, a change to it is not sent: it is drawn live.
    h.pyramid.changed(['n0-0'], ['y1#0'])
    expect(h.sent).toEqual([])
    h.pyramid.setHidden(new Set(), new Set())
    const back = h.sent.find((m) => m.t === 'put') as Extract<PyramidRequest, { t: 'put' }>
    expect(back.cards.map((c) => c.id)).toEqual(['n0-0'])
    expect(back.segs.map((s) => s.key)).toEqual(['y1#0'])
  })

  it('redraws the prints of an asset once its tone is known', () => {
    const notes = [
      frame('p1', 0, 0, { style: 'print', asset: 'asset_A' }),
      frame('p2', 400, 0, { style: 'print', asset: 'asset_A' }),
      frame('n3', 800, 0),
    ]
    const h = harness(notes)
    h.build()
    h.sent.length = 0
    for (const id of ['p1', 'p2']) {
      h.board.set(id, { ...(h.board.get(id) as NoteFrame), tone: '#123456' })
    }
    h.pyramid.retone('asset_A')
    const put = h.sent.find((m) => m.t === 'put') as Extract<PyramidRequest, { t: 'put' }>
    expect(put.cards.map((c) => [c.id, c.tone])).toEqual([
      ['p1', '#123456'],
      ['p2', '#123456'],
    ])
  })

  it('after a worker failure it is never ready (overview falls back to the cards)', () => {
    const h = harness(grid())
    h.build()
    expect(h.pyramid.ready).toBe(true)
    // A send that throws puts the worker down.
    const failing = harness(grid())
    ;(failing.sent as unknown as { push: () => never }).push = () => {
      throw new Error('gone')
    }
    failing.build()
    expect(failing.pyramid.ready).toBe(false)
  })
})

describe('createPyramid under changes the worker has not seen yet', () => {
  const grid = (cols = 60, rows = 40) => {
    const out: NoteFrame[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out.push(frame(`n${r}-${c}`, c * 400, r * 300))
    }
    return out
  }

  it('a tile asked before a commit and answered after it is drawn over, then asked again', () => {
    const h = harness(grid())
    h.build()
    const zoom = 0.06
    const k = levelFor(zoom)
    const at = view(0, 0, zoom)
    // The first frame asks for two tiles; the commit lands before the worker answers them.
    h.pyramid.draw(recordingContext().ctx, at)
    const asked = h.sent.flatMap((m) => (m.t === 'tile' ? [m] : []))
    expect(asked).toHaveLength(2)
    const first = asked[0] as Extract<PyramidRequest, { t: 'tile' }>
    const r = tileRect(first, 1)
    // A note inside that tile moves away, out of it.
    const inside = [...h.board.values()].find((n) => {
      const b = frameBox(n)
      return b.x > r.x + 2000 && b.y > r.y + 2000 && b.x + b.w < r.x + r.w - 2000
    }) as NoteFrame
    expect(inside).toBeDefined()
    h.board.set(inside.id, frame(inside.id, -20_000, -20_000))
    h.pyramid.changed([inside.id], [])
    // The worker answers both at the version before the move.
    h.answer()
    const next = h.pyramid.draw(recordingContext().ctx, at)
    expect(next.patched).toBeGreaterThan(0)
    const again = drawUntilQuiet(h, at)
    expect(again.asked.has(tileKey(k, first.tx, first.ty))).toBe(true)
    expect(again.last.patched).toBe(0)
    expect(h.pyramid.stats().redraws).toBeGreaterThanOrEqual(1)
  })

  it('a commit while the coarsest level is being rastered stales that level too', () => {
    const h = harness(grid())
    h.runSlices()
    // The base request is out; a note moves before the worker takes it in.
    const moved = h.board.get('n10-10') as NoteFrame
    h.board.set(moved.id, frame(moved.id, 30_000, 30_000))
    h.pyramid.changed([moved.id], [])
    // Answered as the worker would: the base before the move (it was asked first).
    const sent = [...h.sent]
    h.sent.length = 0
    h.sent.push(...sent.filter((m) => m.t === 'base'))
    h.answer()
    expect(h.pyramid.ready).toBe(true)
    // Far out, where nothing else is cached, the base is drawn, with the move over it.
    const far = view(-20_000, -20_000, 0.006)
    const drawn = h.pyramid.draw(recordingContext().ctx, far)
    expect(drawn.fallback + drawn.tiles).toBeGreaterThan(0)
    expect(drawn.patched).toBeGreaterThan(0)
  })

  it('a DPR flip and back with tiles on their way never keeps their stale picture', () => {
    const h = harness(grid())
    h.build()
    const zoom = 0.06
    const at = view(0, 0, zoom)
    // Two tiles asked at DPR 1, not answered yet.
    h.pyramid.draw(recordingContext().ctx, at)
    const first = h.sent.find((m) => m.t === 'tile') as Extract<PyramidRequest, { t: 'tile' }>
    expect(first).toBeDefined()
    const r = tileRect(first, 1)
    const inside = [...h.board.values()].find((n) => {
      const b = frameBox(n)
      return b.x > r.x + 2000 && b.y > r.y + 2000 && b.x + b.w < r.x + r.w - 2000
    }) as NoteFrame
    h.board.set(inside.id, frame(inside.id, -20_000, -20_000))
    h.pyramid.changed([inside.id], [])
    // The screen changes DPR and back, looking elsewhere: every tile is let go twice.
    const away = view(200_000, 200_000, zoom)
    h.pyramid.draw(recordingContext().ctx, { ...away, dpr: 2 })
    h.pyramid.draw(recordingContext().ctx, away)
    // The worker answers everything in order, the first tiles at the version before the move.
    drawUntilQuiet(h, away)
    // Back where the tiles were: the first one is asked again (or drawn over), never kept stale.
    const back = drawUntilQuiet(h, at)
    expect(back.asked.has(tileKey(first.k, first.tx, first.ty))).toBe(true)
    expect(back.last.patched).toBe(0)
  })

  it('a base raster from before a DPR flip and back does not stand for the new one', () => {
    const h = harness(grid())
    h.runSlices()
    // The first base raster (DPR 1) is out; the DPR goes to 2 and back: two more are asked.
    h.pyramid.draw(recordingContext().ctx, { ...view(0, 0, 0.006), dpr: 2 })
    h.pyramid.draw(recordingContext().ctx, view(0, 0, 0.006))
    const bases = h.sent.filter((m) => m.t === 'base')
    expect(bases).toHaveLength(3)
    // A note moves before the worker takes any of them.
    const moved = h.board.get('n10-10') as NoteFrame
    h.board.set(moved.id, frame(moved.id, 30_000, 30_000))
    h.pyramid.changed([moved.id], [])
    // Only the first (old) raster comes back: the pyramid is not ready on it.
    const firstBase = h.sent.findIndex((m) => m.t === 'base')
    h.answer(firstBase + 1)
    expect(h.pyramid.ready).toBe(false)
    expect(h.pyramid.stats().tiles).toBe(0)
    // The rest, in order: ready on the last raster only. It was asked before the move too, so
    // the move is drawn over it.
    h.answer()
    expect(h.pyramid.ready).toBe(true)
    const drawn = h.pyramid.draw(recordingContext().ctx, view(-20_000, -20_000, 0.006))
    expect(drawn.fallback + drawn.tiles).toBeGreaterThan(0)
    expect(drawn.patched).toBeGreaterThan(0)
  })

  it('a tile answered after thousands of changes on it is taken in work bounded by its cap, stale to the last', () => {
    const h = harness(grid())
    h.build()
    const zoom = 0.06
    const at = view(0, 0, zoom)
    // A tile asked; then 4,000 changes on it (an opening's slices, a note at a time) before the
    // worker answers.
    h.pyramid.draw(recordingContext().ctx, at)
    const first = h.sent.find((m) => m.t === 'tile') as Extract<PyramidRequest, { t: 'tile' }>
    const r = tileRect(first, 1)
    const inside = [...h.board.values()].filter((n) => {
      const b = frameBox(n)
      return b.x > r.x + 2000 && b.y > r.y + 2000 && b.x + b.w < r.x + r.w - 2000
    })
    expect(inside.length).toBeGreaterThan(10)
    for (let i = 0; i < 4000; i++) {
      const n = inside[i % inside.length] as NoteFrame
      h.board.set(n.id, frame(n.id, n.x + (i % 7) - 3, n.y))
      h.pyramid.changed([n.id], [])
    }
    // Every rect compare the reply makes, counted: a few per change, never one per pair.
    const before = h.pyramid.stats().compared
    h.answer(1)
    const compared = h.pyramid.stats().compared - before
    expect(compared).toBeLessThan(4000 * 20)
    // Stale whole since the last change on it: asked again, and drawn clean.
    const again = drawUntilQuiet(h, at)
    expect(again.asked.has(tileKey(first.k, first.tx, first.ty))).toBe(true)
    expect(again.last.patched).toBe(0)
  })

  it('20,000 changes in view keep the patch of each frame bounded', () => {
    const h = harness(grid(200, 100))
    h.build()
    const at = view(0, 0, 0.02)
    drawUntilQuiet(h, at)
    const ids = [...h.board.keys()]
    for (const id of ids) {
      const n = h.board.get(id) as NoteFrame
      h.board.set(id, { ...n, x: n.x + 37 })
    }
    for (let i = 0; i < ids.length; i += 1000) h.pyramid.changed(ids.slice(i, i + 1000), [])
    h.sent.length = 0
    for (let f = 0; f < 5; f++) {
      h.queried.notes = 0
      h.queried.found = 0
      const d = h.pyramid.draw(recordingContext().ctx, at)
      expect(d.patched).toBeLessThanOrEqual(PATCH_RECTS)
      expect(h.queried.notes).toBeLessThanOrEqual(PATCH_RECTS)
      expect(h.queried.found).toBeLessThanOrEqual(PATCH_CARDS + 64)
      h.answer()
    }
    expect(drawUntilQuiet(h, at).last.patched).toBe(0)
  })

  it('a 50,000 px thread stales the tiles along its curve, and its patch stays small', () => {
    const notes = grid(150, 60)
    const seg: SegFrame = {
      key: 'long#0',
      a: { x: 200, y: 200 },
      b: { x: 50_000, y: 17_000 },
      color: '#a33',
    }
    const h = harness(notes, [seg])
    h.build()
    const zoom = 0.02
    const at = view(0, 0, zoom)
    drawUntilQuiet(h, at)
    const before = h.pyramid.stats().redraws
    h.segments.set(seg.key, { ...seg, color: '#3a3' })
    h.queried.found = 0
    h.pyramid.changed([], [seg.key])
    h.pyramid.draw(recordingContext().ctx, at)
    // The patch looks only along the curve: far fewer notes than the hull's 17,000 × 50,000.
    expect(h.queried.found).toBeLessThan(800)
    drawUntilQuiet(h, at)
    const k = levelFor(zoom)
    const g = tileRange(k, 1, { x: 0, y: 0, w: 1280 / zoom, h: 720 / zoom })
    const inView = (g.tx1 - g.tx0 + 1) * (g.ty1 - g.ty0 + 1)
    const redrawn = h.pyramid.stats().redraws - before
    expect(redrawn).toBeGreaterThan(0)
    // Not every tile under the hull: a thread crosses a diagonal of them.
    expect(redrawn).toBeLessThan(inView)
  })
})

describe('the pyramid worker', () => {
  const rec = (id: string, x: number, y: number, z: number, fill: string): CardRec => ({
    id,
    z,
    corners: [x, y, x + 240, y, x + 240, y + 160, x, y + 160],
    image: null,
    pin: [x + 120, y + 12],
    fill,
    tone: null,
    asset: null,
    box: [x, y, x + 240, y + 160],
  })

  function worker() {
    const replies: PyramidReply[] = []
    const draws = recordingContext()
    const port = {
      onmessage: null as ((e: MessageEvent<PyramidRequest>) => void) | null,
      postMessage: (m: PyramidReply) => replies.push(m),
    }
    const state = serve(port, () => ({ ctx: draws.ctx, take: bitmap }))
    const send = (m: PyramidRequest) =>
      port.onmessage?.({ data: m } as MessageEvent<PyramidRequest>)
    return { replies, draws, state, send }
  }

  it('paints a tile its cards in paint order and its threads over them; nothing on it, no bitmap', () => {
    const w = worker()
    w.send({
      t: 'put',
      v: 3,
      cards: [rec('b', 100, 100, 2, '#bbbbbb'), rec('a', 200, 150, 1, '#aaaaaa')],
      drop: [],
      segs: [{ key: 's', p: [220, 112, 300, 200, 400, 200, 420, 112], color: '#ff0000' }],
      dropSegs: [],
    })
    expect(w.state.size).toEqual({ cards: 2, segs: 1 })
    w.send({ t: 'tile', id: 7, k: 0, tx: 0, ty: 0, dpr: 1 })
    const r = w.replies[0] as Extract<PyramidReply, { t: 'tile' }>
    expect(r).toMatchObject({ t: 'tile', id: 7, k: 0, tx: 0, ty: 0, v: 3 })
    expect(r.bitmap).not.toBeNull()
    // Overlapping cards: 'a' (z 1) is painted on a level below 'b' (z 2).
    const fills = w.draws.sets.filter((s) => s.prop === 'fillStyle').map((s) => s.value)
    expect(fills.indexOf('#aaaaaa')).toBeLessThan(fills.indexOf('#bbbbbb'))
    const strokes = w.draws.calls.filter((c) => c.name === 'stroke')
    expect(strokes).toHaveLength(1)
    const lastFill = w.draws.calls.map((c) => c.name).lastIndexOf('fill')
    const stroke = w.draws.calls.map((c) => c.name).lastIndexOf('stroke')
    // The pins come last, over the threads.
    expect(lastFill).toBeGreaterThan(stroke)

    w.send({ t: 'tile', id: 8, k: 0, tx: 40, ty: 40, dpr: 1 })
    expect((w.replies[1] as Extract<PyramidReply, { t: 'tile' }>).bitmap).toBeNull()
  })

  it('rasters its tiles on the CPU, in the worker, never on the GPU’s main thread', () => {
    // Drawn on a GPU canvas, the coarsest level of 100,000 notes (paths of thousands of cards a
    // fill) was 60–90 ms of raster on the GPU's main thread, and the page's frames waited behind
    // it: a key typed then was shown 64–96 ms late. A CPU canvas rasters in the
    // worker's own thread; the page only uploads the finished tile.
    const asked: unknown[] = []
    const was = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas
    ;(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext(kind: string, options?: unknown) {
        asked.push([kind, options])
        return {}
      }
      transferToImageBitmap() {
        return {}
      }
    }
    try {
      tileCanvas()
    } finally {
      ;(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = was
    }
    expect(asked).toEqual([['2d', { willReadFrequently: true }]])
  })

  it('without a 2D context it says so, rather than answer every tile empty', () => {
    const replies: PyramidReply[] = []
    const port = {
      onmessage: null as ((e: MessageEvent<PyramidRequest>) => void) | null,
      postMessage: (m: PyramidReply) => replies.push(m),
    }
    serve(port, () => ({ ctx: null, take: bitmap }))
    const send = (m: PyramidRequest) =>
      port.onmessage?.({ data: m } as MessageEvent<PyramidRequest>)
    send({
      t: 'put',
      v: 1,
      cards: [rec('a', 10, 10, 1, '#aaaaaa')],
      drop: [],
      segs: [],
      dropSegs: [],
    })
    send({ t: 'tile', id: 1, k: 0, tx: 0, ty: 0, dpr: 1 })
    expect(replies.at(-1)).toMatchObject({ t: 'error' })
  })

  it('rasters the coarsest level whole when it is small, or says it is too large', () => {
    const w = worker()
    const far = tileWorld(LEVELS - 1, 1)
    w.send({
      t: 'put',
      v: 1,
      // Each in the middle of its tile, clear of the tile's edges by more than the reach.
      cards: [rec('a', far / 2, far / 2, 1, '#aaaaaa'), rec('b', far * 3.5, far / 2, 1, '#bbbbbb')],
      drop: [],
      segs: [],
      dropSegs: [],
    })
    w.send({ t: 'base', k: LEVELS - 1, dpr: 1, max: 24, gen: 1 })
    const tiles = w.replies.filter((r) => r.t === 'tile')
    expect(tiles).toHaveLength(2)
    // Its tiles name the raster they belong to.
    expect(tiles.map((r) => (r.t === 'tile' ? r.id : 0))).toEqual([-2, -2])
    expect(w.replies.at(-1)).toMatchObject({ t: 'base', count: 2, gen: 1 })
    w.send({ t: 'base', k: LEVELS - 1, dpr: 1, max: 1, gen: 2 })
    expect(w.replies.at(-1)).toMatchObject({ t: 'base', count: -1 })
  })
})

describe('the index tells the pyramid what changed', () => {
  it('a single-note move on a 100,000-note board reports that note and its threads only', () => {
    // How long the update takes is the timing row's (`pyramid.timing.test.ts`).
    const s = generateBoard({ notes: 100_000, yarns: 10_000, seed: 4242 })
    const index = new SpatialIndex()
    index.rebuild(s, new Map())
    expect(index.takeChanges().all).toBe(true)
    expect(index.takeChanges()).toEqual({ all: false, notes: new Set(), segments: new Set() })
    const id = [...s.notes.keys()][0] as string
    const n = s.notes.get(id)
    if (n === undefined) throw new Error('no note')
    const moved = { ...s, notes: (s.notes as PMap<string, Note>).set(id, { ...n, x: n.x + 500 }) }
    index.updateNotes(moved, [id], new Map())
    const changes = index.takeChanges()
    expect(changes.all).toBe(false)
    expect([...changes.notes]).toEqual([id])
    // Its threads and its neighbours' (their edge pins face it): a handful, never the board's.
    expect(changes.segments.size).toBeGreaterThan(0)
    expect(changes.segments.size).toBeLessThan(200)
    for (const key of changes.segments) expect(index.segment(key)).toBeDefined()
  }, 60_000)
})
