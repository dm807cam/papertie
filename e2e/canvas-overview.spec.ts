import { expect, type Page, test } from '@playwright/test'
import { ANCHOR_REACH_PX, ZOOM_MIN } from '../apps/web/src/canvas/Camera'
import { LOD } from '../apps/web/src/canvas/lod'
import { FAR_IDS, FAR_ORIGIN } from '../apps/web/src/dev/farBoard'
import { PALETTE } from '../packages/core/src/palette'
import type { Cam, Pt } from './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

/** Paper colours by palette token, as the canvas paints them. */
const PAPER = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, v.paper])) as Record<
  string,
  string
>

async function open(page: Page, board: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=${board}`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await idle(page)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const camera = (page: Page) => page.evaluate(() => window.__papertie.debug.camera())
const lod = (page: Page) => page.evaluate(() => window.__papertie.debug.lod())
const mounted = (page: Page) => page.locator('article.note').count()

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

interface CardSample {
  id: string
  /** Viewport px of the note's rect centre, as drawn. */
  at: Pt
  expected: string
  /** The yarn layer's pixel there, `#rrggbb`, or null when not opaque. */
  got: string | null
}

/**
 * Every on-screen non-print note's centre, as the drawn camera maps it, with the yarn layer's
 * pixel there (or a neighbour's in the paper colour, where a thread crosses the centre). The
 * tilt (at most 5°, about the pin) moves a centre by under 0.2 screen px at overview zooms, so
 * the unturned centre is used.
 */
const sampleCards = (page: Page, paper: Record<string, string>): Promise<CardSample[]> =>
  page.evaluate((paper) => {
    const m = window.__papertie
    const dc = m.runtime.drawnCamera()
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.yarn-layer')
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return []
    const k = canvas.width / canvas.clientWidth
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    const out: CardSample[] = []
    const notes = m.store.getState().notes as unknown as Map<
      string,
      { x: number; y: number; w: number; h: number; paper: string; style: string }
    >
    for (const [id, n] of notes) {
      if (n.style === 'print') continue
      const at = {
        x: (n.x + n.w / 2 - dc.x) * dc.zoom,
        y: (n.y + n.h / 2 - dc.y) * dc.zoom,
      }
      if (at.x < 2 || at.y < 2 || at.x > canvas.clientWidth - 2 || at.y > canvas.clientHeight - 2)
        continue
      const expected = (paper[n.paper] ?? '').toLowerCase()
      const px = (x: number, y: number) => {
        const i = 4 * (Math.floor(y * k) * canvas.width + Math.floor(x * k))
        return img[i + 3] === 255
          ? `#${hex(img[i] ?? 0)}${hex(img[i + 1] ?? 0)}${hex(img[i + 2] ?? 0)}`
          : null
      }
      // The centre pixel, or failing that (a thread crosses it) one of its 8 neighbours.
      let got = px(at.x, at.y)
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        if (got === expected) break
        if (px(at.x + dx / k, at.y + dy / k) === expected) got = expected
      }
      out.push({ id, at, expected, got })
    }
    return out
  }, paper)

const matching = (s: CardSample[]) => s.filter((c) => c.got === c.expected)

/** Opaque pixels of the pin layer in a ring `from`..`to` px outside a viewport rect. */
const ringPixels = (page: Page, r: { x: number; y: number; w: number; h: number }) =>
  page.evaluate((r) => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.pin-layer')
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return 0
    const k = canvas.width / canvas.clientWidth
    const pad = 5
    const x0 = Math.floor((r.x - pad) * k)
    const y0 = Math.floor((r.y - pad) * k)
    const w = Math.ceil((r.w + 2 * pad) * k)
    const h = Math.ceil((r.h + 2 * pad) * k)
    const d = ctx.getImageData(x0, y0, w, h).data
    let n = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Only the ring: outside the rect itself (the pin dot sits inside it).
        const px = x0 + x
        const py = y0 + y
        const inside =
          px >= r.x * k && px < (r.x + r.w) * k && py >= r.y * k && py < (r.y + r.h) * k
        if (!inside && (d[4 * (y * w + x) + 3] ?? 0) > 0) n++
      }
    }
    return n
  }, r)

/** A note's rect on screen, as the drawn camera maps it (unturned). */
const screenRect = (page: Page, id: string) =>
  page.evaluate((id) => {
    const m = window.__papertie
    const dc = m.runtime.drawnCamera()
    const n = m.store.getState().notes.get(id)
    if (n === undefined) return null
    return {
      x: (n.x - dc.x) * dc.zoom,
      y: (n.y - dc.y) * dc.zoom,
      w: n.w * dc.zoom,
      h: n.h * dc.zoom,
    }
  }, id)

test('the 5,000 board opens in overview and zooms to 0.02: no DOM notes, every card drawn', async ({
  page,
}) => {
  const errors = await open(page, '5000')
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(5000)
  expect(await lod(page)).toBe('overview')
  expect(await mounted(page)).toBe(0)
  const fit = await camera(page)
  expect(fit.zoom).toBeGreaterThanOrEqual(ZOOM_MIN)
  expect(fit.zoom).toBeLessThan(0.025)

  // Wheel out to 0.02 (where the whole board still shows).
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, Math.log(fit.zoom / 0.02) / 0.01)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(0.02, 9)
  await idle(page)
  expect(await lod(page)).toBe('overview')
  expect(await mounted(page)).toBe(0)

  const samples = await sampleCards(page, PAPER)
  const hits = matching(samples)
  test.info().annotations.push({
    type: 'cards',
    description: `${hits.length} of ${samples.length} centres in their paper colour at zoom 0.02`,
  })
  // Every note is on screen; a centre can miss only where threads cross it and its neighbours.
  expect(samples.length).toBeGreaterThan(4300)
  expect(hits.length / samples.length).toBeGreaterThan(0.9)

  await page.keyboard.press('Backquote')
  await expect(page.locator('[data-hud="zoom"]')).toHaveText('0.02 overview')
  await expect(page.locator('[data-hud="notes"]')).toHaveText(/^\d+ cards \/ 5000$/)
  expect(errors).toEqual([])
})

test('Shift+1 frames every note of the wide board from full detail, landing in overview', async ({
  page,
}) => {
  const errors = await open(page, '5000')
  const id = await page.evaluate(() => [...window.__papertie.store.getState().notes.keys()][2500])
  expect(
    await page.evaluate((id) => window.__papertie.debug.focusCamera(id as string, 1), id),
  ).toBe(true)
  await idle(page)
  expect(await lod(page)).toBe('full')
  expect(await mounted(page)).toBeGreaterThan(0)

  // rAF intervals through the jump and the first frames after it.
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[] }
    w.__gaps = []
    let prev: number | null = null
    const tick = (t: number) => {
      if (prev !== null) w.__gaps.push(t - prev)
      prev = t
      if (w.__gaps.length < 90) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.keyboard.press('Shift+Digit1')
  await idle(page)
  await page.waitForFunction(() => (window as unknown as { __gaps: number[] }).__gaps.length >= 90)
  const gaps = await page.evaluate(() => (window as unknown as { __gaps: number[] }).__gaps)
  // The world layer, rastered at zoom 1 while it moved, must not be rastered again at 0.02 scale
  // over the whole viewport: overview hides it (that once stalled a frame for 22 s).
  expect(Math.max(...gaps)).toBeLessThan(1000)
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.world') as Element).display,
    ),
  ).toBe('none')
  const c = await camera(page)
  expect(c.zoom).toBeGreaterThanOrEqual(ZOOM_MIN)
  const frame = await page.evaluate(() => {
    const m = window.__papertie
    const r = m.debug.notesRect()
    const dc = m.runtime.drawnCamera()
    if (r === null) return null
    return {
      left: (r.x - dc.x) * dc.zoom,
      top: (r.y - dc.y) * dc.zoom,
      right: (r.x + r.w - dc.x) * dc.zoom,
      bottom: (r.y + r.h - dc.y) * dc.zoom,
    }
  })
  expect(frame).not.toBeNull()
  expect(frame?.left).toBeGreaterThanOrEqual(0)
  expect(frame?.top).toBeGreaterThanOrEqual(0)
  expect(frame?.right).toBeLessThanOrEqual(VIEW.width)
  expect(frame?.bottom).toBeLessThanOrEqual(VIEW.height)
  expect(await lod(page)).toBe('overview')
  expect(await mounted(page)).toBe(0)
  // The jump from zoom 1 to the fit rebased: the anchor is within reach of the new centre.
  const a = await page.evaluate(() => window.__papertie.debug.anchor())
  const centre = { x: c.x + VIEW.width / 2 / c.zoom, y: c.y + VIEW.height / 2 / c.zoom }
  expect(Math.abs(centre.x - a.x)).toBeLessThanOrEqual(ANCHOR_REACH_PX)
  expect(Math.abs(centre.y - a.y)).toBeLessThanOrEqual(ANCHOR_REACH_PX)
  expect(errors).toEqual([])
})

test('a press on a card selects its note, a drag moves it, and both show on the canvas', async ({
  page,
}) => {
  const errors = await open(page, '5000')
  // Zoom 0.1: cards are 18-32 px, big enough to aim at and to check the outline around.
  const mid = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.values()][2550],
  )
  await setCamera(page, centredOn({ x: (mid?.x ?? 0) + 150, y: (mid?.y ?? 0) + 100 }, 0.1))
  expect(await lod(page)).toBe('overview')
  const cards = matching(await sampleCards(page, PAPER))
  // Near the middle, clear of the sidebar and the strip.
  const central = cards.filter(
    (c) => Math.abs(c.at.x - VIEW.width / 2) < 300 && Math.abs(c.at.y - VIEW.height / 2) < 200,
  )
  const target = central[0]
  const other = central.find(
    (c) => target !== undefined && Math.hypot(c.at.x - target.at.x, c.at.y - target.at.y) > 120,
  )
  if (target === undefined || other === undefined) throw new Error('no card to press')
  const rect = await screenRect(page, target.id)
  const otherRect = await screenRect(page, other.id)
  if (rect === null || otherRect === null) throw new Error('no rect')

  const ringBefore = await ringPixels(page, rect)
  await page.mouse.click(target.at.x, target.at.y)
  await idle(page)
  expect(await page.evaluate(() => [...window.__papertie.runtime.selection])).toEqual([target.id])
  expect(await page.locator('.overlay > .selection').isHidden()).toBe(true)
  expect(await ringPixels(page, rect)).toBeGreaterThan(ringBefore + 20)

  // Hover outlines the card under the pointer.
  const hoverBefore = await ringPixels(page, otherRect)
  await page.mouse.move(other.at.x, other.at.y)
  await idle(page)
  expect(await ringPixels(page, otherRect)).toBeGreaterThan(hoverBefore + 20)

  const commits = await page.evaluate(() => window.__papertie.store.commits)
  const before = await page.evaluate(
    (id) => window.__papertie.store.getState().notes.get(id),
    target.id,
  )
  await page.mouse.move(target.at.x, target.at.y)
  await page.mouse.down()
  for (let k = 1; k <= 8; k++) await page.mouse.move(target.at.x + 5 * k, target.at.y + 4 * k)
  await idle(page)
  // Mid-drag the card is drawn at the pointer, over the cache.
  const moving = await page.evaluate(
    ({ x, y }) => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.yarn-layer')
      const d = c?.getContext('2d')?.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
      return d
        ? `#${[...d.slice(0, 3)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
        : null
    },
    { x: target.at.x + 40, y: target.at.y + 32 },
  )
  expect(moving).toBe(target.expected)
  await page.mouse.up()
  await idle(page)
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits + 1)
  const after = await page.evaluate(
    (id) => window.__papertie.store.getState().notes.get(id),
    target.id,
  )
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0) - 400)).toBeLessThanOrEqual(10)
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0) - 320)).toBeLessThanOrEqual(10)
  expect(await mounted(page)).toBe(0)
  expect(errors).toEqual([])
})

test('pins and yarn are not hit-tested in overview; the yarn tool still connects two cards', async ({
  page,
}) => {
  const errors = await open(page, '5000')
  const mid = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.values()][2550],
  )
  await setCamera(page, centredOn({ x: (mid?.x ?? 0) + 150, y: (mid?.y ?? 0) + 100 }, 0.1))
  const cards = matching(await sampleCards(page, PAPER))
  const [a, b] = cards.filter(
    (c) => Math.abs(c.at.x - VIEW.width / 2) < 300 && Math.abs(c.at.y - VIEW.height / 2) < 200,
  )
  if (a === undefined || b === undefined) throw new Error('no cards')
  const pin = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), a.id)
  expect(await page.evaluate((p) => window.__papertie.debug.hitAt(p as Pt), pin)).toEqual({
    kind: 'none',
  })
  await armYarn(page)
  const yarns = await page.evaluate(() => window.__papertie.store.getState().yarns.size)
  await page.mouse.move(a.at.x, a.at.y)
  await page.mouse.down()
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(
      a.at.x + ((b.at.x - a.at.x) * k) / 10,
      a.at.y + ((b.at.y - a.at.y) * k) / 10,
    )
  }
  await page.mouse.up()
  await idle(page)
  const after = await page.evaluate(() => [...window.__papertie.store.getState().yarns.values()])
  expect(after.length).toBe(yarns + 1)
  expect(after.some((y) => y.noteIds.join() === `${a.id},${b.id}`)).toBe(true)
  expect(errors).toEqual([])
})

test('zooming back up mounts DOM notes past the hysteresis gap, and never flickers', async ({
  page,
}) => {
  const errors = await open(page, '5000')
  const mid = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.values()][2550],
  )
  const at = { x: (mid?.x ?? 0) + 150, y: (mid?.y ?? 0) + 100 }
  // Every frame: overview exactly when no note is mounted (the cull rect is never empty here).
  await page.evaluate(() => {
    const w = window as unknown as { __lodLog: string[]; __lodBad: string[] }
    w.__lodLog = []
    w.__lodBad = []
    const tick = () => {
      const l = window.__papertie.debug.lod()
      const n = document.querySelectorAll('article.note').length
      if (w.__lodLog.at(-1) !== l) w.__lodLog.push(l)
      if ((l === 'overview') !== (n === 0)) w.__lodBad.push(`${l} with ${n} notes`)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const step = async (zoom: number) => {
    await setCamera(page, centredOn(at, zoom))
    return { lod: await lod(page), notes: await mounted(page) }
  }
  const { overview, lite } = LOD
  for (const z of [0.1, overview.enterBelow + 0.01, overview.exitAtOrAbove - 0.001]) {
    expect(await step(z)).toEqual({ lod: 'overview', notes: 0 })
  }
  const up = await step(overview.exitAtOrAbove)
  expect(up.lod).toBe('lite')
  expect(up.notes).toBeGreaterThan(100)
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.world') as Element).display,
    ),
  ).toBe('block')
  for (const z of [overview.exitAtOrAbove - 0.01, overview.enterBelow + 0.001]) {
    expect((await step(z)).lod).toBe('lite')
  }
  expect((await step(overview.enterBelow - 0.001)).lod).toBe('overview')

  // Real ctrl+wheel notches from the bottom of the range to full detail.
  await setCamera(page, centredOn(at, ZOOM_MIN))
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2)
  await page.keyboard.down('Control')
  while ((await camera(page)).zoom < lite.exitAtOrAbove + 0.1) {
    await page.mouse.wheel(0, -40)
    await page.waitForTimeout(30)
  }
  await page.keyboard.up('Control')
  await idle(page)
  expect(await lod(page)).toBe('full')
  const near = await page.evaluate(() =>
    window.__papertie.debug.noteAt(window.__papertie.debug.screenToWorld({ x: 640, y: 360 })),
  )
  const log = await page.evaluate(() => (window as unknown as { __lodLog: string[] }).__lodLog)
  expect(log.slice(-3)).toEqual(['overview', 'lite', 'full'])
  expect(await page.evaluate(() => (window as unknown as { __lodBad: string[] }).__lodBad)).toEqual(
    [],
  )
  // Full detail is back: real DOM notes, the one under the centre among them.
  expect(await mounted(page)).toBeGreaterThan(0)
  if (near !== undefined) {
    await expect(page.locator(`article.note[data-note-id="${near}"]`)).toBeVisible()
  }
  expect(errors).toEqual([])
})

test('a scripted pan over the 5,000 board in overview has no frame over 50 ms (dev smoke check)', async ({
  page,
}) => {
  const errors = await open(page, '5000')
  // The pan goes 4 screen px down a frame: start the view's centre a known distance short of
  // the anchor's reach below it (30 frames' travel), so the pan crosses it at any frame rate this
  // test accepts (over 60 frames), 30 fps headless included.
  const a0 = await page.evaluate(() => window.__papertie.debug.anchor())
  const { zoom } = await camera(page)
  const short = (30 * 4) / zoom
  await setCamera(
    page,
    centredOn({ x: a0.x, y: a0.y + ANCHOR_REACH_PX / Math.max(1, zoom) - short }, zoom),
  )
  expect(await page.evaluate(() => window.__papertie.debug.anchor())).toEqual(a0)
  expect(await lod(page)).toBe('overview')
  const snap = await page.evaluate(() => window.__papertiePerf.runGesture('pan', 3000))
  test.info().annotations.push({
    type: 'pan',
    description: `${snap.frames} frames, ${snap.fps.toFixed(1)} fps, p95 ${snap.p95FrameMs.toFixed(1)} ms, max ${snap.maxFrameMs.toFixed(1)} ms`,
  })
  expect(snap.frames).toBeGreaterThan(60)
  // rAF times are vsync-quantised: three missed vsyncs read as 50.0x ms, a frame over 50 as 66.7.
  expect(snap.maxFrameMs).toBeLessThan(51)
  await idle(page)
  // The pan travelled past the anchor's reach: the cards were rebased along the way.
  expect(await page.evaluate(() => window.__papertie.debug.anchor())).not.toEqual(a0)
  expect(await lod(page)).toBe('overview')
  expect(await mounted(page)).toBe(0)
  expect(errors).toEqual([])
})

test('far board: overview cards draw in place at 9.8M, and Shift+1 jumps back and rebases', async ({
  page,
}) => {
  const errors = await open(page, 'far')
  const cluster = { x: FAR_ORIGIN.x + 300, y: FAR_ORIGIN.y + 200 }
  await setCamera(page, centredOn(cluster, 0.1))
  expect(await lod(page)).toBe('overview')
  const near = await sampleCards(page, PAPER)
  expect(near.length).toBe(3)
  expect(matching(near).length).toBeGreaterThanOrEqual(2)

  // Far out at the bottom of the zoom range, two million px away: a rebase there.
  await setCamera(page, centredOn({ x: cluster.x - 2_000_000, y: cluster.y + 1_500_000 }, ZOOM_MIN))
  const away = await page.evaluate(() => window.__papertie.debug.anchor())
  expect(Math.abs(away.x - (cluster.x - 2_000_000))).toBeLessThanOrEqual(ANCHOR_REACH_PX)

  await page.keyboard.press('Shift+Digit1')
  await idle(page)
  const c = await camera(page)
  const a = await page.evaluate(() => window.__papertie.debug.anchor())
  const centre = { x: c.x + VIEW.width / 2 / c.zoom, y: c.y + VIEW.height / 2 / c.zoom }
  const k = Math.max(1, c.zoom)
  expect(Math.abs(centre.x - a.x) * k).toBeLessThanOrEqual(ANCHOR_REACH_PX)
  expect(Math.abs(centre.y - a.y) * k).toBeLessThanOrEqual(ANCHOR_REACH_PX)
  expect(await lod(page)).toBe('full')
  // Every note's DOM box is centred where the drawn camera puts its turned paper.
  const gaps = await page.evaluate(
    (ids) => {
      const m = window.__papertie
      const dc = m.runtime.drawnCamera()
      return ids.map((id) => {
        const el = document.querySelector<HTMLElement>(`article.note[data-note-id="${id}"]`)
        const n = m.store.getState().notes.get(id)
        const pin = m.runtime.pinWorld(id)
        if (el === null || n === undefined || pin === undefined) return Number.POSITIVE_INFINITY
        const deg = Number(/rotate\((-?[\d.e+-]+)deg\)/.exec(el.style.transform)?.[1] ?? 0)
        const t = (deg * Math.PI) / 180
        const dx = n.x + n.w / 2 - pin.x
        const dy = n.y + el.offsetHeight / 2 - pin.y
        const cx = (pin.x + dx * Math.cos(t) - dy * Math.sin(t) - dc.x) * dc.zoom
        const cy = (pin.y + dx * Math.sin(t) + dy * Math.cos(t) - dc.y) * dc.zoom
        const b = el.getBoundingClientRect()
        return Math.max(Math.abs(b.left + b.width / 2 - cx), Math.abs(b.top + b.height / 2 - cy))
      })
    },
    Object.values(FAR_IDS).filter((id) => id.startsWith('note')),
  )
  expect(gaps).toHaveLength(4)
  for (const g of gaps) expect(g).toBeLessThanOrEqual(0.5)
  expect(errors).toEqual([])
})

test('in overview the card under the pointer sets the tool cursor', async ({ page }) => {
  const errors = await open(page, '5000')
  const mid = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.values()][2550],
  )
  await setCamera(page, centredOn({ x: (mid?.x ?? 0) + 150, y: (mid?.y ?? 0) + 100 }, 0.1))
  expect(await lod(page)).toBe('overview')
  const [card] = matching(await sampleCards(page, PAPER)).filter(
    (c) => Math.abs(c.at.x - VIEW.width / 2) < 300 && Math.abs(c.at.y - VIEW.height / 2) < 200,
  )
  if (card === undefined) throw new Error('no card')
  // A cork point near the middle: no card's paper under it.
  const cork = await page.evaluate(() => {
    const d = window.__papertie.debug
    for (let y = 300; y < 420; y += 3) {
      for (let x = 500; x < 780; x += 3) {
        if (d.noteAt(d.screenToWorld({ x, y })) === undefined) return { x, y }
      }
    }
    return null
  })
  if (cork === null) throw new Error('no cork point')
  const cursorAt = async (p: Pt) => {
    await page.mouse.move(p.x, p.y)
    return page.evaluate(
      (p) => getComputedStyle(document.elementFromPoint(p.x, p.y) as Element).cursor,
      p,
    )
  }
  // As over a mounted note in full detail: the yarn tool's crosshair is for the notes only.
  await armYarn(page)
  expect(await cursorAt(card.at)).toBe('crosshair')
  expect(await cursorAt(cork)).toBe('auto')
  await page.keyboard.press('v')
  expect(await cursorAt(card.at)).toBe('auto')
  // Space held: the hand, over a card too.
  await page.keyboard.down(' ')
  expect(await cursorAt(card.at)).toBe('grab')
  await page.keyboard.up(' ')
  // Leaving overview drops the card cursor: the mounted note's own rules apply again.
  await armYarn(page)
  await cursorAt(card.at)
  await setCamera(page, centredOn({ x: (mid?.x ?? 0) + 150, y: (mid?.y ?? 0) + 100 }, 0.5))
  const world = await page.evaluate(() => window.__papertie.debug.screenToWorld({ x: 640, y: 360 }))
  const under = await page.evaluate((w) => window.__papertie.debug.noteAt(w), world)
  const atCentre = await cursorAt({ x: 640, y: 360 })
  expect(atCentre).toBe(under === undefined ? 'auto' : 'crosshair')
  expect(errors).toEqual([])
})

test('the selection handles hide and show in the very frame the level flips', async ({ page }) => {
  const errors = await open(page, '5000')
  const mid = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.values()][2550],
  )
  const at = { x: (mid?.x ?? 0) + 150, y: (mid?.y ?? 0) + 100 }
  await setCamera(page, centredOn(at, 0.25))
  const id = await page.evaluate(
    (w) => window.__papertie.debug.noteAt(w),
    await page.evaluate(() => window.__papertie.debug.screenToWorld({ x: 640, y: 360 })),
  )
  if (id === undefined) throw new Error('no note at the centre')
  await page.evaluate((id) => {
    const rt = window.__papertie.runtime as unknown as { selectNote(id: string): void }
    rt.selectNote(id)
  }, id)
  await idle(page)
  await expect(page.locator('.overlay > .selection')).toBeVisible()
  // Every frame, after the runtime's: handles shown exactly when the level is not overview.
  await page.evaluate(() => {
    const w = window as unknown as { __flipBad: string[]; __flipSeen: Set<string> }
    w.__flipBad = []
    w.__flipSeen = new Set()
    const sel = document.querySelector('.overlay > .selection') as HTMLElement
    const tick = () => {
      const l = window.__papertie.debug.lod()
      w.__flipSeen.add(l)
      if ((l === 'overview') !== sel.hidden) w.__flipBad.push(`${l} with hidden=${sel.hidden}`)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(() => requestAnimationFrame(tick))
  })
  // Real ctrl+wheel notches through the flip both ways, not settled between steps.
  await page.mouse.move(VIEW.width / 2, VIEW.height / 2)
  await page.keyboard.down('Control')
  for (let k = 0; k < 2; k++) {
    for (let n = 0; n < 12; n++) {
      await page.mouse.wheel(0, 30)
      await page.waitForTimeout(16)
    }
    for (let n = 0; n < 12; n++) {
      await page.mouse.wheel(0, -30)
      await page.waitForTimeout(16)
    }
  }
  await page.keyboard.up('Control')
  await idle(page)
  const seen = await page.evaluate(() => [
    ...(window as unknown as { __flipSeen: Set<string> }).__flipSeen,
  ])
  expect(seen).toContain('overview')
  expect(seen).toContain('lite')
  expect(
    await page.evaluate(() => (window as unknown as { __flipBad: string[] }).__flipBad),
  ).toEqual([])
  expect(errors).toEqual([])
})
