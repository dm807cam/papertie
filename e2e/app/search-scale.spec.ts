import { loadavg } from 'node:os'
import type { Page } from '@playwright/test'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { firstRun, openBoard } from './helpers/server'

/**
 * ⌘K on a lifetime board (Review Focus 5): on 100,000 notes the search index
 * answers from its worker within 16 ms (p95) and typing never blocks the page. The board is
 * seeded through the page's store (staged batches, each saved), then reopened, so the index is
 * loaded the way a returning writer's is.
 */

/** With the welcome note, 99,801. */
const NOTES = 99_800
const SEED_BATCH = 25_000
/** Where the writer left the board: in the seeded grid, at reading zoom. */
const READING_VIEW = { x: 50_000, y: 30_000, zoom: 1 }
const NEEDLE = 'knot-tower-plan-needle'

const WORDS = [
  'Knot',
  'Paris',
  'Milan',
  'council',
  'drawing',
  'memo',
  'sketch',
  'ledger',
  'about',
  'working',
  'travel',
  'photo',
  'vellum',
  'cork',
  'board',
  'thread',
  'paper',
  'meeting',
  'design',
  'idea',
  'notes',
  'plan',
  'cafe\u0301',
  'Ⓟⓐⓡⓘⓢ',
]

type StoreHandle = {
  getState(): { notes: Map<string, unknown> }
  commit(ops: unknown[]): void
  now(): string
}
type Feed = { getState(): { status: string; pending: number } }

/** Nothing left to send, however long a seed takes to go out. */
async function settled(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(
    () => {
      const feed = (window.__papertie as unknown as { session?: { feed?: Feed } }).session?.feed
      const s = feed?.getState()
      return s !== undefined && s.pending === 0 && s.status === 'saved'
    },
    undefined,
    { timeout, polling: 500 },
  )
}

/** Pin `count` notes of generated text, `SEED_BATCH` to a commit, the needle among them. */
async function seed(page: Page, count: number): Promise<void> {
  const began = Date.now()
  for (let from = 0; from < count; from += SEED_BATCH) {
    await page.evaluate(
      ({ from, to, words, needle }) => {
        const store = (window.__papertie as unknown as { store: StoreHandle }).store
        const now = store.now()
        let r = from * 7919 + 13
        const rand = (k: number) => {
          r = (r * 1_103_515_245 + 12_345) % 2_147_483_648
          return r % k
        }
        const ops: unknown[] = []
        for (let i = from; i < to; i++) {
          const n = 6 + rand(12)
          const parts: string[] = []
          for (let w = 0; w < n; w++) parts.push(words[rand(words.length)] as string)
          const text = i === 54_321 ? needle : `${parts.join(rand(2) ? ' ' : '')} ${i}`
          ops.push({
            op: 'note.create',
            note: {
              type: 'note',
              // note_ and 26 Crockford digits, unique per seed index.
              id: `note_01JBSE${String(i).padStart(20, '0')}`,
              x: (i % 400) * 300,
              y: Math.floor(i / 400) * 240,
              w: 240,
              h: 160,
              z: i + 2,
              paper: 'cream',
              style: 'rustic',
              text,
              image: null,
              createdAt: now,
              updatedAt: now,
            },
          })
        }
        store.commit(ops)
      },
      { from, to: Math.min(count, from + SEED_BATCH), words: WORDS, needle: NEEDLE },
    )
  }
  const committed = Date.now()
  await settled(page, 600_000)
  console.info(
    `search-scale: ${count} notes committed in ${((committed - began) / 1000).toFixed(1)} s, ` +
      `all sent and saved ${((Date.now() - committed) / 1000).toFixed(1)} s later`,
  )
}

/**
 * Watch the open palette: how long each keystroke waits for its list (input to the list's next
 * change), long tasks, and any list naming a note that is not on the board.
 */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __searchWatch: { waits: number[]; longTasks: number[]; ghosts: string[]; shown: number }
    }
    const out = {
      waits: [] as number[],
      longTasks: [] as number[],
      ghosts: [] as string[],
      shown: 0,
    }
    w.__searchWatch = out
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) out.longTasks.push(e.duration)
    }).observe({ type: 'longtask', buffered: false })
    const store = (window.__papertie as unknown as { store: StoreHandle }).store
    const field = document.querySelector('.picker-input') as HTMLInputElement
    const list = document.querySelector('.picker-list') as HTMLElement
    let typedAt: number | null = null
    field.addEventListener('input', () => {
      typedAt = performance.now()
    })
    new MutationObserver(() => {
      if (typedAt !== null) out.waits.push(performance.now() - typedAt)
      typedAt = null
      out.shown++
      const notes = store.getState().notes
      for (const o of list.querySelectorAll('[role="option"]')) {
        const id = /note_[0-9A-Z]{26}$/.exec(o.id)?.[0]
        if (id === undefined || !notes.has(id)) out.ghosts.push(o.id)
      }
    }).observe(list, { childList: true, subtree: true, characterData: true })
  })
}

const watched = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __searchWatch: { waits: number[]; longTasks: number[]; ghosts: string[]; shown: number }
        }
      ).__searchWatch,
  )

const searchTimes = (page: Page) =>
  page.evaluate(() =>
    (window.__papertie as unknown as { debug: { searchTimes(): number[] } }).debug.searchTimes(),
  )

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0
}

/**
 * Open the board again and wait until it is wholly in: it opens at the view it remembers first and
 * the rest comes in behind it (`opening.open` until then).
 */
async function openWhole(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/?bench`)
  await page.waitForFunction(
    () => {
      const h = window.__papertie as unknown as
        | { ready?: boolean; session?: { opening?: { open: boolean } } }
        | undefined
      return h?.ready === true && h.session?.opening?.open === false
    },
    undefined,
    { timeout: 180_000 },
  )
}

/** Open ⌘K and wait for its first answer: the index has the whole board by then. */
async function openSearch(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(8, { timeout: 60_000 })
}

test('typing in ⌘K on ~100,000 notes never blocks the page; the worker answers in ≤ 16 ms p95', async ({
  page,
}) => {
  test.setTimeout(900_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await firstRun(apiFor(page))
  await openBoard(page)
  await settled(page, 30_000)
  const seeding = Date.now()
  await seed(page, NOTES)
  console.info(
    `search-scale: seeded ${NOTES} notes in ${((Date.now() - seeding) / 1000).toFixed(1)} s`,
  )
  // Opened again, as a returning writer would: where they left it (a reading view in the middle
  // of the board), with the index loading the whole board from the store.
  await page.evaluate(
    ([cam]) => {
      const id = (window.__papertie as unknown as { session: { boardId: string } }).session.boardId
      localStorage.setItem(`papertie.camera.${id}`, JSON.stringify(cam))
    },
    [READING_VIEW] as const,
  )
  await openWhole(page)

  expect(
    await page.evaluate(
      () => (window.__papertie as unknown as { store: StoreHandle }).store.getState().notes.size,
    ),
  ).toBe(NOTES + 1)
  await openSearch(page)
  await watch(page)
  const before = (await searchTimes(page)).length
  const field = page.getByRole('combobox')
  // Words, accents and compatibility folding (ⓟⓐⓡⓘⓢ finds Ⓟⓐⓡⓘⓢ), one key at a time.
  for (const q of ['Paris council', 'design notes', 'ⓟⓐⓡⓘⓢ', 'café', NEEDLE]) {
    await field.fill('')
    await field.pressSequentially(q, { delay: 60 })
    await page.waitForTimeout(150)
  }
  // The needle is one note, found by a piece of it from the middle.
  await field.fill('')
  await field.pressSequentially('tower-plan', { delay: 60 })
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option')).toContainText(NEEDLE)

  const w = await watched(page)
  const times = (await searchTimes(page)).slice(before)
  const p95 = percentile(times, 95)
  const waitP95 = percentile(w.waits, 95)
  console.info(
    `search at ${NOTES + 1} notes: worker p95 ${p95.toFixed(2)} ms over ${times.length} ` +
      `answers (slowest ${JSON.stringify(
        [...times]
          .sort((x, y) => y - x)
          .slice(0, 6)
          .map((t) => +t.toFixed(1)),
      )}); ` +
      `keystroke to list p95 ${waitP95.toFixed(1)} ms; long tasks ` +
      `${JSON.stringify(w.longTasks.map((t) => Math.round(t)))}, load ${loadavg()[0]?.toFixed(2)}`,
  )
  expect(times.length).toBeGreaterThan(30)
  expect(p95).toBeLessThanOrEqual(16)
  expect(waitP95).toBeLessThanOrEqual(100)
  // Nothing but typing in the palette runs while this is watched, so every long task here is
  // search's: none may block the page for over 100 ms.
  expect(w.longTasks.filter((t) => t > 100)).toEqual([])
  expect(w.ghosts).toEqual([])
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
