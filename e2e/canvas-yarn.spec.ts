import { expect, type Page, test } from '@playwright/test'
import { yarnHitTolerancePx } from '../apps/web/src/canvas/hitTest'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

/** The demo's loose note at (80, 120), threaded only straight down to the note below it. */
const LOOSE = `note_01JBDEM0${'12'.padStart(18, '0')}`
/** The top-left of the board: LOOSE, print and open cork between them. */
const TOP_CAM: Cam = { x: 0, y: 0, zoom: 1 }
/** The bottom row, where `crossed` runs from X1 under `overlap` to X2. */
const CROSSED_CAM: Cam = { x: 0, y: 800, zoom: 1 }

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

const pin = async (page: Page, id: string): Promise<Pt> => {
  const p = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), id)
  if (p === undefined) throw new Error(`no pin for ${id}`)
  return p
}

const probe = async (page: Page, yarnId: string, t: number, offsetPx: number): Promise<Pt> => {
  const p = await page.evaluate(
    ([id, t, off]) => window.__papertie.debug.yarnProbe(id, 0, t, off),
    [yarnId, t, offsetPx] as const,
  )
  if (p === undefined) throw new Error(`no curve for ${yarnId}`)
  return p
}

const hitAt = (page: Page, p: Pt) => page.evaluate((p) => window.__papertie.debug.hitAt(p), p)

const counts = (page: Page) =>
  page.evaluate(() => {
    const h = window.__papertie
    const s = h.store.getState()
    return { notes: s.notes.size, yarns: s.yarns.size, commits: h.store.commits }
  })

const yarnIds = (page: Page) =>
  page.evaluate(() => [...window.__papertie.store.getState().yarns.keys()])

const noteOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n === undefined) throw new Error(`no note ${id}`)
    return { x: n.x, y: n.y, w: n.w, h: n.h, z: n.z }
  }, id)

const selectedYarn = (page: Page) => page.evaluate(() => window.__papertie.debug.selectedYarn())

const selectedNotes = (page: Page) => page.evaluate(() => [...window.__papertie.runtime.selection])

const add = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy })
const xy = (p: Pt): [number, number] => [p.x, p.y]

async function drag(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 15 })
  await page.mouse.up()
}

/** The yarns added since `before`, with their notes. */
const addedYarns = (page: Page, before: readonly string[]) =>
  page.evaluate((before) => {
    const old = new Set(before)
    return [...window.__papertie.store.getState().yarns.entries()]
      .filter(([id]) => !old.has(id))
      .map(([id, y]) => ({ id, noteIds: y.noteIds }))
  }, before)

test('with the Yarn tool, pressing 9 px right of a pin and dragging to another note adds one yarn; the note stays', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  await armYarn(page)
  const before = await yarnIds(page)
  const c0 = await counts(page)
  const note0 = await noteOf(page, LOOSE)
  const start = add(await pin(page, LOOSE), 9, 0)
  expect(await hitAt(page, start)).toEqual({ kind: 'pin', noteId: LOOSE })
  const drop = add(await pin(page, DEMO_IDS.print), 0, 60)

  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 15 })
  // The live thread is drawn on top while connecting; nothing is committed yet.
  await expect
    .poll(() => page.evaluate(() => window.__papertie.debug.stats().segmentsDynamic))
    .toBeGreaterThan(0)
  expect((await counts(page)).commits).toBe(c0.commits)
  await page.mouse.up()

  await expect.poll(async () => (await counts(page)).yarns).toBe(c0.yarns + 1)
  expect(await addedYarns(page, before)).toEqual([
    { id: expect.stringMatching(/^yarn_/), noteIds: [LOOSE, DEMO_IDS.print] },
  ])
  expect((await counts(page)).commits).toBe(c0.commits + 1)
  expect(await noteOf(page, LOOSE)).toEqual(note0)
  await idle(page)
  expect(errors).toEqual([])
})

test('with Select a press on the pin is its note’s: the drag moves the note and ties nothing', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  const c0 = await counts(page)
  const note0 = await noteOf(page, LOOSE)
  const start = add(await pin(page, LOOSE), 3, 0)
  expect(await hitAt(page, start)).toEqual({ kind: 'pin', noteId: LOOSE })
  await drag(page, start, add(start, 100, 0))
  await expect.poll(async () => (await noteOf(page, LOOSE)).x).toBe(note0.x + 100)
  expect((await counts(page)).yarns).toBe(c0.yarns)
  await idle(page)
  expect(errors).toEqual([])
})

test('pressing 11 px right of the pin and dragging moves the note instead', async ({ page }) => {
  const errors = await open(page, TOP_CAM)
  const c0 = await counts(page)
  const note0 = await noteOf(page, LOOSE)
  const start = add(await pin(page, LOOSE), 11, 0)
  expect(await hitAt(page, start)).toEqual({ kind: 'none' })
  await drag(page, start, add(start, 100, 0))
  await expect.poll(async () => (await noteOf(page, LOOSE)).x).toBe(note0.x + 100)
  expect(await counts(page)).toEqual({ ...c0, commits: c0.commits + 1 })
  await idle(page)
  expect(errors).toEqual([])
})

test('a press within the tolerance of `crossed` selects it; past it, the note under it or nothing', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  const crossed = DEMO_IDS.crossed
  const c0 = await counts(page)
  // t = 0.6 runs over open cork, t = 0.3 across `overlap`.
  const box = await page.locator(`article.note[data-note-id="${DEMO_IDS.overlap}"]`).boundingBox()
  if (box === null) throw new Error('overlap has no box')
  const inBox = (p: Pt) =>
    p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height
  expect(inBox(await probe(page, crossed, 0.3, 0))).toBe(true)
  expect(inBox(await probe(page, crossed, 0.6, 0))).toBe(false)

  // The cord is 10 px at zoom 1: a press takes it within its half-width plus 2 px (7 px); once
  // selected it is drawn 1.35x wider and takes presses out to 8.75 px.
  const tol = yarnHitTolerancePx(1)
  const selectedTol = yarnHitTolerancePx(1, true)
  for (const side of [1, -1]) {
    const far = await probe(page, crossed, 0.6, (tol + 1) * side)
    expect(await hitAt(page, far)).toEqual({ kind: 'none' })
    await page.mouse.click(far.x, far.y)
    await expect.poll(() => selectedYarn(page)).toBeUndefined()
    expect(await selectedNotes(page)).toEqual([])

    const near = await probe(page, crossed, 0.6, (tol - 1) * side)
    expect(await hitAt(page, near)).toEqual({ kind: 'yarn', yarnId: crossed, segIndex: 0 })
    await page.mouse.click(near.x, near.y)
    await expect.poll(() => selectedYarn(page)).toBe(crossed)
    expect(await selectedNotes(page)).toEqual([])

    // Selected, the wider cord takes the press that missed it before; past that, nothing.
    expect(await hitAt(page, far)).toEqual({ kind: 'yarn', yarnId: crossed, segIndex: 0 })
    const beyond = await probe(page, crossed, 0.6, (selectedTol + 1) * side)
    expect(await hitAt(page, beyond)).toEqual({ kind: 'none' })
    await page.mouse.click(beyond.x, beyond.y)
    await expect.poll(() => selectedYarn(page)).toBeUndefined()
  }

  await page.mouse.click(...xy(await probe(page, crossed, 0.3, tol - 1)))
  await expect.poll(() => selectedYarn(page)).toBe(crossed)
  await page.mouse.click(...xy(await probe(page, crossed, 0.3, selectedTol + 1)))
  await expect.poll(() => selectedNotes(page)).toEqual([DEMO_IDS.overlap])
  expect(await selectedYarn(page)).toBeUndefined()
  expect(await counts(page)).toEqual(c0)
  expect(errors).toEqual([])
})

test('connecting to cork adds no yarn', async ({ page }) => {
  const errors = await open(page, TOP_CAM)
  await armYarn(page)
  const c0 = await counts(page)
  const from = await pin(page, LOOSE)
  const cork = add(from, 150, 280)
  expect(await hitAt(page, cork)).toEqual({ kind: 'none' })
  await drag(page, from, cork)
  await idle(page)
  expect(await counts(page)).toEqual(c0)
  expect(errors).toEqual([])
})

test('selecting a yarn and pressing Delete removes one yarn', async ({ page }) => {
  const errors = await open(page, CROSSED_CAM)
  const c0 = await counts(page)
  await page.mouse.click(...xy(await probe(page, DEMO_IDS.crossed, 0.6, 0)))
  await expect.poll(() => selectedYarn(page)).toBe(DEMO_IDS.crossed)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await counts(page)).yarns).toBe(c0.yarns - 1)
  expect(await yarnIds(page)).not.toContain(DEMO_IDS.crossed)
  expect(await selectedYarn(page)).toBeUndefined()
  expect((await counts(page)).commits).toBe(c0.commits + 1)
  await idle(page)
  expect(errors).toEqual([])
})

test('"+" and Pin add one note by the middle of the view, on free cork; a click or double-click on cork adds none', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  const c0 = await counts(page)
  const cork = add(await pin(page, LOOSE), 150, 280)
  expect(await hitAt(page, cork)).toEqual({ kind: 'none' })

  // The cork makes nothing, whatever the tool.
  await page.mouse.click(cork.x, cork.y)
  await page.mouse.dblclick(cork.x, cork.y)
  await armYarn(page)
  await page.mouse.dblclick(cork.x, cork.y)
  await page.keyboard.press('n')
  await page.keyboard.press('v')
  await idle(page)
  expect(await counts(page)).toEqual(c0)

  const expected = await expectedSpot(page)
  await page.getByRole('button', { name: 'New note' }).click()
  await page
    .getByRole('dialog', { name: 'New note' })
    .getByRole('button', { name: 'Pin note' })
    .click()
  await expect.poll(async () => (await counts(page)).notes).toBe(c0.notes + 1)
  const [created] = await selectedNotes(page)
  if (created === undefined) throw new Error('the new note is not selected')
  const made = await noteOf(page, created)
  expect(made).toMatchObject({ w: 240, h: 160 })
  await onFreeCork(page, created)
  // Near the middle: exactly the spot asked for, the nearest free one to the middle of the view.
  expect(made.x).toBe(Math.round(expected.spot.x - 120))
  expect(made.y).toBe(Math.round(expected.spot.y - 80))
  // It opens ready to write; Esc leaves it with its text.
  await expect(page.locator('.note-edit')).toBeFocused()
  await page.keyboard.type('a')
  await page.keyboard.press('Escape')
  await expect(page.locator('.note-edit')).toHaveCount(0)
  expect(
    await page.evaluate((id) => window.__papertie.store.getState().notes.get(id)?.text, created),
  ).toBe('a')
  await idle(page)
  // One create and one keystroke.
  expect((await counts(page)).commits).toBe(c0.commits + 2)
  expect(errors).toEqual([])
})

test('with the Yarn tool a pin sets the cursor to crosshair, a yarn to pointer; Select shows no pin', async ({
  page,
}) => {
  const errors = await open(page, CROSSED_CAM)
  const cursorAt = (p: Pt) =>
    page.evaluate((p) => getComputedStyle(document.elementFromPoint(p.x, p.y) as Element).cursor, p)
  const p = add(await pin(page, DEMO_IDS.overlap), 3, 0)
  await page.mouse.move(p.x, p.y)
  await expect.poll(() => cursorAt(p)).not.toBe('crosshair')
  await armYarn(page)
  await page.mouse.move(p.x + 1, p.y)
  await expect.poll(() => cursorAt(p)).toBe('crosshair')
  const y = await probe(page, DEMO_IDS.crossed, 0.6, 2)
  await page.mouse.move(y.x, y.y)
  await expect.poll(() => cursorAt(y)).toBe('pointer')
  const off = await probe(page, DEMO_IDS.crossed, 0.6, 40)
  await page.mouse.move(off.x, off.y)
  await expect.poll(() => cursorAt(off)).not.toBe('pointer')
  expect(errors).toEqual([])
})

test('in the yarn tool a press anywhere on a note connects from its pin', async ({ page }) => {
  const errors = await open(page, TOP_CAM)
  const before = await yarnIds(page)
  const note0 = await noteOf(page, LOOSE)
  await armYarn(page)
  await expect(page.getByRole('button', { name: 'Yarn', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const paper = add(await pin(page, LOOSE), 80, 90)
  expect(await hitAt(page, paper)).toEqual({ kind: 'none' })
  await drag(page, paper, add(await pin(page, DEMO_IDS.print), 0, 60))
  await expect.poll(async () => (await addedYarns(page, before)).length).toBe(1)
  expect((await addedYarns(page, before))[0]?.noteIds).toEqual([LOOSE, DEMO_IDS.print])
  expect(await noteOf(page, LOOSE)).toEqual(note0)
  expect(errors).toEqual([])
})

test('a middle-button drag from a pin still pans and connects nothing', async ({ page }) => {
  const errors = await open(page, TOP_CAM)
  const c0 = await counts(page)
  const cam0 = await page.evaluate(() => window.__papertie.debug.camera())
  const p = await pin(page, LOOSE)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(p.x + 80, p.y + 30, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await expect
    .poll(async () => (await page.evaluate(() => window.__papertie.debug.camera())).x)
    .toBeCloseTo(cam0.x - 80, 6)
  await idle(page)
  expect(await counts(page)).toEqual(c0)
  expect(errors).toEqual([])
})

/**
 * The note's paper on screen meets no other paper and lies in the view, right of the sidebar
 * (a new note goes to the nearest free spot by the middle of the view).
 */
async function onFreeCork(page: Page, id: string): Promise<void> {
  const out = await page.evaluate((id) => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect()
      return r && { l: r.left, r: r.right, t: r.top, b: r.bottom }
    }
    const mine = box(document.querySelector(`article[data-note-id="${id}"] .note-paper`))
    const others = [...document.querySelectorAll<HTMLElement>('article.note')]
      .filter((el) => el.dataset.noteId !== id)
      .map((el) => box(el.querySelector('.note-paper')))
    const tools = box(document.querySelector('[role="toolbar"][aria-label="Tools"]'))
    return { mine, others, tools, w: innerWidth, h: innerHeight }
  }, id)
  const m = out.mine
  if (!m) throw new Error('the new note is not drawn')
  const meets = out.others.filter((o) => o && o.l < m.r && m.l < o.r && o.t < m.b && m.t < o.b)
  expect(meets).toEqual([])
  expect(m.l).toBeGreaterThanOrEqual(out.tools?.r ?? 0)
  expect(m.r).toBeLessThanOrEqual(out.w)
  expect(m.t).toBeGreaterThanOrEqual(0)
  expect(m.b).toBeLessThanOrEqual(out.h)
}

/**
 * Where "+" will put a note of `w` × `h`, asked before it is made: the nearest free spot to the
 * middle of the view's free part (`CanvasRuntime.placeNear`), as a world centre, and that middle.
 */
const expectedSpot = (page: Page, w = 240, h = 160) =>
  page.evaluate(
    ([w, h]) => {
      const rt = window.__papertie.runtime as unknown as {
        placeNear(size: { w: number; h: number }): { x: number; y: number }
        safeViewport(): { x: number; y: number; w: number; h: number }
      }
      const v = rt.safeViewport()
      const middle = window.__papertie.debug.screenToWorld({ x: v.x + v.w / 2, y: v.y + v.h / 2 })
      return { spot: rt.placeNear({ w: w as number, h: h as number }), middle }
    },
    [w, h],
  )
