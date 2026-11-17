import { expect } from '@playwright/test'
import { type Note, newId, type Op } from '../../../packages/core/src'
import { generateBoard } from '../../../tools/src/genBoard'
import { APP_URL, type Api } from './app'
import { freshStart, onlyBoard } from './server'

/**
 * A lifetime board: 100,000 notes less ten, which the specs pin with "+", on
 * genBoard's grid, and their threads.
 */
export const LIFETIME_NOTES = 99_990
export const LIFETIME_YARNS = 10_000

/** One request's ops: the API's per-batch cap. */
const BATCH_OPS = 500

/**
 * The lifetime board's notes and threads, as `generateBoard` lays them out (deterministic): a
 * 317-column grid of 340 × 300 world px cells. Photos are left out (they need an upload each).
 */
export function lifetimeRecords(): { notes: Note[]; ops: Op[] } {
  const state = generateBoard({ notes: LIFETIME_NOTES, yarns: LIFETIME_YARNS, seed: 4242 })
  const notes = [...state.notes.values()].map(
    (n): Note => (n.style === 'print' ? { ...n, style: 'rustic', image: null } : n),
  )
  const ops: Op[] = [
    ...notes.map((note): Op => ({ op: 'note.create', note })),
    ...[...state.yarns.values()].map((yarn): Op => ({ op: 'yarn.create', yarn })),
  ]
  return { notes, ops }
}

/**
 * Start afresh (`freshStart`: one empty board) and fill that board with `ops`, 500 a batch,
 * through the API as the page would (one client id, rising seq). Returns the board id.
 */
export async function seedBoard(request: Api, ops: readonly Op[]): Promise<string> {
  await freshStart(request)
  const boardId = await onlyBoard(request)
  await fillBoard(request, boardId, ops)
  return boardId
}

/**
 * Fill board `boardId` (an empty one: revision 0) with `ops`, as {@link seedBoard} does.
 */
export async function fillBoard(request: Api, boardId: string, ops: readonly Op[]): Promise<void> {
  const headers = { Origin: APP_URL }
  const clientId = newId('tab', Date.now())
  let revision = 0
  let seq = 0
  for (let i = 0; i < ops.length; i += BATCH_OPS) {
    const body = { clientId, seq: ++seq, baseRevision: revision, ops: ops.slice(i, i + BATCH_OPS) }
    const res = await request.post(`/api/boards/${boardId}/ops`, { headers, data: body })
    expect(res.status(), await res.text()).toBe(200)
    revision = ((await res.json()) as { revision: number }).revision
  }
}

/** The ids of `notes` whose stored rect meets the world rect `r`. */
export function notesIn(
  notes: readonly Note[],
  r: { x: number; y: number; w: number; h: number },
): string[] {
  return notes
    .filter((n) => n.x < r.x + r.w && n.x + n.w > r.x && n.y < r.y + r.h && n.y + n.h > r.y)
    .map((n) => n.id)
}
