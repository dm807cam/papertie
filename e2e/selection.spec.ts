import { expect, type Page, test } from '@playwright/test'
import type { Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

/** Note `n` of the seeded board: a 3 × 3 grid, 200 × 120 papers 300 world px apart, row by row. */
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
const ids = (...ns: number[]) => ns.map(nid)
const NOW = '2026-10-30T09:00:00.000Z'

/** The store as the page sees it; the proto hooks type only what the older specs read. */
interface PageStore {
  commit(ops: unknown[], o?: { label?: string }): void
  getState(): { notes: Map<string, { x: number; y: number; z: number; text: string }> }
  commits: number
}

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=empty')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate(
    ([now]) => {
      const store = window.__papertie.store as unknown as PageStore
      const ops = Array.from({ length: 9 }, (_, i) => ({
        op: 'note.create',
        note: {
          type: 'note',
          id: `note_${String(i + 1).padStart(26, '0')}`,
          x: (i % 3) * 300,
          y: Math.floor(i / 3) * 300,
          w: 200,
          h: 120,
          z: i + 1,
          paper: 'cream',
          style: 'rustic',
          text: '',
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      }))
      store.commit(ops)
    },
    [NOW],
  )
  await view(page, 0.8)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

/** The camera at `zoom` with the grid's middle (world 400, 300) in the middle of the viewport. */
async function view(page: Page, zoom: number) {
  await page.evaluate(
    ([zoom, w, h]) =>
      window.__papertie.debug.setCamera({ x: 400 - w / 2 / zoom, y: 300 - h / 2 / zoom, zoom }),
    [zoom, VIEW.width, VIEW.height] as const,
  )
  await idle(page)
}

/** Viewport px of a world point at the camera now. */
async function screenOf(page: Page, w: Pt): Promise<Pt> {
  const c = await page.evaluate(() => window.__papertie.debug.camera())
  return { x: (w.x - c.x) * c.zoom, y: (w.y - c.y) * c.zoom }
}

const selected = (page: Page) =>
  page.evaluate(() => [...window.__papertie.runtime.selection].sort())

const notes = (page: Page) =>
  page.evaluate(() => {
    const store = window.__papertie.store as unknown as PageStore
    return Object.fromEntries(
      [...store.getState().notes].map(([id, n]) => [id, { x: n.x, y: n.y, z: n.z }]),
    )
  })

const commits = (page: Page) => page.evaluate(() => window.__papertie.store.commits)

/** Drag from one world point to another with the primary button, in a few steps. */
async function dragWorld(page: Page, from: Pt, to: Pt) {
  const a = await screenOf(page, from)
  const b = await screenOf(page, to)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
}

/** The marquee: a Shift-drag from bare cork, between two world points. */
async function marquee(page: Page, from: Pt, to: Pt) {
  await page.keyboard.down('Shift')
  await dragWorld(page, from, to)
  await page.keyboard.up('Shift')
}

/** A point on a note's paper, below its pin. */
const onNote = (n: number): Pt => ({
  x: ((n - 1) % 3) * 300 + 100,
  y: Math.floor((n - 1) / 3) * 300 + 80,
})

const noteEl = (page: Page, n: number) => page.locator(`article.note[data-note-id="${nid(n)}"]`)

test('a Shift-drag over cork selects the notes it touches, adding to them; a click on cork clears', async ({
  page,
}) => {
  const errors = await open(page)
  // The first row only: from bare cork above-left of note 1 across notes 1 and 2.
  await marquee(page, { x: -60, y: -60 }, { x: 520, y: 140 })
  await expect.poll(() => selected(page)).toEqual(ids(1, 2))
  await expect(page.locator('.overlay > .marquee')).toBeHidden()
  // A second band adds its notes to those already selected.
  await marquee(page, { x: -60, y: 260 }, { x: 120, y: 440 })
  await expect.poll(() => selected(page)).toEqual(ids(1, 2, 4))
  // Selected notes point at the one hidden "Selected" node; the others do not.
  await expect(noteEl(page, 4)).toHaveAttribute('aria-describedby', 'papertie-selected-mark')
  await expect(noteEl(page, 5)).not.toHaveAttribute('aria-describedby')
  await expect(page.locator('#papertie-selected-mark')).toHaveText('Selected')
  // A press and release on bare cork clears.
  const cork = await screenOf(page, { x: 250, y: 220 })
  await page.mouse.click(cork.x, cork.y)
  await expect.poll(() => selected(page)).toEqual([])
  await expect(noteEl(page, 4)).not.toHaveAttribute('aria-describedby')
  expect(errors).toEqual([])
})

test('a plain drag over cork pans the board: no band, the selection kept', async ({ page }) => {
  const errors = await open(page)
  await marquee(page, { x: -60, y: -60 }, { x: 520, y: 140 })
  await expect.poll(() => selected(page)).toEqual(ids(1, 2))
  const c0 = await page.evaluate(() => window.__papertie.debug.camera())
  const a = await screenOf(page, { x: -60, y: 260 })
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(a.x + 60, a.y + 90, { steps: 4 })
  await expect(page.locator('.overlay > .marquee')).toBeHidden()
  await page.mouse.up()
  const c1 = await page.evaluate(() => window.__papertie.debug.camera())
  expect(c1.x).toBeCloseTo(c0.x - 60 / c0.zoom, 6)
  expect(c1.y).toBeCloseTo(c0.y - 90 / c0.zoom, 6)
  expect(await selected(page)).toEqual(ids(1, 2))
  expect(errors).toEqual([])
})

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true })

  test('a long press on cork arms the band (its corner shows), then the drag draws it; a plain drag pans', async ({
    page,
  }) => {
    const errors = await open(page)
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: Pt) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: p === undefined ? [] : [{ x: p.x, y: p.y }],
      })
    const a = await screenOf(page, { x: -60, y: -60 })
    const b = await screenOf(page, { x: 520, y: 140 })
    await touch('touchStart', a)
    await page.waitForTimeout(550)
    await expect(page.locator('.overlay > .marquee[data-armed]')).toBeVisible()
    for (let k = 1; k <= 8; k++) {
      await touch('touchMove', { x: a.x + ((b.x - a.x) * k) / 8, y: a.y + ((b.y - a.y) * k) / 8 })
    }
    await touch('touchEnd')
    await expect.poll(() => selected(page)).toEqual(ids(1, 2))
    await expect(page.locator('.overlay > .marquee')).toBeHidden()

    // A drag straight away pans, and keeps what is selected.
    const c0 = await page.evaluate(() => window.__papertie.debug.camera())
    const s = await screenOf(page, { x: -60, y: 260 })
    await touch('touchStart', s)
    for (let k = 1; k <= 6; k++) await touch('touchMove', { x: s.x + 10 * k, y: s.y + 15 * k })
    await touch('touchEnd')
    const c1 = await page.evaluate(() => window.__papertie.debug.camera())
    expect(c1.x).toBeCloseTo(c0.x - 60 / c0.zoom, 4)
    expect(c1.y).toBeCloseTo(c0.y - 90 / c0.zoom, 4)
    expect(await selected(page)).toEqual(ids(1, 2))
    expect(errors).toEqual([])
  })
})

test('the marquee works in overview, where no note is mounted', async ({ page }) => {
  const errors = await open(page)
  await view(page, 0.1)
  await expect.poll(() => page.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  expect(await page.locator('article.note').count()).toBe(0)
  // Left column: from bare cork between the columns back over notes 1, 4 and 7.
  await marquee(page, { x: 250, y: -80 }, { x: 80, y: 760 })
  await expect.poll(() => selected(page)).toEqual(ids(1, 4, 7))
  expect(errors).toEqual([])
})

test('Shift-click toggles a note in and out of the selection', async ({ page }) => {
  const errors = await open(page)
  const click = async (n: number, shift: boolean) => {
    const p = await screenOf(page, onNote(n))
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.click(p.x, p.y)
    if (shift) await page.keyboard.up('Shift')
  }
  await click(1, false)
  await expect.poll(() => selected(page)).toEqual(ids(1))
  await click(5, true)
  await expect.poll(() => selected(page)).toEqual(ids(1, 5))
  await click(9, true)
  await expect.poll(() => selected(page)).toEqual(ids(1, 5, 9))
  await click(5, true)
  await expect.poll(() => selected(page)).toEqual(ids(1, 9))
  // A plain click on one of the pair narrows to it.
  await click(9, false)
  await expect.poll(() => selected(page)).toEqual(ids(9))
  expect(errors).toEqual([])
})

test('dragging one of several selected notes moves them all in one commit, in order, on top', async ({
  page,
}) => {
  const errors = await open(page)
  await marquee(page, { x: -60, y: -60 }, { x: 520, y: 140 })
  await expect.poll(() => selected(page)).toEqual(ids(1, 2))
  const before = await notes(page)
  const c0 = await commits(page)
  const from = onNote(2)
  await dragWorld(page, from, { x: from.x + 50, y: from.y + 30 })
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  const after = await notes(page)
  expect(after[nid(1)]).toMatchObject({ x: 50, y: 30 })
  expect(after[nid(2)]).toMatchObject({ x: 350, y: 30 })
  // They keep their order (1 below 2), above everything else.
  expect(after[nid(1)]?.z).toBeLessThan(after[nid(2)]?.z ?? 0)
  expect(after[nid(1)]?.z).toBeGreaterThan(before[nid(9)]?.z ?? 0)
  expect(after[nid(3)]).toEqual(before[nid(3)])
  expect(await selected(page)).toEqual(ids(1, 2))
  expect(errors).toEqual([])
})

test('arrow keys walk the grid, Esc clears, select all takes every note', async ({ page }) => {
  const errors = await open(page)
  const click = await screenOf(page, onNote(5))
  await page.mouse.click(click.x, click.y)
  await expect.poll(() => selected(page)).toEqual(ids(5))
  const walk = async (key: string, to: number) => {
    await page.keyboard.press(key)
    await expect.poll(() => selected(page)).toEqual(ids(to))
    // The note holds the keyboard too, so Enter would write on it.
    await expect(noteEl(page, to)).toBeFocused()
  }
  await walk('ArrowRight', 6)
  await walk('ArrowDown', 9)
  await walk('ArrowLeft', 8)
  await walk('ArrowUp', 5)
  // At the edge the selection stays where it is.
  await walk('ArrowUp', 2)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => selected(page)).toEqual(ids(2))
  await page.keyboard.press('Escape')
  await expect.poll(() => selected(page)).toEqual([])
  await page.keyboard.press('ControlOrMeta+a')
  await expect.poll(() => selected(page)).toEqual(ids(1, 2, 3, 4, 5, 6, 7, 8, 9))
  expect(errors).toEqual([])
})

test('Alt+Shift+Arrow nudges the selection by 10, Alt+Arrow by 1', async ({ page }) => {
  const errors = await open(page)
  await marquee(page, { x: -60, y: -60 }, { x: 520, y: 140 })
  await expect.poll(() => selected(page)).toEqual(ids(1, 2))
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect.poll(async () => (await notes(page))[nid(1)]?.x).toBe(10)
  await page.keyboard.press('Alt+Shift+ArrowDown')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(async () => (await notes(page))[nid(2)]).toMatchObject({ x: 309, y: 10 })
  expect((await notes(page))[nid(1)]).toMatchObject({ x: 9, y: 10 })
  // Others stay put, and the stacking order is not touched by a nudge.
  expect((await notes(page))[nid(3)]).toMatchObject({ x: 600, y: 0, z: 3 })
  expect((await notes(page))[nid(1)]?.z).toBe(1)
  expect(errors).toEqual([])
})

test('notes are in the tab order by reading position, and still paint by z', async ({ page }) => {
  const errors = await open(page)
  // Note 1 (leftmost) is raised over note 2 and made to overlap it: DOM order is reading order,
  // so the one painted on top comes first in the DOM.
  await page.evaluate(
    ([a, b]) => {
      const store = window.__papertie.store as unknown as PageStore
      store.commit([
        { op: 'note.update', id: a, set: { x: 150, z: 20 } },
        { op: 'note.update', id: b, set: { x: 300, z: 2 } },
      ])
    },
    [nid(1), nid(2)],
  )
  await idle(page)
  // The chrome comes first: the first Tab from the page lands in the sidebar, not on a note.
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.closest('.ui') !== null)).toBe(true)
  await noteEl(page, 1).focus()
  const focusedId = () => page.evaluate(() => document.activeElement?.getAttribute('data-note-id'))
  await page.keyboard.press('Tab')
  await expect.poll(focusedId).toBe(nid(2))
  await page.keyboard.press('Tab')
  await expect.poll(focusedId).toBe(nid(3))
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect.poll(focusedId).toBe(nid(1))
  await expect(noteEl(page, 1)).toHaveAttribute('aria-label', 'Empty note')
  await expect(noteEl(page, 1)).toHaveAttribute('tabindex', '0')
  // Where 1 (150..350) overlaps 2 (300..500), what is under the pointer is note 1: z 20 beats 2.
  const where = await screenOf(page, { x: 325, y: 100 })
  const top = await page.evaluate(
    (p) => document.elementFromPoint(p.x, p.y)?.closest('article')?.dataset.noteId,
    where,
  )
  expect(top).toBe(nid(1))
  expect(errors).toEqual([])
})
