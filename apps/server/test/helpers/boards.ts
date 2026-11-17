import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BoardState,
  emptyBoardState,
  type Note,
  newId,
  parseBoard,
  serializeBoard,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import { JOURNAL_FILE, parseJournal, replay } from '../../src/store/journal'
import type { TestUser } from './client'
import type { TestServer } from './harness'

/** A `note.create` op; `at` is both `createdAt` and `updatedAt`. */
export function noteCreate(opts: { id?: string; text?: string; at: string }) {
  return {
    op: 'note.create',
    note: {
      type: 'note',
      id: opts.id ?? newId('note'),
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      z: 0,
      paper: 'cream',
      style: 'rustic',
      text: opts.text ?? 'hello',
      image: null,
      createdAt: opts.at,
      updatedAt: opts.at,
    },
  }
}

export const tabNow = (server: TestServer) => newId('tab', server.clock.now().getTime())

export const boardDir = (server: TestServer, userId: string, boardId: string) =>
  join(server.dataDir, 'users', userId, 'boards', boardId)

export const boardFile = (server: TestServer, userId: string, boardId: string) =>
  join(boardDir(server, userId, boardId), 'board.jsonl')

/**
 * The board as stored: `board.jsonl` as is when there is no journal, otherwise the canonical JSONL
 * of the snapshot with the journal replayed over it (what a restart loads).
 */
export function readBoardFile(server: TestServer, userId: string, boardId: string): Buffer {
  return storedBoard(boardDir(server, userId, boardId))
}

export function storedBoard(dir: string): Buffer {
  const file = readFileSync(join(dir, 'board.jsonl'))
  const journal = join(dir, JOURNAL_FILE)
  if (!existsSync(journal)) return file
  const snapshot = parseBoard(file.toString('utf8')).state
  if (!snapshot) throw new Error('board.jsonl did not load')
  return Buffer.from(serializeBoard(replay(parseJournal(readFileSync(journal)), snapshot).state))
}

/** Fold the board's journal into `board.jsonl` now (backups come from compactions). */
export async function compactBoard(server: TestServer, userId: string, boardId: string) {
  const store = server.deps.store
  if (!store) throw new Error('the server has no store')
  return store.compact(userId, boardId)
}

export async function createBoard(user: TestUser, name = 'Board'): Promise<string> {
  const res = await user.request('/api/boards', { method: 'POST', body: JSON.stringify({ name }) })
  if (res.status !== 201) throw new Error(`create board failed: ${res.status}`)
  return ((await res.json()) as { id: string }).id
}

export function postOps(user: TestUser, boardId: string, body: unknown) {
  return user.request(`/api/boards/${boardId}/ops`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** `notes` notes with ~120 characters of mixed text each, and threads of 50 notes. */
export function hugeState(
  boardId: string,
  notes: number,
  at = '2026-10-27T10:00:00.000Z',
): BoardState {
  const papers = ['cream', 'rose', 'sage', 'indigo'] as const
  const records: Array<Note | Yarn> = []
  const ids: string[] = []
  for (let i = 0; i < notes; i++) {
    const id = newId('note')
    ids.push(id)
    records.push({
      type: 'note',
      id,
      x: (i % 400) * 300,
      y: Math.floor(i / 400) * 260,
      w: 240,
      h: 160,
      z: i,
      paper: papers[i % papers.length] as Note['paper'],
      style: 'rustic',
      text: `Note ${i}: tied thoughts on cork and thread, kept for a lifetime — ${'€'.repeat(40)}`,
      image: null,
      createdAt: at,
      updatedAt: at,
    } as Note)
  }
  for (let t = 0; t + 50 <= Math.min(notes, 10_000); t += 50) {
    records.push({
      type: 'yarn',
      id: newId('yarn'),
      noteIds: ids.slice(t, t + 50),
      color: 'apricot',
      label: `thread ${t / 50}`,
      createdAt: at,
      updatedAt: at,
    } as Yarn)
  }
  const empty = emptyBoardState(boardId, 'Lifetime', at)
  return stateFromRecords(empty.board, records)
}
