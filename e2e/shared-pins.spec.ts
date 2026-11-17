import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'
import { armYarn } from './yarnTool'

/**
 * Threads sharing a pin (the select tool, local demo board): a thread started on another
 * thread's edge pin, or dropped on one, is tied at that same pin (one pin drawn for both, one
 * undo for the change); one started on a note's hanging pin is tied there; one dropped elsewhere
 * on the paper gets an edge pin of its own. Persistence across a reload is `app/shared-pins`.
 */

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const demo = (prefix: string, n: number) => `${prefix}_01JBDEM0${String(n).padStart(18, '0')}`
/** The loose note at (80, 120); its only thread runs down to note 11 below it. */
const LOOSE = demo('note', 12)
const BELOW = demo('note', 11)
/** noteIds [BELOW, LOOSE]: end a on BELOW's top edge, end b on LOOSE's bottom edge. */
const DOWN = demo('yarn', 7)
const PRINT = DEMO_IDS.print
const TOP_CAM: Cam = { x: 0, y: 0, zoom: 1 }

interface YarnRec {
  noteIds: string[]
  pins?: Record<string, string>
}

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), TOP_CAM)
  await idle(page)
  // Threads are tied with the Yarn tool.
  await armYarn(page)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const attach = async (page: Page, yarnId: string, seg: number, end: 'a' | 'b'): Promise<Pt> => {
  const p = await page.evaluate(
    ([id, seg, end]) => window.__papertie.debug.attachScreen(id, seg, end),
    [yarnId, seg, end] as const,
  )
  if (p === undefined) throw new Error(`no pin for ${yarnId}`)
  return p
}

const pinOf = async (page: Page, id: string): Promise<Pt> => {
  const p = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), id)
  if (p === undefined) throw new Error(`no pin for ${id}`)
  return p
}

const centreOf = async (page: Page, id: string): Promise<Pt> => {
  const box = await page.locator(`article.note[data-note-id="${id}"]`).boundingBox()
  if (box === null) throw new Error(`no box for ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const yarnOf = (page: Page, id: string) =>
  page.evaluate(
    (id) => window.__papertie.store.getState().yarns.get(id) as unknown as YarnRec | undefined,
    id,
  )

const yarnIds = (page: Page) =>
  page.evaluate(() => [...window.__papertie.store.getState().yarns.keys()])

/** The one yarn added since `before`. */
async function added(page: Page, before: readonly string[]): Promise<string> {
  await expect.poll(async () => (await yarnIds(page)).length).toBe(before.length + 1)
  const id = (await yarnIds(page)).find((k) => !before.includes(k))
  if (id === undefined) throw new Error('no new yarn')
  return id
}

const pinsDrawn = async (page: Page) => {
  await idle(page)
  return page.evaluate(() => window.__papertie.debug.stats().pins)
}

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}

const near = (p: Pt, q: Pt, px: number) => Math.hypot(p.x - q.x, p.y - q.y) <= px

/** RGBA of the yarn canvas at a viewport CSS point. */
const yarnPixel = (page: Page, p: Pt) =>
  page.evaluate((p) => {
    const c = document.querySelector('canvas.yarn-layer') as HTMLCanvasElement
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    const d = devicePixelRatio
    return Array.from(ctx.getImageData(Math.round(p.x * d), Math.round(p.y * d), 1, 1).data)
  }, p)

/** RGBA of the pin canvas at a viewport CSS point. */
const pinPixel = (page: Page, p: Pt) =>
  page.evaluate((p) => {
    const c = document.querySelector('canvas.pin-layer') as HTMLCanvasElement
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    const d = devicePixelRatio
    return Array.from(ctx.getImageData(Math.round(p.x * d), Math.round(p.y * d), 1, 1).data)
  }, p)

const expectBrass = async (page: Page, p: Pt, what: string) => {
  const [r = 0, g = 0, b = 0, a = 0] = await pinPixel(page, p)
  expect(a, what).toBe(255)
  expect(r, what).toBeGreaterThan(150)
  expect(r, what).toBeGreaterThan(g)
  expect(g, what).toBeGreaterThan(b)
}

test("a thread started on another thread's edge pin shares it: one pin, one undo", async ({
  page,
}) => {
  const errors = await open(page)
  const before = await yarnIds(page)
  const pins0 = await pinsDrawn(page)
  const shared = await attach(page, DOWN, 0, 'b')
  await drag(page, shared, await centreOf(page, PRINT))
  const id = await added(page, before)
  const yarn = await yarnOf(page, id)
  const key = (await yarnOf(page, DOWN))?.pins?.[LOOSE]
  // Named after the end it was: DOWN's end on LOOSE, toward its previous note.
  expect(key).toBe(`y${DOWN.slice(5)}p`)
  expect(yarn).toMatchObject({ noteIds: [LOOSE, PRINT], pins: { [LOOSE]: key } })
  await idle(page)
  // Both threads leave LOOSE from the pin DOWN already had: it did not move.
  const a = await attach(page, id, 0, 'a')
  expect(near(a, await attach(page, DOWN, 0, 'b'), 0.5)).toBe(true)
  expect(near(a, shared, 0.5)).toBe(true)
  await expectBrass(page, a, 'the shared pin')
  // One new pin is drawn, on the print; LOOSE's is the one both threads share.
  expect(await pinsDrawn(page)).toBe(pins0 + 1)

  // One undo takes the thread away and DOWN's pin key with it.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await yarnIds(page)).length).toBe(before.length)
  expect(await yarnOf(page, DOWN)).not.toHaveProperty('pins')
  expect(await pinsDrawn(page)).toBe(pins0)
  expect(errors).toEqual([])
})

test("a thread from a note's hanging pin is tied at it", async ({ page }) => {
  const errors = await open(page)
  const before = await yarnIds(page)
  const pins0 = await pinsDrawn(page)
  const top = await pinOf(page, LOOSE)
  await drag(page, top, await centreOf(page, PRINT))
  const id = await added(page, before)
  expect(await yarnOf(page, id)).toMatchObject({
    noteIds: [LOOSE, PRINT],
    pins: { [LOOSE]: 'hanging' },
  })
  await idle(page)
  expect(near(await attach(page, id, 0, 'a'), top, 0.5)).toBe(true)
  // The hanging pin was drawn already: only the print's new edge pin is added.
  expect(await pinsDrawn(page)).toBe(pins0 + 1)
  // Past a stub at the pin, the strand lies beneath LOOSE's own paper: its text stays clear.
  const box = await page.locator(`article.note[data-note-id="${LOOSE}"]`).boundingBox()
  if (box === null) throw new Error('no box')
  const points = await page.evaluate(
    (id) =>
      Array.from({ length: 40 }, (_, k) => window.__papertie.debug.yarnPointScreen(id, 0, k / 40)),
    id,
  )
  const inside = (p: Pt) =>
    p.x > box.x + 12 &&
    p.x < box.x + box.width - 12 &&
    p.y > box.y + 12 &&
    p.y < box.y + box.height - 12 &&
    !near(p, top, 40)
  const under = points.filter((p): p is Pt => p !== undefined && inside(p))
  const over = points.filter(
    (p): p is Pt =>
      p !== undefined && p.x > box.x + box.width + 20 && p.x < box.x + box.width + 120,
  )
  expect(under.length).toBeGreaterThan(0)
  expect(over.length).toBeGreaterThan(0)
  for (const p of under) expect((await yarnPixel(page, p))[3], 'beneath the paper').toBe(0)
  expect((await yarnPixel(page, over[0] as Pt))[3], 'over the cork').toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test("a drop on the target's existing edge pin shares it; elsewhere on the paper, its own", async ({
  page,
}) => {
  const errors = await open(page)
  const onPin = await attach(page, DOWN, 0, 'a')
  let before = await yarnIds(page)
  // From the print's hanging pin to the pin holding DOWN on BELOW's top edge.
  await drag(page, await pinOf(page, PRINT), onPin)
  const first = await added(page, before)
  const key = (await yarnOf(page, DOWN))?.pins?.[BELOW]
  expect(key).toBe(`y${DOWN.slice(5)}n`)
  expect(await yarnOf(page, first)).toMatchObject({
    noteIds: [PRINT, BELOW],
    pins: { [PRINT]: 'hanging', [BELOW]: key },
  })
  await idle(page)
  expect(near(await attach(page, first, 0, 'b'), onPin, 0.5)).toBe(true)

  // Dropped on BELOW's paper away from its pins: an edge pin of its own. (LOOSE and BELOW are
  // tied in cream already; the new thread is apricot, so it is tied, not just shown.)
  before = await yarnIds(page)
  const pins0 = await pinsDrawn(page)
  const paper = await centreOf(page, BELOW)
  expect(await page.evaluate((p) => window.__papertie.debug.hitAt(p), paper)).toEqual({
    kind: 'none',
  })
  await drag(page, await pinOf(page, LOOSE), paper)
  const second = await added(page, before)
  const yarn = await yarnOf(page, second)
  expect(yarn?.noteIds).toEqual([LOOSE, BELOW])
  expect(yarn?.pins).toEqual({ [LOOSE]: 'hanging' })
  await idle(page)
  const own = await attach(page, second, 0, 'b')
  expect(near(own, onPin, 15)).toBe(false)
  await expectBrass(page, own, 'its own edge pin')
  expect(await pinsDrawn(page)).toBe(pins0 + 1)
  expect(errors).toEqual([])
})
