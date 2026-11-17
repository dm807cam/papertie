/**
 * Which shelf books use each card, read from the books' `cards` (the server stamps them in the
 * commit that changes them), so the board can show a card's reverse mark without holding
 * any book's blocks. Always loaded, so it stays small: the popover listing the books is a chunk of
 * its own (`book/uses/CardUses.tsx`).
 *
 * Kept per note from the book records: on each store change only the books whose record changed
 * are looked at, and only one whose `cards` is a different array, or whose place on the shelf
 * (deleted or put back) changed, is diffed, in O(that book's cards). A keystroke's commit keeps
 * the very same `cards` array (core keeps it), so it costs O(books it touched) and wakes no note.
 */
import { type Book, mapChangesWithin } from '@papertie/core'
import { useCallback, useSyncExternalStore } from 'react'
import type { BoardStore } from '../../store/boardStore'

/** Which shelf books use each card, and which book a card came from: kept from book records. */
export interface CardUses {
  /** Books on the shelf (not trashed) whose `cards` name `noteId`, in shelf order. */
  usedIn(noteId: string): readonly string[]
  /** Subscribe to one note's uses; called only when that note's list changes. */
  watch(noteId: string, fn: () => void): () => void
  /** Whether `bookId` stands on the shelf (a card's origin shows only then). */
  shelved(bookId: string): boolean
  /** Subscribe to whether `bookId` stands on the shelf; called only when that changes. */
  watchBook(bookId: string, fn: () => void): () => void
}

const NONE: readonly string[] = []

/** What `cardUses` keeps of a book: the cards it counts and whether it stands on the shelf. */
interface Seen {
  cards: readonly string[]
  shelved: boolean
}

/** The cards a book counts for: its `cards` while on the shelf, none once deleted. */
const countedOf = (b: Book | undefined): Seen =>
  b === undefined
    ? { cards: NONE, shelved: false }
    : { cards: b.trashedAt === null ? (b.cards ?? NONE) : NONE, shelved: b.trashedAt === null }

/** The notes in exactly one of the sorted lists `a` and `b`: one walk of both. */
function* differ(a: readonly string[], b: readonly string[]): Generator<string> {
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const x = a[i]
    const y = b[j]
    if (y === undefined || (x !== undefined && x < y)) {
      yield x as string
      i++
    } else if (x === undefined || y < x) {
      yield y
      j++
    } else {
      i++
      j++
    }
  }
}

const made = new WeakMap<BoardStore, CardUses>()

/** The board store's card uses: made once per store, kept as it changes. */
export function cardUsesFor(store: BoardStore): CardUses {
  let uses = made.get(store)
  if (uses === undefined) {
    uses = createCardUses(store)
    made.set(store, uses)
  }
  return uses
}

function createCardUses(store: BoardStore): CardUses {
  /** Note id → the shelf books naming it. */
  const byNote = new Map<string, Set<string>>()
  const seen = new Map<string, Seen>()
  /** The lists `usedIn` answered, until the note's uses change. */
  const lists = new Map<string, readonly string[]>()
  const watchers = new Map<string, Set<() => void>>()
  const bookWatchers = new Map<string, Set<() => void>>()
  let books = store.getState().books

  const add = <K>(m: Map<K, Set<() => void>>, k: K, fn: () => void) => {
    let set = m.get(k)
    if (set === undefined) {
      set = new Set()
      m.set(k, set)
    }
    const mine = set
    mine.add(fn)
    return () => {
      mine.delete(fn)
      if (mine.size === 0 && m.get(k) === mine) m.delete(k)
    }
  }

  /** Bring `bookId` from what was seen of it to `book`; the notes whose uses changed go in `woken`. */
  const update = (
    bookId: string,
    book: Book | undefined,
    woken: Set<string>,
    moved: Set<string>,
  ) => {
    const was = seen.get(bookId) ?? { cards: NONE, shelved: false }
    const now = countedOf(book)
    if (book === undefined) seen.delete(bookId)
    else seen.set(bookId, now)
    if (was.shelved !== now.shelved) moved.add(bookId)
    // The same array (a keystroke's commit, a title): nothing to diff.
    if (was.cards === now.cards) return
    const had = new Set(was.cards)
    for (const n of differ(was.cards, now.cards)) {
      let set = byNote.get(n)
      if (had.has(n)) {
        set?.delete(bookId)
        if (set?.size === 0) byNote.delete(n)
      } else {
        if (set === undefined) {
          set = new Set()
          byNote.set(n, set)
        }
        set.add(bookId)
      }
      lists.delete(n)
      woken.add(n)
    }
  }

  const tell = (woken: Set<string>, moved: Set<string>) => {
    for (const n of woken) for (const fn of [...(watchers.get(n) ?? [])]) fn()
    for (const b of moved) for (const fn of [...(bookWatchers.get(b) ?? [])]) fn()
  }

  {
    const woken = new Set<string>()
    for (const [id, b] of books) update(id, b, woken, new Set())
  }

  store.subscribe((s) => {
    if (s.books === books) return
    const before = books
    books = s.books
    // The books whose record changed (O(changes)); every book when the board was swapped whole.
    const changes = mapChangesWithin(before, books, 64)
    const ids =
      changes === null
        ? new Set([...before.keys(), ...books.keys()])
        : [...changes.set, ...changes.deleted]
    const woken = new Set<string>()
    const moved = new Set<string>()
    for (const id of ids) update(id, books.get(id), woken, moved)
    // A book put on or taken off the shelf reorders nothing else; one moved on the shelf keeps
    // its uses, and lists answered keep their order until a use changes (shelf order is the
    // books' `shelfPos`, read when a list is made).
    if (woken.size > 0 || moved.size > 0) tell(woken, moved)
  })

  return {
    usedIn(noteId) {
      let list = lists.get(noteId)
      if (list === undefined) {
        const set = byNote.get(noteId)
        if (set === undefined || set.size === 0) list = NONE
        else {
          const pos = (id: string) => books.get(id)?.shelfPos ?? ''
          list = [...set].sort((a, b) => {
            const pa = pos(a)
            const pb = pos(b)
            return pa < pb ? -1 : pa > pb ? 1 : a < b ? -1 : a > b ? 1 : 0
          })
        }
        lists.set(noteId, list)
      }
      return list
    },
    watch: (noteId, fn) => add(watchers, noteId, fn),
    shelved: (bookId) => seen.get(bookId)?.shelved === true,
    watchBook: (bookId, fn) => add(bookWatchers, bookId, fn),
  }
}

const NO_WATCH = () => () => {}

/** Whether a shelf book uses card `noteId` (its reverse mark shows), followed. */
export function useCardUse(uses: CardUses | undefined, noteId: string): boolean {
  const subscribe = useCallback(
    (fn: () => void) => (uses === undefined ? NO_WATCH() : uses.watch(noteId, fn)),
    [uses, noteId],
  )
  return useSyncExternalStore(subscribe, () => (uses?.usedIn(noteId).length ?? 0) > 0)
}

/** Whether book `bookId` (a card's origin) stands on the shelf, followed; false without one. */
export function useShelved(uses: CardUses | undefined, bookId: string | undefined): boolean {
  const subscribe = useCallback(
    (fn: () => void) =>
      uses === undefined || bookId === undefined ? NO_WATCH() : uses.watchBook(bookId, fn),
    [uses, bookId],
  )
  return useSyncExternalStore(subscribe, () =>
    uses === undefined || bookId === undefined ? false : uses.shelved(bookId),
  )
}
