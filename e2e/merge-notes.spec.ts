import { expect, type Page, test } from '@playwright/test'
import type { Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const NOW = '2026-11-02T09:00:00.000Z'
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
/** The target (cream, at 100, 100) and the note dragged to it (rose, at 700, 100). */
const TARGET = nid(1)
const MOVED = nid(2)
const SIZE = { w: 240, h: 160 }

interface PageStore {
  commit(ops: unknown[], o?: { label?: string }): void
  getState(): {
    notes: Map<string, { x: number; y: number; text: string }>
    yarns: Map<string, { noteIds: string[] }>
  }
  commits: number
}

/**
 * The page's clock is ours (`page.clock`): frames and the hold before a merge run only as the
 * test lets time pass, so a quick release is quick however loaded the machine is.
 */
/** Opens the board with the target, the moved note and `under` (indigo notes at x, y). */
async function open(page: Page, under: Array<{ id: string; x: number; y: number }> = []) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.clock.install()
  await page.goto('/bench?board=empty')
  await page.clock.runFor(500)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate(
    ([now, target, moved, w, h, under]) => {
      const store = window.__papertie.store as unknown as PageStore
      const note = (id: string, x: number, paper: string, text: string, z: number, y = 100) => ({
        op: 'note.create',
        note: {
          type: 'note',
          id,
          x,
          y,
          w,
          h,
          z,
          paper,
          style: 'rustic',
          text,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      })
      store.commit([
        note(target, 100, 'cream', 'first', 1),
        note(moved, 700, 'rose', 'second', 2),
        ...under.map((u, i) => note(u.id, u.x, 'indigo', 'under', 3 + i, u.y)),
      ])
      window.__papertie.debug.setCamera({ x: 0, y: 0, zoom: 1 })
    },
    [NOW, TARGET, MOVED, SIZE.w, SIZE.h, under] as const,
  )
  await page.clock.runFor(300)
  return errors
}

const notes = (page: Page) =>
  page.evaluate(() => {
    const store = window.__papertie.store as unknown as PageStore
    return Object.fromEntries(
      [...store.getState().notes].map(([id, n]) => [id, { x: n.x, y: n.y, text: n.text }]),
    )
  })

const bridgeShown = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.merge-bridge') as HTMLCanvasElement | null
    return c !== null && !c.hidden
  })

/** A grip on the moved note's paper, below its pin (world = screen at zoom 1, camera at 0). */
const GRIP: Pt = { x: 820, y: 200 }

/** Drag the moved note by `dx`, `dy` and leave the button down. */
async function dragBy(page: Page, dx: number, dy: number) {
  await page.mouse.move(GRIP.x, GRIP.y)
  await page.mouse.down()
  await page.mouse.move(GRIP.x + dx, GRIP.y + dy, { steps: 10 })
  await page.clock.runFor(16)
}

/** Dragged this far left, the moved note's left edge lies 10 px right of the target's. */
const BESIDE = -(700 - (100 + SIZE.w + 10))

test('held beside another note with Option, a note joins it by a bridge and merges into it on release', async ({
  page,
}) => {
  const errors = await open(page)
  const c0 = await page.evaluate(() => window.__papertie.store.commits)
  await page.keyboard.down('Alt')
  await dragBy(page, BESIDE, 8)
  await page.clock.runFor(400)
  expect(await bridgeShown(page)).toBe(true)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.clock.runFor(500)

  const after = await notes(page)
  expect(Object.keys(after)).toEqual([TARGET])
  expect(after[TARGET]).toEqual({ x: 100, y: 100, text: 'first\n\nsecond' })
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(c0 + 1)
  expect(await bridgeShown(page)).toBe(false)
  await expect(page.locator('.note--merging')).toHaveCount(0)
  await expect(page.locator('[data-live-region]')).toHaveText(/Merged into “first”/)

  await page.keyboard.press('ControlOrMeta+z')
  await page.clock.runFor(100)
  const back = await notes(page)
  expect(back[TARGET]?.text).toBe('first')
  expect(back[MOVED]).toEqual({ x: 700, y: 100, text: 'second' })
  expect(errors).toEqual([])
})

test('a note moved over another drops on it without merging, even with Option', async ({
  page,
}) => {
  const errors = await open(page)
  await page.keyboard.down('Alt')
  await dragBy(page, -480, 20)
  await page.clock.runFor(400)
  expect(await bridgeShown(page)).toBe(false)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.clock.runFor(300)
  const after = await notes(page)
  expect(after[MOVED]).toEqual({ x: 220, y: 120, text: 'second' })
  expect(after[TARGET]?.text).toBe('first')
  expect(errors).toEqual([])
})

test('a quick release beside a note, before the hold, does not merge', async ({ page }) => {
  const errors = await open(page)
  // Swept in beside the target with Option and let go at once.
  await page.keyboard.down('Alt')
  await dragBy(page, BESIDE, 8)
  await page.clock.runFor(60)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.clock.runFor(300)
  const after = await notes(page)
  expect(after[MOVED]).toEqual({ x: 700 + BESIDE, y: 108, text: 'second' })
  expect(after[TARGET]?.text).toBe('first')
  expect(await bridgeShown(page)).toBe(false)
  expect(errors).toEqual([])
})

test('held over a third note with Option, a note still merges with the note beside it', async ({
  page,
}) => {
  // UNDER lies where the moved note is held beside the target: moving over it is no merge with
  // UNDER, but it does not keep the moved note from joining the target beside it.
  const UNDER = nid(3)
  const errors = await open(page, [{ id: UNDER, x: 420, y: 140 }])
  await page.keyboard.down('Alt')
  await dragBy(page, BESIDE, 8)
  await page.clock.runFor(600)
  expect(await bridgeShown(page)).toBe(true)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await page.clock.runFor(600)
  const after = await notes(page)
  expect(after[MOVED]).toBeUndefined()
  expect(after[TARGET]?.text).toContain('first')
  expect(after[TARGET]?.text).toContain('second')
  expect(after[UNDER]).toBeDefined()
  expect(errors).toEqual([])
})

test('without Option, a note held beside another only moves there: no bridge, no merge', async ({
  page,
}) => {
  const errors = await open(page)
  const c0 = await page.evaluate(() => window.__papertie.store.commits)
  await dragBy(page, BESIDE, 8)
  await page.clock.runFor(600)
  expect(await bridgeShown(page)).toBe(false)
  await page.mouse.up()
  await page.clock.runFor(300)
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(c0 + 1)
  const after = await notes(page)
  expect(after[MOVED]).toEqual({ x: 700 + BESIDE, y: 108, text: 'second' })
  expect(after[TARGET]?.text).toBe('first')
  expect(errors).toEqual([])
})
