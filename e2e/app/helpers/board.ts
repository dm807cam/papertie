import type { Page } from '@playwright/test'
import type { Pt } from '../../hooks'

/** What the `app` specs read of the board page, through `window.__papertie` (`?bench`) and the DOM. */

export const noteEl = (page: Page, id: string) => page.locator(`article.note[data-note-id="${id}"]`)

type Feed = { getState(): { status: string; pending: number } }

/** The save dot's feed: its status and the batches not yet saved. */
export const feedState = (page: Page) =>
  page.evaluate(() => {
    const feed = (window.__papertie as unknown as { session?: { feed?: Feed } }).session?.feed
    return feed?.getState() ?? null
  })

/** Nothing left to send and the dot says Saved. */
export async function saved(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const feed = (window.__papertie as unknown as { session?: { feed?: Feed } }).session?.feed
      const s = feed?.getState()
      return s !== undefined && s.pending === 0 && s.status === 'saved'
    },
    undefined,
    { timeout: 15_000 },
  )
}

/** No frame running and the camera at rest. */
export const idle = (page: Page) =>
  page.waitForFunction(() => {
    const rt = window.__papertie.runtime
    return !rt.loop.running && !rt.camera.moving
  })

/** A point on a note's paper that a press hands to the note itself (no pin, no thread). */
export async function paperPoint(page: Page, id: string): Promise<Pt> {
  const p = await page.evaluate((id) => {
    const el = document.querySelector(`article.note[data-note-id="${id}"] .note-paper`)
    if (!el) return null
    const box = el.getBoundingClientRect()
    for (const fy of [0.75, 0.85, 0.65, 0.55]) {
      for (const fx of [0.5, 0.35, 0.65]) {
        const x = box.left + box.width * fx
        const y = box.top + box.height * fy
        const hit = document.elementFromPoint(x, y)
        if (hit?.closest('article[data-note-id]')?.getAttribute('data-note-id') !== id) continue
        if (window.__papertie.debug.hitAt({ x, y }).kind !== 'none') continue
        return { x, y }
      }
    }
    return null
  }, id)
  if (p === null) throw new Error(`no free point on ${id}`)
  return p
}

/** A note's hanging pin on screen. */
export async function pin(page: Page, id: string): Promise<Pt> {
  const p = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), id)
  if (p === undefined) throw new Error(`no pin for ${id}`)
  return p
}
