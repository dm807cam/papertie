/**
 * Between the writer's editor and the board: its changes as core ops, and the
 * board's changes to a book (a restore's, an undo's) as editor changes.
 */
import {
  applyBatch,
  type Block,
  type BoardState,
  bookBlocks,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  type Op,
  posKeysBetween,
} from '@papertie/core'
import type { EditorBlock, EditorChange } from '../../src/book/editor/BookEditor'
import { BookModel } from '../../src/book/editor/model'
import { bookDiff, changesToOps, opsToChanges } from '../../src/book/editorOps'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'

const BOOK = idOf('book', 7)

/** A board holding `BOOK` with one paragraph per text, `para(1…)`, at `keys` (spread by default). */
function bookState(texts: readonly string[], keys?: readonly string[]): BoardState {
  const pos = keys ?? posKeysBetween(null, null, texts.length)
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(BOOK), trashedAt: null } },
      ...texts.map(
        (text, i): ClientOp => ({
          op: 'block.create',
          block: {
            type: 'block',
            id: para(i + 1),
            bookId: BOOK,
            pos: pos[i] as string,
            kind: 'p',
            text,
            marks: [],
          },
        }),
      ),
    ],
    { now: T0 },
  )
}

const blocks = (s: BoardState) => bookBlocks(s.blocks, BOOK).chunks.flat()
const texts = (s: BoardState) => blocks(s).map((b) => b.text)
const apply = (s: BoardState, ops: readonly ClientOp[]) => applyBatch(s, ops, { now: T0 })

/** The editor's model of `s`'s book with `changes` applied, as plain blocks. */
function modelAfter(s: BoardState, changes: readonly EditorChange[]): EditorBlock[] {
  const m = new BookModel(blocks(s))
  for (const c of changes) expect(m.apply(c)).toBe(true)
  return m.snapshot()
}
const plain = (bs: readonly EditorBlock[]) =>
  bs.map(({ id, kind, text, marks }) => ({ id, kind, text, marks: [...marks] }))

describe('the editor’s blocks are the board’s', () => {
  it('core Block is assignable to EditorBlock', () => {
    const b: Block = {
      type: 'block',
      id: para(1),
      bookId: BOOK,
      pos: 'V',
      kind: 'quote',
      text: 'x',
      marks: [{ t: 'b', from: 0, to: 1 }],
    }
    const e: EditorBlock = b
    expectTypeOf<Block>().toExtend<EditorBlock>()
    expect(e.kind).toBe('quote')
  })
})

describe('changesToOps', () => {
  it('states typing, Enter, Backspace, a kind and a delete as the book’s ops', () => {
    const s = bookState(['Once upon a time', 'there was'])
    const newId = idOf('block', 50)
    const changes: EditorChange[] = [
      { t: 'edit', id: para(1), splices: [{ at: 4, del: 0, ins: ',' }] },
      { t: 'split', id: para(1), at: 5, newId, kind: 'p' },
      { t: 'kind', id: newId, kind: 'h2' },
      { t: 'merge', from: para(2), into: newId },
    ]
    const ops = changesToOps(s, BOOK, changes)
    expect(ops.map((o) => o.op)).toEqual(['block.edit', 'block.split', 'block.set', 'block.merge'])
    const split = ops[1] as Extract<ClientOp, { op: 'block.split' }>
    const first = blocks(s)[0] as Block
    const second = blocks(s)[1] as Block
    expect(split.pos > first.pos && split.pos < second.pos).toBe(true)
    // The merge says how long `into` is by then: the split's tail, " upon a time".
    expect(ops[3]).toMatchObject({ op: 'block.merge', from: para(2), into: newId, at: 12 })
    const after = apply(s, ops)
    expect(texts(after)).toEqual(['Once,', ' upon a timethere was'])
    expect(plain(blocks(after))).toEqual(plain(modelAfter(s, changes)))
  })

  it('a multi-paragraph paste is creates in order, and a cross-paragraph delete is deletes', () => {
    const s = bookState(['one', 'two', 'three', 'four'])
    const ids = [idOf('block', 60), idOf('block', 61), idOf('block', 62)]
    const paste: EditorChange[] = [
      { t: 'edit', id: para(1), splices: [{ at: 3, del: 0, ins: ' a' }] },
      { t: 'create', id: ids[0] as string, after: para(1), kind: 'p', text: 'b' },
      { t: 'create', id: ids[1] as string, after: ids[0] as string, kind: 'quote', text: 'c' },
      { t: 'create', id: ids[2] as string, after: ids[1] as string, kind: 'p', text: 'd' },
    ]
    const made = changesToOps(s, BOOK, paste)
    // Each create says the block it follows, as the editor had it.
    expect(made.flatMap((o) => (o.op === 'block.create' ? [o.after] : []))).toEqual([
      para(1),
      ids[0],
      ids[1],
    ])
    const pasted = apply(s, made)
    expect(texts(pasted)).toEqual(['one a', 'b', 'c', 'd', 'two', 'three', 'four'])
    expect(plain(blocks(pasted))).toEqual(plain(modelAfter(s, paste)))

    const cut: EditorChange[] = [
      { t: 'edit', id: para(2), splices: [{ at: 1, del: 2, ins: '' }] },
      { t: 'edit', id: para(4), splices: [{ at: 0, del: 2, ins: '' }] },
      { t: 'delete', id: para(3) },
      { t: 'merge', from: para(4), into: para(2) },
    ]
    const ops = changesToOps(pasted, BOOK, cut)
    expect(ops.map((o) => o.op)).toEqual([
      'block.edit',
      'block.edit',
      'block.delete',
      'block.merge',
    ])
    expect(texts(apply(pasted, ops))).toEqual(['one a', 'b', 'c', 'd', 'tur'])
  })

  it('a book with no blocks: its first keystroke creates the paragraph', () => {
    const s = bookState([])
    const id = idOf('block', 70)
    const ops = changesToOps(s, BOOK, [{ t: 'create', id, after: null, kind: 'p', text: 'H' }])
    expect(ops).toEqual([
      {
        op: 'block.create',
        block: {
          type: 'block',
          id,
          bookId: BOOK,
          pos: expect.any(String),
          kind: 'p',
          text: 'H',
          marks: [],
        },
        // First in the book.
        after: null,
      },
    ])
    expect(texts(apply(s, ops))).toEqual(['H'])
  })

  it('a split key past 64 characters re-spaces its neighbours', () => {
    // Two neighbours whose keys differ only in their 64th digit: the key between them is longer.
    const stem = `V${'0'.repeat(62)}`
    const keys = [
      ...posKeysBetween(null, `${stem}1`, 40),
      `${stem}1`,
      `${stem}2`,
      ...posKeysBetween(`${stem}2`, null, 40),
    ]
    const s = bookState(
      keys.map((_, i) => `p${i}`),
      keys,
    )
    const at = 41 // para(41) holds `${stem}1`
    const newId = idOf('block', 99)
    const ops = changesToOps(s, BOOK, [{ t: 'split', id: para(at), at: 1, newId, kind: 'p' }])
    const sets = ops.filter((o) => o.op === 'block.set')
    expect(sets.length).toBeGreaterThan(0)
    expect(sets.length).toBeLessThanOrEqual(64)
    const after = apply(s, ops)
    const order = blocks(after)
    // Every key is short again, the order is kept, and the new block is right after its head.
    for (const b of order) expect(b.pos.length).toBeLessThanOrEqual(64)
    expect(order.map((b) => b.id).indexOf(newId)).toBe(at)
    expect(order.map((b) => b.text)).toEqual(
      [...keys.map((_, i) => `p${i}`)].flatMap((t, i) =>
        i === at - 1 ? ['p', `${t.slice(1)}`] : [t],
      ),
    )
    // Only the 32 blocks on each side move.
    for (const op of sets) {
      const i = blocks(s).findIndex((b) => b.id === (op as { id: string }).id)
      expect(Math.abs(i - (at - 1))).toBeLessThanOrEqual(32)
    }
    expect(LIMITS.maxPosLength).toBe(128)
  })
})

describe('opsToChanges', () => {
  it('maps the board’s creates, deletes, moves, edits, splits and merges', () => {
    const s = bookState(['a', 'b', 'c'])
    const [k1, k2, k3] = blocks(s).map((b) => b.pos) as [string, string, string]
    const made: Block = {
      type: 'block',
      id: idOf('block', 80),
      bookId: BOOK,
      pos: posKeysBetween(k1, k2, 1)[0] as string,
      kind: 'quote',
      text: 'new',
      marks: [],
    }
    const ops: Op[] = [
      { op: 'block.create', block: made },
      { op: 'block.delete', bookId: BOOK, id: para(2) },
      // Moved past the last block.
      { op: 'block.set', bookId: BOOK, id: para(1), set: { pos: posKeysBetween(k3, null, 1)[0] } },
      { op: 'block.edit', bookId: BOOK, id: para(3), splices: [{ at: 1, del: 0, ins: '!' }] },
      {
        op: 'block.split',
        bookId: BOOK,
        id: para(3),
        at: 1,
        newId: idOf('block', 81),
        pos: posKeysBetween(k3, posKeysBetween(k3, null, 1)[0] as string, 1)[0] as string,
        kind: 'p',
      },
      { op: 'block.merge', bookId: BOOK, from: idOf('block', 81), into: idOf('block', 80), at: 3 },
    ]
    const after = apply(s, ops as ClientOp[])
    const changes = opsToChanges(ops, after)
    expect(changes.map((c) => c.t)).toEqual([
      'create',
      'delete',
      'delete',
      'create',
      'edit',
      'split',
      'merge',
    ])
    expect(changes[3]).toMatchObject({ t: 'create', id: para(1), after: para(3), text: 'a' })
    expect(plain(modelAfter(s, changes))).toEqual(plain(blocks(after)))
  })
})

describe('bookDiff', () => {
  it('states what changed between two versions of a book as ops, reading only what changed', () => {
    const s = bookState(Array.from({ length: 600 }, (_, i) => `paragraph ${i}`))
    const ids = blocks(s).map((b) => b.id)
    const k = blocks(s).map((b) => b.pos)
    const steps: ClientOp[][] = [
      [
        {
          op: 'block.edit',
          bookId: BOOK,
          id: ids[300] as string,
          splices: [{ at: 0, del: 0, ins: 'Remote ' }],
        },
      ],
      [{ op: 'block.delete', bookId: BOOK, id: ids[10] as string }],
      [
        {
          op: 'block.split',
          bookId: BOOK,
          id: ids[500] as string,
          at: 4,
          newId: idOf('block', 900),
          pos: posKeysBetween(k[500] as string, k[501] as string, 1)[0] as string,
          kind: 'p',
        },
      ],
      [
        {
          op: 'block.merge',
          bookId: BOOK,
          from: ids[201] as string,
          into: ids[200] as string,
          at: 13,
        },
      ],
      [{ op: 'block.set', bookId: BOOK, id: ids[5] as string, set: { kind: 'h1' } }],
      [
        {
          op: 'block.edit',
          bookId: BOOK,
          id: ids[7] as string,
          splices: [],
          addMarks: [{ t: 'i', from: 0, to: 4 }],
        },
      ],
      // Moved to the end.
      [
        {
          op: 'block.set',
          bookId: BOOK,
          id: ids[2] as string,
          set: { pos: posKeysBetween(k[599] as string, null, 1)[0] },
        },
      ],
    ]
    let state = s
    for (const ops of steps) {
      const next = apply(state, ops)
      const diff = bookDiff(BOOK, bookBlocks(state.blocks, BOOK), bookBlocks(next.blocks, BOOK))
      expect(plain(modelAfter(state, opsToChanges(diff, next)))).toEqual(plain(blocks(next)))
      state = next
    }
    // A split and a merge read back as a split and a merge (so a composition follows its text).
    const split = bookDiff(
      BOOK,
      bookBlocks(s.blocks, BOOK),
      bookBlocks(apply(s, steps[2] as ClientOp[]).blocks, BOOK),
    )
    expect(split.map((o) => o.op)).toEqual(['block.split'])
    const merged = bookDiff(
      BOOK,
      bookBlocks(s.blocks, BOOK),
      bookBlocks(apply(s, steps[3] as ClientOp[]).blocks, BOOK),
    )
    expect(merged.map((o) => o.op)).toEqual(['block.merge'])
    // Nothing changed, nothing said.
    expect(bookDiff(BOOK, bookBlocks(s.blocks, BOOK), bookBlocks(s.blocks, BOOK))).toEqual([])
  })
})

describe('bookDiff past a bound', () => {
  it('says nothing (null) once more chunks changed than `most` allows, before reading them', () => {
    const s = bookState(Array.from({ length: 2000 }, (_, i) => `p${i}`))
    const t = bookState(Array.from({ length: 2000 }, (_, i) => `q${i}`))
    expect(
      bookDiff(BOOK, bookBlocks(s.blocks, BOOK), bookBlocks(t.blocks, BOOK), { most: 4 }),
    ).toBeNull()
    // Within it, the ops as before.
    const one = apply(s, [
      { op: 'block.edit', bookId: BOOK, id: para(5), splices: [{ at: 0, del: 0, ins: 'x' }] },
    ])
    expect(
      bookDiff(BOOK, bookBlocks(s.blocks, BOOK), bookBlocks(one.blocks, BOOK), { most: 4 })?.map(
        (o) => o.op,
      ),
    ).toEqual(['block.edit'])
  })
})

describe('figures and their images between the editor and the board', () => {
  const ASSET = `asset_${'0'.repeat(25)}1`
  const ASSET2 = `asset_${'0'.repeat(25)}2`
  const NOTE = idOf('note', 1)
  const asset = (id: string, width: number, height: number): Op => ({
    op: 'asset.add',
    asset: {
      type: 'asset',
      id,
      mime: 'image/webp',
      width,
      height,
      bytes: 10,
      sha256: 'a'.repeat(64),
      createdAt: T0,
    },
  })
  const fig: Block = {
    type: 'block',
    id: para(9),
    bookId: BOOK,
    pos: 'zz',
    kind: 'figure',
    text: 'A caption',
    marks: [],
    image: { assetId: ASSET, card: NOTE },
  }
  const base = () =>
    apply(bookState(['one']), [asset(ASSET, 300, 200), asset(ASSET2, 100, 400)] as ClientOp[])

  it('a remote block.set image reaches the page, and a remote figure comes with its aspect', () => {
    const s = apply(base(), [{ op: 'block.create', block: fig }])
    expect(opsToChanges([{ op: 'block.create', block: fig }], s)).toEqual([
      {
        t: 'create',
        id: para(9),
        after: para(1),
        kind: 'figure',
        text: 'A caption',
        image: { assetId: ASSET, card: NOTE, aspect: 1.5 },
      },
    ])
    const set: Op = {
      op: 'block.set',
      bookId: BOOK,
      id: para(9),
      set: { image: { assetId: ASSET2 } },
    }
    const t = apply(s, [set as ClientOp])
    expect(opsToChanges([set], t)).toEqual([
      { t: 'image', id: para(9), image: { assetId: ASSET2 } },
    ])
    // What the board changed is said as the same op, and the model shows the new image.
    const diff = bookDiff(BOOK, bookBlocks(s.blocks, BOOK), bookBlocks(t.blocks, BOOK))
    expect(diff).toEqual([set])
    const m = new BookModel(blocks(s), {
      aspectOf: (id) => {
        const a = t.assets.get(id)
        return a === undefined ? undefined : a.width / a.height
      },
    })
    for (const c of opsToChanges(diff, t)) expect(m.apply(c)).toBe(true)
    expect(m.get(para(9))?.image).toEqual({ assetId: ASSET2, aspect: 0.25 })
  })

  it('the editor’s image change and a made figure are the board’s ops', () => {
    const s = apply(base(), [{ op: 'block.create', block: fig }])
    const ops = changesToOps(s, BOOK, [
      { t: 'image', id: para(9), image: { assetId: ASSET2, card: NOTE } },
      {
        t: 'create',
        id: para(10),
        after: para(9),
        kind: 'figure',
        text: '',
        image: { assetId: ASSET, aspect: 1.5 },
      },
    ])
    expect(ops[0]).toEqual({
      op: 'block.set',
      bookId: BOOK,
      id: para(9),
      set: { image: { assetId: ASSET2, card: NOTE } },
    })
    expect(ops[1]).toMatchObject({
      op: 'block.create',
      block: { id: para(10), kind: 'figure', image: { assetId: ASSET } },
    })
    expect((ops[1] as { block: Block }).block.image).toEqual({ assetId: ASSET })
    expect(() => apply(s, ops)).not.toThrow()
  })
})
