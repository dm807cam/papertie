import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Pt } from './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const HUB = DEMO_IDS.hub
/** The hub's centre in world px (x 1040, y 560, 280 × 200). */
const HUB_CENTRE = { x: 1180, y: 660 }

async function open(page: Page, zoom = 1) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  const cam = {
    x: HUB_CENTRE.x - VIEW.width / 2 / zoom,
    y: HUB_CENTRE.y - VIEW.height / 2 / zoom,
    zoom,
  }
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), cam)
  await idle(page)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

/** Resolves after the next frame has run (and painted). */
const nextFrame = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

const note = (page: Page, id = HUB) =>
  page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n === undefined) throw new Error(`no note ${id}`)
    return { x: n.x, y: n.y, w: n.w, h: n.h, z: n.z }
  }, id)

const commits = (page: Page) => page.evaluate(() => window.__papertie.store.commits)

const noteEl = (page: Page, id = HUB) => page.locator(`article.note[data-note-id="${id}"]`)

async function box(page: Page, id = HUB) {
  const b = await noteEl(page, id).boundingBox()
  if (b === null) throw new Error(`note ${id} has no box`)
  return b
}

/** A point on the note's paper, below its pin and threads. */
async function grabPoint(page: Page, id = HUB): Promise<Pt> {
  const b = await box(page, id)
  return { x: b.x + b.width / 2, y: b.y + b.height * 0.7 }
}

/** Pixel `[r, g, b, a]` of the pin canvas at a viewport CSS point. */
const pinPixel = (page: Page, p: Pt) =>
  page.evaluate((p) => {
    const c = document.querySelector('canvas.pin-layer') as HTMLCanvasElement
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    const d = devicePixelRatio
    return [...ctx.getImageData(Math.floor(p.x * d), Math.floor(p.y * d), 1, 1).data]
  }, p)

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

test('dragging a note moves its DOM node live and commits once at release, on top', async ({
  page,
}) => {
  const errors = await open(page)
  const before = await note(page)
  const box0 = await box(page)
  const c0 = await commits(page)
  const p = await grabPoint(page)

  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  // 160 px: 200 would lay the hub flush beside d, and held there a release merges the two.
  await page.mouse.move(p.x + 160, p.y, { steps: 20 })
  await expect.poll(async () => (await box(page)).x - box0.x).toBeCloseTo(160, 0)
  expect((await note(page)).x).toBe(before.x)
  expect(await commits(page)).toBe(c0)

  await page.mouse.up()
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  const after = await note(page)
  expect(after).toMatchObject({ x: before.x + 160, y: before.y, w: before.w, h: before.h })
  const zs = await page.evaluate(() =>
    [...window.__papertie.store.getState().notes.values()].map((n) => n.z),
  )
  expect(after.z).toBe(Math.max(...zs))
  expect(zs.filter((z) => z === after.z)).toHaveLength(1)
  // Painted on top too, and it stays where it was dropped. The notes sit in the DOM in reading
  // order, so "on top" is the highest z-index (`--stack`), not the last element.
  await expect
    .poll(() =>
      page.evaluate((hub) => {
        const z = (el: Element) => Number(getComputedStyle(el).zIndex)
        const els = [...document.querySelectorAll<HTMLElement>('.world > article.note')]
        const top = Math.max(...els.map(z))
        const topIds = els.filter((el) => z(el) === top).map((el) => el.dataset.noteId)
        return topIds.length === 1 && topIds[0] === hub
      }, HUB),
    )
    .toBe(true)
  await idle(page)
  expect(near((await box(page)).x - box0.x, 160)).toBe(true)
  expect(await commits(page)).toBe(c0 + 1)
  expect(errors).toEqual([])
})

test('at zoom 0.5 a 200 px drag moves the note 400 world px', async ({ page }) => {
  const errors = await open(page, 0.5)
  const before = await note(page)
  const c0 = await commits(page)
  const p = await grabPoint(page)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 200, p.y, { steps: 20 })
  await page.mouse.up()
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  expect(await note(page)).toMatchObject({ x: before.x + 400, y: before.y })
  expect(errors).toEqual([])
})

for (const how of ['Escape', 'pointercancel', 'tool switch'] as const) {
  test(`${how} mid-drag restores the DOM node and commits nothing`, async ({ page }) => {
    const errors = await open(page)
    await page.evaluate(() => {
      const w = window as unknown as { __pid?: number }
      document
        .querySelector('.viewport')
        ?.addEventListener('pointerdown', (e) => (w.__pid = (e as PointerEvent).pointerId), true)
    })
    const before = await note(page)
    const box0 = await box(page)
    const c0 = await commits(page)
    const p = await grabPoint(page)

    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x + 150, p.y + 40, { steps: 15 })
    await expect.poll(async () => (await box(page)).x - box0.x).toBeCloseTo(150, 0)

    if (how === 'Escape') await page.keyboard.press('Escape')
    else if (how === 'tool switch') await armYarn(page)
    else {
      await page.evaluate(() => {
        const pointerId = (window as unknown as { __pid: number }).__pid
        const root = document.querySelector('.viewport') as HTMLElement
        if (!root.hasPointerCapture(pointerId)) throw new Error('root lacks the capture')
        root.dispatchEvent(
          new PointerEvent('pointercancel', { pointerId, pointerType: 'mouse', bubbles: true }),
        )
      })
    }
    await expect.poll(async () => (await box(page)).x).toBeCloseTo(box0.x, 0)
    expect((await box(page)).y).toBeCloseTo(box0.y, 0)

    // The rest of the gesture is ignored.
    await page.mouse.move(p.x + 260, p.y + 80, { steps: 5 })
    await page.mouse.up()
    await idle(page)
    await nextFrame(page)
    expect(near((await box(page)).x, box0.x)).toBe(true)
    expect(await commits(page)).toBe(c0)
    expect(await note(page)).toEqual(before)
    expect(errors).toEqual([])
  })
}

test('a release over the controls still commits exactly once (pointer capture)', async ({
  page,
}) => {
  const errors = await open(page)
  const before = await note(page)
  const c0 = await commits(page)
  const p = await grabPoint(page)
  const ctl = await page.locator('.controls').boundingBox()
  if (ctl === null) throw new Error('no controls')
  const drop = { x: ctl.x + 20, y: ctl.y + ctl.height / 2 }
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 20 })
  await page.mouse.up()
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  await idle(page)
  expect(await commits(page)).toBe(c0 + 1)
  const after = await note(page)
  expect(after.x).toBe(before.x + Math.round(drop.x - p.x))
  expect(after.y).toBe(before.y + Math.round(drop.y - p.y))
  expect(errors).toEqual([])
})

test('dragging the se handle by (+60, +40) resizes the note in one commit', async ({ page }) => {
  const errors = await open(page)
  const before = await note(page)
  const c0 = await commits(page)
  const p = await grabPoint(page)
  await page.mouse.click(p.x, p.y)
  const handle = page.locator(`.overlay .selection[data-note-id="${HUB}"] [data-handle="se"]`)
  await expect(handle).toBeVisible()
  expect(await commits(page)).toBe(c0)
  await expect(noteEl(page)).toHaveClass(/note--selected/)

  const hb = await handle.boundingBox()
  if (hb === null) throw new Error('no handle box')
  const h = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }
  await page.mouse.move(h.x, h.y)
  await page.mouse.down()
  await page.mouse.move(h.x + 60, h.y + 40, { steps: 10 })
  await expect
    .poll(async () => await noteEl(page).evaluate((el) => (el as HTMLElement).offsetWidth))
    .toBe(before.w + 60)
  expect(await commits(page)).toBe(c0)
  await page.mouse.up()
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  expect(await note(page)).toMatchObject({
    x: before.x,
    y: before.y,
    w: before.w + 60,
    h: before.h + 40,
  })
  // The handles follow the new size.
  await idle(page)
  const hb2 = await handle.boundingBox()
  expect(near((hb2?.x ?? 0) - hb.x, 60, 2)).toBe(true)
  expect(near((hb2?.y ?? 0) - hb.y, 40, 2)).toBe(true)
  expect(errors).toEqual([])
})

test('the hub pin (and its threads) follow the drag: brass at pinScreen on 10 frames', async ({
  page,
}) => {
  const errors = await open(page)
  const pin0 = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), HUB)
  const p = await grabPoint(page)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  let last: Pt | undefined
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(p.x + 14 * k, p.y + 6 * k)
    await nextFrame(page)
    last = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), HUB)
    if (last === undefined) throw new Error('no pin')
    const [r = 0, g = 0, b = 0] = await pinPixel(page, last)
    expect(r, `frame ${k}`).toBeGreaterThan(150)
    expect(r, `frame ${k}`).toBeGreaterThan(g)
    expect(g, `frame ${k}`).toBeGreaterThan(b)
  }
  expect(near((last?.x ?? 0) - (pin0?.x ?? 0), 140)).toBe(true)
  expect(near((last?.y ?? 0) - (pin0?.y ?? 0), 60)).toBe(true)
  const stats = await page.evaluate(() => window.__papertie.debug.stats())
  // The hub's 4 threads, plus its neighbours' other segments (print-b, tea-perforation): their
  // edge pins face the hub, so they move with it.
  expect(stats.segmentsDynamic).toBe(6)
  await page.mouse.up()
  await idle(page)
  expect((await page.evaluate(() => window.__papertie.debug.stats())).segmentsDynamic).toBe(0)
  expect(errors).toEqual([])
})
