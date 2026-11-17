import { expect, type Locator, type Page } from '@playwright/test'
import type { Pt } from '../../hooks'
import { APP_URL } from './app'
import { idle, paperPoint } from './board'

/*
 * What the page holds and does, for the `app` and `desktop` specs: the notes and threads in its
 * store, bare cork to pin on, a note pinned through the sidebar.
 */

/** Open the board with the test hooks (`?bench`), and wait until it is drawn (it may be empty). */
export async function openEmptyBoard(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/?bench`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

/** No word of an account on the page: its text, and every accessible name in it. */
export async function expectNoAccountWords(page: Page): Promise<void> {
  const said = await page.evaluate(() => [
    document.body.textContent,
    ...[...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
  ])
  for (const s of said)
    expect(s ?? '').not.toMatch(/account|e-?mail|sign(ed)? ?(in|out|up)|password/i)
}

/** The notes as the page holds them, by id. */
export const pageNotes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...window.__papertie.store.getState().notes.entries()].map(([id, n]) => [
        id,
        { x: n.x, y: n.y, text: n.text },
      ]),
    ),
  )

export const pageYarns = (page: Page) =>
  page.evaluate(() =>
    [...window.__papertie.store.getState().yarns.values()].map((y) => [...y.noteIds]),
  )

/** A spot of bare cork in the view, at least `clear` px from every note. */
export async function bareCork(page: Page, clear = 120): Promise<Pt> {
  const p = await page.evaluate((clear) => {
    const boxes = [...document.querySelectorAll('article.note .note-paper')].map((el) =>
      el.getBoundingClientRect(),
    )
    for (let y = 160; y < innerHeight - 160; y += 40) {
      for (let x = 260; x < innerWidth - 200; x += 40) {
        const far = boxes.every(
          (b) =>
            x < b.left - clear || x > b.right + clear || y < b.top - clear || y > b.bottom + clear,
        )
        if (far && window.__papertie.debug.hitAt({ x, y }).kind === 'none') return { x, y }
      }
    }
    return null
  }, clear)
  if (p === null) throw new Error('no bare cork in view')
  return p
}

/** A new note from "+", written on, then hung at `at` on bare cork. Its id. */
export async function pinNote(
  page: Page,
  text: string,
  at: Pt,
  choose: (picker: Locator) => Promise<void> = async () => {},
): Promise<string> {
  const before = Object.keys(await pageNotes(page))
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  const picker = page.getByRole('dialog', { name: 'New note' })
  await choose(picker)
  await picker.getByRole('button', { name: 'Pin note' }).click()
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await idle(page)
  const id = Object.keys(await pageNotes(page)).find((k) => !before.includes(k))
  if (id === undefined) throw new Error('no new note')
  const grab = await paperPoint(page, id)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(at.x, at.y, { steps: 12 })
  await page.mouse.up()
  await idle(page)
  return id
}

/**
 * A touch screen on the window, from the next page load on: a finger's input, no hover, a coarse
 * pointer. `touch` is one finger down, moved or lifted; `tapAt` and `tap` put it down and lift
 * it, at a point or on the middle of what `target` finds.
 */
export async function touchScreen(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'hover', value: 'none' },
      { name: 'any-hover', value: 'none' },
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
    ],
  })
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    })
  }
  const tapAt = async (x: number, y: number) => {
    await touch('touchStart', x, y)
    await touch('touchEnd')
  }
  const tap = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (box === null) throw new Error('nothing to tap')
    await tapAt(box.x + box.width / 2, box.y + box.height / 2)
  }
  return { touch, tapAt, tap }
}
