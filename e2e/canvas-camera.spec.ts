import { expect, type Page, test } from '@playwright/test'
import { ZOOM_MAX, ZOOM_MIN } from '../apps/web/src/canvas/Camera'
import { DEMO_MOCKUP } from '../apps/web/src/dev/demoBoard'
import './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await idle(page)
  return errors
}

const camera = (page: Page) => page.evaluate(() => window.__papertie.debug.camera())

/** Wait until the frame loop has nothing left to do. */
const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

/** Resolve after two animation frames, so anything requested has been applied. */
const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

const willChange = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.querySelector('.world') as HTMLElement).willChange)

test('the canvas DOM contract is in place, with DPR-sized canvases', async ({ page }) => {
  const errors = await open(page)
  const layers = await page
    .locator('.viewport > *')
    .evaluateAll((els) => els.map((el) => `${el.tagName.toLowerCase()}.${el.classList[0]}`))
  // The chrome comes first, so Tab reaches it before the notes; each layer paints by
  // its own z-index, whatever its place in the DOM. The photo input lives inside `.ui`.
  expect(layers).toEqual([
    'div.ui',
    'div.cork',
    'div.world',
    'canvas.yarn-layer',
    'canvas.pin-layer',
    'div.overlay',
  ])
  expect(await page.locator('.viewport').evaluate((el) => getComputedStyle(el).touchAction)).toBe(
    'none',
  )
  const sizes = await page.locator('.viewport > canvas').evaluateAll((els) =>
    els.map((el) => {
      const c = el as HTMLCanvasElement
      return [c.width, c.height, c.clientWidth, c.clientHeight, devicePixelRatio]
    }),
  )
  for (const [w, h, cw, ch, dpr] of sizes) {
    expect([cw, ch]).toEqual([VIEW.width, VIEW.height])
    expect([w, h]).toEqual([
      Math.round(VIEW.width * (dpr ?? 1)),
      Math.round(VIEW.height * (dpr ?? 1)),
    ])
  }
  const c = await camera(page)
  expect(c.zoom).toBeGreaterThan(0.1)
  expect(c.zoom).toBeLessThan(1)
  expect(errors).toEqual([])
})

test('the mouse wheel pans: camera y rises by 200/zoom and notes move up 200 px', async ({
  page,
}) => {
  await open(page)
  // A note in the initial framing (the demo's other notes are culled until panned to).
  const note = page.locator(`article.note[data-note-id="${DEMO_MOCKUP.centre}"]`)
  const before = await note.boundingBox()
  const c0 = await camera(page)
  await page.mouse.move(640, 360)
  await page.mouse.wheel(0, 200)
  await expect.poll(async () => (await camera(page)).y).toBeCloseTo(c0.y + 200 / c0.zoom, 6)
  const c1 = await camera(page)
  expect(c1.x).toBe(c0.x)
  expect(c1.zoom).toBe(c0.zoom)
  await frames(page)
  const after = await note.boundingBox()
  expect(Math.abs((after?.y ?? 0) - ((before?.y ?? 0) - 200))).toBeLessThanOrEqual(1)
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1)
})

test('ctrl+wheel zooms about the pointer and stops at exactly ZOOM_MIN (0.005)', async ({
  page,
}) => {
  await open(page)
  const at = { x: 420, y: 310 }
  const worldAt = () => page.evaluate((p) => window.__papertie.debug.screenToWorld(p), at)
  const w0 = await worldAt()
  const z0 = (await camera(page)).zoom
  await page.mouse.move(at.x, at.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(z0 * Math.exp(0.5), 9)
  const w1 = await worldAt()
  expect(w1.x).toBeCloseTo(w0.x, 6)
  expect(w1.y).toBeCloseTo(w0.y, 6)

  for (let i = 0; i < 50; i++) await page.mouse.wheel(0, 100)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await camera(page)).zoom).toBe(ZOOM_MIN)
  await idle(page)
  expect((await camera(page)).zoom).toBe(0.005)
  const w2 = await worldAt()
  expect(w2.x).toBeCloseTo(w0.x, 6)
  expect(w2.y).toBeCloseTo(w0.y, 6)
})

test('zoom stops at 2×: ctrl+wheel, = and Shift+2 on one note go no closer', async ({ page }) => {
  await open(page)
  expect(ZOOM_MAX).toBe(2)
  const at = { x: 520, y: 330 }
  const worldAt = () => page.evaluate((p) => window.__papertie.debug.screenToWorld(p), at)
  const w0 = await worldAt()
  await page.mouse.move(at.x, at.y)
  await page.keyboard.down('Control')
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await camera(page)).zoom).toBe(ZOOM_MAX)
  await idle(page)
  expect((await camera(page)).zoom).toBe(2)
  // It zoomed about the pointer all the way to the stop.
  const w1 = await worldAt()
  expect(w1.x).toBeCloseTo(w0.x, 6)
  expect(w1.y).toBeCloseTo(w0.y, 6)

  // At the stop, = changes nothing.
  const c1 = await camera(page)
  await page.keyboard.press('=')
  await idle(page)
  expect(await camera(page)).toEqual(c1)

  // Shift+2 on the centre note (362 × 166) would fit it at about 3.2×; it frames it at 2×.
  const id = DEMO_MOCKUP.centre
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 0, y: 0, zoom: 0.5 }))
  await page.evaluate((k) => window.__papertie.runtime.selectNotes([k]), id)
  await idle(page)
  await page.keyboard.press('Shift+Digit2')
  await idle(page)
  expect((await camera(page)).zoom).toBe(2)
  const box = await page.locator(`article.note[data-note-id="${id}"]`).boundingBox()
  if (box === null) throw new Error('the centre note is not on screen')
  expect(box.width).toBeLessThan(362 * 2.5)
  expect(Math.abs(box.x + box.width / 2 - VIEW.width / 2)).toBeLessThan(box.width / 4)
})

/**
 * What decides whether text on the world layer is crisp: anything that still asks for its own
 * compositor layer (`will-change`, which freezes the raster at the scale it was promoted at),
 * the world layer's translation in device px (whole, or the glyphs are resampled), its scale,
 * and the computed font sizes of the mounted notes' text.
 */
const crispness = (page: Page) =>
  page.evaluate(() => {
    const world = document.querySelector('.world') as HTMLElement
    const layers = [world, ...document.querySelectorAll<HTMLElement>('.cork > *, .world *')]
    const promoted = layers
      .filter((el) => getComputedStyle(el).willChange !== 'auto')
      .map((el) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''}`)
    const m = new DOMMatrixReadOnly(getComputedStyle(world).transform)
    const fontSizes = new Set<string>()
    for (const el of document.querySelectorAll('.world article.note *')) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())
      if (own) fontSizes.add(getComputedStyle(el).fontSize)
    }
    return {
      promoted,
      translateDevicePx: [m.e * devicePixelRatio, m.f * devicePixelRatio],
      scale: m.a,
      fontSizes: [...fontSizes],
      lod: window.__papertie.debug.lod(),
    }
  })

test('text is crisp at every reading zoom: the layers are re-rastered once the camera rests', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() => document.fonts.ready)
  const id = DEMO_MOCKUP.centre
  for (const zoom of [0.6, 1, 1.5, 2]) {
    // One = step short of the zoom, centred on the centre note.
    await page.evaluate(
      ({ id, z, view }) => {
        const n = window.__papertie.store.getState().notes.get(id)
        if (n === undefined) throw new Error('no centre note')
        const from = z / 1.25
        window.__papertie.debug.setCamera({
          x: n.x + n.w / 2 - view.width / 2 / from,
          y: n.y + n.h / 2 - view.height / 2 / from,
          zoom: from,
        })
      },
      { id, z: zoom, view: VIEW },
    )
    await idle(page)
    // The eased = zoom promotes the world while it moves...
    await page.keyboard.press('=')
    await expect.poll(() => willChange(page), { intervals: [16] }).toBe('transform')
    await idle(page)
    expect((await camera(page)).zoom).toBeCloseTo(zoom, 9)
    // ...and once it rests nothing is promoted, so every layer is re-rastered at this scale.
    const c = await crispness(page)
    expect(c.lod, `zoom ${zoom}`).toBe('full')
    expect(c.promoted, `zoom ${zoom}`).toEqual([])
    expect(c.scale).toBeCloseTo(zoom, 9)
    for (const v of c.translateDevicePx) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-3)
    expect(c.fontSizes.length, `zoom ${zoom}: text on screen`).toBeGreaterThan(0)
    for (const f of c.fontSizes) expect(Number.isInteger(Number.parseFloat(f)), f).toBe(true)
  }
})

test('= zooms ×1.25 within 400 ms; Shift+1 brings every note into view', async ({ page }) => {
  await open(page)
  const z0 = (await camera(page)).zoom
  // Timed in the page, from the keydown to the first frame at the new zoom, so the test runner's
  // own latency does not count.
  await page.evaluate(() => {
    const w = window as unknown as { __keyAt?: number }
    window.addEventListener('keydown', () => (w.__keyAt ??= performance.now()), {
      capture: true,
      once: true,
    })
  })
  await page.keyboard.press('=')
  const elapsed = await page
    .waitForFunction(
      (target) => {
        const w = window as unknown as { __keyAt?: number }
        const z = window.__papertie.debug.camera().zoom
        return w.__keyAt !== undefined && Math.abs(z - target) < 1e-9
          ? performance.now() - w.__keyAt
          : false
      },
      z0 * 1.25,
      { polling: 'raf', timeout: 5000 },
    )
    .then((h) => h.jsonValue())
  expect(elapsed).toBeLessThanOrEqual(400)

  await page.mouse.move(640, 360)
  await page.mouse.wheel(1500, 2500)
  await page.keyboard.press('=')
  await idle(page)
  const total = await page.evaluate(() => window.__papertie.store.getState().notes.size)
  // Culling unmounts far notes, so count the notes fully on screen rather than the off-screen ones.
  const onscreen = () =>
    page.locator('article.note').evaluateAll((els, v) => {
      const inside = (r: DOMRect) =>
        r.left >= 0 && r.top >= 0 && r.right <= v.width && r.bottom <= v.height
      return els.filter((el) => inside(el.getBoundingClientRect())).length
    }, VIEW)
  expect(await onscreen()).toBeLessThan(total)

  await page.keyboard.press('Shift+Digit1')
  await idle(page)
  expect(total).toBeGreaterThan(10)
  expect(await page.locator('article.note').count()).toBe(total)
  expect(await onscreen()).toBe(total)
})

test('space-drag and middle-drag both pan', async ({ page }) => {
  await open(page)
  const c0 = await camera(page)
  await page.mouse.move(600, 400)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(700, 450, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect.poll(async () => (await camera(page)).x).toBeCloseTo(c0.x - 100 / c0.zoom, 6)
  const c1 = await camera(page)
  expect(c1.y).toBeCloseTo(c0.y - 50 / c0.zoom, 6)

  await page.mouse.move(500, 300)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(440, 340, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  await expect.poll(async () => (await camera(page)).x).toBeCloseTo(c1.x + 60 / c0.zoom, 6)
  expect((await camera(page)).y).toBeCloseTo(c1.y - 40 / c0.zoom, 6)
})

/** A viewport point on bare cork: no note, pin, thread or UI under it. */
async function corkPoint(page: Page) {
  const p = await page.evaluate(() => {
    for (let y = 120; y < innerHeight - 60; y += 20) {
      for (let x = 200; x < innerWidth - 60; x += 20) {
        const el = document.elementFromPoint(x, y)
        if (el?.closest('article, .ui') || !el?.closest('.viewport')) continue
        if (window.__papertie.debug.hitAt({ x, y }).kind !== 'none') continue
        return { x, y }
      }
    }
    return null
  })
  if (p === null) throw new Error('no bare cork in view')
  return p
}

test('a plain drag on bare cork pans, with either tool; a click there clears the selection', async ({
  page,
}) => {
  await open(page)
  const at = await corkPoint(page)
  const id = await page.evaluate(() => [...window.__papertie.store.getState().notes.keys()][0])
  await page.evaluate((k) => window.__papertie.runtime.selectNotes([k as string]), id)
  const c0 = await camera(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x - 40, at.y - 20, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await camera(page)).x).toBeCloseTo(c0.x + 40 / c0.zoom, 6)
  expect((await camera(page)).y).toBeCloseTo(c0.y + 20 / c0.zoom, 6)
  // A pan keeps the selection; no band was drawn.
  expect(await page.evaluate(() => window.__papertie.runtime.selection.size)).toBe(1)
  await expect(page.locator('.overlay > .marquee')).toBeHidden()

  await armYarn(page)
  const back = await corkPoint(page)
  const c1 = await camera(page)
  await page.mouse.move(back.x, back.y)
  await page.mouse.down()
  await page.mouse.move(back.x + 30, back.y, { steps: 3 })
  await page.mouse.up()
  await expect.poll(async () => (await camera(page)).x).toBeCloseTo(c1.x - 30 / c0.zoom, 6)
  await page.keyboard.press('v')

  // A click that stays put is no pan: it clears the selection.
  const c2 = await camera(page)
  const still = await corkPoint(page)
  await page.mouse.click(still.x, still.y)
  await frames(page)
  expect(await camera(page)).toEqual(c2)
  expect(await page.evaluate(() => window.__papertie.runtime.selection.size)).toBe(0)
})

test('no React render during pan', async ({ page }) => {
  await open(page)
  const renders = () => page.evaluate(() => window.__papertie.renders.canvasView)
  const r0 = await renders()
  const c0 = await camera(page)
  await page.mouse.move(640, 360)
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 10)
  await expect.poll(async () => (await camera(page)).y).toBeCloseTo(c0.y + 200 / c0.zoom, 6)
  await idle(page)
  expect(await renders()).toBe(r0)
})

test('.world has will-change: transform only while panning', async ({ page }) => {
  await open(page)
  expect(await willChange(page)).toBe('auto')
  await page.mouse.move(640, 360)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 10)
  // The style is written in the frame that applies the pan, so wait for it rather than read once.
  await expect.poll(() => willChange(page), { intervals: [16] }).toBe('transform')
  await expect.poll(() => willChange(page)).toBe('auto')
  await idle(page)
  expect(await willChange(page)).toBe('auto')
})

test('no idle motion: the loop stops after input and draws nothing while idle', async ({
  page,
}) => {
  await open(page)
  await page.mouse.move(640, 360)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 30)
  await page.keyboard.press('-')
  await page.waitForTimeout(1000)
  const before = await page.evaluate(() => ({
    running: window.__papertie.runtime.loop.running,
    frames: window.__papertie.runtime.loop.framesDrawn,
  }))
  expect(before.running).toBe(false)
  await page.waitForTimeout(2000)
  const after = await page.evaluate(() => window.__papertie.runtime.loop.framesDrawn)
  expect(after).toBe(before.frames)
})
