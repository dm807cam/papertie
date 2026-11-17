/**
 * The writer on a local board, typed into as a browser would (`writerKit.ts`):
 * every edit a commit of the session's store, every change of the board (the store's own, an
 * undo, a restore) on the page without moving the caret or breaking a dead key's composition.
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
  OpError,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { flushPlaces, recallPlace, rememberPlace } from '../../src/app/screenMemory'
import { type BoardSession, openLocalSession, stepHistory } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { openBook } from '../../src/book/shelfActions'
import { wordCountStats } from '../../src/book/wordCount'
import type { BookStore } from '../../src/sync/books/bookStore'
import { attachBooks, shelfBooks } from '../../src/sync/books/bookStore'
import { Sidebar } from '../../src/ui/Sidebar'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'
import { blockEl, caret, caretOffset, deadKey, paste, press, startDeadKey, type } from './writerKit'

const ID = idOf('book', 9)

function stateWith(
  texts: readonly string[],
  lang: 'de' | 'en' = 'en',
  title = 'On paper',
): BoardState {
  const keys = posKeysBetween(null, null, Math.max(1, texts.length))
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(ID, { title, lang }), trashedAt: null } },
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
    ],
    { now: T0 },
  )
}

interface Writer {
  session: BoardSession
  /** Every batch committed, in order. */
  batches: Array<{ ops: readonly ClientOp[]; coalesceKey?: string }>
  page: HTMLElement
}

function open(
  state: BoardState,
  o: { books?: BookStore | null; strict?: boolean; boardId?: string } = {},
): Writer {
  const session = openLocalSession({ kind: 'local', state, label: 'test' })
  if (o.books !== undefined) session.books = o.books
  // A server board's id: its places are kept by the app (a local board keeps none).
  if (o.boardId !== undefined) session.boardId = o.boardId
  attachBooks(session.store)
  const batches: Writer['batches'] = []
  session.store.onCommit((_before, ops, c) => {
    batches.push({ ops, ...(c.coalesceKey === undefined ? {} : { coalesceKey: c.coalesceKey }) })
  })
  // The book at full width, its formatting in the sidebar beside it.
  const ui = (
    <>
      <BookScreen session={session} bookId={ID} />
      <Sidebar onNewNote={() => {}} books="book" />
    </>
  )
  render(o.strict === false ? ui : <StrictMode>{ui}</StrictMode>)
  return { session, batches, page: document.querySelector('.bk-book') as HTMLElement }
}

const blocksOf = (s: BoardSession): Block[] =>
  bookBlocks(s.store.getState().blocks, ID).chunks.flat() as Block[]
const textsOf = (s: BoardSession) => blocksOf(s).map((b) => b.text)
const opsOf = (w: Writer) => w.batches.flatMap((b) => b.ops)
/** Ops the board takes from the store (as the sync client's view takes them): not a commit here. */
const remote = (s: BoardSession, ops: readonly Op[]) =>
  act(() => s.store.replace(applyBatch(s.store.getState(), ops as ClientOp[], { now: T0 })))

const KIND_NAMES = ['Paragraph', 'Chapter', 'Section', 'Quote', 'List', 'Prompt']
/**
 * The sidebar's writing control `name`: a kind is a choice of Text style's picker (opened by a
 * press on Text style when it is not open yet), the rest are the sidebar's own buttons.
 */
const control = (name: string) => {
  const bar = screen.getByRole('toolbar', { name: 'Tools' })
  if (!KIND_NAMES.includes(name)) return within(bar).getByRole('button', { name })
  if (screen.queryByRole('dialog', { name: 'Text style' }) === null) {
    const style = within(bar).getByRole('button', { name: 'Text style' })
    // Rendered at once, inside a test's own act() too.
    act(() => {
      fireEvent.pointerDown(style)
      flushSync(() => fireEvent.click(style))
    })
  }
  return within(screen.getByRole('dialog', { name: 'Text style' })).getByRole('radio', { name })
}

/** A book store that holds nothing itself: its resets are the test's to make. */
function stubBooks() {
  const resets = new Set<(ids: readonly string[]) => void>()
  const store: BookStore = {
    open: async () => true,
    close: () => {},
    onReset: (fn) => {
      resets.add(fn)
      return () => resets.delete(fn)
    },
    reset: (ids) => {
      for (const fn of resets) fn(ids ?? [])
    },
    changed: () => {},
    dispose: () => {},
  }
  return { store, reset: (ids: readonly string[]) => store.reset(ids) }
}

afterEach(() => {
  cleanup()
  attachBooks(null)
  history.replaceState(null, '', '/')
  localStorage.clear()
})

describe('the writer', () => {
  it('the title field is the one way to rename: typing in it updates the shelf', () => {
    const w = open(stateWith(['Text']))
    const title = screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement
    expect(title.value).toBe('On paper')
    fireEvent.change(title, { target: { value: 'On collecting' } })
    expect(shelfBooks(w.session.store.getState().books).map((b) => b.title)).toEqual([
      'On collecting',
    ])
    expect(w.batches.at(-1)).toEqual({
      ops: [{ op: 'book.update', id: ID, set: { title: 'On collecting' } }],
      coalesceKey: `title:${ID}`,
    })
    // The page names the book; nothing else on it renames it.
    expect(screen.getByRole('dialog', { name: 'On collecting' })).toBeTruthy()
    expect(screen.getAllByRole('textbox', { name: 'Title' })).toHaveLength(1)
  })

  it('typing "# On collecting" makes a chapter with its label and rule', () => {
    const w = open(stateWith(['']))
    caret(blockEl(w.page), 0)
    type('# On collecting')
    const [b] = blocksOf(w.session)
    expect(b).toMatchObject({ id: para(1), kind: 'h1', text: 'On collecting' })
    const h = blockEl(w.page, para(1))
    expect(h.tagName).toBe('H1')
    expect(h.textContent).toBe('On collecting')
    expect(h.dataset.label).toBe('Chapter 1')
    expect(h.classList.contains('bk-h1')).toBe(true)
    // The caret stays where the typing goes on.
    expect(caretOffset(h)).toBe('On collecting'.length)
    // In a German book the label is German.
    cleanup()
    const de = open(stateWith(['Vorwort', ''], 'de'))
    caret(blockEl(de.page, para(2)), 0)
    type('# Vom Sammeln')
    expect(blockEl(de.page, para(2)).dataset.label).toBe('Kapitel 1')
    expect(document.querySelector('.writer-page')?.getAttribute('lang')).toBe('de')
  })

  it('each accelerator matches its sidebar control exactly', () => {
    const cases: Array<{ typed: string; plain: string; name: string; from?: number; to?: number }> =
      [
        { typed: '# Title', plain: 'Title', name: 'Chapter' },
        { typed: '## Title', plain: 'Title', name: 'Section' },
        { typed: '> Title', plain: 'Title', name: 'Quote' },
        { typed: '- Title', plain: 'Title', name: 'List' },
        { typed: 'a *word*', plain: 'a word', name: 'Italic', from: 2, to: 6 },
        { typed: 'a **word**', plain: 'a word', name: 'Bold', from: 2, to: 6 },
      ]
    for (const c of cases) {
      const a = open(stateWith(['']))
      caret(blockEl(a.page), 0)
      type(c.typed)
      const byKeys = blocksOf(a.session)
      const formatting = opsOf(a).filter(
        (o) => o.op === 'block.set' || (o.op === 'block.edit' && (o.addMarks || o.removeMarks)),
      )
      cleanup()

      const b = open(stateWith(['']))
      caret(blockEl(b.page), 0)
      type(c.plain)
      caret(blockEl(b.page), c.from ?? 0, c.to ?? c.plain.length)
      const before = opsOf(b).length
      act(() => {
        fireEvent.pointerDown(control(c.name))
        fireEvent.click(control(c.name))
      })
      const byControl = opsOf(b).slice(before)
      expect(blocksOf(b.session), c.typed).toEqual(byKeys)
      // The marks and kinds alike; the splices (and what their typing takes, said beside them) are the keys' own.
      const marksOnly = (o: ClientOp) => ({ ...o, splices: undefined, takes: undefined })
      expect(byControl.map(marksOnly), c.typed).toEqual(formatting.map(marksOnly))
      cleanup()
    }
    // "Paragraph" turns a block back into a paragraph; it has no accelerator.
    const p = open(stateWith(['']))
    caret(blockEl(p.page), 0)
    type('> Said')
    caret(blockEl(p.page), 0, 4)
    act(() => {
      fireEvent.click(control('Paragraph'))
    })
    expect(blocksOf(p.session)[0]).toMatchObject({ kind: 'p', text: 'Said' })
  })

  it('German and English quotes and dashes are corrected as you type, and not inside a dead-key composition', () => {
    const en = open(stateWith(['']))
    caret(blockEl(en.page), 0)
    type('"Yes" -- she said...')
    expect(textsOf(en.session)).toEqual(['“Yes” – she said…'])
    // Each correction is part of its keystroke's own splice: one edit op per key.
    for (const b of en.batches) expect(b.ops).toHaveLength(1)
    cleanup()

    const de = open(stateWith([''], 'de'))
    caret(blockEl(de.page), 0)
    type('"Ja" -- sagte sie')
    expect(textsOf(de.session)).toEqual(['„Ja“ – sagte sie'])
    // A quote that came from a dead key (US International's ") stays as it was composed.
    type(' ')
    deadKey('"', '"')
    type('x')
    expect(textsOf(de.session)).toEqual(['„Ja“ – sagte sie "x'])
  })

  it('dead-key composition is never split by smart typography', () => {
    const w = open(stateWith(['caf']))
    const el = blockEl(w.page)
    caret(el, 3)
    const before = w.batches.length
    deadKey('´', 'é', () => {
      // Nothing is written while the mark is pending, and the page is left alone.
      expect(w.batches.length).toBe(before)
      expect(el.textContent).toBe('caf´')
    })
    expect(textsOf(w.session)).toEqual(['café'])
    // The composed text is one edit, after the composition, saying what it takes.
    expect(w.batches.slice(before)).toEqual([
      {
        ops: [
          {
            op: 'block.edit',
            bookId: ID,
            id: para(1),
            splices: [{ at: 3, del: 0, ins: 'é' }],
            takes: [[]],
          },
        ],
        coalesceKey: `type:${para(1)}`,
      },
    ])
    // A dash composed after a dash is not joined into an en dash.
    caret(el, 4)
    type(' -')
    deadKey('-', '-')
    expect(textsOf(w.session)).toEqual(['café --'])
    expect(caretOffset(el)).toBe(7)
  })

  it('remote splice during composition: the composition completes, then the remote text appears, both kept', () => {
    const w = open(stateWith(['Intro', 'cafe']))
    const el = blockEl(w.page, para(2))
    caret(el, 3)
    deadKey('´', 'é', () => {
      remote(w.session, [
        { op: 'block.edit', bookId: ID, id: para(2), splices: [{ at: 0, del: 0, ins: 'R ' }] },
        { op: 'block.edit', bookId: ID, id: para(1), splices: [{ at: 0, del: 0, ins: 'Remote ' }] },
      ])
      // The block before changes at once; the composing one waits for the end.
      expect(blockEl(w.page, para(1)).textContent).toBe('Remote Intro')
      expect(el.textContent).toBe('caf´e')
    })
    expect(textsOf(w.session)).toEqual(['Remote Intro', 'R cafée'])
    expect(blockEl(w.page, para(2)).textContent).toBe('R cafée')
    expect(caretOffset(blockEl(w.page, para(2)))).toBe(6)
  })

  it('Enter splits a paragraph keeping the existing part’s id; Backspace at its start merges', () => {
    const w = open(stateWith(['Once upon a time']))
    caret(blockEl(w.page), 4)
    const n = w.batches.length
    expect(press('Enter')).toBe(true)
    const split = opsOf(w).slice(n)
    expect(split).toEqual([
      expect.objectContaining({ op: 'block.split', id: para(1), at: 4, kind: 'p' }),
    ])
    const tail = (split[0] as Extract<ClientOp, { op: 'block.split' }>).newId
    expect(textsOf(w.session)).toEqual(['Once', ' upon a time'])
    expect(blocksOf(w.session)[0]?.id).toBe(para(1))
    expect(caretOffset(blockEl(w.page, tail))).toBe(0)

    const m = w.batches.length
    expect(press('Backspace')).toBe(true)
    expect(opsOf(w).slice(m)).toEqual([
      { op: 'block.merge', bookId: ID, from: tail, into: para(1), at: 4 },
    ])
    expect(textsOf(w.session)).toEqual(['Once upon a time'])
    expect(caretOffset(blockEl(w.page, para(1)))).toBe(4)
  })

  it('word count updates with O(1) block reads per keystroke', async () => {
    const texts = Array.from({ length: 400 }, (_, i) => `paragraph ${i} has five words`)
    const w = open(stateWith(texts))
    const count = () => document.querySelector('.writer-count')?.textContent
    // The count of the whole book comes in after the page (in slices), once.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(count()).toBe('2,000 words')
    wordCountStats.reads = 0
    caret(blockEl(w.page, para(3)), 0)
    type('two more ')
    expect(count()).toBe('2,002 words')
    // Nine keys: each counts the one block it changed, before and after.
    expect(wordCountStats.reads).toBeLessThanOrEqual(9 * 2)
    // An edit the board takes from the store is counted the same way.
    wordCountStats.reads = 0
    remote(w.session, [
      {
        op: 'block.edit',
        bookId: ID,
        id: para(200),
        splices: [{ at: 0, del: 0, ins: 'three more words ' }],
      },
    ])
    expect(count()).toBe('2,005 words')
    expect(wordCountStats.reads).toBeLessThanOrEqual(2)
  })

  it('⌘Z in the writer undoes writing through the session, never the browser', () => {
    const w = open(stateWith(['Hello']))
    const el = blockEl(w.page)
    caret(el, 5)
    type(' world')
    expect(textsOf(w.session)).toEqual(['Hello world'])
    expect(press('z', { metaKey: true })).toBe(true)
    expect(textsOf(w.session)).toEqual(['Hello'])
    expect(el.textContent).toBe('Hello')
    expect(press('z', { metaKey: true, shiftKey: true })).toBe(true)
    expect(textsOf(w.session)).toEqual(['Hello world'])
    // The browser's own history (a menu's Undo) is taken too.
    let prevented = false
    act(() => {
      const e = new InputEvent('beforeinput', {
        inputType: 'historyUndo',
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(e)
      prevented = e.defaultPrevented
    })
    expect(prevented).toBe(true)
    expect(textsOf(w.session)).toEqual(['Hello'])
  })

  it('a reset under an open writer: a restore resets the editor to the restored text; a book gone goes to the shelf with its notice', async () => {
    const resets = new Set<(ids: readonly string[]) => void>()
    const books: BookStore = {
      open: async () => true,
      close: () => {},
      onReset: (fn) => {
        resets.add(fn)
        return () => resets.delete(fn)
      },
      reset: (ids) => {
        for (const fn of resets) fn(ids ?? [])
      },
      changed: () => {},
      dispose: () => {},
    }
    const w = open(stateWith(['Before the restore', 'second']), { books })
    history.replaceState(null, '', `/book/${ID}`)
    // The restore: the board loaded whole, the book's text as it was.
    await act(async () => {
      w.session.store.replace(stateWith(['Restored text']), 'all')
      books.reset([ID])
    })
    expect(textsOf(w.session)).toEqual(['Restored text'])
    expect([...w.page.querySelectorAll('[data-id]')].map((e) => e.textContent)).toEqual([
      'Restored text',
    ])
    // Restored to a board without the book: back to the shelf, saying so.
    await act(async () => {
      w.session.store.replace(emptyBoardState(BOARD_ID, 'Test board', T0), 'all')
      books.reset([ID])
    })
    expect(location.pathname).toBe('/shelf')
    expect(w.session.feed.getState().notices).toEqual([
      expect.objectContaining({
        kind: 'book-gone',
        bookId: ID,
        message: 'This book isn’t in the restored board.',
      }),
    ])
  })

  it('a multi-paragraph paste creates one block per paragraph, and a remote block delete removes it from the page', () => {
    const w = open(stateWith(['Start end']))
    caret(blockEl(w.page), 6)
    const n = w.batches.length
    paste({ 'text/plain': 'one\ntwo\n\nthree ' })
    expect(textsOf(w.session)).toEqual(['Start one', 'two', 'three end'])
    expect(
      opsOf(w)
        .slice(n)
        .map((o) => o.op),
    ).toEqual(['block.edit', 'block.create', 'block.create'])
    const made = blocksOf(w.session)[1] as Block
    remote(w.session, [{ op: 'block.delete', bookId: ID, id: made.id }])
    expect([...w.page.querySelectorAll('[data-id]')].map((e) => e.textContent)).toEqual([
      'Start one',
      'three end',
    ])
  })

  it('paste of rich HTML keeps only the five kinds, bold and italic', () => {
    const w = open(stateWith(['']))
    caret(blockEl(w.page), 0)
    paste({
      'text/plain': 'ignored',
      'text/html':
        '<meta charset="utf-8"><h1 style="color:red">Title</h1><h3>Sub</h3>' +
        '<p class="x">Some <b>bold</b>, <i>italic</i>, <span style="font-weight:700">heavy</span> and <a href="https://x">a link</a>.</p>' +
        '<blockquote><p>Quoted</p></blockquote><ul><li>One</li><li>Two</li></ul>' +
        '<table><tr><td>Cell</td></tr></table><img src="x.png"><script>bad()</script>',
    })
    const got = blocksOf(w.session).map(({ kind, text, marks }) => ({ kind, text, marks }))
    expect(got).toEqual([
      { kind: 'h1', text: 'Title', marks: [] },
      { kind: 'h2', text: 'Sub', marks: [] },
      {
        kind: 'p',
        text: 'Some bold, italic, heavy and a link.',
        marks: [
          { t: 'b', from: 5, to: 9 },
          { t: 'b', from: 19, to: 24 },
          { t: 'i', from: 11, to: 17 },
        ],
      },
      { kind: 'quote', text: 'Quoted', marks: [] },
      { kind: 'li', text: 'One', marks: [] },
      { kind: 'li', text: 'Two', marks: [] },
      { kind: 'p', text: 'Cell', marks: [] },
    ])
    expect(w.page.querySelector('script, img, table, a, span[style]')).toBeNull()
  })

  it('while the book is read, the page waits calmly: no field to type into, no count, nothing said to be loading', async () => {
    // A board that does not hold the book yet (the tab's own new book after a full reload).
    let held: () => void = () => {}
    const books: BookStore = {
      open: () =>
        new Promise<boolean>((r) => {
          held = () => r(true)
        }),
      close: () => {},
      onReset: () => () => {},
      reset: () => {},
      changed: () => {},
      dispose: () => {},
    }
    const w = open({ ...stateWith(['Held later']), blocksHeld: new Set<string>() }, { books })
    const body = document.querySelector('.writer-body') as HTMLElement
    expect(body.querySelector('[data-id]')).toBeNull()
    expect(body.hasAttribute('inert')).toBe(true)
    expect(body.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector('.writer-count')).toBeNull()
    expect(document.body.textContent).not.toMatch(/loading/i)
    // The title is there all the while, and can be typed in.
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'On paper',
    )
    // Held: the text comes, and can be written in.
    await act(async () => {
      w.session.store.replace(stateWith(['Held later']))
      held()
    })
    expect(blockEl(document.body).textContent).toBe('Held later')
    expect(body.hasAttribute('inert')).toBe(false)
  })

  it('a Google Docs paste: its normal-weight wrapper is not bold, its one bold span is', () => {
    const w = open(stateWith(['']))
    caret(blockEl(w.page), 0)
    paste({
      'text/plain': 'ignored',
      'text/html':
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-7fff-1234-abcd-0123456789ab">' +
        '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;font-weight:400;font-style:normal;">Plain words and </span>' +
        '<span style="font-size:11pt;font-family:Arial,sans-serif;font-weight:700;font-style:normal;">one bold</span>' +
        '<span style="font-size:11pt;font-family:Arial,sans-serif;font-weight:400;font-style:italic;"> one italic</span></p>' +
        '<p dir="ltr"><span title="a > b" style="font-weight:700;">x&gt;y</span></p></b>',
    })
    const got = blocksOf(w.session).map(({ kind, text, marks }) => ({ kind, text, marks }))
    expect(got).toEqual([
      {
        kind: 'p',
        text: 'Plain words and one bold one italic',
        marks: [
          { t: 'b', from: 16, to: 24 },
          { t: 'i', from: 24, to: 35 },
        ],
      },
      { kind: 'p', text: 'x>y', marks: [{ t: 'b', from: 0, to: 3 }] },
    ])
    // An em under an explicit normal style is upright too.
    cleanup()
    const v = open(stateWith(['']))
    caret(blockEl(v.page), 0)
    paste({ 'text/html': '<p><em style="font-style: normal">plain</em> <i>slanted</i></p>' })
    expect(blocksOf(v.session)[0]?.marks).toEqual([{ t: 'i', from: 6, to: 13 }])
  })

  it('the empty paragraph of a book with none goes in where the page shows it, after a first paragraph the board took meanwhile', () => {
    const w = open(stateWith([]))
    const ghost = blockEl(w.page)
    // The board takes a first paragraph of the book while this page shows its empty one.
    remote(w.session, [
      {
        op: 'block.create',
        block: {
          type: 'block',
          id: para(7),
          bookId: ID,
          pos: 'V',
          kind: 'p',
          text: 'Theirs',
          marks: [],
        },
      },
    ])
    const page = () => [...w.page.querySelectorAll('[data-id]')].map((e) => e.textContent)
    expect(page()).toEqual(['Theirs', ''])
    caret(ghost, 0)
    type('Mine')
    // The board and the page agree on the order.
    expect(textsOf(w.session)).toEqual(page())
    expect(page()).toEqual(['Theirs', 'Mine'])
  })

  it('Esc that cancels a pending dead key (no composition events: Chrome on Windows and Linux) stays on the page', () => {
    const w = open(stateWith(['text']))
    history.replaceState(null, '', `/book/${ID}`)
    const el = blockEl(w.page)
    caret(el, 4)
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Dead', bubbles: true, cancelable: true }),
      )
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    expect(location.pathname).toBe(`/book/${ID}`)
    // A plain Esc after it goes to the shelf.
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    expect(location.pathname).toBe('/shelf')
  })

  it('a book let go under the page while a dead key composes: the page stays calm, nothing is built, the composed text is not lost', () => {
    const books = stubBooks()
    const w = open(stateWith(['cafe']), { books: books.store })
    const el = blockEl(w.page)
    caret(el, 3)
    const finish = startDeadKey('´')
    // The board loaded whole: it does not hold the book any more (it is read again, later).
    act(() =>
      w.session.store.replace({ ...w.session.store.getState(), blocksHeld: new Set<string>() }),
    )
    const body = document.querySelector('.writer-body') as HTMLElement
    expect(body.hasAttribute('inert')).toBe(true)
    finish('é')
    // Still calm, the same page (no model built from a book not held), and the text said for.
    expect(body.hasAttribute('inert')).toBe(true)
    expect(blockEl(w.page)).toBe(el)
    // Said without a cause it does not know: the paragraph is not gone, the book was let go.
    // (The live region adds a space to say a sentence again.)
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'What you wrote there couldn’t be kept.',
    )
  })

  it('a book asked for before the board was in is asked for again once the board moves on', async () => {
    // Opened as the board opens (its first paint): the sync client has no book to hold yet, so the
    // first ask comes to nothing; the board, once in, holds the book only if it is asked again.
    let opens = 0
    const books: BookStore = {
      open: async () => {
        opens++
        return true
      },
      close: () => {},
      onReset: () => () => {},
      reset: () => {},
      changed: () => {},
      dispose: () => {},
    }
    const unheld = { ...stateWith(['Held later']), blocksHeld: new Set<string>() }
    const w = open(unheld, { books, strict: false })
    await act(async () => {})
    expect(opens).toBe(1)
    // The board moves on (loaded whole, a commit): still not held, the writer asks again, once
    // for each revision of the board.
    const moved = (n: number) => ({
      ...unheld,
      board: { ...unheld.board, revision: unheld.board.revision + n },
    })
    await act(async () => w.session.store.replace(moved(1)))
    await act(async () => w.session.store.replace({ ...moved(1) }))
    expect(opens).toBe(2)
    await act(async () => w.session.store.replace(moved(2)))
    expect(opens).toBe(3)
    // Held: shown.
    await act(async () => w.session.store.replace(stateWith(['Held later'])))
    for (let k = 0; k < 5; k++) await act(() => new Promise((r) => setTimeout(r, 5)))
    expect(blockEl(document.body).textContent).toBe('Held later')
  })

  it('a book asked for while the board opens is asked for again when the opening ends, the board’s revision unchanged', async () => {
    // The first paint drew the board at its revision already; the whole board, handed over at
    // the opening's end, has the same revision: only the end itself says the book can be held.
    let opens = 0
    const books: BookStore = {
      open: async () => {
        opens++
        return true
      },
      close: () => {},
      onReset: () => () => {},
      reset: () => {},
      changed: () => {},
      dispose: () => {},
    }
    const unheld = { ...stateWith(['Held later']), blocksHeld: new Set<string>() }
    const session = openLocalSession({ kind: 'local', state: unheld, label: 'test' })
    session.books = books
    let end: () => void = () => {}
    const done = new Promise<void>((r) => {
      end = r
    })
    session.opening = {
      open: true,
      subscribe: () => () => {},
      done,
      painted: true,
      onPainted: () => () => {},
      booksWhole: true,
      onBooksWhole: () => () => {},
    }
    attachBooks(session.store)
    render(<BookScreen session={session} bookId={ID} />)
    await act(async () => {})
    expect(opens).toBe(1)
    await act(async () => session.store.replace({ ...unheld }))
    expect(opens).toBe(1)
    await act(async () => end())
    expect(opens).toBe(2)
  })

  it('a book let go while its page is being built is not shown until it is held again', async () => {
    const texts = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i + 1}.`)
    const books = stubBooks()
    let opens = 0
    const asked = books.store.open
    books.store.open = (id) => {
      opens++
      return asked(id)
    }
    const w = open(stateWith(texts), { books: books.store, strict: false })
    const body = document.querySelector('.writer-body') as HTMLElement
    // A long book is built in slices, the page calm meanwhile; the board lets it go in between.
    expect(body.hasAttribute('inert')).toBe(true)
    act(() =>
      w.session.store.replace({ ...w.session.store.getState(), blocksHeld: new Set<string>() }),
    )
    for (let k = 0; k < 20; k++) await act(() => new Promise((r) => setTimeout(r, 5)))
    // Built, but not shown: the board holds no book to write into.
    expect(body.hasAttribute('inert')).toBe(true)
    expect(body.querySelector('[data-id]')).toBeNull()
    // And the book is asked for again (it was let go before the page had it: nothing else asks).
    expect(opens).toBe(2)
    // Held again: shown, and written in.
    await act(async () =>
      w.session.store.replace({ ...w.session.store.getState(), blocksHeld: 'all' }),
    )
    for (let k = 0; k < 20; k++) await act(() => new Promise((r) => setTimeout(r, 5)))
    expect(body.hasAttribute('inert')).toBe(false)
    expect(blockEl(body).textContent).toBe('Paragraph 1.')
  })

  it('a reset waiting for a dead key, then an edit from the store: when it lands, the page is the board', async () => {
    const books = stubBooks()
    const w = open(stateWith(['cafe', 'two']), { books: books.store })
    caret(blockEl(w.page, para(1)), 3)
    const finish = startDeadKey('´')
    // A restore under the composition: the book as it was, then the board takes an edit of it.
    const restored = stateWith(['Restored cafe', 'two'])
    await act(async () => {
      w.session.store.replace(restored, 'all')
      books.reset([ID])
    })
    act(() =>
      w.session.store.replace(
        applyBatch(
          w.session.store.getState(),
          [
            {
              op: 'block.edit',
              bookId: ID,
              id: para(2),
              splices: [{ at: 0, del: 0, ins: 'their ' }],
            },
          ],
          { now: T0 },
        ),
      ),
    )
    finish('é')
    const page = [...w.page.querySelectorAll('[data-id]')].map((e) => e.textContent)
    expect(textsOf(w.session)).toEqual(['Resétored cafe', 'their two'])
    expect(page).toEqual(textsOf(w.session))
  })

  it('Esc after a dead key that a plain letter followed (no composition events) goes to the shelf', () => {
    const w = open(stateWith(['text']))
    history.replaceState(null, '', `/book/${ID}`)
    const el = blockEl(w.page)
    caret(el, 4)
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Dead', bubbles: true, cancelable: true }),
      )
    })
    type('e')
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
    })
    expect(location.pathname).toBe('/shelf')
  })

  it('on a board with no server (no unsaved-changes path), writing into a paragraph gone is said, not dropped silently', () => {
    const w = open(stateWith(['first', 'cafe']))
    caret(blockEl(w.page, para(2)), 3)
    deadKey('´', 'é', () => {
      remote(w.session, [{ op: 'block.delete', bookId: ID, id: para(2) }])
    })
    expect(textsOf(w.session)).toEqual(['first'])
    expect(document.querySelector('[data-live-region]')?.textContent).toMatch(
      /What you wrote there couldn.t be kept/,
    )
  })

  it('a book opens where it was left: the window around its place, the caret at its offset', () => {
    const texts = Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1} of the book.`)
    rememberPlace(BOARD_ID, ID, { blockId: para(300), offset: 4, scrollTop: 12 })
    flushPlaces()
    const w = open(stateWith(texts), { boardId: BOARD_ID, strict: false })
    // The window is the place's, not the book's start.
    expect(w.page.querySelector(`[data-id="${para(300)}"]`)).not.toBeNull()
    expect(w.page.querySelector(`[data-id="${para(1)}"]`)).toBeNull()
    const el = blockEl(w.page, para(300))
    expect(caretOffset(el)).toBe(4)
    expect(document.activeElement).toBe(el)
    // The place stays as it was kept (nothing on screen in a DOM without layout to read).
    cleanup()
    expect(recallPlace(BOARD_ID, ID)).toEqual({ blockId: para(300), offset: 4, scrollTop: 12 })
  })

  it('a book opened to type its title first opens at its place without taking the caret there', () => {
    const texts = Array.from({ length: 400 }, (_, i) => `Paragraph ${i + 1} of the book.`)
    rememberPlace(BOARD_ID, ID, { blockId: para(300), offset: 4, scrollTop: 0 })
    flushPlaces()
    openBook(ID, 'select')
    const w = open(stateWith(texts), { boardId: BOARD_ID, strict: false })
    expect(w.page.querySelector(`[data-id="${para(300)}"]`)).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Title' }))
  })

  /** A board of three chapters (a heading and two paragraphs each). */
  const threeChapters = () => {
    const kinds = ['h1', 'p', 'p', 'h1', 'p', 'p', 'h1', 'p', 'p'] as const
    const s = stateWith(
      kinds.map((k, i) => (k === 'h1' ? `Chapter ${i / 3 + 1}` : `Text ${i + 1}`)),
    )
    return applyBatch(
      s,
      kinds.flatMap((k, i): ClientOp[] =>
        k === 'h1' ? [{ op: 'block.set', bookId: ID, id: para(i + 1), set: { kind: 'h1' } }] : [],
      ),
      { now: T0 },
    )
  }

  it('the outline: Esc closes it for good; titles are named by their words, with the move keys said; the list follows the board while open; a refused move is said', async () => {
    const w = open(threeChapters(), { strict: false })
    const nav = screen.getByRole('navigation', { name: 'Chapters' })
    const tab = within(nav).getByRole('button', { name: 'Chapters' })
    act(() => tab.focus())
    // Named by its title alone (its number is not read as part of it); the drag's keys said.
    const second = within(nav).getByRole('button', { name: 'Chapter 2' })
    expect(second.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown')
    expect(second.getAttribute('aria-describedby')).toBeTruthy()
    expect(
      document.getElementById(second.getAttribute('aria-describedby') as string)?.textContent,
    ).toBe('Alt+Up or Alt+Down moves the chapter.')
    // While open, a title written elsewhere shows.
    remote(w.session, [
      { op: 'block.edit', bookId: ID, id: para(4), splices: [{ at: 0, del: 9, ins: 'Rivers' }] },
    ])
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))))
    expect(within(nav).getByRole('button', { name: 'Rivers' })).toBeTruthy()
    // A move the board refuses is said, not thrown.
    const commit = vi.spyOn(w.session.store, 'commit').mockImplementation(() => {
      throw new OpError('limit', 'too many ops')
    })
    const first = within(nav).getByRole('button', { name: 'Chapter 1' })
    act(() => first.focus())
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true })
    })
    commit.mockRestore()
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'That chapter couldn’t be moved.',
    )
    // Esc: closed, and the tab it gives the focus back to does not open it again.
    act(() => {
      fireEvent.keyDown(first, { key: 'Escape' })
    })
    expect(document.activeElement).toBe(tab)
    expect(within(nav).queryByRole('listitem')).toBeNull()
  })

  it('the outline lists the chapters: a title jumps to its chapter; Alt+↓ moves one, a commit and an undo step', () => {
    // Three chapters of a heading and two paragraphs.
    const kinds = ['h1', 'p', 'p', 'h1', 'p', 'p', 'h1', 'p', 'p'] as const
    let s = stateWith(kinds.map((k, i) => (k === 'h1' ? `Chapter ${i / 3 + 1}` : `Text ${i + 1}`)))
    s = applyBatch(
      s,
      kinds.flatMap((k, i): ClientOp[] =>
        k === 'h1' ? [{ op: 'block.set', bookId: ID, id: para(i + 1), set: { kind: 'h1' } }] : [],
      ),
      { now: T0 },
    )
    const w = open(s, { strict: false })
    const nav = screen.getByRole('navigation', { name: 'Chapters' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Chapters' }))
    const titles = () =>
      within(nav)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    expect(titles()).toEqual(['1Chapter 1', '2Chapter 2', '3Chapter 3'])
    // Enter on a title: the caret at its chapter's start, the outline closed.
    const second = within(nav).getByRole('button', { name: /Chapter 2/ })
    second.focus()
    fireEvent.keyDown(second, { key: 'Enter' })
    expect(caretOffset(blockEl(w.page, para(4)))).toBe(0)
    expect(within(nav).queryByRole('listitem')).toBeNull()
    // Alt+↓ on the first: it goes after the second, one commit.
    fireEvent.click(within(nav).getByRole('button', { name: 'Chapters' }))
    const before = w.batches.length
    const first = within(nav).getByRole('button', { name: /Chapter 1/ })
    first.focus()
    act(() => {
      fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true })
    })
    expect(w.batches.length).toBe(before + 1)
    expect(w.batches.at(-1)?.ops.every((o) => o.op === 'block.set')).toBe(true)
    expect(textsOf(w.session)).toEqual([
      'Chapter 2',
      'Text 5',
      'Text 6',
      'Chapter 1',
      'Text 2',
      'Text 3',
      'Chapter 3',
      'Text 8',
      'Text 9',
    ])
    expect(titles()).toEqual(['1Chapter 2', '2Chapter 1', '3Chapter 3'])
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'Moved to chapter 2 of 3.',
    )
    // The page shows the book as the board has it.
    const page = () => [...w.page.querySelectorAll('[data-id]')].map((e) => e.textContent)
    expect(page()).toEqual(textsOf(w.session))
    // One undo step puts it back.
    act(() => stepHistory(w.session, 'undo'))
    expect(textsOf(w.session).slice(0, 3)).toEqual(['Chapter 1', 'Text 2', 'Text 3'])
    expect(page()).toEqual(textsOf(w.session))
  })

  it('a book with no blocks shows one empty paragraph that its first keystroke creates', () => {
    const w = open(stateWith([]))
    const el = blockEl(w.page)
    expect(el.textContent).toBe('')
    caret(el, 0)
    type('H')
    expect(opsOf(w).map((o) => o.op)).toEqual(['block.create'])
    expect(textsOf(w.session)).toEqual(['H'])
  })
})

/**
 * The book's limits, said where sighted users see them (minor 1): a change the
 * limits refuse brings a notice slip in the board's notices (as the live region says it too), in
 * words that name the limit it met; a pasted paragraph longer than a paragraph can be is split
 * into paragraphs that fit, never refused.
 */
describe('the writer at the book’s limits', () => {
  const L = LIMITS.maxBlockText
  const slips = (s: BoardSession) =>
    s.feed
      .getState()
      .notices.filter((n) => n.slip)
      .map((n) => n.message)

  it('a key typed into a paragraph as long as a paragraph can be: a slip says so, the paragraph as it was', () => {
    const w = open(stateWith(['a'.repeat(L)]))
    caret(blockEl(w.page), 3)
    type('b')
    expect(textsOf(w.session)).toEqual(['a'.repeat(L)])
    expect(slips(w.session)).toEqual([
      'A paragraph can’t be longer than 20,000 characters, so that change wasn’t made.',
    ])
  })

  it('a pasted paragraph longer than a paragraph can be is split into paragraphs that fit, its words all kept', () => {
    const w = open(stateWith(['']))
    caret(blockEl(w.page), 0)
    const long = `${'x'.repeat(L)}${'y'.repeat(L)}${'z'.repeat(5000)}`
    paste({ 'text/plain': long })
    expect(textsOf(w.session)).toEqual(['x'.repeat(L), 'y'.repeat(L), 'z'.repeat(5000)])
    expect(slips(w.session)).toEqual([])
  })

  it('pasted into a long paragraph, the text that would not fit goes on in the paragraph after', () => {
    const w = open(stateWith([`head${'a'.repeat(L - 10)}`]))
    caret(blockEl(w.page), 4)
    paste({ 'text/plain': 'b'.repeat(30) })
    expect(textsOf(w.session)).toEqual([`head${'b'.repeat(30)}`, 'a'.repeat(L - 10)])
    expect(textsOf(w.session).join('')).toBe(`head${'b'.repeat(30)}${'a'.repeat(L - 10)}`)
    expect(slips(w.session)).toEqual([])
  })

  it('a split never cuts a character in two (a surrogate pair at the cut)', () => {
    const w = open(stateWith(['']))
    caret(blockEl(w.page), 0)
    const long = `${'x'.repeat(L - 1)}😀${'y'.repeat(10)}`
    paste({ 'text/plain': long })
    expect(textsOf(w.session)).toEqual(['x'.repeat(L - 1), `😀${'y'.repeat(10)}`])
  })

  it('bold past the marks a paragraph can hold: a slip names the marks', () => {
    // 2,000 bold words, apart: one more is over the limit.
    const text = Array.from({ length: LIMITS.maxMarksPerBlock + 1 }, () => 'w').join(' ')
    const marks = Array.from({ length: LIMITS.maxMarksPerBlock }, (_, i) => ({
      t: 'b' as const,
      from: 2 * i,
      to: 2 * i + 1,
    }))
    const s = stateWith([text])
    const id = para(1)
    const marked = applyBatch(
      s,
      [{ op: 'block.edit', bookId: ID, id, splices: [], addMarks: marks }],
      { now: T0 },
    )
    const w = open(marked)
    const at = 2 * LIMITS.maxMarksPerBlock
    caret(blockEl(w.page), at, at + 1)
    press('b', { metaKey: true })
    expect(blocksOf(w.session)[0]?.marks).toHaveLength(LIMITS.maxMarksPerBlock)
    expect(slips(w.session)).toEqual([
      'A paragraph can’t hold more than 2,000 bold or italic marks, so that change wasn’t made.',
    ])
  })
})

describe('prompts and figures in the writer', () => {
  const ASSET = `asset_${'0'.repeat(25)}1`
  /** A book of blocks of these kinds (a figure shows `ASSET`, 400 × 200). */
  function stateOf(blocks: ReadonlyArray<{ kind: Block['kind']; text: string }>): BoardState {
    const keys = posKeysBetween(null, null, blocks.length)
    return applyBatch(
      emptyBoardState(BOARD_ID, 'Test board', T0),
      [
        {
          op: 'asset.add',
          asset: {
            type: 'asset',
            id: ASSET,
            mime: 'image/webp',
            width: 400,
            height: 200,
            bytes: 10,
            sha256: 'a'.repeat(64),
            createdAt: T0,
          },
        },
        { op: 'book.create', book: { ...book(ID, { title: 'On paper' }), trashedAt: null } },
        ...blocks.map(
          (b, i): ClientOp => ({
            op: 'block.create',
            block: {
              type: 'block',
              id: para(i + 1),
              bookId: ID,
              pos: keys[i] as string,
              kind: b.kind,
              text: b.text,
              marks: [],
              ...(b.kind === 'figure' ? { image: { assetId: ASSET } } : {}),
            },
          }),
        ),
      ] as ClientOp[],
      { now: T0 },
    )
  }

  it('Text style’s Prompt turns a paragraph into a prompt and Paragraph turns it back', () => {
    const w = open(stateOf([{ kind: 'p', text: 'Ask the archivist' }]))
    caret(blockEl(w.page, para(1)), 0, 3)
    const n = w.batches.length
    fireEvent.click(control('Prompt'))
    expect(opsOf(w).slice(n)).toEqual([
      { op: 'block.set', bookId: ID, id: para(1), set: { kind: 'prompt' } },
    ])
    expect(blockEl(w.page, para(1)).classList.contains('bk-prompt')).toBe(true)
    const m = w.batches.length
    caret(blockEl(w.page, para(1)), 0, 3)
    fireEvent.click(control('Paragraph'))
    expect(opsOf(w).slice(m)).toEqual([
      { op: 'block.set', bookId: ID, id: para(1), set: { kind: 'p' } },
    ])
    expect(blockEl(w.page, para(1)).classList.contains('bk-p')).toBe(true)
  })

  it('prompts are not counted as words; captions are', async () => {
    const w = open(
      stateOf([
        { kind: 'p', text: 'three words here' },
        { kind: 'prompt', text: 'ask about the second shelf' },
        { kind: 'figure', text: 'a caption' },
      ]),
    )
    const count = () => document.querySelector('.writer-count')?.textContent
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(count()).toBe('5 words')
    // Typing in the prompt counts nothing; turning it into a paragraph counts its words.
    caret(blockEl(w.page, para(2)), 0)
    type('so ')
    expect(count()).toBe('5 words')
    caret(blockEl(w.page, para(2)), 0, 2)
    fireEvent.click(control('Paragraph'))
    expect(count()).toBe('11 words')
    // The figure shows its asset, as tall as its aspect makes it at the measure.
    const img = blockEl(w.page, para(3)).querySelector('img')
    expect(img?.getAttribute('src')).toContain(ASSET)
  })

  it('pasted HTML makes no prompt, figure or card mark', () => {
    const w = open(stateOf([{ kind: 'p', text: '' }]))
    caret(blockEl(w.page), 0)
    paste({
      'text/plain': 'ignored',
      'text/html':
        '<aside class="bk bk-prompt">A prompt</aside>' +
        '<figure class="bk bk-figure"><img src="/api/assets/x/1024" alt=""><figcaption>Cap</figcaption></figure>' +
        `<p data-mark="c:note_${'0'.repeat(25)}1"><mark>Marked</mark> text</p>`,
    })
    const got = blocksOf(w.session)
    expect(got.map((b) => b.kind)).toEqual(['p', 'p', 'p'])
    expect(got.every((b) => b.image === undefined)).toBe(true)
    expect(got.flatMap((b) => b.marks)).toEqual([])
    expect(got.map((b) => b.text)).toEqual(['A prompt', 'Cap', 'Marked text'])
  })
})
