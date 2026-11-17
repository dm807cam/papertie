import { expect, type Page, test } from '@playwright/test'

/**
 * Where "+" puts a new note: at the middle of the view when it is free,
 * else at the nearest spot nearby with no paper under it, never on top of another note.
 */

test.use({ viewport: { width: 1280, height: 800 } })

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.waitForFunction(() => {
    const rt = window.__papertie.runtime
    return !rt.loop.running && !rt.camera.moving
  })
  return errors
}

/** The papers on screen, by note id. */
const papers = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('article.note')].map((el) => {
        const r = el.querySelector('.note-paper')?.getBoundingClientRect()
        return [
          el.dataset.noteId ?? '',
          r ? { l: r.left, r: r.right, t: r.top, b: r.bottom } : null,
        ]
      }),
    ),
  )

test('a new note from "+" lands on free cork, not on another note', async ({ page }) => {
  const errors = await open(page)
  const before = Object.keys(await papers(page))
  // Something under the middle of the view, as there usually is.
  const centre = await page.evaluate(() =>
    window.__papertie.debug.noteAt(
      window.__papertie.debug.screenToWorld({ x: innerWidth / 2, y: innerHeight / 2 }),
    ),
  )
  expect(centre).toBeDefined()
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  await page
    .getByRole('dialog', { name: 'New note' })
    .getByRole('button', { name: 'Pin note' })
    .click()
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  const after = await papers(page)
  const id = Object.keys(after).find((k) => !before.includes(k))
  if (id === undefined) throw new Error('no new note')
  const mine = after[id]
  if (!mine) throw new Error('new note not drawn')
  const meets = Object.entries(after).filter(
    ([k, p]) =>
      k !== id && p !== null && p.l < mine.r && mine.l < p.r && p.t < mine.b && mine.t < p.b,
  )
  expect(meets.map(([k]) => k)).toEqual([])
  // Still in the view, clear of the sidebar.
  const tools = await page.getByRole('toolbar', { name: 'Tools' }).boundingBox()
  expect(mine.l).toBeGreaterThanOrEqual((tools?.x ?? 0) + (tools?.width ?? 0))
  expect(mine.r).toBeLessThanOrEqual(1280)
  expect(mine.b).toBeLessThanOrEqual(800)
  expect(errors).toEqual([])
})

test('where the middle of the view is free cork, the new note lands right there', async ({
  page,
}) => {
  const errors = await open(page)
  // Far from every note: the whole view is cork.
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 40_000, y: 40_000, zoom: 1 }))
  await page.waitForFunction(() => {
    const rt = window.__papertie.runtime
    return !rt.loop.running && !rt.camera.moving
  })
  const middle = await page.evaluate(() => {
    const v = (
      window.__papertie.runtime as unknown as {
        safeViewport(): { x: number; y: number; w: number; h: number }
      }
    ).safeViewport()
    return window.__papertie.debug.screenToWorld({ x: v.x + v.w / 2, y: v.y + v.h / 2 })
  })
  const before = Object.keys(await papers(page))
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  await page
    .getByRole('dialog', { name: 'New note' })
    .getByRole('button', { name: 'Pin note' })
    .click()
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  const id = Object.keys(await papers(page)).find((k) => !before.includes(k))
  const n = await page.evaluate((id) => window.__papertie.store.getState().notes.get(id ?? ''), id)
  expect(n).toBeDefined()
  expect(Math.abs((n?.x ?? 0) + (n?.w ?? 0) / 2 - middle.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((n?.y ?? 0) + (n?.h ?? 0) / 2 - middle.y)).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})
