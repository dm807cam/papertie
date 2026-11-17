import { expect, type Page } from '@playwright/test'
import { coverFromSeed } from '../../../apps/web/src/book/cover/cover'
import { newId, posBetween, posKeysBetween } from '../../../packages/core/src'
import { APP_URL, apiFor } from './app'

/** Titles a shelf is filled with: a calm mix of lengths, as a writer's would be. */
export const TITLES = [
  'Field notes',
  'Winter letters',
  'Dissertation',
  'Essays 2026',
  'On collecting',
  'The paper garden',
  'Milan, slowly',
  'Recipes',
  'Morning pages',
  'A year of rivers',
  'Untitled draft',
  'Notes on light',
]

/**
 * `n` books on the board, through the API (one batch per 100), each with one paragraph,
 * in shelf order: `titles` repeated and numbered past their end. Returns their ids.
 */
export async function seedBooks(
  page: Page,
  boardId: string,
  n: number,
  titles: readonly string[] = TITLES,
): Promise<string[]> {
  const headers = { Origin: APP_URL }
  const meta = await apiFor(page).get(`/api/boards/${boardId}/meta`)
  let revision = ((await meta.json()) as { revision: number }).revision
  const clientId = newId('tab', Date.now())
  const at = new Date().toISOString()
  const ids: string[] = []
  let pos: string | null = null
  let seq = 0
  for (let from = 0; from < n; from += 100) {
    const ops = []
    for (let i = from; i < Math.min(n, from + 100); i++) {
      pos = posBetween(pos, null)
      const id = newId('book')
      ids.push(id)
      const base = titles[i % titles.length] as string
      const title = i < titles.length ? base : `${base} ${Math.floor(i / titles.length) + 1}`
      ops.push({
        op: 'book.create',
        book: {
          type: 'book',
          id,
          title,
          lang: 'en',
          shelfPos: pos,
          cover: coverFromSeed((i * 2_654_435_761 + 97) >>> 0),
          trashedAt: null,
          createdAt: at,
          updatedAt: at,
        },
      })
      ops.push({
        op: 'block.create',
        block: {
          type: 'block',
          id: newId('block'),
          bookId: id,
          pos: posBetween(null, null),
          kind: 'p',
          text: '',
          marks: [],
        },
      })
    }
    const data = { clientId, seq: ++seq, baseRevision: revision, ops }
    const res = await apiFor(page).post(`/api/boards/${boardId}/ops`, { headers, data })
    expect(res.status(), await res.text()).toBe(200)
    revision = ((await res.json()) as { revision: number }).revision
  }
  return ids
}

/** A paragraph to seed: a `p` with no marks unless said. */
export interface BookBlock {
  kind?: 'p' | 'h1' | 'h2' | 'quote' | 'li' | 'prompt' | 'figure' | 'footnote'
  text: string
  marks?: { t: 'b' | 'i' | `c:${string}` | `n:${string}`; from: number; to: number }[]
  /** Its id, when a mark names it (a footnote's anchor); else a new one. */
  id?: string
  /** A figure's: an asset on the board (`uploadFigure`). */
  image?: { assetId: string; card?: string }
}

/**
 * A photo on the board, as the board's own upload sends it (a 600 × 400 PNG drawn in
 * the page): its asset id. The page must be on the app.
 */
export async function uploadFigure(page: Page, boardId: string): Promise<string> {
  return page.evaluate(async (boardId) => {
    const c = document.createElement('canvas')
    c.width = 600
    c.height = 400
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = '#2e4b7a'
    g.fillRect(0, 0, 600, 400)
    g.fillStyle = '#e9dcc3'
    g.fillRect(60, 60, 240, 160)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
    const form = new FormData()
    form.append('file', new File([blob], 'figure.png', { type: 'image/png' }))
    const res = await fetch(`/api/boards/${boardId}/assets`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`upload: ${res.status}`)
    return ((await res.json()) as { asset: { id: string } }).asset.id
  }, boardId)
}

/** Post `ops` to the board through the API, 500 a batch, under a client id of their own. Returns the board's revision. */
export async function opsOn(page: Page, boardId: string, ops: unknown[]): Promise<number> {
  const headers = { Origin: APP_URL }
  let revision = (
    (await (await apiFor(page).get(`/api/boards/${boardId}/meta`)).json()) as {
      revision: number
    }
  ).revision
  const clientId = newId('tab', Date.now())
  let seq = 0
  for (let from = 0; from < ops.length; from += 500) {
    const data = { clientId, seq: ++seq, baseRevision: revision, ops: ops.slice(from, from + 500) }
    const res = await apiFor(page).post(`/api/boards/${boardId}/ops`, { headers, data })
    expect(res.status(), await res.text()).toBe(200)
    revision = ((await res.json()) as { revision: number }).revision
  }
  return revision
}

/** One book on the board with `o.blocks` in order, through the API. Returns its id. */
export async function seedBook(
  page: Page,
  boardId: string,
  o: { title: string; lang?: 'de' | 'en'; blocks: readonly BookBlock[] },
): Promise<string> {
  const id = newId('book')
  const at = new Date().toISOString()
  const keys = posKeysBetween(null, null, Math.max(1, o.blocks.length))
  await opsOn(page, boardId, [
    {
      op: 'book.create',
      book: {
        type: 'book',
        id,
        title: o.title,
        lang: o.lang ?? 'en',
        shelfPos: posBetween(null, null),
        cover: coverFromSeed(7),
        trashedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    },
    ...o.blocks.map((b, i) => ({
      op: 'block.create',
      block: {
        type: 'block',
        id: b.id ?? newId('block'),
        bookId: id,
        pos: keys[i],
        kind: b.kind ?? 'p',
        text: b.text,
        marks: b.marks ?? [],
        ...(b.image === undefined ? {} : { image: b.image }),
      },
    })),
  ])
  return id
}

/** The book's paragraphs as the board file holds them, in order. */
export async function bookBlocks(
  page: Page,
  boardId: string,
  bookId: string,
): Promise<Array<{ id: string; kind: string; text: string; pos: string; marks: unknown[] }>> {
  const res = await apiFor(page).get(`/api/boards/${boardId}/export?format=jsonl`)
  expect(res.status()).toBe(200)
  return (await res.text())
    .split('\n')
    .filter((l) => l !== '')
    .map(
      (l) =>
        JSON.parse(l) as {
          type: string
          bookId?: string
          id: string
          kind: string
          text: string
          pos: string
          marks: unknown[]
        },
    )
    .filter((r) => r.type === 'block' && r.bookId === bookId)
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1))
}
