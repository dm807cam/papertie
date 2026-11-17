import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const demo = (prefix: string, n: number) => `${prefix}_01JBDEM0${String(n).padStart(18, '0')}`
/** The loose note at (80, 120); its only thread runs down to note 11 below it. */
const LOOSE = demo('note', 12)
const BELOW = demo('note', 11)
/** noteIds [BELOW, LOOSE]: end a on BELOW's top edge, end b on LOOSE's bottom edge. */
const DOWN = demo('yarn', 7)
const TOP_CAM: Cam = { x: 0, y: 0, zoom: 1 }

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

const attach = async (page: Page, yarnId: string, seg: number, end: 'a' | 'b'): Promise<Pt> => {
  const p = await page.evaluate(
    ([id, seg, end]) => window.__papertie.debug.attachScreen(id, seg, end),
    [yarnId, seg, end] as const,
  )
  if (p === undefined) throw new Error(`no edge pin for ${yarnId}`)
  return p
}

const pinOf = async (page: Page, id: string): Promise<Pt> => {
  const p = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), id)
  if (p === undefined) throw new Error(`no pin for ${id}`)
  return p
}

/** RGBA of a layer canvas at a viewport CSS point. */
const pixel = (page: Page, layer: 'yarn-layer' | 'pin-layer', p: Pt) =>
  page.evaluate(
    ({ layer, p }) => {
      const c = document.querySelector(`canvas.${layer}`) as HTMLCanvasElement
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      const d = devicePixelRatio
      return Array.from(ctx.getImageData(Math.round(p.x * d), Math.round(p.y * d), 1, 1).data)
    },
    { layer, p },
  )

const expectBrass = async (page: Page, p: Pt, what: string) => {
  const [r = 0, g = 0, b = 0, a = 0] = await pixel(page, 'pin-layer', p)
  expect(a, what).toBe(255)
  expect(r, what).toBeGreaterThan(150)
  expect(r, what).toBeGreaterThan(g)
  expect(g, what).toBeGreaterThan(b)
}

const boxOf = async (page: Page, id: string) => {
  const box = await page.locator(`article.note[data-note-id="${id}"]`).boundingBox()
  if (box === null) throw new Error(`no box for ${id}`)
  return box
}

const hitAt = (page: Page, p: Pt) => page.evaluate((p) => window.__papertie.debug.hitAt(p), p)
const selectedYarn = (page: Page) => page.evaluate(() => window.__papertie.debug.selectedYarn())
const counts = (page: Page) =>
  page.evaluate(() => {
    const h = window.__papertie
    return { yarns: h.store.getState().yarns.size, commits: h.store.commits }
  })

test('every yarn end on screen sits on a brass edge pin; the hanging pin holds no yarn', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  const ends = await page.evaluate(({ width: w, height: h }) => {
    const m = window.__papertie
    const out: Array<{ id: string; seg: number; end: 'a' | 'b'; p: { x: number; y: number } }> = []
    for (const [id, y] of m.store.getState().yarns) {
      for (let seg = 0; seg < y.noteIds.length - 1; seg++) {
        for (const end of ['a', 'b'] as const) {
          const p = m.debug.attachScreen(id, seg, end)
          if (p && p.x > 20 && p.y > 90 && p.x < w - 20 && p.y < h - 20) {
            out.push({ id, seg, end, p })
          }
        }
      }
    }
    return out
  }, VIEW)
  expect(ends.length).toBeGreaterThanOrEqual(4)
  for (const e of ends) await expectBrass(page, e.p, `${e.id} ${e.seg}${e.end}`)
  // The thread starts at the pin: yarn is drawn just beside it.
  const [, , , a] = await pixel(page, 'yarn-layer', await attach(page, DOWN, 0, 'b'))
  expect(a).toBeGreaterThan(0)
  // LOOSE's only thread leaves its bottom edge: nothing on the yarn layer at its hanging pin.
  const top = await pinOf(page, LOOSE)
  expect((await pixel(page, 'yarn-layer', top))[3]).toBe(0)
  await expectBrass(page, top, 'hanging pin')
  // The facing edges: LOOSE's bottom, BELOW's top.
  const loose = await boxOf(page, LOOSE)
  const b = await attach(page, DOWN, 0, 'b')
  expect(Math.abs(b.y - (loose.y + loose.height - 14))).toBeLessThan(8)
  const below = await boxOf(page, BELOW)
  const a2 = await attach(page, DOWN, 0, 'a')
  expect(Math.abs(a2.y - (below.y + 14))).toBeLessThan(8)
  expect(errors).toEqual([])
})

test('dragging a note moves its edge pins and their threads with it, every frame', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  const c0 = await counts(page)
  const pin0 = await attach(page, DOWN, 0, 'b')
  const box = await boxOf(page, LOOSE)
  const grab = { x: box.x + 60, y: box.y + box.height / 2 }
  expect(await hitAt(page, grab)).toEqual({ kind: 'none' })
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  let last = pin0
  for (let k = 1; k <= 8; k++) {
    await page.mouse.move(grab.x + 25 * k, grab.y)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
    last = await attach(page, DOWN, 0, 'b')
    await expectBrass(page, last, `frame ${k}`)
  }
  expect(last.x - pin0.x).toBeGreaterThan(100)
  await page.mouse.up()
  await idle(page)
  expect((await counts(page)).commits).toBe(c0.commits + 1)
  const after = await attach(page, DOWN, 0, 'b')
  await expectBrass(page, after, 'after commit')
  expect(Math.hypot(after.x - last.x, after.y - last.y)).toBeLessThan(2)
  // The thread still leaves from the pin, on the moved note's bottom edge.
  const moved = await boxOf(page, LOOSE)
  expect(Math.abs(after.y - (moved.y + moved.height - 14))).toBeLessThan(8)
  expect(errors).toEqual([])
})

test('a yarn-tool connect from the paper lands on edge pins on the facing edges', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  const before = await page.evaluate(() => [...window.__papertie.store.getState().yarns.keys()])
  // A press on the paper, not on a pin (a press on the hanging pin ties the thread there).
  const looseBox = await boxOf(page, LOOSE)
  const from = { x: looseBox.x + looseBox.width / 2, y: looseBox.y + looseBox.height / 2 }
  expect(await hitAt(page, from)).toEqual({ kind: 'none' })
  await armYarn(page)
  const printBox = await boxOf(page, DEMO_IDS.print)
  const drop = { x: printBox.x + printBox.width / 2, y: printBox.y + printBox.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate(() => window.__papertie.store.getState().yarns.size))
    .toBe(before.length + 1)
  const id = await page.evaluate(
    (before) =>
      [...window.__papertie.store.getState().yarns.keys()].find((k) => !before.includes(k)),
    before,
  )
  if (id === undefined) throw new Error('no new yarn')
  await idle(page)
  // LOOSE is left of the print: LOOSE's right edge to the print's left edge.
  const loose = await boxOf(page, LOOSE)
  const a = await attach(page, id, 0, 'a')
  const b = await attach(page, id, 0, 'b')
  expect(Math.abs(a.x - (loose.x + loose.width - 14))).toBeLessThan(8)
  expect(b.x - printBox.x).toBeGreaterThan(0)
  expect(b.x - printBox.x).toBeLessThan(40)
  await expectBrass(page, a, 'new end a')
  await expectBrass(page, b, 'new end b')
  expect(errors).toEqual([])
})

test('edge pins hit like pins; with Select a click on one selects its yarn, then a drag extends it', async ({
  page,
}) => {
  const errors = await open(page, TOP_CAM)
  const c0 = await counts(page)
  const p = await attach(page, DOWN, 0, 'b')
  expect(await hitAt(page, { x: p.x + 6, y: p.y })).toEqual({
    kind: 'pin',
    noteId: LOOSE,
    edge: { yarnId: DOWN, segIndex: 0, end: 'b' },
  })
  const cursorAt = (q: Pt) =>
    page.evaluate((q) => getComputedStyle(document.elementFromPoint(q.x, q.y) as Element).cursor, q)
  // With Select an unselected thread's pin is the thread (Yarn is the tool that ties from it).
  await page.mouse.move(p.x + 3, p.y)
  await expect.poll(() => cursorAt(p)).toBe('pointer')

  await page.mouse.click(p.x + 2, p.y)
  await expect.poll(() => selectedYarn(page)).toBe(DOWN)
  expect(await counts(page)).toEqual(c0)
  // Selected, its end pin is one to pull from.
  await page.mouse.move(p.x + 2, p.y + 1)
  await expect.poll(() => cursorAt(p)).toBe('crosshair')

  // The selected thread's end pin extends it: dragging from LOOSE's end to another
  // note winds that note onto DOWN rather than tying a new thread.
  const printBox = await boxOf(page, DEMO_IDS.print)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(printBox.x + printBox.width / 2, printBox.y + 80, { steps: 10 })
  await page.mouse.up()
  await expect
    .poll(() =>
      page.evaluate((id) => window.__papertie.store.getState().yarns.get(id)?.noteIds, DOWN),
    )
    .toEqual([BELOW, LOOSE, DEMO_IDS.print])
  expect((await counts(page)).yarns).toBe(c0.yarns)
  await idle(page)
  expect(errors).toEqual([])
})

test('zoomed out to lite, yarn ends draw no edge pins and take no pin hit', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/bench?board=500')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.keyboard.press('Shift+Digit1')
  await idle(page)
  expect((await page.evaluate(() => window.__papertie.debug.camera())).zoom).toBeLessThan(0.35)
  const hits = await page.evaluate(({ width: w, height: h }) => {
    const m = window.__papertie
    const out: Array<{ kind: string; edge?: unknown }> = []
    for (const [id, y] of m.store.getState().yarns) {
      for (let seg = 0; seg < y.noteIds.length - 1 && out.length < 200; seg++) {
        const p = m.debug.attachScreen(id, seg, 'a')
        if (p && p.x > 10 && p.y > 90 && p.x < w - 10 && p.y < h - 10) out.push(m.debug.hitAt(p))
      }
    }
    return out
  }, VIEW)
  expect(hits.length).toBeGreaterThan(20)
  expect(hits.filter((h) => h.kind === 'pin' && h.edge !== undefined)).toEqual([])
  expect(errors).toEqual([])
})
