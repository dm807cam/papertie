// @vitest-environment jsdom
/**
 * A card dragged across the seam into the book: where it lands (the gap the
 * indicator shows, between blocks), what it says, what a full book does, and a drop while a dead
 * key composes elsewhere on the page.
 */
import {
  applyBatch,
  type BoardState,
  blocksOf,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { BookScreen } from '../../src/book/BookScreen'
import { createCardDrop } from '../../src/book/drop/cardDrop'
import type { LiveBlock } from '../../src/book/editor/pageWindow'
import type { SeamDrop } from '../../src/canvas/seamDrop'
import { attachBooks } from '../../src/sync/books/bookStore'
import { book, para } from '../helpers/books'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { blockEl, caret, startDeadKey } from './writerKit'

const ID = idOf('book', 9)
const CARD = idOf('note', 1)
const ASSET = `asset_${'0'.repeat(25)}1`

/** A board with the book of `blocks` (kind, text) titled "On paper", and the cards `cards`. */
function stateWith(
  blocks: ReadonlyArray<readonly [string, string]>,
  cards: ReadonlyArray<Parameters<typeof note>[1]> = [{ text: 'A card' }],
): BoardState {
  const keys = posKeysBetween(null, null, Math.max(1, blocks.length))
  return applyBatch(
    emptyBoardState(BOARD_ID, 'Test board', T0),
    [
      { op: 'book.create', book: { ...book(ID, { title: 'On paper' }), trashedAt: null } },
      {
        op: 'asset.add',
        asset: {
          type: 'asset',
          id: ASSET,
          mime: 'image/webp',
          width: 300,
          height: 200,
          bytes: 10,
          sha256: 'a'.repeat(64),
          createdAt: T0,
        },
      } as unknown as ClientOp,
      ...blocks.map(
        ([kind, text], i): ClientOp => ({
          op: 'block.create',
          block: {
            type: 'block',
            id: para(i + 1),
            bookId: ID,
            pos: keys[i] as string,
            kind: kind as 'p',
            text,
            marks: [],
          },
        }),
      ),
      ...cards.map((c, i): ClientOp => ({ op: 'note.create', note: note(idOf('note', i + 1), c) })),
    ],
    { now: T0 },
  )
}

const said = () => document.querySelector('[data-live-region]')?.textContent?.trim()
const rect = (top: number, height: number, left = 600, width = 600) =>
  ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON() {},
  }) as DOMRect

let made = 500
const newBlockId = () => idOf('block', ++made)

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('a card dropped into the book', () => {
  /** The drop on a page whose blocks `live` lie as given (the page's top at 100 px). */
  function setUp(state: BoardState, live: LiveBlock[]) {
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    const scroller = document.createElement('div')
    const page = document.createElement('div')
    scroller.append(page)
    document.body.append(scroller)
    scroller.getBoundingClientRect = () => rect(0, 800)
    page.getBoundingClientRect = () => rect(100, 600)
    const drop = createCardDrop({
      session,
      bookId: ID,
      engine: { liveBlocks: () => live, onLayout: () => () => {} },
      page: () => page,
      scroller,
      newBlockId,
    })
    return { session, drop, scroller }
  }
  const texts = (s: BoardSession) => blocksOf(s.store.getState(), ID).map((b) => b.text)

  it('a drop lands in the gap the indicator showed, between blocks, never inside one', () => {
    const state = stateWith([
      ['p', 'one'],
      ['prompt', 'a prompt on one'],
      ['p', 'two'],
      ['p', 'three'],
    ])
    const live: LiveBlock[] = [
      { id: para(1), kind: 'p', top: 0, height: 40 },
      { id: para(2), kind: 'prompt', top: 0, height: 20 },
      { id: para(3), kind: 'p', top: 40, height: 40 },
      { id: para(4), kind: 'p', top: 80, height: 40 },
    ]
    const { session, drop } = setUp(state, live)
    expect(drop.over(700, 150)).toBe(true)
    expect(drop.over(100, 150)).toBe(false)
    // Below the middle of "two": the gap after it, shown as a line at its foot.
    drop.hover(700, 100 + 70, [CARD], false)
    const line = document.querySelector<HTMLElement>('.bk-drop-gap')
    expect(line).not.toBeNull()
    expect(line?.dataset.after).toBe(para(3))
    expect(line?.style.top).toBe('180px')
    // The ghost: a small paper with the card's first line.
    expect(document.querySelector('.card-ghost')?.textContent).toContain('A card')
    expect(drop.drop(700, 100 + 70, [CARD], false)).toBe(true)
    expect(texts(session)).toEqual(['one', 'a prompt on one', 'two', 'A card', 'three'])
    // Hovering is over once it lands.
    expect(document.querySelector('.bk-drop-gap')).toBeNull()
    expect(document.querySelector('.card-ghost')).toBeNull()

    // Above the middle of "two": after "one" and the prompt that annotates it, not inside "one".
    drop.hover(700, 100 + 45, [CARD], false)
    expect(document.querySelector<HTMLElement>('.bk-drop-gap')?.dataset.after).toBe(para(2))
    drop.drop(700, 100 + 45, [CARD], false)
    expect(texts(session)).toEqual(['one', 'a prompt on one', 'A card', 'two', 'A card', 'three'])
    // Above the first block: first in the book.
    drop.drop(700, 100 + 5, [CARD], false)
    expect(texts(session)[0]).toBe('A card')
    drop.destroy()
  })

  it('the live region says what was added and as what', () => {
    const state = stateWith(
      [['p', 'one']],
      [{ text: 'A card' }, { text: 'Milan', image: { assetId: ASSET, frame: 'print' } }],
    )
    const live: LiveBlock[] = [{ id: para(1), kind: 'p', top: 0, height: 40 }]
    const { session, drop } = setUp(state, live)
    drop.drop(700, 130, [CARD], false)
    expect(said()).toBe('Added to “On paper” as a paragraph.')
    drop.drop(700, 130, [idOf('note', 2)], false)
    expect(said()).toBe('Added to “On paper” as a figure.')
    drop.drop(700, 130, [CARD], true)
    expect(said()).toBe('Moved into “On paper” as a paragraph.')
    expect(session.store.getState().notes.has(CARD)).toBe(false)
    // One undo step, labelled as a move.
    const r = session.undo.undo(session.store.getState())
    expect(r?.label).toBe('move into the book')
  })

  it('an empty card adds nothing and says so', () => {
    const state = stateWith([['p', 'one']], [{ text: '   ' }])
    const { session, drop } = setUp(state, [{ id: para(1), kind: 'p', top: 0, height: 40 }])
    const before = session.store.getState()
    expect(drop.drop(700, 130, [CARD], false)).toBe(false)
    expect(session.store.getState()).toBe(before)
    expect(said()).toBe('That card is empty.')
  })

  it('a drop into a full book changes nothing and says so', () => {
    // A book at its length, all but a few characters.
    const n = LIMITS.maxBookChars / LIMITS.maxBlockText
    const blocks: Array<readonly [string, string]> = []
    for (let i = 0; i < n; i++)
      blocks.push(['p', 'x'.repeat(LIMITS.maxBlockText - (i === 0 ? 3 : 0))])
    const state = stateWith(blocks)
    const { session, drop } = setUp(state, [{ id: para(1), kind: 'p', top: 0, height: 40 }])
    const before = session.store.getState()
    expect(drop.drop(700, 130, [CARD], true)).toBe(false)
    expect(session.store.getState()).toBe(before)
    expect(before.notes.has(CARD)).toBe(true)
    expect(said()).toBe('This book is full.')
  })
})

describe('a drop and the page', () => {
  it('a drop during a pending dead key elsewhere leaves the composition whole', () => {
    const state = stateWith([
      ['p', 'cafe'],
      ['p', 'two'],
    ])
    const session = openLocalSession({ kind: 'local', state, label: 'test' })
    attachBooks(session.store)
    let seam: SeamDrop | null = null
    const runtime = {
      setSeamDrop: (t: SeamDrop | null) => {
        seam = t
      },
    }
    render(<BookScreen session={session} bookId={ID} layout="split" runtime={runtime} />)
    expect(seam).not.toBeNull()
    const page = document.querySelector('.bk-book') as HTMLElement
    const el = blockEl(page, para(1))
    caret(el, 4)
    const finish = startDeadKey('´')
    // jsdom lays nothing out: every block is at 0, so the drop goes after the last.
    act(() => {
      ;(seam as unknown as SeamDrop).drop(700, 300, [CARD], false)
    })
    finish('é')
    const blocks = blocksOf(session.store.getState(), ID)
    expect(blocks.map((b) => b.text)).toEqual(['cafeé', 'two', 'A card'])
    expect(blockEl(page, para(1))).toBe(el)
    expect(el.textContent).toBe('cafeé')
    expect(page.querySelectorAll('[data-id]')).toHaveLength(3)
  })
})
