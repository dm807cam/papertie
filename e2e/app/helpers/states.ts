import { expect, type Page } from '@playwright/test'
import { type Note, newId, type Op, type Yarn } from '../../../packages/core/src'
import { APP_URL } from './app'

/**
 * The app's states as the accessibility pass (`a11y.spec.ts`) and the design gallery
 * (`gallery.spec.ts`) both reach them: the 30-note board, Settings' sections, the opening
 * catch-up, and the waits that say a screen is ready to be read.
 */

/** The 30-note board: a 6 × 5 grid, short titles. */
const WORDS = [
  'Sea voyage',
  'Spring trip',
  'Packing list',
  'Train times',
  'Inn by the lake',
  'Tea tasting',
  'Book the sauna',
  'Maps offline',
  'Camera batteries',
  'Gifts for home',
  'Museum hours',
  'Old churches',
  'Night market',
  'Picnic ideas',
  'Rail pass',
  'Currency',
  'Phrasebook',
  'Hiking boots',
  'Rain jacket',
  'Sketchbook',
  'Postcards',
  'Ferry to the island',
  'Deer park',
  'Garden walk',
  'Calligraphy class',
  'Paper shop',
  'Indigo dye',
  'Pottery',
  'Lantern festival',
  'Home again',
]
const COLS = 6
const NOW = '2026-11-01T00:00:00.000Z'

export function board30(): { notes: Note[]; yarns: Yarn[]; ops: Op[] } {
  const notes = WORDS.map(
    (text, i): Note => ({
      type: 'note',
      id: newId('note'),
      x: (i % COLS) * 340,
      y: Math.floor(i / COLS) * 300,
      w: 220,
      h: 160,
      z: i,
      paper: (['cream', 'rose', 'indigo', 'sage', 'lilac', 'ochre', 'apricot', 'ink'] as const)[
        i % 8
      ] as Note['paper'],
      style: i % 3 === 0 ? 'smooth' : 'rustic',
      text,
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  const id = (i: number) => (notes[i] as Note).id
  // A chain from the first note (focus reaches one more each step), and a few threads elsewhere.
  const ties: [number[], Yarn['color']][] = [
    [[1, 2], 'indigo'],
    [[2, 3], 'apricot'],
    [[3, 4], 'sage'],
    [[10, 11, 17], 'lilac'],
    [[20, 21], 'rose'],
  ]
  const yarns = ties.map(
    ([ids, color]): Yarn => ({
      type: 'yarn',
      id: newId('yarn'),
      noteIds: ids.map(id),
      color,
      label: '',
      createdAt: NOW,
      updatedAt: NOW,
    }),
  )
  const ops: Op[] = [
    ...notes.map((note): Op => ({ op: 'note.create', note })),
    ...yarns.map((yarn): Op => ({ op: 'yarn.create', yarn })),
  ]
  return { notes, yarns, ops }
}

/** Every finite animation on the page has ended (what opens fades or rises in). */
export const settle = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0))
        .map((a) => a.finished.catch(() => {})),
    ),
  )

/** The board's toolbar: the sidebar. */
export const tools = (page: Page) => page.getByRole('toolbar', { name: 'Tools' })

/**
 * The writer's formatting in that toolbar: Text style, Bold, Italic, Footnote and Pin to board,
 * under a book (and beside it while the user works in it).
 */
export const writing = (page: Page) => tools(page).getByRole('group', { name: 'Writing' })

/** The caret's block set to kind `name` (Paragraph, Chapter…): Text style, then its choice. */
export async function textStyle(page: Page, name: string, how: 'click' | 'tap' = 'click') {
  const style = writing(page).getByRole('button', { name: 'Text style' })
  await (how === 'tap' ? style.tap() : style.click())
  const choice = page.getByRole('dialog', { name: 'Text style' }).getByRole('radio', { name })
  await (how === 'tap' ? choice.tap() : choice.click())
}

export type Section = 'export' | 'history' | 'preferences' | 'data'
export const SECTIONS: readonly Section[] = ['export', 'history', 'preferences', 'data']

/**
 * Settings is open on `section`, and what the section asks the store for has come in: each
 * shows something only once it has (never a fixed wait).
 */
export async function sectionShown(page: Page, section: string) {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('heading', { level: 1 })).toHaveText(
    section[0]?.toUpperCase() + section.slice(1),
  )
  const ready: Record<Section, () => Promise<void>> = {
    export: () => expect(settings.getByRole('button', { name: 'Import…' })).toBeVisible(),
    history: () =>
      expect(
        settings.getByText('Papertie keeps copies of your board as you work.', { exact: false }),
      ).toBeVisible(),
    preferences: () => expect(settings.getByRole('group', { name: 'Motion' })).toBeVisible(),
    data: () => expect(settings.getByRole('button', { name: 'Delete all data…' })).toBeVisible(),
  }
  await ready[section as Section]()
}

/**
 * The store's answer for the whole board (and for what was committed since) held back on `page`
 * from now on. The view's region is answered, so a board opened meanwhile paints and stays
 * catching up. The function returned lets the answers through.
 */
export async function holdBoard(page: Page): Promise<() => Promise<void>> {
  let open = () => {}
  const held = new Promise<void>((r) => {
    open = r
  })
  const boardRead = /\/api\/boards\/[^/?]+(\/ops\b[^/]*)?$/
  await page.route(
    (url) => boardRead.test(url.pathname + url.search),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await held
      await route.continue().catch(() => {})
    },
  )
  return async () => {
    open()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
}

/**
 * The opening catch-up state, on `page`: the board opened again while the whole board is held
 * back ({@link holdBoard}). It shows the view it was left at and is still catching up. The
 * function returned lets the board through.
 */
export async function heldOpening(page: Page): Promise<() => Promise<void>> {
  const release = await holdBoard(page)
  await page.goto(`${APP_URL}/?bench`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await expect(page.locator('article.note').first()).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window.__papertie as unknown as { session?: { opening?: { open: boolean } } }).session
          ?.opening?.open,
    ),
  ).toBe(true)
  return release
}

/**
 * Settings' Export on `page`, a board file chosen for Import: its confirmation step is up, Keep
 * current focused. Returns the sheet and the step.
 */
export async function importAsking(page: Page, file: string) {
  await page.goto(`${APP_URL}/settings/export?bench`)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const choosing = page.waitForEvent('filechooser')
  await settings.getByRole('button', { name: 'Import…' }).click()
  await (await choosing).setFiles({
    name: 'board.jsonl',
    mimeType: 'application/x-ndjson',
    buffer: Buffer.from(file),
  })
  const ask = settings.getByRole('alertdialog')
  await expect(ask).toBeVisible()
  await expect(ask.getByRole('button', { name: 'Keep current' })).toBeFocused()
  return { settings, ask }
}
