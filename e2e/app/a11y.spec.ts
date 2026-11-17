import type { Page } from '@playwright/test'
import { droppedMessage } from '../../apps/web/src/sync/notices'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, expect, sharedDesktop, test } from './helpers/app'
import { idle, paperPoint, saved } from './helpers/board'
import { seedBook, seedBooks, uploadFigure } from './helpers/books'
import { seedBoard } from './helpers/lifetime'
import { exportJsonl, firstRun, onlyBoard, openBoard } from './helpers/server'
import {
  board30,
  importAsking,
  SECTIONS,
  sectionShown,
  settle,
  tools,
  writing,
} from './helpers/states'

/**
 * The accessibility pass: every state of the app, run through axe with WCAG 2.0
 * A and AA, WCAG 2.1 AA and the best practices, all impacts (`a11y-exceptions.ts`). One test per
 * state, each named `axe has no violations: <state>`.
 */

/** Where to keep screenshots of the zoomed screens, when asked for (`A11Y_SHOTS=<dir>`). */
const SHOTS = process.env.A11Y_SHOTS

async function clean(page: Page): Promise<void> {
  // The pointer on bare ground at the window's corner: a state is read as it stands, not as
  // hovered wherever the machine's own pointer happens to rest over the window.
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 800 }
  await page.mouse.move(width - 2, height - 2)
  // axe reads colours: what opens is read once it has faded in.
  await settle(page)
  expect(await axeViolations(page)).toEqual([])
}

// ── The board ────────────────────────────────────────────────────────────────────────────────

test.describe('the empty board', () => {
  test('axe has no violations: empty board', async ({ page }) => {
    await firstRun(apiFor(page))
    await openBoard(page)
    await saved(page)
    // The welcome note goes: the empty hint shows.
    const id = await page.locator('article.note').first().getAttribute('data-note-id')
    const p = await paperPoint(page, id ?? '')
    await page.mouse.click(p.x, p.y)
    await page.keyboard.press('Delete')
    await expect(page.getByRole('complementary', { name: 'Empty board' })).toBeVisible()
    await clean(page)
  })
})

test.describe('the board with 30 notes', () => {
  // One Papertie and one seeded board for every state here: each test starts where the last left
  // the board, so they run in order, and a failure stops the ones after it (only here).
  test.describe.configure({ mode: 'serial' })
  const shared = sharedDesktop()
  let page: Page
  let ids: string[] = []

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    page = (await shared.desktop.main()).page
    const seeded = board30()
    ids = seeded.notes.map((n) => n.id)
    await seedBoard(apiFor(page), seeded.ops)
    await openBoard(page)
    await saved(page)
    // The grid in view, at reading zoom.
    await page.evaluate(() => window.__papertie.debug.setCamera({ x: -60, y: -60, zoom: 0.8 }))
    await idle(page)
  })

  test.afterAll(async () => {
    await shared.end()
  })

  const select = async (i: number, add = false) => {
    const id = ids[i] as string
    const p = await paperPoint(page, id)
    if (add) await page.keyboard.down('Shift')
    await page.mouse.click(p.x, p.y)
    if (add) await page.keyboard.up('Shift')
  }
  const clear = async () => {
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => window.__papertie.runtime.selection.size)).toBe(0)
  }

  test('axe has no violations: board with 30 notes', async () => {
    await expect(page.locator('article.note')).toHaveCount(30)
    await expect(page.getByRole('article', { name: 'Sea voyage' })).toBeVisible()
    await clean(page)
  })

  test('axe has no violations: one selected note', async () => {
    await select(1)
    await expect(tools(page).getByRole('group', { name: 'Selection' })).toBeVisible()
    await clean(page)
    await clear()
  })

  test('axe has no violations: multi-select', async () => {
    await select(1)
    await select(2, true)
    await select(7, true)
    await expect.poll(() => page.evaluate(() => window.__papertie.runtime.selection.size)).toBe(3)
    // What is shown and said of it, before axe reads it.
    await expect(page.locator('article.note.note--selected')).toHaveCount(3)
    await expect(tools(page).getByRole('group', { name: 'Selection' })).toBeVisible()
    await expect(tools(page).getByRole('button', { name: 'Duplicate' })).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('[data-live-region]')?.textContent?.trim()),
      )
      .toBe('Selected 3 notes')
    await clean(page)
    await clear()
  })

  test('axe has no violations: the "+" sheet with the paper picker', async () => {
    await tools(page).getByRole('button', { name: 'New note' }).click()
    await expect(page.getByRole('dialog', { name: 'New note' })).toBeVisible()
    await clean(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'New note' })).toHaveCount(0)
  })

  test('axe has no violations: the "+" sheet with the yarn colour picker', async () => {
    await tools(page).getByRole('button', { name: 'Yarn' }).click()
    await expect(page.getByRole('dialog', { name: 'New thread' })).toBeVisible()
    await clean(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'New thread' })).toHaveCount(0)
  })

  test('axe has no violations: the save-dot popover', async () => {
    // The dot rests out of reach once saved: a nudge brings it back for a moment.
    await select(8)
    await page.keyboard.press('Alt+ArrowRight')
    const dot = page.getByTestId('save-dot')
    await expect(dot).toHaveAttribute('data-shown', 'true')
    await dot.click()
    await expect(page.getByRole('dialog', { name: 'Save status' })).toBeVisible()
    await clean(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Save status' })).toHaveCount(0)
    await saved(page)
    await clear()
  })

  test('axe has no violations: ⌘K with results', async () => {
    await page.keyboard.press('ControlOrMeta+k')
    const search = page.getByRole('dialog', { name: 'Search notes' })
    await expect(search).toBeVisible()
    await page.keyboard.type('trip')
    await expect(search.getByRole('option').first()).toBeVisible()
    await expect(search.getByRole('status')).toHaveText('1 note')
    await clean(page)
    // The first note is found as well.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Sea voyage')
    await expect(search.getByRole('option', { name: 'Sea voyage' })).toBeVisible()
    await expect(search.getByRole('status')).toHaveText('1 note')
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
  })

  test('axe has no violations: focus mode at depth 2', async () => {
    await select(1)
    await page.keyboard.press('f')
    const chip = page.getByRole('toolbar', { name: 'Focus' })
    await expect(chip).toContainText('1 step')
    await chip.getByRole('button', { name: 'More steps' }).click()
    await expect(chip).toContainText('2 steps')
    await expect
      .poll(() => page.evaluate(() => window.__papertie.runtime.focus?.notes.size))
      .toBe(3)
    await idle(page)
    await clean(page)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => window.__papertie.runtime.focusState)).toBeNull()
    await clear()
  })

  test('axe has no violations: far zoom', async () => {
    for (const zoom of [0.25, 0.1]) {
      await page.evaluate(
        (zoom) => window.__papertie.debug.setCamera({ x: -900, y: -700, zoom }),
        zoom,
      )
      await idle(page)
      await expect
        .poll(() => page.evaluate(() => window.__papertie.debug.lod()))
        .toBe(zoom === 0.25 ? 'lite' : 'overview')
      await clean(page)
    }
    await page.evaluate(() => window.__papertie.debug.setCamera({ x: -60, y: -60, zoom: 0.8 }))
    await idle(page)
  })

  for (const section of SECTIONS) {
    test(`axe has no violations: settings, ${section}`, async () => {
      await page.goto(`${APP_URL}/settings/${section}?bench`)
      await sectionShown(page, section)
      await clean(page)
    })
  }

  test('axe has no violations: import, with its confirmation step', async () => {
    await openBoard(page)
    await saved(page)
    const boardId = await onlyBoard(apiFor(page))
    const file = await exportJsonl(apiFor(page), boardId)
    const { settings, ask } = await importAsking(page, file)
    await clean(page)
    await ask.getByRole('button', { name: 'Replace board' }).click()
    await expect(
      settings.getByText('Board replaced. You can undo this from History.'),
    ).toBeVisible()
    await clean(page)
    // The sheet has said it: no slip comes for it, under the sheet or after it (watched a
    // while: no single look can tell a slip that never comes from one still on its way).
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    const slips = page.locator('.sync-notices [role="note"]')
    for (let k = 0; k < 8; k++) {
      expect(await slips.count()).toBe(0)
      await page.waitForTimeout(250)
    }
  })

  test('axe has no violations: the recovery notice', async () => {
    // The board replaced through the app's routes, with no sheet of the window's to say it:
    // the window hears of it and says it in its recovery slip.
    const api = apiFor(page)
    const boardId = await onlyBoard(api)
    const file = await exportJsonl(api, boardId)
    const preview = await api.post(`/api/boards/${boardId}/import`, {
      headers: { Origin: APP_URL },
      multipart: {
        file: { name: 'board.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(file) },
      },
    })
    expect(preview.status(), await preview.text()).toBe(200)
    const { importId } = (await preview.json()) as { importId: string }
    const commit = await api.post(`/api/boards/${boardId}/import/${importId}/commit`, {
      headers: { Origin: APP_URL },
      data: {},
    })
    expect(commit.status(), await commit.text()).toBe(200)
    const recovery = page.getByRole('region', { name: 'Board recovery' })
    await expect(recovery.getByRole('note')).toBeVisible({ timeout: 15_000 })
    // At the foot with the other notices, never over the top row of notes.
    const box = await recovery.getByRole('note').boundingBox()
    expect(box?.y ?? 0).toBeGreaterThan(400)
    await clean(page)
  })

  test('axe has no violations: a sync notice', async () => {
    // What the sync client tells the feed when a change could not be saved.
    const message = droppedMessage(1)
    await page.evaluate((message) => {
      type Feed = { notice(n: { kind: 'dropped'; count: number; message: string }): void }
      const f = (window.__papertie as unknown as { session: { feed: Feed } }).session.feed
      f.notice({ kind: 'dropped', count: 1, message })
    }, message)
    const notices = page.getByRole('region', { name: 'Notices' })
    await expect(notices.locator('.sync-slip[role="note"]')).toContainText(message)
    await clean(page)
  })
})

// ── The shelf ─────────────────────────────────────────────────────────────

test.describe('the shelf', () => {
  test('axe: no serious violations on the shelf', async ({ page }) => {
    test.setTimeout(120_000)
    await firstRun(apiFor(page))
    await openBoard(page)
    const boardId = await onlyBoard(apiFor(page))
    await seedBooks(page, boardId, 6)
    await page.goto(`${APP_URL}/shelf`)
    const shelf = page.getByRole('dialog', { name: 'Books' })
    await expect(shelf.locator('.cover')).toHaveCount(6)
    await clean(page)
    // A book's popover.
    await shelf.getByRole('button', { name: 'Options for Field notes' }).click()
    const pop = page.getByRole('dialog', { name: 'Field notes' })
    await expect(pop).toBeVisible()
    await clean(page)
    // Delete's question.
    await pop.getByRole('button', { name: 'Delete' }).click()
    const ask = page.getByRole('alertdialog')
    await expect(ask).toBeVisible()
    await clean(page)
    await ask.getByRole('button', { name: 'Delete' }).click()
    // Recently deleted, with the book to put back.
    await shelf.getByRole('button', { name: 'Recently deleted' }).click()
    const trash = page.getByRole('dialog', { name: 'Recently deleted' })
    await expect(trash.getByRole('listitem')).toHaveCount(1)
    await clean(page)
  })
})

// ── The writer ────────────────────────────────────────────────────────────

test.describe('the writer', () => {
  test('axe: no serious violations in the split view', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await firstRun(apiFor(page))
    await openBoard(page)
    const boardId = await onlyBoard(apiFor(page))
    const bookId = await seedBook(page, boardId, {
      title: 'Beside the board',
      blocks: [
        { kind: 'h1', text: 'On collecting' },
        { text: 'Written beside the board.' },
        { kind: 'prompt', text: 'Ask about the second thread.' },
      ],
    })
    await page.goto(`${APP_URL}/book/${bookId}`)
    await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
    await expect(page.locator('.writer [data-id]')).toHaveCount(3)
    await clean(page)
    // The seam focused (its value said), and the board's side in use beside the book.
    await page.getByRole('separator', { name: 'Book width' }).focus()
    await page.keyboard.press('ArrowLeft')
    await clean(page)
    await page.locator('article.note').first().click()
    await clean(page)
  })

  test('axe: no serious violations in the writer', async ({ page }) => {
    test.setTimeout(120_000)
    await firstRun(apiFor(page))
    await openBoard(page)
    const boardId = await onlyBoard(apiFor(page))
    const assetId = await uploadFigure(page, boardId)
    const bookId = await seedBook(page, boardId, {
      title: 'Field notes',
      blocks: [
        { kind: 'h1', text: 'On collecting' },
        { text: 'Who writes thinks twice.', marks: [{ t: 'i', from: 11, to: 17 }] },
        { kind: 'quote', text: 'To remember is to connect.' },
        { kind: 'h2', text: 'The card' },
        { kind: 'li', text: 'one card' },
        { kind: 'li', text: 'one thread' },
        // A prompt beside the list, and a figure with its caption.
        { kind: 'prompt', text: 'Ask about the second thread.' },
        { kind: 'figure', text: 'The board, early on', image: { assetId } },
      ],
    })
    await page.goto(`${APP_URL}/book/${bookId}`)
    const page1 = page.locator('.writer [data-id]')
    await expect(page1).toHaveCount(8)
    await clean(page)
    // The sidebar's writing tools, over a selected word; then Text style's picker open.
    await page.evaluate(() => {
      const t = document.querySelectorAll('.writer [data-id]')[1]?.firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, 0, t, 3)
    })
    await expect(writing(page).getByRole('button', { name: 'Bold' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await clean(page)
    await writing(page).getByRole('button', { name: 'Text style' }).click()
    await expect(page.getByRole('dialog', { name: 'Text style' })).toBeVisible()
    await clean(page)
  })
})

// ── 200 % zoom ───────────────────────────────────────────────────────────────────────────────

/**
 * The controls under `selector` that cannot be seen whole: each is first brought into view
 * inside the containers a user can scroll (as a wheel or Tab would), then must lie inside the
 * view and inside every container that clips it. A radio is judged by the face it sits on.
 */
const clipped = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const out: string[] = []
    const scrolls = (cs: CSSStyleDeclaration, axis: 'x' | 'y') =>
      /auto|scroll/.test(axis === 'x' ? cs.overflowX : cs.overflowY)
    const clips = (cs: CSSStyleDeclaration) =>
      cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none'
    for (const root of document.querySelectorAll<HTMLElement>(selector)) {
      const controls = root.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [role="option"], [role="radio"]',
      )
      for (const el of controls) {
        if (el.closest('[inert], [hidden], [aria-hidden="true"]')) continue
        const face = el.matches('input[type="radio"], input[type="checkbox"]')
          ? (el.closest('label') ?? el)
          : el
        if (face.getClientRects().length === 0) continue
        // Into view within the containers that scroll.
        for (let a = face.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a)
          const r = face.getBoundingClientRect()
          const ar = a.getBoundingClientRect()
          if (scrolls(cs, 'y')) {
            if (r.bottom > ar.bottom) a.scrollTop += r.bottom - ar.bottom
            if (r.top < ar.top) a.scrollTop -= ar.top - r.top
          }
          if (scrolls(cs, 'x')) {
            if (r.right > ar.right) a.scrollLeft += r.right - ar.right
            if (r.left < ar.left) a.scrollLeft -= ar.left - r.left
          }
        }
        const r = face.getBoundingClientRect()
        const inside = (b: { left: number; top: number; right: number; bottom: number }) =>
          r.left >= b.left - 1 &&
          r.top >= b.top - 1 &&
          r.right <= b.right + 1 &&
          r.bottom <= b.bottom + 1
        let ok = inside({ left: 0, top: 0, right: innerWidth, bottom: innerHeight })
        for (let a = face.parentElement; a && ok; a = a.parentElement) {
          if (clips(getComputedStyle(a))) ok = inside(a.getBoundingClientRect())
        }
        if (!ok) {
          const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''
          out.push(
            `${el.tagName.toLowerCase()} "${name}" at ${[r.left, r.top, r.right, r.bottom].map(Math.round).join(',')}`,
          )
        }
      }
    }
    return out
  }, selector)

/** The page scrolls sideways. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const d = document.scrollingElement ?? document.documentElement
    return d.scrollWidth > d.clientWidth + 1
  })

/**
 * The window at 200 % zoom on a 1920 × 1080 screen: the page lays out in half the CSS pixels
 * (960 × 540), each drawn as 2 × 2 device pixels. The sidebar stays, short.
 */
const ZOOMED = { width: 960, height: 540 }

test.describe('zoom', () => {
  test('screen UI is usable at 200 % zoom: 1920 × 1080', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize(ZOOMED)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...ZOOMED,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await firstRun(apiFor(page))
    await openBoard(page)
    await saved(page)
    const bar = '.sidebar'
    const surfaces: Record<string, string[]> = {}
    const check = async (name: string, selector: string) => {
      await expect(page.locator(selector).first()).toBeVisible()
      await settle(page)
      surfaces[name] = await clipped(page, selector)
      if (await sideways(page)) surfaces[name].push('the page scrolls sideways')
    }
    await expect(page.locator(bar)).toBeVisible()

    // The tools, with a note selected (its selection section unfolds).
    const id = (await page.locator('article.note').first().getAttribute('data-note-id')) ?? ''
    const welcome = page.locator(`article.note[data-note-id="${id}"]`)
    await welcome.focus()
    await expect(tools(page).getByRole('group', { name: 'Selection' })).toBeVisible()
    await check('tools and selection', bar)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/zoom-${ZOOMED.width}-board.png` })

    // The "+" sheet: the paper picker (with its sheet row unfolded), then the yarn colours.
    await tools(page).getByRole('button', { name: 'New note' }).focus()
    await page.keyboard.press('Enter')
    await page
      .getByRole('dialog', { name: 'New note' })
      .getByRole('radio', { name: 'Layered sheet' })
      .focus()
    await page.keyboard.press('Space')
    await check('paper picker', '.note-picker')
    await page.keyboard.press('Escape')
    await tools(page).getByRole('button', { name: 'Yarn' }).focus()
    await page.keyboard.press('Enter')
    await check('yarn picker', '.yarn-picker')
    await page.keyboard.press('Escape')

    // The save dot's popover, while a nudge is saving.
    await welcome.focus()
    await page.keyboard.press('Alt+ArrowRight')
    const dot = page.getByTestId('save-dot')
    await expect(dot).toHaveAttribute('data-shown', 'true')
    await dot.focus()
    await page.keyboard.press('Enter')
    await check('save-dot popover', '.save-pop')
    await page.keyboard.press('Escape')

    // The focus chip.
    await welcome.focus()
    await page.keyboard.press('f')
    await check('focus chip', '.focus-chip')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('toolbar', { name: 'Focus' })).toHaveCount(0)

    // ⌘K with results.
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('pin')
    await expect(
      page.getByRole('dialog', { name: 'Search notes' }).getByRole('option'),
    ).toHaveCount(1)
    await check('search', '.picker')
    await page.keyboard.press('Escape')

    // Settings, each section.
    for (const section of SECTIONS) {
      await page.goto(`${APP_URL}/settings/${section}?bench`)
      await sectionShown(page, section)
      await check(`settings, ${section}`, '.settings-sheet')
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/zoom-${ZOOMED.width}-${section}.png` })
    }

    expect(surfaces).toEqual(
      Object.fromEntries(Object.keys(surfaces).map((k) => [k, [] as string[]])),
    )
  })
})
