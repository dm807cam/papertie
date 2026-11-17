import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  emptyBoardState,
  releaseBook,
  stripTimestamps,
  type Yarn,
} from '@papertie/core'
import { UndoStack } from '../../src/history/UndoStack'
import { loadBookSync } from '../../src/sync/books/bookOps'
import { BOOK, block, textOf as blockText, makeBook, para, typeAt } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'

const A = idOf('note', 1)
const B = idOf('note', 2)
const C = idOf('note', 3)
const N = A
const Y = idOf('yarn', 1)

const update = (id: string, set: Record<string, unknown>) =>
  ({ op: 'note.update', id, set }) as ClientOp

function thread(noteIds: string[]): Yarn {
  return {
    type: 'yarn',
    id: Y,
    noteIds,
    color: 'apricot',
    label: '',
    createdAt: T0,
    updatedAt: T0,
  }
}

/** Every commit gets a later stamp, as a real clock would give it. */
let tick = 0
const now = () => ({ now: new Date(Date.parse(T0) + ++tick * 1000).toISOString() })

/**
 * A board edited as the session edits one: each local commit is recorded, an undo or redo is
 * applied like any edit and not recorded, and a remote edit only changes the state.
 */
function board(initial: BoardState, stack = new UndoStack()) {
  let state = initial
  return {
    stack,
    get state() {
      return state
    },
    commit(ops: ClientOp[], label = 'Edit', coalesceKey?: string) {
      const before = state
      state = applyBatch(state, ops, now())
      stack.record(before, ops, label, coalesceKey)
    },
    remote(ops: ClientOp[]) {
      state = applyBatch(state, ops, now())
    },
    undo() {
      const r = stack.undo(state)
      if (r) state = applyBatch(state, r.ops, now())
      return r
    },
    redo() {
      const r = stack.redo(state)
      if (r) state = applyBatch(state, r.ops, now())
      return r
    },
  }
}

/** A board holding `notes`, and the thread through `threaded` when given. */
function seeded(notes: string[], threaded: string[] = []): BoardState {
  const ops: ClientOp[] = notes.map((id, i) => ({
    op: 'note.create',
    note: note(id, { x: i * 300, text: `note ${i}` }),
  }))
  if (threaded.length > 0) ops.push({ op: 'yarn.create', yarn: thread(threaded) })
  return applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), ops, { now: T0 })
}

describe('UndoStack', () => {
  it('undo note delete restores the note and its places in threads', () => {
    const b = board(seeded([A, B, C], [A, B, C]))
    const original = b.state.notes.get(B)
    b.commit([{ op: 'note.delete', id: B }], 'Delete note')
    expect(b.state.yarns.get(Y)?.noteIds).toEqual([A, C])

    const r = b.undo()
    expect(r).toMatchObject({ skipped: 0, label: 'Delete note' })
    expect(b.state.yarns.get(Y)?.noteIds).toEqual([A, B, C])
    const { updatedAt: _a, ...restored } = b.state.notes.get(B) ?? {}
    const { updatedAt: _b, ...before } = original ?? {}
    expect(restored).toEqual(before)
  })

  it('undo after a remote edit skips, never reverts', () => {
    // A remote text edit after my move: the move is undone, the text stays.
    const b = board(seeded([N]))
    b.commit([update(N, { x: 500, y: 40 })], 'Move note')
    b.remote([update(N, { text: 'from the store' })])
    const r = b.undo()
    expect(r).toMatchObject({ skipped: 0, label: 'Move note' })
    expect(b.state.notes.get(N)).toMatchObject({ x: 0, y: 0, text: 'from the store' })

    // A remote delete after my move: the undo skips its one part and changes nothing else.
    const d = board(seeded([N, B]))
    d.commit([update(N, { x: 500, y: 40 })], 'Move note')
    d.remote([{ op: 'note.delete', id: N }])
    const settled = d.state
    const s = d.undo()
    expect(s).toMatchObject({ ops: [], skipped: 1, label: 'Move note' })
    expect(d.state).toBe(settled)
    expect(d.stack.canUndo).toBe(false)
  })

  it('typing session is one undo step', () => {
    const b = board(seeded([N]))
    const start = stripTimestamps(b.state)
    for (const text of ['h', 'he', 'hel', 'hello']) {
      b.commit([update(N, { text })], 'Edit text', `text:${N}`)
    }
    // A height change mid-session is undone with it.
    b.commit([update(N, { text: 'hello\nworld', h: 160 })], 'Edit text', `text:${N}`)
    b.undo()
    expect(stripTimestamps(b.state)).toEqual(start)
    expect(b.stack.canUndo).toBe(false)

    // Another key, or none, starts a new step.
    b.commit([update(N, { text: 'a' })], 'Edit text', `text:${N}`)
    b.commit([update(N, { x: 9 })], 'Move note')
    b.commit([update(N, { text: 'ab' })], 'Edit text', `text:${N}`)
    b.undo()
    expect(b.state.notes.get(N)).toMatchObject({ text: 'a', x: 9 })
  })

  it('redo after undo reapplies; new edit clears redo', () => {
    const b = board(seeded([N]))
    b.commit([update(N, { x: 100 })], 'Move note')
    b.commit([update(N, { paper: 'rose' })], 'Change paper')
    expect(b.stack.canRedo).toBe(false)

    b.undo()
    expect(b.state.notes.get(N)).toMatchObject({ x: 100, paper: 'cream' })
    expect(b.stack.canRedo).toBe(true)
    const r = b.redo()
    expect(r).toMatchObject({ skipped: 0, label: 'Change paper' })
    expect(b.state.notes.get(N)).toMatchObject({ x: 100, paper: 'rose' })
    expect(b.stack.canRedo).toBe(false)

    // Redo is undoable again, and a new edit after an undo clears redo.
    b.undo()
    b.undo()
    expect(b.state.notes.get(N)).toMatchObject({ x: 0, paper: 'cream' })
    expect(b.stack.canRedo).toBe(true)
    b.commit([update(N, { y: 7 })], 'Move note')
    expect(b.stack.canRedo).toBe(false)
    expect(b.redo()).toBeNull()
    expect(b.state.notes.get(N)).toMatchObject({ x: 0, y: 7, paper: 'cream' })
  })

  it('redo skips what the board lost meanwhile', () => {
    const b = board(seeded([N, B]))
    b.commit([update(N, { x: 100 }), update(B, { x: 100 })], 'Move 2 notes')
    b.undo()
    b.remote([{ op: 'note.delete', id: B }])
    const r = b.redo()
    expect(r).toMatchObject({ skipped: 1, label: 'Move 2 notes' })
    expect(b.state.notes.get(N)?.x).toBe(100)
  })

  it('limit 200 drops the oldest', () => {
    const b = board(seeded([N]))
    for (let x = 1; x <= 201; x++) b.commit([update(N, { x })], 'Move note')
    let undone = 0
    while (b.undo()) undone++
    expect(undone).toBe(200)
    // The first move is out of reach: undoing stops at x = 1, not the start.
    expect(b.state.notes.get(N)?.x).toBe(1)
    expect(b.stack.canUndo).toBe(false)

    const small = board(seeded([N]), new UndoStack({ limit: 2 }))
    for (let x = 1; x <= 3; x++) small.commit([update(N, { x })], 'Move note')
    while (small.undo());
    expect(small.state.notes.get(N)?.x).toBe(1)
  })

  it('records nothing for a batch that changes nothing; clear empties both stacks', () => {
    const b = board(seeded([N]))
    b.commit([update(N, { x: 0 })], 'Move note')
    expect(b.stack.canUndo).toBe(false)
    expect(b.undo()).toBeNull()

    b.commit([update(N, { x: 3 })], 'Move note')
    b.commit([update(N, { x: 4 })], 'Move note')
    b.undo()
    expect(b.stack.canUndo && b.stack.canRedo).toBe(true)
    b.stack.clear()
    expect(b.stack.canUndo || b.stack.canRedo).toBe(false)
  })
})

describe('UndoStack, books', () => {
  beforeAll(async () => {
    await loadBookSync()
  })

  /** A board with the book of `texts`. */
  const book = (texts: string[]) =>
    board(applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), makeBook(texts), now()))

  it('a typing session is one step: its inverses compose into one edit of the paragraph', () => {
    const b = book([''])
    for (const [i, ch] of [...'word'].entries()) {
      b.commit([typeAt(1, i, ch)], 'Typing', `block:${para(1)}`)
    }
    const r = b.undo()
    expect(r?.ops).toEqual([
      { op: 'block.edit', bookId: BOOK, id: para(1), splices: [{ at: 0, del: 4, ins: '' }] },
    ])
    expect(blockText(b.state, 1)).toBe('')
  })

  /** A card's passage dropped after paragraph 1, as one block with its card's mark. */
  const dropped = (n: number, text: string): ClientOp => ({
    op: 'block.create',
    block: {
      type: 'block',
      id: para(n),
      bookId: BOOK,
      pos: 'W',
      kind: 'p',
      text,
      marks: [{ t: `c:${A}`, from: 0, to: text.length }],
    },
    after: para(1),
  })

  it('undo of a drop deletes its paragraph, and redo makes it again with its text and marks', () => {
    const b = book(['one'])
    const drop = dropped(5, 'card words')
    b.commit([drop], 'add to the book')
    const made = b.state.blocks.get(para(5))
    const r = b.undo()
    expect(r).toMatchObject({ skipped: 0, label: 'add to the book' })
    expect(r?.ops).toEqual([{ op: 'block.delete', bookId: BOOK, id: para(5) }])
    expect(b.state.blocks.has(para(5))).toBe(false)
    expect(b.redo()).toMatchObject({ skipped: 0 })
    expect(b.state.blocks.get(para(5))).toMatchObject({
      pos: made?.pos,
      text: 'card words',
      marks: made?.marks,
    })
  })
})

describe('UndoStack, a step fitted to the book as it is', () => {
  beforeAll(async () => {
    await loadBookSync()
  })

  it('undo of a join puts the paragraph back right after its head, before one made there since', () => {
    // Paragraphs 1 and 2 at keys V1 and V2.
    const b = board(
      applyBatch(emptyBoardState(BOARD_ID, 'Test board', T0), makeBook(['one', 'two']), now()),
    )
    b.commit([{ op: 'block.merge', bookId: BOOK, from: para(2), into: para(1), at: 3 }], 'Join')
    // Not a recorded step: a paragraph now right after the head, before paragraph 2's old key.
    b.remote([{ op: 'block.create', block: block(3, 'new', BOOK, 'V11') }])
    const r = b.undo()
    expect(r).toMatchObject({ skipped: 0, label: 'Join' })
    expect(blocksOf(b.state, BOOK).map((x) => x.text)).toEqual(['one', 'two', 'new'])
    // Redo joins them again, and undo of that puts it back the same.
    b.redo()
    expect(blocksOf(b.state, BOOK).map((x) => x.text)).toEqual(['onetwo', 'new'])
    b.undo()
    expect(blocksOf(b.state, BOOK).map((x) => x.text)).toEqual(['one', 'two', 'new'])
  })
})

describe('UndoStack, a book no longer held', () => {
  beforeAll(async () => {
    await loadBookSync()
  })

  it('undo of a book edit after the book was let go skips it, and counts it', () => {
    const start = applyBatch(
      emptyBoardState(BOARD_ID, 'Test board', T0),
      [...makeBook(['words']), { op: 'note.create', note: note(A) }],
      now(),
    )
    const stack = new UndoStack()
    let s = start
    const typed = [typeAt(1, 5, ' more')]
    stack.record(s, typed, 'Typing')
    s = applyBatch(s, typed, now())
    const moved = [update(A, { x: 99 })]
    stack.record(s, moved, 'Move')
    s = applyBatch(s, moved, now())
    const released = releaseBook(s, BOOK)
    expect(stack.undo(released)).toMatchObject({ skipped: 0, label: 'Move' })
    const r = stack.undo(released)
    expect(r).toMatchObject({ ops: [], skipped: 1, label: 'Typing' })
  })
})
