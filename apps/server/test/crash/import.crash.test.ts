import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId, parseBoard } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { noteCreate } from '../helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from '../helpers/books'
import { png } from '../helpers/images'
import {
  boardDirOf,
  call,
  createBoard,
  createUser,
  getBoard,
  postOps,
  type ServerChild,
  spawnServer,
  type User,
  walk,
} from './serverChild'

/**
 * Review Focus 2: an import is all or nothing. Killed at any point of its commit, the board loads
 * afterwards either exactly as it was or exactly as imported, never a mix; the safety backup is
 * there whenever the imported board is; and no `import-*` directory survives the restart.
 */

/** Before the new snapshot is renamed in: the board stays as it was. */
const BEFORE = [
  'backup:after-write',
  'import:after-asset-move',
  'snapshot:after-tmp-fsync',
  'restore:after-intent',
]
/** After it: the import stands. */
const AFTER = ['snapshot:after-rename', 'snapshot:after-dir-fsync', 'journal:after-rotate']

let root: string
const children: ServerChild[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'papertie-import-crash-'))
})
afterEach(async () => {
  for (const c of children.splice(0)) c.kill()
  await rm(root, { recursive: true, force: true })
})

async function server(dataDir: string, fault?: string): Promise<ServerChild> {
  const c = await spawnServer(dataDir, fault ? { fault } : {})
  children.push(c)
  return c
}

/** The board as loaded: its notes' ids and texts, its threads' ids, and its photos' ids. */
async function contentOf(s: ServerChild, user: User, board: string) {
  const res = await getBoard(s, user, board)
  expect(res.status).toBe(200)
  const state = parseBoard(await res.text()).state
  if (!state) throw new Error('board did not parse')
  return {
    notes: [...state.notes.values()]
      .map((n) => `${n.id} ${n.text} ${n.image ? 'photo' : '-'}`)
      .sort(),
    yarns: [...state.yarns.keys()].sort(),
    assets: [...state.assets.keys()].sort(),
    shown: [...state.notes.values()].flatMap((n) => (n.image ? [n.image.assetId] : [])),
  }
}

async function commitOps(s: ServerChild, user: User, board: string, seq: number, ops: unknown[]) {
  const meta = await call(s, `/api/boards/${board}/meta`)
  const { revision } = (await meta.json()) as { revision: number }
  const res = await postOps(s, user, board, { clientId: tab, seq, baseRevision: revision, ops })
  expect(res.status, await res.clone().text()).toBe(200)
}

const tab = newId('tab')

describe('import is all-or-nothing across SIGKILL', () => {
  it.each([...BEFORE, ...AFTER])('%s', async (point) => {
    const dataDir = join(root, 'data')
    const first = await server(dataDir)
    const user = await createUser(first)
    const board = await createBoard(first, user, 'Before')
    const dir = boardDirOf(dataDir, user, board)

    // The file: two notes (one with a photo) and a thread.
    const form = new FormData()
    form.append('file', new File([new Uint8Array(await png(64, 48))], 'p.png'))
    const up = await call(first, `/api/boards/${board}/assets`, { method: 'POST', body: form })
    expect(up.status).toBe(201)
    const photo = ((await up.json()) as { asset: { id: string } }).asset.id
    const at = new Date().toISOString()
    const [n1, n2] = [newId('note'), newId('note')]
    const plain = noteCreate({ id: n2, text: 'with a photo', at })
    const withPhoto = {
      ...plain,
      note: { ...plain.note, image: { assetId: photo, frame: 'print' } },
    }
    await commitOps(first, user, board, 1, [
      noteCreate({ id: n1, text: 'in the file', at }),
      withPhoto,
    ])
    await commitOps(first, user, board, 2, [
      {
        op: 'yarn.create',
        yarn: {
          type: 'yarn',
          id: newId('yarn'),
          noteIds: [n1, n2],
          color: 'apricot',
          label: '',
          createdAt: at,
          updatedAt: at,
        },
      },
    ])
    const exported = await call(first, `/api/boards/${board}/export?format=papertie`)
    const file = Buffer.from(await exported.arrayBuffer())
    const imported = await contentOf(first, user, board)
    // The board moves on: a third note, and the thread goes.
    await commitOps(first, user, board, 3, [noteCreate({ text: 'after the export', at })])
    await commitOps(first, user, board, 4, [{ op: 'yarn.delete', id: imported.yarns[0] }])
    const before = await contentOf(first, user, board)
    const backupsBefore = await readdir(join(dir, 'backups'))
    await first.stop()

    const faulty = await server(dataDir, `${point}@1`)
    const body = new FormData()
    body.append('file', new File([new Uint8Array(file)], 'board.papertie'))
    const res = await call(faulty, `/api/boards/${board}/import`, { method: 'POST', body })
    expect(res.status).toBe(200)
    const { importId } = (await res.json()) as { importId: string }
    await Promise.allSettled([
      call(faulty, `/api/boards/${board}/import/${importId}/commit`, {
        method: 'POST',
        body: '{}',
      }),
    ])
    expect(await faulty.exited).toBe('SIGKILL')

    const fresh = await server(dataDir)
    const after = await contentOf(fresh, user, board)
    const { notes, yarns } = after
    const meta = (await (await call(fresh, `/api/boards/${board}/meta`)).json()) as {
      name: string
      recovery: { integrity: string; latestBackup: { file: string } | null } | null
    }
    if (BEFORE.includes(point)) {
      expect({ notes, yarns }).toEqual({ notes: before.notes, yarns: before.yarns })
      expect(after.assets).toEqual(before.assets)
      expect(meta.name).toBe('Before')
      // Cut short after its marker: the notice says so, and never that it happened. Before the
      // marker, nothing tells the board an import began.
      expect(meta.recovery?.integrity ?? null).toBe(
        point === 'restore:after-intent' ? 'import-interrupted' : null,
      )
      // A photo moved in before the cut (`moved.json` names it and a snapshot that never went
      // in) is gone after the restart: the board's photo directories are exactly its records'.
      expect((await readdir(join(dir, 'assets'))).sort()).toEqual(before.assets)
    } else {
      // The import stands, whole: the file's notes and thread, its photo under a new id.
      expect({ notes, yarns }).toEqual({ notes: imported.notes, yarns: imported.yarns })
      expect(after.assets).toHaveLength(1)
      expect(after.assets[0]).not.toBe(photo)
      expect(after.shown).toEqual(after.assets)
      expect(existsSync(join(dir, 'assets', after.assets[0] as string, '2560.webp'))).toBe(true)
      expect((await call(fresh, `/api/assets/${after.assets[0]}/256`)).status).toBe(200)
      // The safety backup is there: the board as it was just before, marked for retention.
      const backups = await readdir(join(dir, 'backups'))
      const safety = backups.filter((b) => !backupsBefore.includes(b) && !b.endsWith('.safety'))
      expect(safety).toHaveLength(1)
      expect(backups.filter((b) => !backupsBefore.includes(b)).sort()).toEqual(
        [safety[0], `${safety[0]}.safety`].sort(),
      )
      expect(meta.recovery).toMatchObject({
        integrity: 'imported',
        latestBackup: { file: safety[0] },
      })
    }
    // Nothing of the import is left beside the board.
    expect((await readdir(dir)).filter((n) => n.startsWith('import-'))).toEqual([])
    expect((await readdir(dir)).filter((n) => n === 'restore.json')).toEqual([])
    // Every photo the board shows is there. Beside it only the replaced board's photo, which the
    // safety backup shows (the asset sweep's to collect): nothing of a cut-short move.
    for (const id of after.shown) expect(existsSync(join(dir, 'assets', id))).toBe(true)
    expect((await readdir(join(dir, 'assets'))).sort()).toEqual(
      [...new Set([...before.assets, ...after.assets])].sort(),
    )
    expect((await walk(dir)).some((p) => p.includes('upload'))).toBe(false)
    await fresh.stop()
  })
})

describe('an import with books across SIGKILL (one unit)', () => {
  /** The board's books and blocks as the file holds them (the export carries the blocks). */
  async function booksOf(s: ServerChild, _user: User, board: string) {
    const res = await call(s, `/api/boards/${board}/export?format=jsonl`)
    expect(res.status).toBe(200)
    const state = parseBoard(await res.text()).state
    if (!state) throw new Error('board did not parse')
    return {
      books: [...state.books.values()].map((b) => `${b.id} ${b.title}`).sort(),
      blocks: [...state.blocks.values()].map((b) => `${b.bookId} ${b.text}`).sort(),
      notes: state.notes.size,
    }
  }

  it.each(['restore:after-intent', 'snapshot:after-tmp-fsync', ...AFTER])(
    'an import rolled back mid-way leaves board and books as they were (%s)',
    async (point) => {
      const dataDir = join(root, 'data')
      const first = await server(dataDir)
      const user = await createUser(first)
      const board = await createBoard(first, user, 'Before')
      const at = new Date().toISOString()
      const fileBook = { ...bookRecord({ title: 'In the file' }), createdAt: at, updatedAt: at }
      const block = blockRecord(fileBook.id, 'V', 'as exported')
      await commitOps(first, user, board, 1, [
        noteCreate({ text: 'note in the file', at }),
        bookCreate(fileBook),
        blockCreate(block),
      ])
      const exported = await call(first, `/api/boards/${board}/export?format=papertie`, {})
      const file = Buffer.from(await exported.arrayBuffer())
      const imported = await booksOf(first, user, board)
      // The board and its books move on.
      const later = { ...bookRecord({ title: 'Written after' }), createdAt: at, updatedAt: at }
      await commitOps(first, user, board, 2, [
        edit(fileBook.id, block.id, [ins(11, ', then edited')]),
        bookCreate(later),
        blockCreate(blockRecord(later.id, 'V', 'new words')),
      ])
      const before = await booksOf(first, user, board)
      await first.stop()

      const faulty = await server(dataDir, `${point}@1`)
      const body = new FormData()
      body.append('file', new File([new Uint8Array(file)], 'board.papertie'))
      const res = await call(faulty, `/api/boards/${board}/import`, { method: 'POST', body })
      expect(res.status).toBe(200)
      const { importId } = (await res.json()) as { importId: string }
      await Promise.allSettled([
        call(faulty, `/api/boards/${board}/import/${importId}/commit`, {
          method: 'POST',
          body: '{}',
        }),
      ])
      expect(await faulty.exited).toBe('SIGKILL')

      const fresh = await server(dataDir)
      const after = await booksOf(fresh, user, board)
      expect(after).toEqual(AFTER.includes(point) ? imported : before)
      await fresh.stop()
    },
  )
})
