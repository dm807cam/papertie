import { loadavg } from 'node:os'
import { expect, type Page, test } from '@playwright/test'
import { PALETTE } from '../packages/core/src/palette'
import type { Cam, Pt } from './hooks'

/**
 * The far-zoom picture pyramid: on a board of more than 5,000
 * notes, overview is drawn from raster tiles a worker renders, not from 100,000 cards a frame.
 * It must look like the card overview, show an edit in the very next frame with no ghost, and
 * hold the frame rate far out. Timings are asserted in a quiet window only (load1 < 4); the load is logged with every result.
 */

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const QUIET = 4

/**
 * How alike the pyramid and the card overview must look (`difference`): a mean under 8 of 255 a
 * channel (resampling softens every edge and thread a little; measured 2.6–5.4) and under 2% of
 * pixels off by more than 64 (measured 0.5–0.75%).
 */
const TOLERANCE = { mean: 8, off: 0.02 }

interface PyramidStats {
  ready: boolean
  on: boolean
  tiles: number
  inFlight: number
  renders: number
  redraws: number
  cards: number
  last: { level: number; tiles: number; fallback: number; missing: number; patched: number } | null
}

type Debug = {
  pyramid(): PyramidStats | null
  setPyramidAbove(n: number): void
  holdPyramid(on: boolean): void
}

const debug = (page: Page) =>
  page.evaluate(() => (window.__papertie.debug as unknown as Debug).pyramid())

async function open(page: Page, board: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=${board}`)
  await page.waitForFunction(() => window.__papertie?.ready === true, undefined, {
    timeout: 120_000,
  })
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const setCamera = async (page: Page, c: Cam) => {
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), c)
  await idle(page)
}

/** The camera at `zoom` with world point `w` at the viewport centre. */
const centredOn = (w: Pt, zoom: number): Cam => ({
  x: w.x - VIEW.width / 2 / zoom,
  y: w.y - VIEW.height / 2 / zoom,
  zoom,
})

/** Wait until the pyramid draws the view from its own level's tiles, all fresh. */
async function settled(page: Page) {
  await page.waitForFunction(
    () => {
      const p = (window.__papertie.debug as unknown as Debug).pyramid()
      const l = p?.last
      return (
        p?.on === true &&
        p.inFlight === 0 &&
        l != null &&
        l.fallback === 0 &&
        l.missing === 0 &&
        l.patched === 0
      )
    },
    undefined,
    { timeout: 60_000, polling: 100 },
  )
  await idle(page)
}

/**
 * The yarn and pin layers composited over a flat cork-brown (the cork's texture is the same
 * either way and would only blur the comparison), at the device scale, kept in the page under
 * `slot`: a frame's pixels stay there (shipping millions of numbers out took ~20 s a frame, and
 * the whole test's time). False when a layer is missing.
 */
const layers = (page: Page, slot: 'cards' | 'tiles') =>
  page.evaluate((slot) => {
    const yarn = document.querySelector<HTMLCanvasElement>('canvas.yarn-layer')
    const pins = document.querySelector<HTMLCanvasElement>('canvas.pin-layer')
    if (!yarn || !pins) return false
    const c = new OffscreenCanvas(yarn.width, yarn.height)
    const ctx = c.getContext('2d')
    if (!ctx) return false
    ctx.fillStyle = '#9a6a3c'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(yarn, 0, 0)
    ctx.drawImage(pins, 0, 0)
    const w = window as unknown as { __layers?: Record<string, Uint8ClampedArray> }
    w.__layers ??= {}
    w.__layers[slot] = ctx.getImageData(0, 0, c.width, c.height).data
    return true
  }, slot)

/**
 * How far apart the two kept frames are, as RGB (computed in the page): mean |Δ| per channel, and
 * the share of pixels off by > 64.
 */
const difference = (page: Page) =>
  page.evaluate(() => {
    const kept = (window as unknown as { __layers: Record<string, Uint8ClampedArray> }).__layers
    const a = kept.cards as Uint8ClampedArray
    const b = kept.tiles as Uint8ClampedArray
    let sum = 0
    let off = 0
    const n = Math.min(a.length, b.length) / 4
    for (let i = 0; i < n * 4; i += 4) {
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0))
        sum += d
        worst = Math.max(worst, d)
      }
      if (worst > 64) off++
    }
    // A frame of another size differs everywhere it does not overlap.
    if (a.length !== b.length) return { mean: 255, off: 1 }
    return { mean: sum / (n * 3), off: off / n }
  })

test('overview on 100,000 notes draws from the pyramid; at 5,000 the card overview', async ({
  page,
}) => {
  test.setTimeout(180_000)
  let errors = await open(page, 'lifetime')
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(100_000)
  // Fit-all frames the whole lifetime board, far out (the zoom floor is under its fit).
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  const fit = await page.evaluate(() => window.__papertie.debug.camera())
  const rect = await page.evaluate(() => window.__papertie.debug.notesRect())
  expect(rect).not.toBeNull()
  expect(fit.zoom).toBeLessThan(0.01)
  expect(fit.x).toBeLessThanOrEqual(rect?.x ?? 0)
  expect(fit.y).toBeLessThanOrEqual(rect?.y ?? 0)
  await page.waitForFunction(
    () => (window.__papertie.debug as unknown as Debug).pyramid()?.on === true,
    undefined,
    { timeout: 60_000 },
  )
  await settled(page)
  const p = await debug(page)
  expect(p?.cards).toBe(100_000)
  expect(p?.last?.tiles).toBeGreaterThan(0)
  await page.keyboard.press('Backquote')
  await expect(page.locator('[data-hud="notes"]')).toHaveText(/^\d+ tiles \/ 100000$/)
  expect(errors).toEqual([])

  errors = await open(page, '5000')
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  expect(await debug(page)).toBeNull()
  expect(errors).toEqual([])
})

test('at 5,000 notes the pyramid looks like the card overview it stands in for', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors = await open(page, '5000')
  const centre = await page.evaluate(() => {
    const r = window.__papertie.debug.notesRect()
    return r === null ? { x: 0, y: 0 } : { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  })
  const results: string[] = []
  // A level's own reference zoom (0.0318), mid-level (0.1, 0.0405) and the far end of a level
  // (0.0455: drawn from tiles rastered at 0.09, its details shown 1.4× their reference size).
  for (const zoom of [0.0318, 0.1, 0.0405, 0.0455]) {
    await page.evaluate(() => (window.__papertie.debug as unknown as Debug).setPyramidAbove(5000))
    await setCamera(page, centredOn(centre, zoom))
    expect((await debug(page))?.on ?? false).toBe(false)
    const cards = await layers(page, 'cards')
    await page.evaluate(() => (window.__papertie.debug as unknown as Debug).setPyramidAbove(1000))
    await page.waitForFunction(
      () => (window.__papertie.debug as unknown as Debug).pyramid()?.on === true,
      undefined,
      { timeout: 60_000 },
    )
    await settled(page)
    const tiles = await layers(page, 'tiles')
    expect(cards).toBe(true)
    expect(tiles).toBe(true)
    const d = await difference(page)
    results.push(`${zoom}: mean ${d.mean.toFixed(2)}, off ${(d.off * 100).toFixed(2)}%`)
    // Raster resampling softens edges, and a level's screen-size details (shadow, pin, thread
    // width) are within √2 of the card overview's: edge pixels may differ, the mean barely moves.
    expect.soft(d.mean).toBeLessThan(TOLERANCE.mean)
    expect.soft(d.off).toBeLessThan(TOLERANCE.off)
  }
  test.info().annotations.push({ type: 'look', description: results.join('; ') })
  console.info(`canvas-pyramid look: ${results.join('; ')}`)
  expect(errors).toEqual([])
})

/** A pixel of the composited layers at viewport point `p`, `#rrggbb`, or null if not opaque. */
const pixelAt = (page: Page, pts: Pt[]) =>
  page.evaluate((pts) => {
    const yarn = document.querySelector<HTMLCanvasElement>('canvas.yarn-layer')
    const ctx = yarn?.getContext('2d')
    if (!yarn || !ctx) return []
    const k = yarn.width / yarn.clientWidth
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    return pts.map((p) => {
      const d = ctx.getImageData(Math.floor(p.x * k), Math.floor(p.y * k), 1, 1).data
      return d[3] === 255 ? `#${hex(d[0] ?? 0)}${hex(d[1] ?? 0)}${hex(d[2] ?? 0)}` : null
    })
  }, pts)

test('pyramid redraws touched tiles only, no ghosts: a move, a recolour and a delete show in the next frame', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const errors = await open(page, 'lifetime')
  await page.waitForFunction(
    () => (window.__papertie.debug as unknown as Debug).pyramid()?.ready === true,
    undefined,
    { timeout: 60_000 },
  )
  // A note near the grid's left edge with no thread, which moves out onto the bare cork.
  const pick = await page.evaluate(() => {
    const m = window.__papertie
    const topo = (m.runtime as unknown as { topology: { yarnsOf: Map<string, unknown> } }).topology
    for (const [id, n] of m.store.getState().notes as unknown as Map<
      string,
      { x: number; y: number; w: number; h: number; paper: string; style: string }
    >) {
      if (n.style === 'print' || n.x > 1500 || n.y < 20_000) continue
      if ((topo.yarnsOf.get(id) as Set<string> | undefined)?.size) continue
      return { id, x: n.x, y: n.y, w: n.w, h: n.h, paper: n.paper }
    }
    return null
  })
  expect(pick).not.toBeNull()
  if (pick === null) return
  const to = { x: pick.x - 9000, y: pick.y }
  const zoom = 0.03
  await setCamera(page, centredOn({ x: pick.x - 3000, y: pick.y + pick.h / 2 }, zoom))
  await settled(page)
  const dc = await page.evaluate(() => window.__papertie.runtime.drawnCamera())
  /** Points inside the inner part of a world rect, in viewport px. */
  const inner = (x: number, y: number): Pt[] =>
    [
      [0.5, 0.5],
      [0.3, 0.4],
      [0.7, 0.4],
      [0.3, 0.7],
      [0.7, 0.7],
    ].map(([fx, fy]) => ({
      x: (x + pick.w * (fx as number) - dc.x) * dc.zoom,
      y: (y + pick.h * (fy as number) - dc.y) * dc.zoom,
    }))
  const oldSpot = inner(pick.x, pick.y)
  const newSpot = inner(to.x, to.y)
  const paper = (t: string) => PALETTE[t as keyof typeof PALETTE].paper.toLowerCase()
  expect(await pixelAt(page, oldSpot)).toContain(paper(pick.paper))
  expect(await pixelAt(page, newSpot)).toEqual(newSpot.map(() => null))
  const rendersBefore = (await debug(page))?.redraws ?? 0
  const visible = (await debug(page))?.last?.tiles ?? 0

  /** Commit `ops` and read the given points in the frame that draws the commit. */
  const commitAndRead = (ops: unknown[], pts: Pt[][]) =>
    page.evaluate(
      ({ ops, pts }) =>
        new Promise<Array<Array<string | null>>>((resolve) => {
          const store = window.__papertie.store as unknown as { commit(ops: unknown[]): void }
          store.commit(ops)
          // The runtime asked for its frame as the store changed: this callback runs after it.
          requestAnimationFrame(() => {
            const yarn = document.querySelector<HTMLCanvasElement>('canvas.yarn-layer')
            const ctx = yarn?.getContext('2d')
            if (!yarn || !ctx) return resolve([])
            const k = yarn.width / yarn.clientWidth
            const hex = (v: number) => v.toString(16).padStart(2, '0')
            resolve(
              pts.map((spot) =>
                spot.map((p) => {
                  const d = ctx.getImageData(Math.floor(p.x * k), Math.floor(p.y * k), 1, 1).data
                  return d[3] === 255
                    ? `#${hex(d[0] ?? 0)}${hex(d[1] ?? 0)}${hex(d[2] ?? 0)}`
                    : null
                }),
              ),
            )
          })
        }),
      { ops, pts },
    )

  // Moved far: the old spot is bare in the very next frame and the new one has the card.
  const [oldAfter, newAfter] = await commitAndRead(
    [{ op: 'note.update', id: pick.id, set: { x: to.x, y: to.y } }],
    [oldSpot, newSpot],
  )
  expect(oldAfter).not.toContain(paper(pick.paper))
  expect(newAfter).toEqual(newSpot.map(() => paper(pick.paper)))
  await settled(page)
  const rendersAfter = (await debug(page))?.redraws ?? 0
  // Only the tiles under the old and the new rect are drawn again: one or two each.
  test.info().annotations.push({
    type: 'tiles',
    description: `${rendersAfter - rendersBefore} tiles drawn again of ${visible} in view`,
  })
  expect(rendersAfter - rendersBefore).toBeGreaterThan(0)
  expect(rendersAfter - rendersBefore).toBeLessThanOrEqual(4)
  expect(await pixelAt(page, oldSpot)).not.toContain(paper(pick.paper))
  expect(await pixelAt(page, newSpot)).toEqual(newSpot.map(() => paper(pick.paper)))

  // Recoloured: the new paper in the next frame.
  const other = pick.paper === 'rose' ? 'sage' : 'rose'
  const [recoloured] = await commitAndRead(
    [{ op: 'note.update', id: pick.id, set: { paper: other } }],
    [newSpot],
  )
  expect(recoloured).toEqual(newSpot.map(() => paper(other)))
  await settled(page)

  // Deleted: gone in the next frame, and gone once its tiles are back.
  const [deleted] = await commitAndRead([{ op: 'note.delete', id: pick.id }], [newSpot])
  expect(deleted).toEqual(newSpot.map(() => null))
  await settled(page)
  expect(await pixelAt(page, newSpot)).toEqual(newSpot.map(() => null))
  expect(errors).toEqual([])
})

test('a move that lands while its tiles are on their way leaves no ghost once they are back', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const errors = await open(page, 'lifetime')
  await page.waitForFunction(
    () => (window.__papertie.debug as unknown as Debug).pyramid()?.ready === true,
    undefined,
    { timeout: 60_000 },
  )
  const pick = await page.evaluate(() => {
    const m = window.__papertie
    const topo = (m.runtime as unknown as { topology: { yarnsOf: Map<string, unknown> } }).topology
    for (const [id, n] of m.store.getState().notes as unknown as Map<
      string,
      { x: number; y: number; w: number; h: number; paper: string; style: string }
    >) {
      if (n.style === 'print' || n.x > 1500 || n.y < 40_000) continue
      if ((topo.yarnsOf.get(id) as Set<string> | undefined)?.size) continue
      return { id, x: n.x, y: n.y, w: n.w, h: n.h, paper: n.paper }
    }
    return null
  })
  expect(pick).not.toBeNull()
  if (pick === null) return
  // Made large and lifted first, so both its spots are many px wide far out.
  const big = { w: 2000, h: 1600 }
  await page.evaluate(
    ({ id, big }) =>
      (window.__papertie.store as unknown as { commit(ops: unknown[]): void }).commit([
        { op: 'note.update', id, set: { ...big, z: 10_000_000 } },
      ]),
    { id: pick.id, big },
  )
  // Taken by the pyramid (sent to its worker) before the camera moves.
  await idle(page)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const small = { w: pick.w, h: pick.h }
  pick.w = big.w
  pick.h = big.h
  const to = { x: pick.x - 30_000, y: pick.y }
  // The camera goes there and asks for its tiles; the worker is slow (its replies are held), so
  // the note moves before any comes back, drawn at the version before the move.
  const cam = centredOn({ x: pick.x + pick.w / 2, y: pick.y + pick.h / 2 }, 0.008)
  const inFlight = await page.evaluate(
    ({ cam, id, to }) =>
      new Promise<number>((resolve) => {
        const debug = window.__papertie.debug as unknown as Debug
        debug.holdPyramid(true)
        window.__papertie.debug.setCamera(cam)
        requestAnimationFrame(() => {
          const p = debug.pyramid()
          const store = window.__papertie.store as unknown as { commit(ops: unknown[]): void }
          store.commit([{ op: 'note.update', id, set: { x: to.x, y: to.y } }])
          // The move is sent to the worker in the next frame; then the replies come.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              debug.holdPyramid(false)
              resolve(p?.inFlight ?? 0)
            }),
          )
        })
      }),
    { cam, id: pick.id, to },
  )
  expect(inFlight).toBeGreaterThan(0)
  await settled(page)
  const dc = await page.evaluate(() => window.__papertie.runtime.drawnCamera())
  const inner = (x: number, y: number, size = big): Pt[] =>
    [
      [0.5, 0.5],
      [0.3, 0.4],
      [0.7, 0.4],
      [0.3, 0.7],
      [0.7, 0.7],
    ].map(([fx, fy]) => ({
      x: (x + size.w * (fx as number) - dc.x) * dc.zoom,
      y: (y + size.h * (fy as number) - dc.y) * dc.zoom,
    }))
  const paper = PALETTE[pick.paper as keyof typeof PALETTE].paper.toLowerCase()
  // Neither the note as it was when its tiles were asked for (small) nor as it was moved (large)
  // is left at the old spot.
  expect(await pixelAt(page, inner(pick.x, pick.y, small).slice(0, 1))).not.toContain(paper)
  expect(await pixelAt(page, inner(pick.x, pick.y))).not.toContain(paper)
  expect(await pixelAt(page, inner(to.x, to.y))).toEqual(inner(to.x, to.y).map(() => paper))
  expect(errors).toEqual([])
})

test('far zoom on 100,000 notes: pan and zoom at 0.03 and 0.01 hold 55 fps, fit-all never stalls', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const errors = await open(page, 'lifetime')
  await page.waitForFunction(
    () => (window.__papertie.debug as unknown as Debug).pyramid()?.ready === true,
    undefined,
    { timeout: 60_000 },
  )
  const load = loadavg()[0] ?? Number.NaN
  const quiet = load < QUIET
  const rows: string[] = [`load1 ${load.toFixed(2)}`]
  const centre = { x: 54_000, y: 47_000 }
  for (const zoom of [0.03, 0.01]) {
    await setCamera(page, centredOn(centre, zoom))
    await settled(page)
    const pan = await page.evaluate(() => window.__papertiePerf.runGesture('pan', 3000))
    await idle(page)
    await setCamera(page, centredOn(centre, zoom))
    await settled(page)
    const zoomed = await page.evaluate(
      (z) => window.__papertiePerf.runGesture('zoom', 3000, { zoomMin: z / 1.5, zoomMax: z * 1.5 }),
      zoom,
    )
    await idle(page)
    rows.push(
      `${zoom}: pan ${pan.fps.toFixed(1)} fps (p95 ${pan.p95FrameMs.toFixed(1)}, max ${pan.maxFrameMs.toFixed(1)} ms), ` +
        `zoom ${zoomed.fps.toFixed(1)} fps (p95 ${zoomed.p95FrameMs.toFixed(1)}, max ${zoomed.maxFrameMs.toFixed(1)} ms)`,
    )
    if (quiet) {
      expect(pan.fps).toBeGreaterThanOrEqual(55)
      expect(zoomed.fps).toBeGreaterThanOrEqual(55)
    }
  }

  // Fit-all from reading zoom: rAF gaps through the jump and the frames after it.
  const id = await page.evaluate(() => [...window.__papertie.store.getState().notes.keys()][50_000])
  expect(
    await page.evaluate((id) => window.__papertie.debug.focusCamera(id as string, 1), id),
  ).toBe(true)
  await idle(page)
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('full')
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[] }
    w.__gaps = []
    let prev: number | null = null
    const tick = (t: number) => {
      if (prev !== null) w.__gaps.push(t - prev)
      prev = t
      if (w.__gaps.length < 120) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.keyboard.press('Shift+Digit1')
  await page.waitForFunction(() => (window as unknown as { __gaps: number[] }).__gaps.length >= 120)
  const gaps = await page.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps)
  const slow = gaps.filter((g) => g > 50)
  rows.push(
    `fit-all: max frame ${Math.max(...gaps).toFixed(1)} ms; over 50 ms: ${JSON.stringify(slow.map((g) => Math.round(g)))}`,
  )
  if (slow.length > 0) console.warn(`pyramid fit-all: frames over 50 ms ${JSON.stringify(slow)}`)
  test.info().annotations.push({ type: 'far zoom', description: rows.join('; ') })
  console.info(`canvas-pyramid: ${rows.join('; ')}`)
  expect(Math.max(...gaps)).toBeLessThan(1000)
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  expect(errors).toEqual([])
})

test('a pour of remote commits in overview on 100,000 notes: no long task over 50 ms', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const errors = await open(page, 'lifetime')
  await page.waitForFunction(
    () => (window.__papertie.debug as unknown as Debug).pyramid()?.ready === true,
    undefined,
    { timeout: 60_000 },
  )
  await setCamera(page, centredOn({ x: 20_000, y: 20_000 }, 0.03))
  await settled(page)
  const load = loadavg()[0] ?? Number.NaN
  const out = await page.evaluate(async () => {
    const long: number[] = []
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) long.push(e.duration)
    })
    po.observe({ type: 'longtask', buffered: false })
    const notes = [...window.__papertie.store.getState().notes.values()] as unknown as Array<{
      id: string
      x: number
      y: number
    }>
    const frames: number[] = []
    const now = new Date().toISOString()
    for (let round = 0; round < 40; round++) {
      // The board is full (100,000): three of its notes go for each three poured in.
      const ops: unknown[] = []
      for (let k = 0; k < 3; k++) {
        const gone = notes[notes.length - 1 - (round * 3 + k)]
        if (gone !== undefined) ops.push({ op: 'note.delete', id: gone.id })
      }
      for (let k = 0; k < 3; k++) {
        const id = `note_01JBPY${String(round * 3 + k).padStart(20, '0')}`
        ops.push({
          op: 'note.create',
          note: {
            type: 'note',
            id,
            x: 8000 + k * 300,
            y: 12_000 + round * 250,
            w: 240,
            h: 160,
            z: 300_000 + round * 3 + k,
            paper: 'rose',
            style: 'rustic',
            text: `pour ${round}`,
            image: null,
            createdAt: now,
            updatedAt: now,
          },
        })
      }
      // And one of the board's notes moved, as an edit elsewhere would.
      const n = notes[(round * 7919) % notes.length]
      if (n !== undefined) ops.push({ op: 'note.update', id: n.id, set: { x: n.x + 40 } })
      const cost = await window.__papertiePerf.remoteCommit(ops)
      frames.push(cost.eventMs + cost.frameMs)
      await new Promise((r) => setTimeout(r, 150))
    }
    await new Promise((r) => setTimeout(r, 500))
    po.disconnect()
    return { long, frames }
  })
  const worst = Math.max(...out.frames)
  test.info().annotations.push({
    type: 'pour',
    description: `load1 ${load.toFixed(2)}; long tasks ${JSON.stringify(out.long.map(Math.round))}; worst commit+frame ${worst.toFixed(1)} ms`,
  })
  console.info(
    `canvas-pyramid pour: load1 ${load.toFixed(2)}; long tasks ${JSON.stringify(out.long.map(Math.round))}; worst commit+frame ${worst.toFixed(1)} ms`,
  )
  if (load < QUIET) expect(out.long.filter((d) => d > 50)).toEqual([])
  expect(errors).toEqual([])
})
