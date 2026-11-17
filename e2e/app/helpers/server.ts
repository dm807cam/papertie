import { expect, type Page } from '@playwright/test'
import { newId } from '../../../packages/core/src'
import type { Hooks } from '../../hooks'
import { APP_URL, type Api } from './app'

/** The API refuses a write without a trusted `Origin`: the app's own. */
const ORIGIN = { Origin: APP_URL }

/** The welcome note's words, as `apps/web/src/app/bootstrap.ts` has them (`WELCOME_TEXT`). */
const WELCOME_TEXT = 'Use + to pin a thought'

/**
 * A spec starts from nothing: "Delete all data" through the API leaves one empty board, where a
 * first launch pinned its welcome note.
 */
export async function freshStart(request: Api): Promise<void> {
  const res = await request.post('/api/data/delete', {
    headers: ORIGIN,
    data: { confirm: 'delete' },
  })
  expect(res.status(), await res.text()).toBe(200)
}

/**
 * A spec starts as a first run of Papertie does: {@link freshStart}, then the welcome note on the one
 * board, as the app pins it on a board it makes (`apps/web/src/app/bootstrap.ts`). The page then
 * opens on that board with that note, as on a new install.
 */
export async function firstRun(request: Api): Promise<void> {
  await freshStart(request)
  const boardId = await onlyBoard(request)
  const now = new Date().toISOString()
  const res = await request.post(`/api/boards/${boardId}/ops`, {
    headers: ORIGIN,
    data: {
      clientId: newId('tab'),
      seq: 1,
      baseRevision: 0,
      ops: [
        {
          op: 'note.create',
          note: {
            type: 'note',
            id: newId('note'),
            x: 0,
            y: 0,
            w: 280,
            h: 160,
            z: 1,
            paper: 'cream',
            style: 'rustic',
            text: WELCOME_TEXT,
            image: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    },
  })
  expect(res.status(), await res.text()).toBe(200)
}

/**
 * Open the board with the test hooks (`?bench` installs `window.__papertie` in a production build,
 * for reading positions and state; every change in the specs still goes through real input).
 */
export async function openBoard(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/?bench`)
  await waitReady(page)
}

/** The board is drawn and its notes are mounted. */
export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as { __papertie?: Hooks }).__papertie?.ready === true)
  await expect(page.locator('article.note').first()).toBeVisible()
}

/** The boards the app holds: its one board. */
export async function boardIds(request: Api): Promise<string[]> {
  const res = await request.get('/api/boards')
  expect(res.status()).toBe(200)
  return ((await res.json()) as { id: string }[]).map((b) => b.id)
}

/** The one board's id. */
export async function onlyBoard(request: Api): Promise<string> {
  const ids = await boardIds(request)
  expect(ids).toHaveLength(1)
  return ids[0] as string
}

/** The board's revision in the store: one per committed batch. */
export async function revisionOf(request: Api, boardId: string): Promise<number> {
  const res = await request.get(`/api/boards/${boardId}/meta`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { revision: number }).revision
}

/** The canonical `board.jsonl`, as Settings' export downloads it. */
export async function exportJsonl(request: Api, boardId: string): Promise<string> {
  const res = await request.get(`/api/boards/${boardId}/export?format=jsonl`)
  expect(res.status()).toBe(200)
  return res.text()
}

interface ServerNote {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  paper: string
  motif?: string
  image: { assetId: string } | null
  /** The book (and block) a card made from a book came from. */
  from?: { book: string; block: string }
  /** The note's reference. */
  ref?: string
}

/** The notes and threads in the board file. */
export async function serverBoard(
  request: Api,
  boardId: string,
): Promise<{
  notes: Map<string, ServerNote>
  yarns: { id: string; noteIds: string[]; color: string }[]
}> {
  const lines = (await exportJsonl(request, boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { type: string; id: string; noteIds?: string[]; color?: string })
  const notes = new Map<string, ServerNote>()
  const yarns: { id: string; noteIds: string[]; color: string }[] = []
  for (const r of lines) {
    if (r.type === 'note') notes.set(r.id, r as unknown as ServerNote)
    if (r.type === 'yarn') yarns.push({ id: r.id, noteIds: r.noteIds ?? [], color: r.color ?? '' })
  }
  return { notes, yarns }
}
