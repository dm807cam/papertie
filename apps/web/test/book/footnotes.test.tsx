/**
 * Footnotes in the writer: "Footnote" on a selection and its accelerator
 * `^[`, the numbers drawn through CSS (never text in the editing host), orphans, Backspace in an
 * empty footnote, ⌘K's ref (a card's, inserted at the caret), the word count and Find.
 */
import {
  applyBatch,
  type Block,
  type BoardState,
  bookBlocks,
  type ClientOp,
  emptyBoardState,
  posBetween,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { type BoardSession, openLocalSession, stepHistory } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { findInBook, type Match } from '../../src/book/find/find'
import { releaseSearchIndex, searchIndexFor } from '../../src/search/searchIndex'
import { attachBooks } from '../../src/sync/books/bookStore'
import { Sidebar } from '../../src/ui/Sidebar'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { blockEl, caret, caretOffset, press, type } from './writerKit'

const ID = idOf('book', 9)
const REFD = idOf('note', 1)
const REF = 'Thoreau, Walden, 1854'
const PLAIN = idOf('note', 2)

function stateWith(texts: readonly string[]): BoardState {
  const keys = posKeysBetween(null, null, texts.length)
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(ID, { title: 'On paper' }), trashedAt: null } },
      ...texts.map(
        (text, i): ClientOp => ({
          op: 'block.create',
          block: {
            type: 'block',
            id: para(i + 1),
            bookId: ID,
            pos: keys[i] as string,
            kind: 'p',
            text,
            marks: [],
          },
        }),
      ),
      { op: 'note.create', note: note(REFD, { text: 'Walden', ref: REF }) },
      { op: 'note.create', note: note(PLAIN, { text: 'Walden pond, a plain card', y: 400 }) },
      // Many plain cards edited after the one with a ref: the picker still offers it.
      ...Array.from(
        { length: 40 },
        (_, i): ClientOp => ({
          op: 'note.create',
          note: note(idOf('note', 100 + i), {
            text: `Walden plain ${i}`,
            y: 600 + i * 10,
            updatedAt: `2026-11-13T12:00:${String(i).padStart(2, '0')}.000Z`,
          }),
        }),
      ),
    ],
    { now: T0 },
  )
}

interface W {
  session: BoardSession
  batches: number
  page: HTMLElement
}

let session: BoardSession | null = null

function open(state: BoardState): W {
  const s = openLocalSession({ kind: 'local', state, label: 'test' })
  session = s
  attachBooks(s.store)
  const w: W = { session: s, batches: 0, page: document.body }
  s.store.onCommit(() => {
    w.batches++
  })
  // The book at full width, its formatting in the sidebar beside it.
  render(
    <>
      <BookScreen session={s} bookId={ID} />
      <Sidebar onNewNote={() => {}} books="book" />
    </>,
  )
  w.page = document.querySelector('.bk-book') as HTMLElement
  return w
}

const blocksOf = (s: BoardSession): Block[] =>
  bookBlocks(s.store.getState().blocks, ID).chunks.flat() as Block[]
const shapes = (s: BoardSession) => blocksOf(s).map((b) => [b.kind, b.text])
/** The sidebar's writing control `name`. */
const control = (name: string) =>
  within(screen.getByRole('toolbar', { name: 'Tools' })).getByRole('button', { name })
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const remote = (s: BoardSession, ops: readonly ClientOp[]) =>
  act(() => s.store.replace(applyBatch(s.store.getState(), ops, { now: T0 })))

/** A cut of the selection (its text out of the book, through the engine). */
function cut(el: HTMLElement): void {
  act(() => {
    const e = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'clipboardData', { value: { setData() {} } })
    el.dispatchEvent(e)
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      if (session) await searchIndexFor(session.store).query('', 1)
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

afterEach(() => {
  cleanup()
  if (session) releaseSearchIndex(session.store)
  session = null
  attachBooks(null)
  localStorage.clear()
})

describe('footnotes in the writer', () => {
  it('Footnote on a selection makes a numbered footnote after the paragraph and puts the caret in it', async () => {
    const w = open(stateWith(['Hello world.', 'Next']))
    const el = blockEl(w.page, para(1))
    caret(el, 6, 11)
    const before = w.batches
    fireEvent.click(control('Footnote'))
    expect(shapes(w.session)).toEqual([
      ['p', 'Hello world.'],
      ['footnote', ''],
      ['p', 'Next'],
    ])
    const fid = blocksOf(w.session)[1]?.id as string
    expect(blocksOf(w.session)[0]?.marks).toEqual([{ t: `n:${fid}`, from: 6, to: 11 }])
    // One commit; the caret in the new footnote.
    expect(w.batches - before).toBe(1)
    const fn = blockEl(w.page, fid)
    expect(fn.classList.contains('bk-footnote')).toBe(true)
    expect(caretOffset(fn)).toBe(0)
    await act(frame)
    expect(fn.dataset.n).toBe('1')
    expect(el.querySelector('.bk-anchor')?.getAttribute('data-n')).toBe('1')
    type('A note')
    expect(shapes(w.session)[1]).toEqual(['footnote', 'A note'])
    // Enter leaves it: the caret at its paragraph's end.
    expect(press('Enter')).toBe(true)
    expect(caretOffset(el)).toBe(12)
    expect(shapes(w.session)).toHaveLength(3)
    // The footnote was one undo step of its own, so labelled.
    const steps = w.session.undo
    steps.undo(w.session.store.getState())
    expect(steps.undo(w.session.store.getState())?.label).toBe('add a footnote')
  })

  it('^[ makes a footnote at the caret', () => {
    const w = open(stateWith(['Hello']))
    caret(blockEl(w.page, para(1)), 5)
    type(' world^[')
    const bs = blocksOf(w.session)
    expect(shapes(w.session)).toEqual([
      ['p', 'Hello world'],
      ['footnote', ''],
    ])
    // Anchored over the word before it.
    expect(bs[0]?.marks).toEqual([{ t: `n:${bs[1]?.id}`, from: 6, to: 11 }])
    expect(caretOffset(blockEl(w.page, bs[1]?.id))).toBe(0)
    type('See page 4')
    expect(shapes(w.session)[1]).toEqual(['footnote', 'See page 4'])
  })

  it('numbers follow anchor order, and a remote footnote before mine renumbers mine', async () => {
    const w = open(stateWith(['zero', 'alpha beta']))
    const el = blockEl(w.page, para(2))
    caret(el, 6, 10)
    fireEvent.click(control('Footnote'))
    caret(el, 0, 5)
    fireEvent.click(control('Footnote'))
    const bs = blocksOf(w.session)
    expect(bs.map((b) => b.kind)).toEqual(['p', 'p', 'footnote', 'footnote'])
    const [fa, fb] = [bs[2]?.id as string, bs[3]?.id as string]
    // In anchor order: alpha's footnote before beta's, whichever was made first.
    expect(bs[1]?.marks.find((m) => m.t === `n:${fa}`)?.from).toBe(0)
    expect(bs[1]?.marks.find((m) => m.t === `n:${fb}`)?.from).toBe(6)
    await act(frame)
    expect(blockEl(w.page, fa).dataset.n).toBe('1')
    expect(blockEl(w.page, fb).dataset.n).toBe('2')

    // A footnote the board takes on the paragraph before: mine are 2 and 3 now.
    const theirs = idOf('block', 77)
    const s = w.session.store.getState()
    const p1 = s.blocks.get(para(1)) as Block
    const p2 = s.blocks.get(para(2)) as Block
    remote(w.session, [
      {
        op: 'block.create',
        block: {
          type: 'block',
          id: theirs,
          bookId: ID,
          pos: posBetween(p1.pos, p2.pos),
          kind: 'footnote',
          text: 'theirs',
          marks: [],
        },
      },
      {
        op: 'block.edit',
        bookId: ID,
        id: para(1),
        splices: [],
        addMarks: [{ t: `n:${theirs}`, from: 0, to: 4 }],
      },
    ])
    await act(frame)
    expect(blockEl(w.page, theirs).dataset.n).toBe('1')
    expect(blockEl(w.page, fa).dataset.n).toBe('2')
    expect(blockEl(w.page, fb).dataset.n).toBe('3')
    expect([...el.querySelectorAll('.bk-anchor')].map((a) => a.getAttribute('data-n'))).toEqual([
      '2',
      '3',
    ])
  })

  it('deleting the anchored text shows the footnote as an orphan with Remove', async () => {
    const w = open(stateWith(['Hello world.']))
    const el = blockEl(w.page, para(1))
    caret(el, 6, 11)
    fireEvent.click(control('Footnote'))
    type('A note')
    const fid = blocksOf(w.session)[1]?.id as string
    caret(el, 6, 11)
    cut(el)
    expect(shapes(w.session)).toEqual([
      ['p', 'Hello .'],
      ['footnote', 'A note'],
    ])
    await act(frame)
    // Shown, never dropped: faded, with no number, and the way to remove it.
    const fn = blockEl(w.page, fid)
    expect(fn.hasAttribute('data-orphan')).toBe(true)
    expect(fn.dataset.n).toBeUndefined()
    expect(screen.getByText('No longer anchored')).toBeTruthy()
    const before = w.batches
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(shapes(w.session)).toEqual([['p', 'Hello .']])
    expect(w.batches - before).toBe(1)
    await act(frame)
    expect(screen.queryByText('No longer anchored')).toBeNull()
    expect(w.session.undo.undo(w.session.store.getState())?.label).toBe('remove a footnote')
  })

  it('Backspace in an empty footnote removes it and its anchor in one undo step', () => {
    const w = open(stateWith(['Hello world.']))
    const el = blockEl(w.page, para(1))
    caret(el, 6, 11)
    fireEvent.click(control('Footnote'))
    const before = w.batches
    expect(press('Backspace')).toBe(true)
    expect(shapes(w.session)).toEqual([['p', 'Hello world.']])
    expect(blocksOf(w.session)[0]?.marks).toEqual([])
    expect(w.batches - before).toBe(1)
    // The caret back after the anchored text.
    expect(caretOffset(el)).toBe(11)
    // One undo brings both back.
    act(() => stepHistory(w.session, 'undo'))
    const bs = blocksOf(w.session)
    expect(bs.map((b) => b.kind)).toEqual(['p', 'footnote'])
    expect(bs[0]?.marks).toEqual([{ t: `n:${bs[1]?.id}`, from: 6, to: 11 }])
  })

  it('a footnote with text keeps itself: Backspace at its start and Delete at its end join nothing', () => {
    const w = open(stateWith(['Hello world.', 'Next']))
    caret(blockEl(w.page, para(1)), 6, 11)
    fireEvent.click(control('Footnote'))
    type('Note')
    const fid = blocksOf(w.session)[1]?.id as string
    const fn = blockEl(w.page, fid)
    caret(fn, 0)
    expect(press('Backspace')).toBe(true)
    caret(fn, 4)
    expect(press('Delete')).toBe(true)
    // Backspace at the start of the paragraph after it joins the paragraph before the footnote.
    caret(blockEl(w.page, para(2)), 0)
    expect(press('Backspace')).toBe(true)
    expect(shapes(w.session)).toEqual([
      ['p', 'Hello world.Next'],
      ['footnote', 'Note'],
    ])
  })

  it('the DOM never shows an n: mark as text, and typing near the number never edits it', async () => {
    const w = open(stateWith(['Hello world.']))
    const el = blockEl(w.page, para(1))
    caret(el, 6, 11)
    fireEvent.click(control('Footnote'))
    type('Note')
    const fid = blocksOf(w.session)[1]?.id as string
    await act(frame)
    expect(el.textContent).toBe('Hello world.')
    const anchor = el.querySelector<HTMLElement>('.bk-anchor')
    expect(anchor?.dataset.n).toBe('1')
    // The number is the wrapper's attribute only: no text node of the host holds it.
    const texts: string[] = []
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) texts.push(n.nodeValue ?? '')
    expect(texts.join('')).toBe('Hello world.')
    expect(texts.some((t) => /\d/.test(t))).toBe(false)
    // Typed right after the number: the text goes on, the anchor and its number stay.
    caret(el, 11)
    type(',')
    expect(blocksOf(w.session)[0]?.text).toBe('Hello world,.')
    expect(blocksOf(w.session)[0]?.marks).toEqual([{ t: `n:${fid}`, from: 6, to: 11 }])
    await act(frame)
    expect(el.textContent).toBe('Hello world,.')
    expect(el.querySelector('.bk-anchor')?.textContent).toBe('world')
    expect(el.querySelector<HTMLElement>('.bk-anchor')?.dataset.n).toBe('1')
    // Typed right before the anchored word: the anchor moves with its word.
    caret(el, 6)
    type('x')
    expect(blocksOf(w.session)[0]?.marks).toEqual([{ t: `n:${fid}`, from: 7, to: 12 }])
  })

  it('⌘K in a footnote inserts a card’s ref at the caret, offering only cards with a ref', async () => {
    const w = open(stateWith(['Hello world.']))
    caret(blockEl(w.page, para(1)), 6, 11)
    fireEvent.click(control('Footnote'))
    type('See also')
    const fid = blocksOf(w.session)[1]?.id as string
    const fn = blockEl(w.page, fid)
    caret(fn, 8)
    act(() => {
      fn.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          code: 'KeyK',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await settle()
    const field = screen.getByRole('combobox') as HTMLInputElement
    expect(field.placeholder).toBe('Find a card with a reference')
    // Only the card with a ref is offered, though 41 plain cards were edited after it.
    const options = () => screen.getAllByRole('option').map((o) => o.textContent ?? '')
    expect(options()).toEqual(['Walden'])
    fireEvent.change(field, { target: { value: 'Walden' } })
    await settle()
    expect(options()).toHaveLength(1)
    const before = w.batches
    fireEvent.keyDown(field, { key: 'Enter' })
    await settle()
    expect(screen.queryByRole('combobox')).toBeNull()
    // Inserted at the caret: the footnote's own text kept.
    expect(shapes(w.session)[1]).toEqual(['footnote', `See also ${REF}`])
    expect(w.batches - before).toBe(1)
  })

  it('a cut across a footnote takes its anchor in the same change', async () => {
    const w = open(stateWith(['Walden and the pond', 'Second paragraph']))
    const el = blockEl(w.page, para(1))
    caret(el, 0, 6)
    fireEvent.click(control('Footnote'))
    type('Thoreau')
    const fid = blocksOf(w.session)[1]?.id as string
    expect(blocksOf(w.session)[0]?.marks).toEqual([{ t: `n:${fid}`, from: 0, to: 6 }])
    // From "pond" in P1 to the middle of P2, the footnote between them: a drag, the one host.
    const p2 = blockEl(w.page, para(2))
    act(() => {
      w.page.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    })
    caret(el, 15, 7, p2)
    act(() => document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
    const before = w.batches
    cut(el)
    expect(shapes(w.session)).toEqual([['p', 'Walden and the paragraph']])
    expect(blocksOf(w.session)[0]?.marks).toEqual([])
    expect(w.batches - before).toBe(1)
    await act(frame)
    expect(el.querySelector('.bk-anchor')).toBeNull()
  })

  it('a block made a prompt: its footnote shows as an orphan, as the exports leave it out', async () => {
    const w = open(stateWith(['Hello world.']))
    caret(blockEl(w.page, para(1)), 6, 11)
    fireEvent.click(control('Footnote'))
    type('A note')
    const fid = blocksOf(w.session)[1]?.id as string
    await act(frame)
    expect(blockEl(w.page, fid).dataset.n).toBe('1')
    remote(w.session, [{ op: 'block.set', bookId: ID, id: para(1), set: { kind: 'prompt' } }])
    await act(frame)
    await act(frame)
    expect(blockEl(w.page, fid).hasAttribute('data-orphan')).toBe(true)
    expect(blockEl(w.page, fid).dataset.n).toBeUndefined()
  })

  it('footnotes are not counted as words', async () => {
    const w = open(stateWith(['three words here']))
    const count = () => document.querySelector('.writer-count')?.textContent
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(count()).toBe('3 words')
    caret(blockEl(w.page, para(1)), 6, 11)
    fireEvent.click(control('Footnote'))
    type('four more words here')
    expect(count()).toBe('3 words')
  })

  it('Find searches footnotes', async () => {
    const w = open(stateWith(['Hello world.']))
    caret(blockEl(w.page, para(1)), 6, 11)
    fireEvent.click(control('Footnote'))
    type('lantern')
    const fid = blocksOf(w.session)[1]?.id
    const found = await new Promise<readonly Match[]>((done) => {
      findInBook(w.session.store.getState(), ID, 'lantern', {
        signal: new AbortController().signal,
        onSome: (m, end) => {
          if (end) done(m)
        },
      })
    })
    expect(found).toEqual([{ blockId: fid, from: 0, to: 7 }])
  })
})
