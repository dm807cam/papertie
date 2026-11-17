import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Page } from '@playwright/test'
import { coverFromSeed } from '../../apps/web/src/book/cover/cover'
import { droppedMessage, reloadMessage } from '../../apps/web/src/sync/notices'
import { newId, posKeysBetween } from '../../packages/core/src'
import { pngLossless, webpFrom } from '../../tools/src/galleryImages'
import { genBookBlocks } from '../../tools/src/genBook'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, type Desktop, expect, sharedDesktop, test } from './helpers/app'
import { idle, paperPoint, saved } from './helpers/board'
import { type BookBlock, bookBlocks, opsOn, seedBook, TITLES, uploadFigure } from './helpers/books'
import { seedBoard } from './helpers/lifetime'
import { exportJsonl, firstRun, onlyBoard, openBoard } from './helpers/server'
import {
  board30,
  heldOpening,
  holdBoard,
  importAsking,
  SECTIONS,
  sectionShown,
  settle,
  tools,
  writing,
} from './helpers/states'

/**
 * The screenshot gallery: every state of the app at three window sizes. Each shot is kept as a
 * lossless PNG in `e2e/artifacts/gallery/<viewport>-<state>.png` (git-ignored: the full-quality
 * originals), and written as a WebP of it to `docs/screenshots/board/<viewport>-<state>.webp`,
 * with an index.
 *
 * Not a gate on pixels: each test asserts only that its state was reached (something visible or
 * a live-region line proves it), then takes the screenshot. Motion is reduced and every finite
 * animation has ended, the fonts and images are in, and the board's camera is at rest, so the
 * frames are deterministic.
 *
 * The states: the accessibility pass's (`a11y.spec.ts`, set up from the same helpers), with far
 * zoom and the import each in their parts, plus typing, a photo uploading, a dropped-batch
 * notice, the opening catching up and the save dot in each of its states. Every state is reached
 * at every viewport. The wide frame's shots are written for every state; the 1440 × 900 @2x
 * viewport's for {@link LAPTOP_SUBSET} and the tablet's for {@link TABLET_SUBSET} only. The WebPs
 * are at quality {@link QUALITY_CORK} where the cork fills the frame and {@link QUALITY_SHEET}
 * where a Settings sheet does (the committed gallery stays under 20 MB; lossless PNGs of the cork
 * run 1–6 MB each).
 *
 * On demand only (it rewrites the committed WebPs; the desktop app is built first, as for
 * `pnpm e2e:app`):
 *   GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery
 *
 * The books' states (the shelf, covers and the writer) are written to `docs/screenshots/books/`,
 * with an index of their own, at the same viewports. Their tests are titled `books …`, so they
 * run alone with
 *   GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g books
 *
 * The states of the board and the book side by side are written to `docs/screenshots/split/` the
 * same way:
 *   GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g split
 *
 * A note's ref, footnotes and export (the Word file through Quick Look) are written to
 * `docs/screenshots/sources/`:
 *   GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g sources
 */

test.skip(!process.env.GALLERY, 'the gallery runs on demand: GALLERY=1')

/** The committed gallery: WebP, and the index. */
const OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots', 'board')
/** The lossless originals, kept on this machine only (`e2e/.gitignore`: `artifacts/`). */
const ORIGINALS = path.join(__dirname, '..', 'artifacts', 'gallery')

/** WebP quality where the cork's grain fills most of the frame, and where a sheet covers it. */
const QUALITY_CORK = 82
const QUALITY_SHEET = 90
const covered = (state: string) => /^(settings-|import-)/.test(state)

type Viewport = {
  name: 'wide' | 'laptop2x' | 'tablet'
  label: string
  /** The window's content size in CSS px, and the device pixels to each. */
  frame: { width: number; height: number; scale: 1 | 2 }
}

const VIEWPORTS: readonly Viewport[] = [
  {
    name: 'wide',
    label: '1672 × 941 (a desktop window)',
    frame: { width: 1672, height: 941, scale: 1 },
  },
  {
    name: 'laptop2x',
    label: '1440 × 900 @ DPR 2',
    frame: { width: 1440, height: 900, scale: 2 },
  },
  {
    name: 'tablet',
    label: '1024 × 768 (tablet)',
    frame: { width: 1024, height: 768, scale: 1 },
  },
]

/** The camera at reading zoom: the grid's first columns in view, clear of the sidebar. */
const READING = { x: -170, y: -60, zoom: 0.8 }

/** Every state, in the order the gallery reaches it, with what it shows. */
const STATES = {
  'empty-board': 'The empty board, its hint (the welcome note deleted)',
  'board-30': 'The board with 30 notes and five threads, at reading zoom',
  'one-selected': 'One note selected: its section in the tools',
  'multi-select': 'Three notes selected (live region: "Selected 3 notes")',
  'new-note-sheet': 'The "+" sheet: the paper picker',
  'new-thread-sheet': 'The "+" sheet: the yarn colour picker',
  'save-popover': 'The save-dot popover, after a nudge',
  'search-results': '⌘K with results ("trip")',
  'focus-depth-2': 'Focus mode at depth 2 (the focus chip)',
  'far-zoom-lite': 'Far zoom, 25 % (the lite view)',
  'far-zoom-overview': 'Far zoom, 10 % (the overview)',
  typing: 'Typing in a new note (the view is full: it covers the least it can)',
  'place-free':
    'A new note from "+" where the middle of the view is free cork: it lands right there',
  'photo-uploading': 'A pasted photo uploading (held on its way to the store)',
  'dropped-notice': 'A dropped-batch notice (a change that could not be applied)',
  'save-saving': 'The save dot: Saving…',
  'save-saved': 'The save dot: Saved (it shows for 1.5 s, then rests)',
  'save-error': "The save dot: Couldn't save",
  'settings-export': 'Settings: Export',
  'settings-history': 'Settings: History',
  'settings-preferences': 'Settings: Preferences',
  'settings-data': 'Settings: Data (Delete all data)',
  'import-confirm': 'Import: the confirmation step (Keep current focused)',
  'import-replaced': 'Import: the board replaced',
  'recovery-notice':
    'The board-recovery slip at the foot, after the board was replaced behind the window (it says the reload too: one slip)',
  'opening-catch-up': 'The board opening, still catching up (the whole board held back)',
} as const
type State = keyof typeof STATES

/**
 * What the 1440 × 900 @2x viewport writes (about 6 MB a shot): the screens whose fine detail a
 * dense display shows: the notes, deckle, pins and yarn; the sheets' controls; the editor's text;
 * a form; the wordmark.
 */
const LAPTOP_SUBSET: readonly State[] = [
  'board-30',
  'new-note-sheet',
  'search-results',
  'typing',
  'settings-export',
]

/** What the tablet writes: one of each kind of screen, laid out at 1024 × 768. */
const TABLET_SUBSET: readonly State[] = [
  'empty-board',
  'board-30',
  'multi-select',
  'new-note-sheet',
  'new-thread-sheet',
  'search-results',
  'focus-depth-2',
  'far-zoom-overview',
  'typing',
  'photo-uploading',
  'dropped-notice',
  'settings-export',
  'settings-history',
  'import-confirm',
]

const written = (vp: Viewport['name'], state: State): boolean => {
  if (vp === 'laptop2x') return LAPTOP_SUBSET.includes(state)
  if (vp === 'tablet') return TABLET_SUBSET.includes(state)
  return true
}

/** The page's fonts and images are in. */
async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await document.fonts.ready
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
  })
}

/** Each window's DevTools session: its scale is set and its frames are asked for through it. */
const sessions = new WeakMap<Page, CDPSession>()

async function sessionOf(page: Page): Promise<CDPSession> {
  let cdp = sessions.get(page)
  if (cdp === undefined) {
    cdp = await page.context().newCDPSession(page)
    sessions.set(page, cdp)
  }
  return cdp
}

/** A Papertie of `desktop`'s on data of its own: its window at `vp`, motion reduced. */
async function windowAt(desktop: Desktop, vp: Viewport): Promise<Page> {
  const { width, height, scale } = vp.frame
  const { page } = await desktop.launch({ viewport: { width, height } })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // The scale said outright: left to the window, it is the display's.
  await (await sessionOf(page)).send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  })
  return page
}

/**
 * The window's frame as a PNG, the caret hidden unless asked for. Asked of Chromium itself:
 * Playwright's screenshot sets the window's metrics anew for each (a dense window goes back to
 * one device pixel a CSS px, a drag under way is let go).
 */
async function frameOf(page: Page, caret = false): Promise<Buffer> {
  const cdp = await sessionOf(page)
  const size = page.viewportSize()
  if (size === null) throw new Error('a window of no set size')
  // A constructed sheet: the app's policy allows no style element.
  const hidden = caret
    ? null
    : await page.evaluateHandle(() => {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync('* { caret-color: transparent !important }')
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        return sheet
      })
  try {
    // The window's own size, at its scale: the surface behind it may be denser.
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, ...size, scale: 1 },
    })
    return Buffer.from(data, 'base64')
  } finally {
    if (hidden !== null) {
      await page.evaluate((sheet) => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet)
      }, hidden)
      await hidden.dispose()
    }
  }
}

/**
 * The state's screenshot, once the page is still: animations ended, fonts in, camera at rest.
 * `still` runs as soon as the frame is taken (a state that passes by itself is checked then).
 */
async function shot(
  page: Page,
  vp: Viewport,
  state: State,
  o: { caret?: boolean; still?: () => Promise<void> } = {},
) {
  await settle(page)
  await fontsReady(page)
  if (await page.evaluate(() => window.__papertie?.runtime !== undefined)) await idle(page)
  await settle(page)
  const png = written(vp.name, state) ? await frameOf(page, o.caret) : null
  await o.still?.()
  if (png === null) return
  const name = `${vp.name}-${state}`
  mkdirSync(ORIGINALS, { recursive: true })
  writeFileSync(path.join(ORIGINALS, `${name}.png`), await pngLossless(png))
  mkdirSync(OUT, { recursive: true })
  const quality = covered(state) ? QUALITY_SHEET : QUALITY_CORK
  writeFileSync(path.join(OUT, `${name}.webp`), await webpFrom(png, quality))
}

/** What the live region says now (its toggled trailing space left out). */
const said = (page: Page) =>
  page.evaluate(
    () => document.querySelector('[data-live-region]')?.textContent?.replace(/[\s ]+$/, '') ?? '',
  )

const noteIds = (page: Page) =>
  page.evaluate(() => [...window.__papertie.store.getState().notes.keys()])

type Feed = {
  status(s: string): void
  notice(n: { kind: string; count: number; message: string }): void
  clearNotices(): void
}
/** The board's centre in world px (the 30-note grid). */
const CENTRE = { x: (5 * 340 + 220) / 2, y: (4 * 300 + 160) / 2 }

for (const vp of VIEWPORTS) {
  test.describe(`gallery at ${vp.name}`, () => {
    // ── A new board ────────────────────────────────────────────────────────────────────────

    test(`${vp.name}: empty-board`, async ({ desktop }) => {
      const page = await windowAt(desktop, vp)
      await firstRun(apiFor(page))
      await openBoard(page)
      await saved(page)
      // The welcome note goes: the empty hint shows.
      const id = await page.locator('article.note').first().getAttribute('data-note-id')
      const p = await paperPoint(page, id ?? '')
      await page.mouse.click(p.x, p.y)
      await page.keyboard.press('Delete')
      await expect(page.getByRole('complementary', { name: 'Empty board' })).toBeVisible()
      await shot(page, vp, 'empty-board')
    })

    // ── The board with 30 notes ────────────────────────────────────────────────────────────

    test.describe('the board with 30 notes', () => {
      // One window and one seeded board for every state here, in order.
      test.describe.configure({ mode: 'serial' })
      const shared = sharedDesktop()
      let page: Page
      let ids: string[] = []

      const reading = async () => {
        await page.evaluate((c) => window.__papertie.debug.setCamera(c), READING)
        await idle(page)
      }

      test.beforeAll(async () => {
        test.setTimeout(120_000)
        page = await windowAt(shared.desktop, vp)
        const seeded = board30()
        ids = seeded.notes.map((n) => n.id)
        const boardId = await seedBoard(apiFor(page), seeded.ops)
        // The board opens at reading zoom.
        await page.addInitScript(([key, cam]) => localStorage.setItem(key, JSON.stringify(cam)), [
          `papertie.camera.${boardId}`,
          READING,
        ] as const)
        await openBoard(page)
        await saved(page)
        await reading()
      })

      test.afterAll(async () => {
        await shared.end()
      })

      /**
       * The board opened again, for a route set just before: a route catches the requests of
       * the documents loaded after it, none of one already loaded.
       */
      const reopen = async () => {
        await openBoard(page)
        await saved(page)
        await reading()
      }

      const select = async (i: number, add = false) => {
        const p = await paperPoint(page, ids[i] as string)
        if (add) await page.keyboard.down('Shift')
        await page.mouse.click(p.x, p.y)
        if (add) await page.keyboard.up('Shift')
      }
      const clear = async () => {
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')
        await expect
          .poll(() => page.evaluate(() => window.__papertie.runtime.selection.size))
          .toBe(0)
      }
      const dot = () => page.getByTestId('save-dot')
      /** A nudge of note 7, one step right (`back`: left), and the selection cleared. */
      const nudge = async (back = false) => {
        await select(7)
        await page.keyboard.press(back ? 'Alt+ArrowLeft' : 'Alt+ArrowRight')
        await clear()
      }
      /** The note "+" pins at the middle of the view, being written on. */
      const newNote = async (): Promise<string> => {
        const before = await noteIds(page)
        await tools(page).getByRole('button', { name: 'New note' }).click()
        await page
          .getByRole('dialog', { name: 'New note' })
          .getByRole('button', { name: 'Pin note' })
          .click()
        await expect(page.locator('[contenteditable]').first()).toBeFocused()
        const id = (await noteIds(page)).find((k) => !before.includes(k))
        if (id === undefined) throw new Error('no new note')
        return id
      }
      /** Delete `id` from the selection's tools. */
      const remove = async (id: string) => {
        await page.evaluate((id) => window.__papertie.runtime.selectNotes([id]), id)
        await tools(page)
          .getByRole('group', { name: 'Selection' })
          .getByRole('button', { name: 'Delete' })
          .click()
        await expect(page.locator(`article.note[data-note-id="${id}"]`)).toHaveCount(0)
        await saved(page)
      }

      test(`${vp.name}: board-30`, async () => {
        // The notes near the view are mounted.
        await expect(page.getByRole('article', { name: 'Spring trip' })).toBeVisible()
        await expect(page.getByRole('article', { name: 'Maps offline' })).toBeVisible()
        await shot(page, vp, 'board-30')
      })

      test(`${vp.name}: one-selected`, async () => {
        await select(1)
        await expect(tools(page).getByRole('group', { name: 'Selection' })).toBeVisible()
        await shot(page, vp, 'one-selected')
        await clear()
      })

      test(`${vp.name}: multi-select`, async () => {
        await select(1)
        await select(6, true)
        await select(7, true)
        await expect(page.locator('article.note.note--selected')).toHaveCount(3)
        await expect.poll(() => said(page)).toBe('Selected 3 notes')
        await shot(page, vp, 'multi-select')
        await clear()
      })

      test(`${vp.name}: new-note-sheet`, async () => {
        await tools(page).getByRole('button', { name: 'New note' }).click()
        await expect(page.getByRole('dialog', { name: 'New note' })).toBeVisible()
        await shot(page, vp, 'new-note-sheet')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'New note' })).toHaveCount(0)
      })

      test(`${vp.name}: new-thread-sheet`, async () => {
        await tools(page).getByRole('button', { name: 'Yarn' }).click()
        await expect(page.getByRole('dialog', { name: 'New thread' })).toBeVisible()
        await shot(page, vp, 'new-thread-sheet')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'New thread' })).toHaveCount(0)
      })

      test(`${vp.name}: save-popover`, async () => {
        await select(7)
        await page.keyboard.press('Alt+ArrowRight')
        await expect(dot()).toHaveAttribute('data-shown', 'true')
        await dot().click()
        await expect(page.getByRole('dialog', { name: 'Save status' })).toBeVisible()
        await shot(page, vp, 'save-popover')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: 'Save status' })).toHaveCount(0)
        await saved(page)
        await clear()
      })

      test(`${vp.name}: search-results`, async () => {
        await page.keyboard.press('ControlOrMeta+k')
        const search = page.getByRole('dialog', { name: 'Search notes' })
        await expect(search).toBeVisible()
        await page.keyboard.type('trip')
        await expect(search.getByRole('option').first()).toBeVisible()
        await expect(search.getByRole('status')).toHaveText('1 note')
        await shot(page, vp, 'search-results')
        await page.keyboard.press('Escape')
        await expect(search).toHaveCount(0)
      })

      test(`${vp.name}: focus-depth-2`, async () => {
        await select(1)
        await page.keyboard.press('f')
        const chip = page.getByRole('toolbar', { name: 'Focus' })
        await expect(chip).toContainText('1 step')
        await chip.getByRole('button', { name: 'More steps' }).click()
        await expect(chip).toContainText('2 steps')
        await expect
          .poll(() => page.evaluate(() => window.__papertie.runtime.focus?.notes.size))
          .toBe(3)
        await shot(page, vp, 'focus-depth-2')
        await page.keyboard.press('Escape')
        await expect
          .poll(() => page.evaluate(() => window.__papertie.runtime.focusState))
          .toBeNull()
        await clear()
      })

      for (const [state, zoom, lod] of [
        ['far-zoom-lite', 0.25, 'lite'],
        ['far-zoom-overview', 0.1, 'overview'],
      ] as const) {
        test(`${vp.name}: ${state}`, async () => {
          const { width, height } = vp.frame
          await page.evaluate((c) => window.__papertie.debug.setCamera(c), {
            x: CENTRE.x - width / 2 / zoom,
            y: CENTRE.y - height / 2 / zoom,
            zoom,
          })
          await idle(page)
          await expect.poll(() => page.evaluate(() => window.__papertie.debug.lod())).toBe(lod)
          await shot(page, vp, state)
        })
      }

      test(`${vp.name}: place-free`, async () => {
        // The grid's last columns at the left quarter of the view: cork in the middle.
        const { width } = vp.frame
        const { zoom } = READING
        await page.evaluate((c) => window.__papertie.debug.setCamera(c), {
          x: 1920 - (0.25 * width) / zoom,
          y: READING.y,
          zoom,
        })
        await idle(page)
        const middle = await page.evaluate(() => {
          const v = (
            window.__papertie.runtime as unknown as {
              safeViewport(): { x: number; y: number; w: number; h: number }
            }
          ).safeViewport()
          return window.__papertie.debug.screenToWorld({ x: v.x + v.w / 2, y: v.y + v.h / 2 })
        })
        const id = await newNote()
        await page.keyboard.type('Ask the inn about late check-in')
        const n = await page.evaluate((id) => window.__papertie.store.getState().notes.get(id), id)
        expect(Math.abs((n?.x ?? 0) + (n?.w ?? 0) / 2 - middle.x)).toBeLessThanOrEqual(1)
        expect(Math.abs((n?.y ?? 0) + (n?.h ?? 0) / 2 - middle.y)).toBeLessThanOrEqual(1)
        await shot(page, vp, 'place-free', { caret: true })
        await page.keyboard.press('Escape')
        await remove(id)
        await reading()
      })

      test(`${vp.name}: typing`, async () => {
        await reading()
        const id = await newNote()
        const field = page.locator('[contenteditable]').first()
        await page.keyboard.type('Ask about the night train to Lisbon')
        await expect(field).toContainText('Ask about the night train to Lisbon')
        await shot(page, vp, 'typing', { caret: true })
        await page.keyboard.press('Escape')
        await remove(id)
      })

      test(`${vp.name}: photo-uploading`, async () => {
        await reading()
        // The upload is held on its way to the store: the shot is taken with its line showing.
        let letGo = () => {}
        const held = new Promise<void>((r) => {
          letGo = r
        })
        await page.route(
          (url) => /\/api\/boards\/[^/]+\/assets$/.test(url.pathname),
          async (route) => {
            if (route.request().method() !== 'POST') return route.continue()
            await held
            await route.continue().catch(() => {})
          },
        )
        await reopen()
        const before = await noteIds(page)
        // A photo-like PNG (noise, so it stays a few hundred KB), pasted as a screenshot would be.
        await page.evaluate(async () => {
          const c = document.createElement('canvas')
          c.width = 480
          c.height = 320
          const g = c.getContext('2d') as CanvasRenderingContext2D
          const img = g.createImageData(480, 320)
          let seed = 7
          for (let i = 0; i < img.data.length; i += 4) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff
            const n = seed % 48
            img.data[i] = 46 + n
            img.data[i + 1] = 75 + n
            img.data[i + 2] = 122 + n
            img.data[i + 3] = 255
          }
          g.putImageData(img, 0, 0)
          g.fillStyle = '#f4dedc'
          g.beginPath()
          g.arc(240, 160, 90, 0, Math.PI * 2)
          g.fill()
          const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
          const dt = new DataTransfer()
          dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }))
          ;(document.activeElement as HTMLElement | null)?.blur()
          document.body.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
          )
        })
        const bar = page.getByRole('progressbar', { name: 'Adding photo' })
        await expect(bar).toBeVisible()
        await shot(page, vp, 'photo-uploading')
        await expect(bar).toBeVisible()
        letGo()
        const print = (await noteIds(page)).find((k) => !before.includes(k))
        if (print === undefined) throw new Error('no print note')
        await expect(page.locator(`article.note[data-note-id="${print}"] img`)).toBeVisible({
          timeout: 30_000,
        })
        await expect(page.getByRole('progressbar', { name: 'Adding photo' })).toHaveCount(0)
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await page.keyboard.press('Escape')
        await remove(print)
      })

      test(`${vp.name}: dropped-notice`, async () => {
        // What the sync client tells the feed when a waiting change no longer applies to the
        // board (the board replaced under it).
        const message = droppedMessage(1)
        await page.evaluate((message) => {
          const f = (window.__papertie as unknown as { session: { feed: Feed } }).session.feed
          f.notice({ kind: 'dropped', count: 1, message })
        }, message)
        const notices = page.getByRole('region', { name: 'Notices' })
        await expect(notices.getByRole('note')).toContainText(message)
        await shot(page, vp, 'dropped-notice')
        await notices.getByRole('button', { name: 'Dismiss' }).click()
        await expect(notices.getByRole('note')).toHaveCount(0)
        await page.evaluate(() =>
          (window.__papertie as unknown as { session: { feed: Feed } }).session.feed.clearNotices(),
        )
      })

      test(`${vp.name}: save-saving and save-saved`, async () => {
        // The batch is held on its way to the store: the dot says Saving….
        let letGo = () => {}
        const held = new Promise<void>((r) => {
          letGo = r
        })
        const ops = /\/api\/boards\/[^/]+\/ops$/
        await page.route(
          (url) => ops.test(url.pathname),
          async (route) => {
            if (route.request().method() !== 'POST') return route.continue()
            await held
            await route.continue().catch(() => {})
          },
        )
        await reopen()
        await nudge()
        await expect(dot()).toHaveAttribute('data-status', 'saving')
        await expect(dot()).toHaveAttribute('data-shown', 'true')
        await shot(page, vp, 'save-saving')
        // Let through: Saved, for 1.5 s.
        letGo()
        await expect(dot()).toHaveAttribute('data-status', 'saved')
        await expect(dot()).toHaveAttribute('data-shown', 'true')
        // Still shown once taken: the shot is of Saved, not of the dot at rest.
        await shot(page, vp, 'save-saved', {
          still: () => expect(dot()).toHaveAttribute('data-shown', 'true', { timeout: 0 }),
        })
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await saved(page)
      })

      test(`${vp.name}: save-error`, async () => {
        // The dot's Couldn't save, as the sync client tells the feed when a change is refused
        // for a reason it cannot mend (not reachable from here without breaking the store).
        await page.evaluate(() =>
          (window.__papertie as unknown as { session: { feed: Feed } }).session.feed.status(
            'error',
          ),
        )
        await expect(dot()).toHaveAttribute('data-status', 'error')
        await expect(page.getByRole('status').filter({ hasText: 'Couldn’t save' })).toHaveCount(1)
        await shot(page, vp, 'save-error')
        await page.evaluate(() =>
          (window.__papertie as unknown as { session: { feed: Feed } }).session.feed.status(
            'saved',
          ),
        )
        await saved(page)
      })

      for (const section of SECTIONS) {
        test(`${vp.name}: settings-${section}`, async () => {
          await page.goto(`${APP_URL}/settings/${section}?bench`)
          await sectionShown(page, section)
          await shot(page, vp, `settings-${section}`)
        })
      }

      test(`${vp.name}: import-confirm and import-replaced`, async () => {
        await openBoard(page)
        await saved(page)
        const boardId = await onlyBoard(apiFor(page))
        const file = await exportJsonl(apiFor(page), boardId)
        const { settings, ask } = await importAsking(page, file)
        await shot(page, vp, 'import-confirm')
        await ask.getByRole('button', { name: 'Replace board' }).click()
        await expect(
          settings.getByText('Board replaced. You can undo this from History.'),
        ).toBeVisible()
        await shot(page, vp, 'import-replaced')
      })

      test(`${vp.name}: recovery-notice`, async () => {
        // The board replaced through the app's routes, with no sheet of the window's to say it:
        // the window hears of it and says it in one recovery slip (it says the reload too).
        await openBoard(page)
        await saved(page)
        const api = apiFor(page)
        const boardId = await onlyBoard(api)
        const file = await exportJsonl(api, boardId)
        const preview = await api.post(`/api/boards/${boardId}/import`, {
          headers: { Origin: APP_URL },
          multipart: {
            file: {
              name: 'board.jsonl',
              mimeType: 'application/x-ndjson',
              buffer: Buffer.from(file),
            },
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
        const notices = page.locator('.sync-notices [role="note"]')
        await expect(notices).toHaveCount(1, { timeout: 15_000 })
        await shot(page, vp, 'recovery-notice')
      })

      test(`${vp.name}: opening-catch-up`, async () => {
        const release = await heldOpening(page)
        await shot(page, vp, 'opening-catch-up')
        await release()
      })
    })
  })
}

// ── Books: the shelf and the writer ─────────────────────────────────────────────────────────

/** The books' committed gallery: WebP, the scroll recording and the index. */
const BOOK_OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots', 'books')

const BOOK_STATES = {
  'board-books': 'The board with Books in its tools: beside Settings in the sidebar',
  'shelf-12':
    'The shelf with twelve books, covers face-out, "New book" at the end of the last shelf',
  'shelf-options': "A book's options on the shelf (Rename, New cover, Delete)",
  'shelf-recently-deleted': '"Recently deleted" at the shelf’s end, opened: two books to put back',
  'shelf-waiting':
    'The shelf while the board is still coming in (Papertie opened again into a book, the whole board held back, Books pressed): the empty wood, waiting',
  'chapter-page':
    'A chapter page: the chapter label, title and red rule, body text with italic and bold, a quote, a section, a list',
  popover: 'A selected word: the sidebar’s writing tools for it',
  'writer-reload': '"Papertie needs a reload to keep saving." and Reload, over the writer',
} as const
type BookState = keyof typeof BOOK_STATES

/** What the 1440 × 900 @2x viewport writes: the covers' and the page's fine detail. */
const BOOK_LAPTOP: readonly BookState[] = ['shelf-12', 'chapter-page', 'popover']
const bookWritten = (vp: Viewport['name'], state: BookState) =>
  vp !== 'laptop2x' || BOOK_LAPTOP.includes(state)
/** The shelf is wood, quality as the cork; the writer is paper and text. */
const bookQuality = (state: BookState) => (state.startsWith('shelf') ? QUALITY_CORK : QUALITY_SHEET)
/** The shots this run took (the index is written only when some were). */
const bookShots = new Set<string>()

async function bookShot(page: Page, vp: Viewport, state: BookState, images = true) {
  await settle(page)
  if (images) await fontsReady(page)
  else await page.evaluate(() => document.fonts.ready)
  await settle(page)
  if (!bookWritten(vp.name, state)) return
  const png = await frameOf(page)
  const name = `${vp.name}-${state}`
  mkdirSync(ORIGINALS, { recursive: true })
  writeFileSync(path.join(ORIGINALS, `books-${name}.png`), await pngLossless(png))
  mkdirSync(BOOK_OUT, { recursive: true })
  writeFileSync(path.join(BOOK_OUT, `${name}.webp`), await webpFrom(png, bookQuality(state)))
  bookShots.add(name)
}

/** The chapter the page shows: a writer's first chapter, set in every kind the writer has. */
const CHAPTER: BookBlock[] = [
  { kind: 'h1', text: 'On collecting' },
  {
    text: 'Who writes thinks twice: once while reading, when a sentence stays, and once while ordering, when it comes to lie beside another. The first time is quick and almost careless; the second is slow.',
    marks: [{ t: 'i', from: 25, to: 29 }],
  },
  {
    text: 'A card holds one thought and no more. It is small on purpose, so that it can be moved, and moved again, until it finds the company it belongs in.',
  },
  { kind: 'quote', text: '“To remember is to connect. What stays alone, we forget.”' },
  { kind: 'h2', text: 'The card as a partner in conversation' },
  {
    text: 'The cards do not lie in a drawer; they hang side by side, in plain view, and sometimes they answer one another. A thread tied between two of them is a question asked out loud.',
    marks: [{ t: 'b', from: 39, to: 56 }],
  },
  { kind: 'li', text: 'a card for every thought' },
  { kind: 'li', text: 'a thread for every link' },
  { kind: 'li', text: 'a chapter for every knot that holds' },
  {
    text: 'What the board holds, the page tells in order. The words find their places slowly, as paper finds its fold, and the book grows the way a shelf fills: one spine at a time.',
  },
]

/**
 * Twelve books on the board, through the API, in shelf order (`TITLES`, the covers
 * `seedBooks` draws): the first, "Field notes", holds {@link CHAPTER}, the rest one empty
 * paragraph each. Returns their ids.
 */
async function seedShelf(page: Page, boardId: string): Promise<string[]> {
  const at = new Date().toISOString()
  const shelf = posKeysBetween(null, null, TITLES.length)
  const ids = TITLES.map(() => newId('book'))
  const ops: unknown[] = []
  TITLES.forEach((title, i) => {
    const id = ids[i] as string
    ops.push({
      op: 'book.create',
      book: {
        type: 'book',
        id,
        title,
        lang: 'en',
        shelfPos: shelf[i],
        cover: coverFromSeed((i * 2_654_435_761 + 97) >>> 0),
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    })
    const blocks: BookBlock[] = i === 0 ? CHAPTER : [{ text: '' }]
    const keys = posKeysBetween(null, null, blocks.length)
    blocks.forEach((b, k) => {
      ops.push({
        op: 'block.create',
        block: {
          type: 'block',
          id: newId('block'),
          bookId: id,
          pos: keys[k],
          kind: b.kind ?? 'p',
          text: b.text,
          marks: b.marks ?? [],
        },
      })
    })
  })
  await opsOn(page, boardId, ops)
  return ids
}

const shelfOf = (page: Page) => page.getByRole('dialog', { name: 'Books' })

for (const vp of VIEWPORTS) {
  test.describe(`books gallery at ${vp.name}`, () => {
    test.describe.configure({ mode: 'serial' })
    const shared = sharedDesktop()
    let page: Page
    let boardId = ''
    let ids: string[] = []

    test.beforeAll(async () => {
      test.setTimeout(120_000)
      page = await windowAt(shared.desktop, vp)
      await firstRun(apiFor(page))
      await openBoard(page)
      boardId = await onlyBoard(apiFor(page))
      ids = await seedShelf(page, boardId)
      await saved(page)
    })

    test.afterAll(async () => {
      await shared.end()
    })

    test(`books ${vp.name}: board-books`, async () => {
      await expect(tools(page).getByRole('button', { name: 'Books' })).toBeVisible()
      await bookShot(page, vp, 'board-books')
    })

    test(`books ${vp.name}: shelf-12`, async () => {
      await page.goto(`${APP_URL}/shelf`)
      await expect(shelfOf(page).locator('.cover')).toHaveCount(12)
      await expect(shelfOf(page).getByRole('button', { name: 'New book' })).toBeVisible()
      await bookShot(page, vp, 'shelf-12')
    })

    test(`books ${vp.name}: shelf-options`, async () => {
      const options = shelfOf(page).getByRole('button', { name: 'Options for Field notes' })
      // The options show on hover.
      await shelfOf(page).getByRole('button', { name: 'Field notes', exact: true }).hover()
      await options.click()
      const pop = page.getByRole('dialog', { name: 'Field notes' })
      await expect(pop.getByRole('button', { name: 'Delete' })).toBeVisible()
      await bookShot(page, vp, 'shelf-options')
      await page.keyboard.press('Escape')
      await expect(pop).toHaveCount(0)
    })

    test(`books ${vp.name}: chapter-page`, async () => {
      await page.goto(`${APP_URL}/book/${ids[0]}?bench`)
      const h1 = page.locator('.writer h1.bk-h1')
      await expect(h1).toHaveText('On collecting')
      await expect(page.locator('.writer blockquote')).toBeVisible()
      await bookShot(page, vp, 'chapter-page')
    })

    test(`books ${vp.name}: popover`, async () => {
      // "conversation" in the section heading, selected (as a double-click leaves it): the
      // sidebar's writing tools for it.
      await page.evaluate(() => {
        const h2 = document.querySelector('.writer h2.bk-h2') as HTMLElement
        h2.scrollIntoView({ block: 'center' })
        const t = h2.firstChild as Text
        const at = t.data.indexOf('conversation')
        document.getSelection()?.setBaseAndExtent(t, at, t, at + 'conversation'.length)
      })
      const pop = writing(page)
      await expect(pop).toBeInViewport()
      await expect(pop.getByRole('button', { name: 'Bold' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      )
      // Whole on the screen.
      const box = await pop.boundingBox()
      const { width } = vp.frame
      expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true)
      await bookShot(page, vp, 'popover')
      await page.evaluate(() => document.getSelection()?.removeAllRanges())
    })

    test(`books ${vp.name}: writer-reload`, async () => {
      // What the sync client says when this page can send nothing more until it is reloaded
      // (`reloadMessage`), over the writer.
      const message = reloadMessage()
      await page.evaluate((message) => {
        const f = (window.__papertie as unknown as { session: { feed: Feed } }).session.feed
        f.notice({ kind: 'updated', count: 0, message })
      }, message)
      const slip = page.locator('.sync-updated [role="note"]')
      await expect(slip).toContainText(message)
      await expect(slip.getByRole('button', { name: 'Reload' })).toBeVisible()
      await bookShot(page, vp, 'writer-reload')
      await page.reload()
      await expect(page.locator('.sync-updated')).toHaveCount(0)
    })

    test(`books ${vp.name}: shelf-recently-deleted`, async () => {
      const at = new Date().toISOString()
      await opsOn(page, boardId, [
        { op: 'book.update', id: ids[1], set: { trashedAt: at } },
        { op: 'book.update', id: ids[7], set: { trashedAt: at } },
      ])
      await page.goto(`${APP_URL}/shelf`)
      await expect(shelfOf(page).locator('.cover')).toHaveCount(10)
      await shelfOf(page).getByRole('button', { name: 'Recently deleted' }).click()
      const trash = page.getByRole('dialog', { name: 'Recently deleted' })
      await expect(trash.getByRole('listitem')).toHaveCount(2)
      await bookShot(page, vp, 'shelf-recently-deleted')
      await page.keyboard.press('Escape')
      await expect(trash).toHaveCount(0)
    })

    test(`books ${vp.name}: shelf-waiting`, async () => {
      test.setTimeout(120_000)
      // Papertie opened again into the book it was left in, the whole board held back (a large
      // board): the writer waits for the book, and the shelf, opened from it, waits empty until
      // the board has every book.
      await page.goto(`${APP_URL}/book/${ids[0]}?bench`)
      await expect(page.locator('.writer h1.bk-h1')).toHaveText('On collecting')
      const release = await holdBoard(page)
      // Opened again (at the board): it goes to the book left open.
      await page.goto(`${APP_URL}/?bench`)
      await expect(page).toHaveURL(new RegExp(`/book/${ids[0]}$`))
      await page.locator('.writer-band').getByRole('button', { name: 'Books' }).click()
      await expect(shelfOf(page)).toBeVisible()
      await page.waitForTimeout(1500)
      await expect(shelfOf(page).locator('.cover')).toHaveCount(0)
      await expect(shelfOf(page).getByRole('button', { name: 'New book' })).toHaveCount(0)
      await bookShot(page, vp, 'shelf-waiting', false)
      await release()
      // Then every book at once.
      await expect(shelfOf(page).getByRole('button', { name: 'New book' })).toBeVisible({
        timeout: 30_000,
      })
      expect(await shelfOf(page).locator('.cover').count()).toBeGreaterThanOrEqual(10)
    })
  })
}

/**
 * The window's screencast while `act` runs, as a VP9 WebM at `out`, `width` px wide: 30 frames a
 * second, each frame shown until the next came (the screencast sends one only when the window
 * changed), encoded by this machine's ffmpeg (CRF 52). The frames are kept in `dir`.
 */
async function record(
  page: Page,
  o: { dir: string; out: string; width: number },
  act: () => Promise<void>,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  const frames: Array<{ at: number; data: string }> = []
  cdp.on('Page.screencastFrame', (f) => {
    // Timed as they come (the screencast's own stamps are on another clock than the stop's).
    frames.push({ at: Date.now() / 1000, data: f.data })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 })
  await act()
  const stopped = Date.now() / 1000
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  if (frames.length < 10) throw new Error(`only ${frames.length} frames recorded`)
  rmSync(o.dir, { recursive: true, force: true })
  mkdirSync(o.dir, { recursive: true })
  const first = (frames[0] as { at: number }).at
  const total = Math.round((stopped - first) * 30)
  let k = 0
  for (let n = 0; n < total; n++) {
    const t = first + n / 30
    while (k + 1 < frames.length && (frames[k + 1] as { at: number }).at <= t) k++
    const f = frames[k] as { data: string }
    writeFileSync(
      path.join(o.dir, `frame-${String(n).padStart(5, '0')}.jpg`),
      Buffer.from(f.data, 'base64'),
    )
  }
  mkdirSync(path.dirname(o.out), { recursive: true })
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-framerate',
    '30',
    '-i',
    path.join(o.dir, 'frame-%05d.jpg'),
    '-vf',
    `scale=${o.width}:-2`,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '52',
    '-row-mt',
    '1',
    '-an',
    o.out,
  ])
}

/** The long-book scroll recording: a 200,000-word book read from its start, at a reader's pace. */
/** The long-book scroll recording: a 200,000-word book read from its start, at a reader's pace. */
test('books wide: long-book-scroll (a recording)', async ({ page }) => {
  test.setTimeout(300_000)
  await firstRun(apiFor(page))
  await openBoard(page)
  const board = await onlyBoard(apiFor(page))
  const bookId = newId('book')
  const at = new Date().toISOString()
  await opsOn(page, board, [
    {
      op: 'book.create',
      book: {
        type: 'book',
        id: bookId,
        title: 'A lifetime',
        lang: 'en',
        shelfPos: posKeysBetween(null, null, 1)[0],
        cover: { seed: 11, ink: 'ink', motif: 'fields' },
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    },
    ...genBookBlocks({ seed: 1, words: 200_000, bookId }).map((block) => ({
      op: 'block.create',
      block,
    })),
  ])
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(page.locator('.writer-body[data-shown] [data-id]').first()).toBeVisible({
    timeout: 60_000,
  })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(1000)
  await record(
    page,
    {
      dir: path.join(ORIGINALS, 'books-video'),
      out: path.join(BOOK_OUT, 'wide-long-book-scroll.webm'),
      width: 1280,
    },
    // Eight seconds down from the start, 6 px a frame (a reader's pace), then a flick far on.
    () =>
      page.evaluate(async () => {
        const sc = document.querySelector('.writer-scroll') as HTMLElement
        const run = (px: number, ms: number) =>
          new Promise<void>((done) => {
            const start = performance.now()
            const tick = (t: number) => {
              sc.scrollTop += px
              if (t - start < ms) requestAnimationFrame(tick)
              else done()
            }
            requestAnimationFrame(tick)
          })
        await run(6, 8000)
        await run(120, 3000)
        await new Promise((r) => setTimeout(r, 800))
      }),
  )
  bookShots.add('wide-long-book-scroll')
})

test.afterAll(() => {
  if (!process.env.GALLERY || bookShots.size === 0) return
  const lines = [
    '# Books: the shelf and the writer',
    '',
    'The shelf, the covers and the writer.',
    'Written by `e2e/app/gallery.spec.ts`; regenerate with',
    '`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g books`.',
    'Motion reduced, fonts loaded, nothing moving.',
    '',
    `The images are WebP: quality ${QUALITY_CORK} for the shelf (wood), ${QUALITY_SHEET} for the writer (paper and`,
    'text). Each lossless original is kept beside the spec, in',
    '`e2e/artifacts/gallery/books-<viewport>-<state>.png` (not committed).',
    '',
    'Every state is reached at every viewport; `laptop2x` writes the covers’ and the page’s fine',
    'detail only.',
    '',
    '| File | Viewport | State |',
    '| --- | --- | --- |',
  ]
  for (const v of VIEWPORTS)
    for (const [state, what] of Object.entries(BOOK_STATES) as [BookState, string][]) {
      if (!bookWritten(v.name, state)) continue
      const file = `${v.name}-${state}.webp`
      lines.push(`| [${file}](${file}) | ${v.label} | \`${state}\`: ${what} |`)
    }
  lines.push(
    '| [wide-long-book-scroll.webm](wide-long-book-scroll.webm) | 1280 × 800 | `long-book-scroll`: a 200,000-word book scrolled from its start at a reader’s pace, then flicked far on (a recording, VP9; made with ffmpeg) |',
  )
  lines.push('')
  mkdirSync(BOOK_OUT, { recursive: true })
  writeFileSync(path.join(BOOK_OUT, 'index.md'), lines.join('\n'))
})

// ── Split: the board and the book side by side ──────────────────────────────────────────────

/** The split view's committed gallery: WebP, the recording and the index. */
const SPLIT_OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots', 'split')

const SPLIT_STATES = {
  split: 'The split view: a chapter page beside the live board (the seam between them)',
  'seam-drag': 'The seam mid-drag (the sheet’s width held while it moves)',
  'card-drag-copy': 'A card mid-drag over the page: its ghost and the crimson gap line (a copy)',
  'card-drag-move': 'The same drag with ⌥ held: the ghost reads Move',
  chooser: 'The chooser after a drop: Paragraph · Quote · Prompt, with their keys',
  'pins-peek': 'A paragraph from two cards: two brass pins in the margin, one peek open',
  'pin-faded': 'A faded pin: its card was deleted (the peek says so)',
  'prompts-margin': 'Prompts in the right margin (Patrick Hand, pencil), on a wide page',
  'prompts-inline': 'Prompts inline, under their paragraph, on a narrow pane',
  figure: 'A figure: the photo at the measure, its caption under it',
  'reverse-mark': 'The reverse mark (a small ink dot) on a used card, and its list',
  find: 'The find bar with matches, the current one in a crimson wash',
  'top-band': 'The writer’s top band: Books; Find, Insert card and Board',
  'copy-move': 'The tablet’s Copy · Move chip after a long press on a card',
} as const
type SplitState = keyof typeof SPLIT_STATES

/** Where each state is shot. */
const SPLIT_AT: Record<SplitState, readonly Viewport['name'][]> = {
  split: ['wide', 'laptop2x', 'tablet'],
  'seam-drag': ['wide'],
  'card-drag-copy': ['wide', 'laptop2x'],
  'card-drag-move': ['wide'],
  chooser: ['wide', 'laptop2x', 'tablet'],
  'pins-peek': ['wide', 'laptop2x'],
  'pin-faded': ['wide'],
  'prompts-margin': ['wide'],
  'prompts-inline': ['tablet'],
  figure: ['wide'],
  'reverse-mark': ['wide', 'laptop2x'],
  find: ['wide', 'laptop2x'],
  'top-band': ['wide'],
  'copy-move': ['tablet'],
}
const splitShots = new Set<string>()

async function splitShot(page: Page, vp: Viewport['name'], state: SplitState) {
  await settle(page)
  await fontsReady(page)
  await settle(page)
  const png = await frameOf(page)
  const name = `${vp}-${state}`
  mkdirSync(ORIGINALS, { recursive: true })
  writeFileSync(path.join(ORIGINALS, `split-${name}.png`), await pngLossless(png))
  mkdirSync(SPLIT_OUT, { recursive: true })
  writeFileSync(path.join(SPLIT_OUT, `${name}.webp`), await webpFrom(png, QUALITY_SHEET))
  splitShots.add(name)
}

/** The board's cards the book is made from, and the book. */
interface SplitSeed {
  boardId: string
  bookId: string
  /** "Lantern festival": a card the book uses (two pins share its paragraph with `paper`). */
  lantern: string
  paper: string
  /** A card not yet in the book, to drag in. */
  loose: string
  photo: string
  /** The paragraphs: from two cards, from a deleted card, and the figure. */
  twoPins: string
  faded: string
}

/** The board around its welcome card: the cards, a photo; the book "Field notes" made of them. */
async function seedSplit(page: Page, boardId: string): Promise<SplitSeed> {
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { type: string; id: string; x: number; y: number; rev?: number })
    .find((r) => r.type === 'note')
  if (welcome === undefined) throw new Error('no welcome card')
  const { rev: _rev, ...base } = welcome
  const assetId = await uploadFigure(page, boardId)
  const [lantern, paper, loose, photo] = [
    newId('note'),
    newId('note'),
    newId('note'),
    newId('note'),
  ]
  const gone = newId('note')
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: {
        ...base,
        id: lantern,
        x: base.x + 300,
        text: 'Lantern festival\n\nBy the river at dusk',
      },
    },
    {
      op: 'note.create',
      note: { ...base, id: paper, x: base.x + 600, text: 'Paper keeps what we let go of' },
    },
    {
      op: 'note.create',
      note: { ...base, id: loose, y: base.y + 280, text: 'A thought for the next chapter' },
    },
    {
      op: 'note.create',
      note: {
        ...base,
        id: photo,
        x: base.x + 300,
        y: base.y + 280,
        style: 'print',
        text: 'The harbour at dawn',
        image: { assetId, frame: 'print' },
      },
    },
  ])
  const twoText =
    'Lantern festival by the river at dusk. Paper keeps what we let go of, and gives it back when we are ready.'
  const fadedText = 'A line kept from a card that is no longer on the board.'
  const blocks: BookBlock[] = [
    CHAPTER[0] as BookBlock,
    CHAPTER[1] as BookBlock,
    {
      text: twoText,
      // In normal form: the marks sorted by type.
      marks: [
        { t: `c:${lantern}`, from: 0, to: 37 },
        { t: `c:${paper}`, from: 39, to: 68 },
      ].sort((a, b) => (a.t < b.t ? -1 : 1)) as unknown as BookBlock['marks'],
    },
    { kind: 'prompt', text: 'Say where you first saw the lanterns.' },
    { kind: 'prompt', text: 'Is this the same evening as chapter one?' },
    CHAPTER[3] as BookBlock,
    { kind: 'figure', text: 'The harbour at dawn', image: { assetId, card: photo } },
    CHAPTER[4] as BookBlock,
    CHAPTER[5] as BookBlock,
    {
      text: fadedText,
      marks: [{ t: `c:${gone}`, from: 0, to: fadedText.length }] as unknown as BookBlock['marks'],
    },
    CHAPTER[6] as BookBlock,
    CHAPTER[7] as BookBlock,
    CHAPTER[9] as BookBlock,
  ]
  const bookId = await seedBook(page, boardId, { title: 'Field notes', blocks })
  const held = await bookBlocksOf(page, boardId, bookId)
  return {
    boardId,
    bookId,
    lantern,
    paper,
    loose,
    photo,
    twoPins: held[2] as string,
    faded: held[9] as string,
  }
}

/** The book's block ids, in order, as the store holds them. */
async function bookBlocksOf(page: Page, boardId: string, bookId: string): Promise<string[]> {
  const blocks = await bookBlocks(page, boardId, bookId)
  return blocks.map((b) => b.id)
}

/** Card `id` brought into the board's view (zoom 1, `?bench`); a point on its paper. */
async function cardInView(page: Page, id: string) {
  await page.evaluate(
    (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
    id,
  )
  await page.waitForTimeout(700)
  return paperPoint(page, id)
}

async function bookOpen(page: Page, bookId: string, layout: 'split' | 'full') {
  await page.evaluate(
    (board) => localStorage.setItem('papertie.split', JSON.stringify({ ratio: 0.5, board })),
    layout === 'split',
  )
  await page.goto(`${APP_URL}/book/${bookId}?bench`)
  await expect(page.locator('.writer-body[data-shown] [data-id]').first()).toBeVisible({
    timeout: 60_000,
  })
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

/** The page scrolled so block `id` sits a little below the view's top. */
async function toBlock(page: Page, id: string) {
  await page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`.writer [data-id="${id}"]`)
    const sc = document.querySelector<HTMLElement>('.writer-scroll')
    if (el && sc)
      sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120
  }, id)
  await page.waitForTimeout(300)
}

for (const vp of VIEWPORTS) {
  const wants = (state: SplitState) => SPLIT_AT[state].includes(vp.name)
  test.describe(`split gallery at ${vp.name}`, () => {
    test.describe.configure({ mode: 'serial' })
    const shared = sharedDesktop()
    let page: Page
    let seed: SplitSeed

    test.beforeAll(async () => {
      test.setTimeout(120_000)
      page = await windowAt(shared.desktop, vp)
      await firstRun(apiFor(page))
      await openBoard(page)
      const boardId = await onlyBoard(apiFor(page))
      seed = await seedSplit(page, boardId)
      await saved(page)
    })

    test.afterAll(async () => {
      await shared.end()
    })

    test(`split ${vp.name}: split, seam and the card's drag`, async () => {
      await bookOpen(page, seed.bookId, 'split')
      await cardInView(page, seed.lantern)
      if (wants('split')) await splitShot(page, vp.name, 'split')
      if (wants('seam-drag')) {
        const seam = page.getByRole('separator', { name: 'Book width' })
        const box = await seam.boundingBox()
        if (box === null) throw new Error('no seam')
        const at = { x: box.x + box.width / 2, y: box.y + 320 }
        await page.mouse.move(at.x, at.y)
        await page.mouse.down()
        await page.mouse.move(at.x - 140, at.y, { steps: 8 })
        await expect(page.locator('.book-pane')).toHaveAttribute('data-seam', 'drag')
        await splitShot(page, vp.name, 'seam-drag')
        await page.mouse.move(at.x, at.y, { steps: 8 })
        await page.mouse.up()
      }
      if (wants('card-drag-copy')) {
        // A drag is let go when the window loses the keyboard: it is given it first.
        await page.bringToFront()
        const from = await cardInView(page, seed.loose)
        const target = await page.locator(`.writer [data-id="${seed.twoPins}"]`).boundingBox()
        if (target === null) throw new Error('no paragraph')
        const to = { x: target.x + target.width / 2, y: target.y + target.height * 0.8 }
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 })
        await page.mouse.move(to.x, to.y, { steps: 14 })
        await expect(page.locator('.bk-drop-gap')).toBeVisible()
        await splitShot(page, vp.name, 'card-drag-copy')
        if (wants('card-drag-move')) {
          await page.keyboard.down('Alt')
          await page.mouse.move(to.x, to.y + 1)
          await expect(page.locator('.card-ghost-move')).toBeVisible()
          await splitShot(page, vp.name, 'card-drag-move')
          await page.keyboard.up('Alt')
        }
        // Let go back on the board, where it came from: nothing made.
        await page.mouse.move(from.x + 40, from.y + 10, { steps: 14 })
        await page.mouse.move(from.x, from.y, { steps: 4 })
        await page.mouse.up()
        await saved(page)
      }
    })

    test(`split ${vp.name}: the chooser after a drop`, async () => {
      await bookOpen(page, seed.bookId, 'split')
      const from = await cardInView(page, seed.loose)
      await toBlock(page, seed.twoPins)
      const target = await page.locator(`.writer [data-id="${seed.twoPins}"]`).boundingBox()
      if (target === null) throw new Error('no paragraph')
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 40, from.y + 10, { steps: 4 })
      await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.8, {
        steps: 14,
      })
      await page.mouse.up()
      await expect(page.getByRole('radiogroup', { name: 'Add as' })).toBeVisible()
      await saved(page)
      await splitShot(page, vp.name, 'chooser')
      // Taken out again: the book as seeded.
      await page.keyboard.press('Escape')
      await page.keyboard.press('ControlOrMeta+z')
      await saved(page)
    })

    if (wants('pins-peek') || wants('pin-faded'))
      test(`split ${vp.name}: pins and their peeks`, async () => {
        await bookOpen(page, seed.bookId, 'split')
        await toBlock(page, seed.twoPins)
        const pins = page.locator(`.bk-pin`)
        await expect(pins.first()).toBeVisible()
        await pins.first().hover()
        await expect(page.locator('.card-peek')).toBeVisible()
        await splitShot(page, vp.name, 'pins-peek')
        if (wants('pin-faded')) {
          await toBlock(page, seed.faded)
          const faded = page.locator('.bk-pin[data-faded]')
          await faded.hover()
          await expect(page.locator('.card-peek')).toContainText('This card was deleted.')
          await splitShot(page, vp.name, 'pin-faded')
        }
        await page.mouse.move(5, 5)
      })

    if (wants('reverse-mark'))
      test(`split ${vp.name}: the reverse mark and its list`, async () => {
        await page.goto(`${APP_URL}/?bench`)
        await page.waitForFunction(() => window.__papertie?.ready === true)
        await cardInView(page, seed.lantern)
        const ink = page.locator(
          `main.viewport article.note[data-note-id="${seed.lantern}"] .note-ink`,
        )
        await expect(ink).toHaveAttribute('data-ink', 'used')
        await ink.click()
        await expect(page.getByRole('dialog', { name: 'Card uses' })).toBeVisible()
        await splitShot(page, vp.name, 'reverse-mark')
        await page.keyboard.press('Escape')
      })
    if (wants('prompts-margin') || wants('top-band') || wants('figure'))
      test(`split ${vp.name}: full width: prompts in the margin, the band, a figure`, async () => {
        await bookOpen(page, seed.bookId, 'full')
        await toBlock(page, seed.twoPins)
        if (wants('prompts-margin')) {
          await expect(page.locator('.writer .bk-book')).toHaveAttribute('data-asides', 'margin')
          await splitShot(page, vp.name, 'prompts-margin')
        }
        if (wants('figure')) {
          await page
            .locator('.writer .bk-book figure')
            .first()
            .evaluate((el) => el.scrollIntoView({ block: 'center' }))
          await page.waitForTimeout(300)
          await splitShot(page, vp.name, 'figure')
        }
        if (wants('top-band')) {
          await page.locator('.writer-scroll').evaluate((el) => {
            el.scrollTop = 0
          })
          await splitShot(page, vp.name, 'top-band')
        }
      })

    if (wants('prompts-inline'))
      test(`split ${vp.name}: prompts inline`, async () => {
        await bookOpen(page, seed.bookId, 'split')
        await toBlock(page, seed.twoPins)
        await expect(page.locator('.writer .bk-book')).toHaveAttribute('data-asides', 'inline')
        await splitShot(page, vp.name, 'prompts-inline')
      })

    if (wants('find'))
      test(`split ${vp.name}: the find bar`, async () => {
        await bookOpen(page, seed.bookId, 'split')
        await page.getByRole('button', { name: 'Find' }).click()
        const field = page.getByRole('searchbox', { name: 'Find in the book' })
        await field.fill('card')
        await expect(page.locator('.find-count')).toHaveText(/^\d+ of \d+$/)
        await field.press('Enter')
        await page.waitForTimeout(300)
        await splitShot(page, vp.name, 'find')
        await field.press('Escape')
      })

    if (wants('copy-move'))
      test(`split ${vp.name}: the Copy · Move chip`, async () => {
        // A window with a touch screen, the split beside the board: a finger held on a card.
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
        try {
          await bookOpen(page, seed.bookId, 'split')
          const at = await cardInView(page, seed.loose)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: Math.round(at.x), y: Math.round(at.y) }],
          })
          await page.waitForTimeout(700)
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await expect(page.getByRole('group', { name: 'Copy or move' })).toBeVisible()
          await splitShot(page, vp.name, 'copy-move')
        } finally {
          await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
          await cdp.detach()
        }
      })
  })
}

/**
 * The 20-second recording: a card dragged into the book, switched to a quote in the chooser,
 * then its text pinned back out onto the board (Pin to board).
 */
test('split wide: card-in-and-out (a recording)', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await firstRun(apiFor(page))
  await openBoard(page)
  const seed = await seedSplit(page, await onlyBoard(apiFor(page)))
  await saved(page)
  await bookOpen(page, seed.bookId, 'split')
  await record(
    page,
    {
      dir: path.join(ORIGINALS, 'split-video'),
      out: path.join(SPLIT_OUT, 'wide-card-in-and-out.webm'),
      width: 1440,
    },
    async () => {
      const began = Date.now()
      const from = await cardInView(page, seed.loose)
      await toBlock(page, seed.twoPins)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(1500)
      // The card, slowly across the seam, onto the gap after the paragraph from two cards.
      const target = await page.locator(`.writer [data-id="${seed.twoPins}"]`).boundingBox()
      if (target === null) throw new Error('no paragraph')
      const to = { x: target.x + target.width / 2, y: target.y + target.height * 0.8 }
      await page.mouse.move(from.x, from.y, { steps: 3 })
      await page.mouse.down()
      await page.mouse.move(from.x + 40, from.y + 10, { steps: 3 })
      await page.mouse.move(to.x, to.y, { steps: 36 })
      await page.waitForTimeout(800)
      await page.mouse.up()
      await expect(page.getByRole('radiogroup', { name: 'Add as' })).toBeVisible()
      await page.waitForTimeout(1500)
      // Switched to a quote.
      await page.keyboard.press('2')
      await page.waitForTimeout(2000)
      await page.keyboard.press('Escape')
      // Pinned back out: its words selected, Pin to board.
      const quoted = page
        .locator('.writer [data-id]')
        .filter({ hasText: 'A thought for the next chapter' })
      await expect(quoted.first()).toBeVisible()
      const id = (await quoted.first().getAttribute('data-id')) as string
      // Back in the book (the drag was on the board): the sidebar holds the writing tools again.
      await quoted.first().click()
      await page.evaluate((id) => {
        const t = document.querySelector(`.writer [data-id="${id}"]`)?.firstChild as Text
        document.getSelection()?.setBaseAndExtent(t, 0, t, 9)
      }, id)
      await page.waitForTimeout(1200)
      await writing(page).getByRole('button', { name: 'Pin to board' }).click()
      await page.waitForTimeout(2500)
      // The rest of the twenty seconds: the card on the board, selected, beside the book.
      console.log(`the recording's actions took ${((Date.now() - began) / 1000).toFixed(1)} s`)
      const left = 20_000 - (Date.now() - began)
      if (left > 0) await page.waitForTimeout(left)
    },
  )
  splitShots.add('wide-card-in-and-out')
})

test.afterAll(() => {
  if (!process.env.GALLERY || splitShots.size === 0) return
  const label = new Map(VIEWPORTS.map((v) => [v.name, v.label]))
  const lines = [
    '# The board beside the book',
    '',
    'The board and the book side by side.',
    'Written by `e2e/app/gallery.spec.ts`; regenerate with',
    '`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g split`.',
    'Motion reduced, fonts loaded. The split needs a window of 1,024 px or more; below it the book is',
    'full width.',
    '',
    `The images are WebP at quality ${QUALITY_SHEET}. Each lossless original is kept beside the spec, in`,
    '`e2e/artifacts/gallery/split-<viewport>-<state>.png` (not committed).',
    '',
    '| File | Viewport | State |',
    '| --- | --- | --- |',
  ]
  for (const [state, what] of Object.entries(SPLIT_STATES) as [SplitState, string][])
    for (const v of SPLIT_AT[state]) {
      const file = `${v}-${state}.webp`
      if (!existsSync(path.join(SPLIT_OUT, file))) continue
      lines.push(`| [${file}](${file}) | ${label.get(v)} | \`${state}\`: ${what} |`)
    }
  if (existsSync(path.join(SPLIT_OUT, 'wide-card-in-and-out.webm')))
    lines.push(
      '| [wide-card-in-and-out.webm](wide-card-in-and-out.webm) | 1440 × 900 | `card-in-and-out`: a card dragged into the book, switched to a quote in the chooser, then its words pinned back out onto the board (20 s, VP9; made with ffmpeg) |',
    )
  lines.push('')
  mkdirSync(SPLIT_OUT, { recursive: true })
  writeFileSync(path.join(SPLIT_OUT, 'index.md'), lines.join('\n'))
})

// ── Sources: refs, footnotes and export ──────────────────────────────────────────────────────

const C_OUT = path.join(__dirname, '..', '..', 'docs', 'screenshots', 'sources')

const C_STATES = {
  'ref-note': 'A note with its ref at its bottom: under a hairline, in small type',
  'ref-edit': 'A note being written on: "Add reference" opened into the ref field',
  'ref-drop':
    'A card with a ref inserted with ⌘K: a quote at once, its ref as the footnote, the chooser',
  footnotes: 'Footnotes under their paragraph, numbered through the book, the crimson superscripts',
  orphan: 'An orphaned footnote: faded (AA), no number, "No longer anchored · Remove"',
  'popover-footnote': 'The writing tools with Footnote',
  'export-choices': "A book's options on the shelf with Export open: Markdown · Word",
} as const
type CState = keyof typeof C_STATES

const C_AT: Record<CState, readonly Viewport['name'][]> = {
  'ref-note': ['wide', 'laptop2x', 'tablet'],
  'ref-edit': ['wide'],
  'ref-drop': ['wide', 'laptop2x'],
  footnotes: ['wide', 'laptop2x', 'tablet'],
  orphan: ['wide'],
  'popover-footnote': ['wide'],
  'export-choices': ['wide', 'laptop2x'],
}
const cShots = new Set<string>()

async function cShot(page: Page, vp: Viewport['name'], state: CState) {
  await settle(page)
  // As `fontsReady`, but only the photos in view are waited for: a lazy one below the fold never
  // loads, and its decode() never settles.
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await document.fonts.ready
    const seen = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect()
      return r.bottom > 0 && r.top < innerHeight && r.width > 0
    })
    await Promise.all(seen.map((img) => img.decode().catch(() => undefined)))
  })
  await settle(page)
  const png = await frameOf(page)
  const name = `${vp}-${state}`
  mkdirSync(ORIGINALS, { recursive: true })
  writeFileSync(path.join(ORIGINALS, `sources-${name}.png`), await pngLossless(png))
  mkdirSync(C_OUT, { recursive: true })
  const quality = state === 'ref-note' || state === 'ref-edit' ? QUALITY_CORK : QUALITY_SHEET
  writeFileSync(path.join(C_OUT, `${name}.webp`), await webpFrom(png, quality))
  cShots.add(name)
}

/** Nothing of `el` is cut at the view's edges, and it scrolls nothing sideways. */
async function fitsWidth(page: Page, el: ReturnType<Page['locator']>) {
  const width = page.viewportSize()?.width ?? 0
  const box = await el.boundingBox()
  if (box === null) throw new Error('not shown')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5)
  expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

interface CSeed {
  boardId: string
  bookId: string
  /** A note with a ref, and a card with one to insert into "Drop letters". */
  reffed: string
  toDrop: string
  dropBook: string
  /** The paragraph with two footnotes, and the orphan. */
  noted: string
  orphan: string
}

/** The board's notes with refs; the book "Pond letters" with its footnotes; "Drop letters". */
async function seed2c(page: Page, boardId: string): Promise<CSeed> {
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { type: string; id: string; x: number; y: number; rev?: number })
    .find((r) => r.type === 'note')
  if (welcome === undefined) throw new Error('no welcome card')
  const { rev: _rev, ...base } = welcome
  const assetId = await uploadFigure(page, boardId)
  const reffed = newId('note')
  const toDrop = newId('note')
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: {
        ...base,
        id: reffed,
        x: base.x + 320,
        text: 'I went to the woods because I wished to live deliberately.',
        ref: 'Henry David Thoreau, Walden; or, Life in the Woods,\nTicknor and Fields, 1854, p. 90',
      },
    },
    {
      op: 'note.create',
      note: {
        ...base,
        id: toDrop,
        x: base.x + 680,
        y: base.y + 120,
        text: 'Heaven is under our feet as well as over our heads.',
        ref: 'Thoreau, Walden, 1854, p. 283',
      },
    },
  ])
  const [fa, fb, fc, fd, fo] = [1, 2, 3, 4, 5].map(() => newId('block')) as [
    string,
    string,
    string,
    string,
    string,
  ]
  const n = (id: string, from: number, to: number) => ({ t: `n:${id}` as const, from, to })
  const two =
    'The pond is a clear and deep green well, half a mile long and a mile and three quarters round, and about sixty-one and a half acres in extent.'
  const blocks: BookBlock[] = [
    { kind: 'h1', text: 'Where I lived' },
    {
      text: 'I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach.',
      marks: [{ t: 'i', from: 45, to: 57 }, n(fa, 0, 58)],
    },
    { kind: 'footnote', text: 'Thoreau, Walden; or, Life in the Woods, 1854, p. 90', id: fa },
    {
      text: two,
      marks: [n(fb, 0, two.indexOf(' and a mile')), n(fc, two.indexOf('sixty'), two.length)],
    },
    { kind: 'footnote', text: 'Measured on the ice in the winter of 1846.', id: fb },
    {
      kind: 'footnote',
      text: 'See https://www.gutenberg.org/ebooks/205 for the whole text.',
      id: fc,
    },
    { kind: 'footnote', text: 'A note whose words were cut from the chapter.', id: fo },
    { kind: 'prompt', text: 'Say how the water looked in March.' },
    {
      kind: 'quote',
      text: 'Heaven is under our feet as well as over our heads.',
      marks: [n(fd, 0, 51)],
    },
    { kind: 'footnote', text: 'Thoreau, Walden, 1854, p. 283', id: fd },
    { kind: 'figure', text: 'The cove at the north end', image: { assetId } },
    { kind: 'h1', text: 'Winter animals' },
    {
      text: 'When the ponds were firmly frozen, they afforded not only new and shorter routes to many points, but new views from their surfaces of the familiar landscape around them.',
    },
    { kind: 'li', text: 'the fox at night' },
    { kind: 'li', text: 'the red squirrel at dawn' },
  ]
  for (const b of blocks)
    if (b.marks) b.marks.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.from - y.from))
  const bookId = await seedBook(page, boardId, { title: 'Pond letters', blocks })
  const held = await bookBlocksOf(page, boardId, bookId)
  const dropBook = await seedBook(page, boardId, {
    title: 'Drop letters',
    blocks: [
      { kind: 'h1', text: 'Higher laws' },
      {
        text: 'Every man is the builder of a temple, called his body, to the god he worships.',
      },
    ],
  })
  return { boardId, bookId, reffed, toDrop, dropBook, noted: held[3] as string, orphan: fo }
}

for (const vp of VIEWPORTS) {
  const wants = (state: CState) => C_AT[state].includes(vp.name)
  test.describe(`sources gallery at ${vp.name}`, () => {
    test.describe.configure({ mode: 'serial' })
    const shared = sharedDesktop()
    let page: Page
    let seed: CSeed

    test.beforeAll(async () => {
      test.setTimeout(120_000)
      page = await windowAt(shared.desktop, vp)
      await firstRun(apiFor(page))
      await openBoard(page)
      seed = await seed2c(page, await onlyBoard(apiFor(page)))
      await saved(page)
    })

    test.afterAll(async () => {
      await shared.end()
    })

    if (wants('ref-note') || wants('ref-edit'))
      test(`sources ${vp.name}: a note's ref, and its field`, async () => {
        await page.goto(`${APP_URL}/?bench`)
        await page.waitForFunction(() => window.__papertie?.ready === true)
        await cardInView(page, seed.reffed)
        const card = page.locator(`main.viewport article.note[data-note-id="${seed.reffed}"]`)
        await expect(card.getByRole('note', { name: 'Reference' })).toContainText('Ticknor')
        if (wants('ref-note')) await cShot(page, vp.name, 'ref-note')
        if (wants('ref-edit')) {
          await cardInView(page, seed.toDrop)
          const other = page.locator(`main.viewport article.note[data-note-id="${seed.toDrop}"]`)
          await other.dblclick()
          await expect(other.getByRole('textbox', { name: 'Note text' })).toBeFocused()
          // The field of a ref it has, shown open; a note without one shows "Add reference".
          await expect(other.getByRole('textbox', { name: 'Reference' })).toBeVisible()
          await other.getByRole('textbox', { name: 'Reference' }).click()
          await cShot(page, vp.name, 'ref-edit')
          await page.keyboard.press('Escape')
          await saved(page)
        }
      })

    if (wants('ref-drop'))
      test(`sources ${vp.name}: a card with a ref inserted as a quote with its footnote`, async () => {
        await bookOpen(page, seed.dropBook, 'full')
        const last = page.locator('.writer [data-id]').last()
        await last.click()
        await page.keyboard.press('End')
        await page.keyboard.press('ControlOrMeta+k')
        await page.keyboard.type('heaven')
        await expect(page.getByRole('option').first()).toContainText('Heaven')
        await page.keyboard.press('Enter')
        await expect(page.locator('.writer .bk-quote')).toHaveText(/Heaven is under our feet/)
        await expect(page.locator('.writer .bk-footnote[data-n="1"]')).toHaveText(
          'Thoreau, Walden, 1854, p. 283',
        )
        await expect(page.getByRole('radiogroup')).toBeVisible()
        await cShot(page, vp.name, 'ref-drop')
      })

    if (wants('footnotes') || wants('orphan') || wants('popover-footnote'))
      test(`sources ${vp.name}: footnotes, an orphan and the writing tools`, async () => {
        await bookOpen(page, seed.bookId, 'full')
        await toBlock(page, seed.noted)
        await expect(page.locator('.writer .bk-footnote[data-n="3"]')).toBeVisible()
        if (wants('footnotes')) await cShot(page, vp.name, 'footnotes')
        if (wants('orphan')) {
          const orphan = page.locator(`.writer [data-id="${seed.orphan}"]`)
          await expect(orphan).toHaveAttribute('data-orphan', '')
          await orphan.evaluate((el) => el.scrollIntoView({ block: 'center' }))
          await expect(page.locator('.bk-orphan')).toContainText('No longer anchored')
          // AA for the faded text: its colour on the page's paper.
          const ratio = await orphan.evaluate((el) => {
            // `rgb(…)` in 0–255, or `color(srgb …)` in 0–1 (what a color-mix() computes to).
            const rgb = (s: string) => {
              const v = (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
              return s.startsWith('color(') ? v.map((x) => x * 255) : v
            }
            const lum = (c: number[]) => {
              const [r, g, b] = c.map((v) => {
                const x = v / 255
                return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
              }) as [number, number, number]
              return 0.2126 * r + 0.7152 * g + 0.0722 * b
            }
            const fg = lum(rgb(getComputedStyle(el).color))
            const bg = lum([0xfb, 0xf7, 0xef])
            return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
          })
          console.log(`orphan footnote contrast on the paper: ${ratio.toFixed(2)}:1`)
          expect(ratio).toBeGreaterThanOrEqual(4.5)
          if (vp.name === 'wide') expect(await axeViolations(page)).toEqual([])
          await cShot(page, vp.name, 'orphan')
        }
        if (wants('popover-footnote')) {
          const id = seed.noted
          await toBlock(page, id)
          await page.locator(`.writer [data-id="${id}"]`).click()
          await page.evaluate((id) => {
            // Plain words between the anchors: the paragraph's longest text outside them.
            const el = document.querySelector(`.writer [data-id="${id}"]`) as HTMLElement
            const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
            let t: Text | null = null
            for (let n = walk.nextNode(); n !== null; n = walk.nextNode())
              if (!n.parentElement?.closest('.bk-anchor') && (n as Text).length > (t?.length ?? 0))
                t = n as Text
            if (t === null) throw new Error('no text')
            document.getSelection()?.setBaseAndExtent(t, 8, t, 22)
          }, id)
          const pop = writing(page)
          await expect(pop.getByRole('button', { name: 'Footnote' })).toBeVisible()
          await cShot(page, vp.name, 'popover-footnote')
          await page.keyboard.press('Escape')
          await page.evaluate(() => document.getSelection()?.removeAllRanges())
        }
      })

    if (wants('export-choices'))
      test(`sources ${vp.name}: Export on the shelf`, async () => {
        await page.goto(`${APP_URL}/shelf`)
        const shelf = page.getByRole('dialog', { name: 'Books' })
        await shelf.getByRole('button', { name: 'Options for Pond letters' }).click()
        const pop = page.getByRole('dialog', { name: 'Pond letters' })
        await pop.getByRole('button', { name: 'Export' }).click()
        await expect(pop.getByRole('group', { name: 'Export as' })).toBeVisible()
        await fitsWidth(page, pop)
        await cShot(page, vp.name, 'export-choices')
        await page.keyboard.press('Escape')
      })

    if (vp.name === 'wide')
      test('sources wide: the Word file through the route, in Quick Look', async () => {
        const res = await apiFor(page).get(
          `/api/boards/${seed.boardId}/books/${seed.bookId}/export?format=docx`,
        )
        expect(res.status()).toBe(200)
        const dir = path.join(ORIGINALS, 'sources-docx')
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'pond-letters.docx')
        writeFileSync(file, await res.body())
        execFileSync('qlmanage', ['-t', '-s', '1200', '-o', dir, file], { stdio: 'ignore' })
        mkdirSync(C_OUT, { recursive: true })
        writeFileSync(path.join(C_OUT, 'docx-preview.png'), readFileSync(`${file}.png`))
        cShots.add('docx-preview')
      })
  })
}

test.afterAll(() => {
  if (!process.env.GALLERY || cShots.size === 0) return
  const label = new Map(VIEWPORTS.map((v) => [v.name, v.label]))
  const lines = [
    '# References, footnotes and export',
    '',
    'A note’s reference, footnotes and a book’s export.',
    'Written by `e2e/app/gallery.spec.ts`; regenerate with',
    '`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g sources`.',
    'Motion reduced, fonts loaded. The run checks that the book options fit the width (nothing cut,',
    'nothing scrolling sideways), and that an orphaned footnote keeps 4.5:1 on the paper.',
    '',
    `The images are WebP at quality ${QUALITY_SHEET} (the board's at ${QUALITY_CORK}). Each lossless original is kept beside the spec, in`,
    '`e2e/artifacts/gallery/sources-<viewport>-<state>.png` (not committed).',
    '',
    '| File | Viewport | State |',
    '| --- | --- | --- |',
  ]
  for (const [state, what] of Object.entries(C_STATES) as [CState, string][])
    for (const v of C_AT[state]) {
      const file = `${v}-${state}.webp`
      if (!existsSync(path.join(C_OUT, file))) continue
      lines.push(`| [${file}](${file}) | ${label.get(v)} | \`${state}\`: ${what} |`)
    }
  if (existsSync(path.join(C_OUT, 'docx-preview.png')))
    lines.push(
      '| [docx-preview.png](docx-preview.png) | — | The Word file from the export route, rendered by macOS Quick Look (`qlmanage -t -s 1200`) |',
    )
  lines.push('')
  mkdirSync(C_OUT, { recursive: true })
  writeFileSync(path.join(C_OUT, 'index.md'), lines.join('\n'))
})

// ── The index ────────────────────────────────────────────────────────────────────────────────

test.afterAll(() => {
  if (!process.env.GALLERY) return
  const lines = [
    '# The board',
    '',
    'Every state of the board at three window sizes.',
    'Written by `e2e/app/gallery.spec.ts`; regenerate with',
    '`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery`.',
    'Motion reduced, fonts loaded, the camera at rest.',
    '',
    `The images here are WebP: quality ${QUALITY_CORK} where the cork fills the frame, ${QUALITY_SHEET} where a`,
    'Settings sheet covers it. The run keeps each lossless original beside the spec, in',
    '`e2e/artifacts/gallery/<viewport>-<state>.png` (not committed).',
    '',
    'Every state is reached at every viewport. The shots of `wide` cover every state; `laptop2x`',
    'covers the screens whose fine detail a dense display shows, and `tablet` one of each kind of',
    "screen (the repository's size).",
    '',
    '| File | Viewport | State |',
    '| --- | --- | --- |',
  ]
  for (const v of VIEWPORTS) {
    for (const [state, what] of Object.entries(STATES) as [State, string][]) {
      if (!written(v.name, state)) continue
      const file = `${v.name}-${state}.webp`
      lines.push(`| [${file}](${file}) | ${v.label} | \`${state}\`: ${what} |`)
    }
  }
  lines.push('')
  mkdirSync(OUT, { recursive: true })
  writeFileSync(path.join(OUT, 'index.md'), lines.join('\n'))
})
