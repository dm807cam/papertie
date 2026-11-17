import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

/** The bottom row at zoom 1: X1, `overlap`, the open stretch of `crossed` and X2. */
const CROSSED_CAM: Cam = { x: 0, y: 800, zoom: 1 }
/** Zoom 2 on the crossing: X1's pin, all of `overlap`, and the thread either side of it. */
const SHOT_CAM: Cam = { x: 140, y: 960, zoom: 2 }
/**
 * Zoom 1.5 on two whole fibre notes with a strong seeded tilt, the hub (0.83°) and the tea note
 * (0.86°), and the threads between them, so rotation on and off differ visibly.
 */
const ROTATION_CAM: Cam = { x: 1000, y: 520, zoom: 1.5 }

type Layer = 'over' | 'over-fix' | 'under'

async function open(page: Page, cam: Cam) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), cam)
  await idle(page)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

/** Pick a layer through the Controls select, then wait for the redrawn frame. */
async function setLayer(page: Page, layer: Layer) {
  await page.getByLabel('Yarn layer').selectOption(layer)
  await expect(page.getByTestId('canvas')).toHaveAttribute('data-layer', layer)
  await idle(page)
}

/** Max alpha of a layer canvas over the (2r+1)² device px around a viewport CSS point. */
const alphaAt = (page: Page, layer: 'yarn-layer' | 'pin-layer', p: Pt, r = 2) =>
  page.evaluate(
    ({ layer, p, r }) => {
      const c = document.querySelector(`canvas.${layer}`) as HTMLCanvasElement
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      const d = devicePixelRatio
      const x = Math.round(p.x * d) - r
      const y = Math.round(p.y * d) - r
      const px = ctx.getImageData(x, y, 2 * r + 1, 2 * r + 1).data
      let max = 0
      for (let i = 3; i < px.length; i += 4) max = Math.max(max, px[i] ?? 0)
      return max
    },
    { layer, p, r },
  )

const probe = async (page: Page, t: number, offsetPx = 0): Promise<Pt> => {
  const p = await page.evaluate(
    ([id, t, off]) => window.__papertie.debug.yarnProbe(id, 0, t, off),
    [DEMO_IDS.crossed, t, offsetPx] as const,
  )
  if (p === undefined) throw new Error('no curve for crossed')
  return p
}

const hitAt = (page: Page, p: Pt) => page.evaluate((p) => window.__papertie.debug.hitAt(p), p)
const selectedYarn = (page: Page) => page.evaluate(() => window.__papertie.debug.selectedYarn())
const selectedNotes = (page: Page) => page.evaluate(() => [...window.__papertie.runtime.selection])

const overlapBox = async (page: Page) => {
  const box = await page.locator(`article.note[data-note-id="${DEMO_IDS.overlap}"]`).boundingBox()
  if (box === null) throw new Error('overlap has no box')
  return box
}

const inside = (b: { x: number; y: number; width: number; height: number }, p: Pt, by = 0) =>
  p.x > b.x + by && p.x < b.x + b.width - by && p.y > b.y + by && p.y < b.y + b.height - by

/** P: `crossed` under `overlap`, well inside it. Q: the same curve over open cork. */
async function crossing(page: Page) {
  const box = await overlapBox(page)
  const P = await probe(page, 0.3)
  const Q = await probe(page, 0.6)
  expect(inside(box, P, 40)).toBe(true)
  expect(inside(box, Q)).toBe(false)
  return { P, Q }
}

/** Viewport point `dist` screen px along `crossed` from its edge pin on X1. */
async function alongFromPin(page: Page, dist: number): Promise<Pt> {
  const pin = await page.evaluate(
    (id) => window.__papertie.debug.attachScreen(id, 0, 'a'),
    DEMO_IDS.crossed,
  )
  if (pin === undefined) throw new Error('no pin')
  let lo = 0
  let hi = 0.2
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2
    const p = await probe(page, mid)
    if (Math.hypot(p.x - pin.x, p.y - pin.y) < dist) lo = mid
    else hi = mid
  }
  return probe(page, (lo + hi) / 2)
}

async function shoot(page: Page, name: string, cam: Cam = SHOT_CAM) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(VIEW.width - 4, VIEW.height - 4)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), cam)
  await page.evaluate(() => document.fonts.ready)
  await idle(page)
  await page.screenshot({
    path: path.join(__dirname, 'artifacts', `${name}.png`),
    animations: 'disabled',
  })
}

test('over: the thread paints across the higher note and a press there takes it', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  await setLayer(page, 'over')
  const { P, Q } = await crossing(page)
  expect(await alphaAt(page, 'yarn-layer', P)).toBeGreaterThan(0)
  expect(await alphaAt(page, 'yarn-layer', Q)).toBeGreaterThan(0)
  expect(await hitAt(page, P)).toEqual({ kind: 'yarn', yarnId: DEMO_IDS.crossed, segIndex: 0 })
  await page.mouse.click(P.x, P.y)
  await expect.poll(() => selectedYarn(page)).toBe(DEMO_IDS.crossed)
  expect(await selectedNotes(page)).toEqual([])
  expect(errors).toEqual([])
})

test('over-fix: the paper erases the thread beneath it and a press there takes the note', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  const renders = await page.evaluate(() => window.__papertie.renders.canvasView)
  await setLayer(page, 'over-fix')
  const { P, Q } = await crossing(page)
  await expect.poll(() => alphaAt(page, 'yarn-layer', P)).toBe(0)
  expect(await alphaAt(page, 'yarn-layer', Q)).toBeGreaterThan(0)
  expect(await hitAt(page, P)).toEqual({ kind: 'none' })
  expect(await hitAt(page, Q)).toEqual({ kind: 'yarn', yarnId: DEMO_IDS.crossed, segIndex: 0 })
  await page.mouse.click(P.x, P.y)
  await expect.poll(() => selectedNotes(page)).toEqual([DEMO_IDS.overlap])
  expect(await selectedYarn(page)).toBeUndefined()
  // The layer is drawn outside React: switching it never re-renders the canvas.
  expect(await page.evaluate(() => window.__papertie.renders.canvasView)).toBe(renders)
  expect(errors).toEqual([])
})

test('over-fix: the erase follows a dragged note, and the thread it left shows again', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  await setLayer(page, 'over-fix')
  const { P, Q } = await crossing(page)
  const box = await overlapBox(page)
  // A press on the paper below the thread, well clear of the pin.
  const grab = { x: box.x + 40, y: box.y + box.height - 24 }
  expect(await hitAt(page, grab)).toEqual({ kind: 'none' })
  const dx = 300
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + dx, grab.y, { steps: 12 })
  expect(inside(await overlapBox(page), Q, 20)).toBe(true)
  // Mid-gesture: the cache is not redrawn per frame, but the covered span still clears.
  await expect.poll(() => alphaAt(page, 'yarn-layer', Q)).toBe(0)
  await expect.poll(() => alphaAt(page, 'yarn-layer', P)).toBeGreaterThan(0)
  await page.mouse.up()
  await idle(page)
  expect(await alphaAt(page, 'yarn-layer', Q)).toBe(0)
  expect(await alphaAt(page, 'yarn-layer', P)).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('under: yarn sits below the notes, pin stubs show on the pin layer, presses reach paper', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  // On X1's paper between the edge pin and the paper's edge (inset 14), past the pin's hit
  // radius; and just past the paper's edge, beyond the pin head's shadow.
  const stub12 = await alongFromPin(page, 12)
  const stub21 = await alongFromPin(page, 21)
  await setLayer(page, 'over')
  // Past the pin head's shadow, the pin layer is empty in `over`.
  expect(await alphaAt(page, 'pin-layer', stub21, 1)).toBe(0)

  await setLayer(page, 'under')
  const z = await page.evaluate(() => {
    const zOf = (sel: string) =>
      Number(getComputedStyle(document.querySelector(sel) as Element).zIndex)
    return { yarn: zOf('.viewport > .yarn-layer'), world: zOf('.viewport > .world') }
  })
  expect(z.yarn).toBeLessThan(z.world)
  expect(await alphaAt(page, 'pin-layer', stub12, 1)).toBeGreaterThan(0)
  expect(await alphaAt(page, 'pin-layer', stub21, 1)).toBeGreaterThan(0)

  const { P, Q } = await crossing(page)
  // Inside X1's paper but on the stub: still the thread. Under `overlap`: the note.
  expect(await hitAt(page, stub12)).toEqual({
    kind: 'yarn',
    yarnId: DEMO_IDS.crossed,
    segIndex: 0,
  })
  expect(await hitAt(page, P)).toEqual({ kind: 'none' })
  expect(await hitAt(page, Q)).toEqual({ kind: 'yarn', yarnId: DEMO_IDS.crossed, segIndex: 0 })
  await page.mouse.click(P.x, P.y)
  await expect.poll(() => selectedNotes(page)).toEqual([DEMO_IDS.overlap])
  expect(await selectedYarn(page)).toBeUndefined()
  expect(errors).toEqual([])
})

test('rotation off sets every note to rotate(0deg); on restores the seeded tilt', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  const renders = await page.evaluate(() => window.__papertie.renders.canvasView)
  const transforms = () =>
    page
      .locator('article.note')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform))
  const toggle = page.getByLabel('Paper rotation')
  await expect(toggle).toBeChecked()
  expect((await transforms()).some((t) => !t.includes('rotate(0deg)'))).toBe(true)
  await toggle.uncheck()
  const off = await transforms()
  expect(off.length).toBeGreaterThan(0)
  for (const t of off) expect(t).toContain('rotate(0deg)')
  await toggle.check()
  expect((await transforms()).some((t) => !t.includes('rotate(0deg)'))).toBe(true)
  expect(await page.evaluate(() => window.__papertie.renders.canvasView)).toBe(renders)
  expect(errors).toEqual([])
})

test('motion and wheel selects take effect live', async ({ page }) => {
  const errors = await open(page, CROSSED_CAM)
  const motion = page.getByLabel('Motion')
  await motion.selectOption('reduced')
  expect(await page.evaluate(() => window.__papertie.runtime.reducedMotion())).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced')
  await motion.selectOption('full')
  expect(await page.evaluate(() => window.__papertie.runtime.reducedMotion())).toBe(false)

  const wheel = page.getByLabel('Wheel')
  const cam = () => page.evaluate(() => window.__papertie.debug.camera())
  await page.mouse.move(640, 600)
  await wheel.selectOption('zoom')
  const z0 = (await cam()).zoom
  await page.mouse.wheel(0, -120)
  await expect.poll(async () => (await cam()).zoom).toBeGreaterThan(z0)
  await wheel.selectOption('pan')
  const c1 = await cam()
  await page.mouse.wheel(0, 120)
  await expect.poll(async () => (await cam()).y).toBeGreaterThan(c1.y)
  expect((await cam()).zoom).toBe(c1.zoom)
  expect(errors).toEqual([])
})

test('screenshots: each layer, and rotation on and off', async ({ page }) => {
  const errors = await open(page, SHOT_CAM)
  for (const layer of ['over', 'over-fix', 'under'] as const) {
    await setLayer(page, layer)
    await shoot(page, `layer-${layer}`)
  }
  await setLayer(page, 'over')
  await shoot(page, 'rotation-on', ROTATION_CAM)
  await page.getByLabel('Paper rotation').uncheck()
  await shoot(page, 'rotation-off', ROTATION_CAM)
  await page.getByLabel('Paper rotation').check()
  await setLayer(page, 'over-fix')

  // A tilted fibre note dropped across the thread: the erase is the rect, the edge is deckled.
  const fibre = `note_01JBDEM0${'3'.padStart(18, '0')}`
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 0, y: 0, zoom: 0.5 }))
  await idle(page)
  const from = { x: 1080 * 0.5, y: 260 * 0.5 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x - 120, from.y + 430, { steps: 10 })
  await page.mouse.up()
  await page.mouse.click(5, 700)
  const n = await page.evaluate(
    (id) => window.__papertie.store.getState().notes.get(id) ?? null,
    fibre,
  )
  if (n === null) throw new Error('no fibre note')
  expect([n.x, n.y]).toEqual([800, 980])
  await shoot(page, 'layer-over-fix-fibre', { x: n.x - 100, y: n.y + 60, zoom: 2 })
  expect(errors).toEqual([])
})
