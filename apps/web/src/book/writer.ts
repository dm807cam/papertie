/**
 * The writer's controller: the engine on one book of the session's board. Each
 * change the editor makes is one commit of the board's store (the undo stack, the
 * store, as every edit of the board); each change the board takes that the editor did not make
 * (an undo, a restore, the store's own) reaches the page as what changed between the
 * book shown and the book now (`bookDiff`: the chunks it changed, never the book).
 */
import {
  type BoardState,
  type BookBlocks,
  bookBlocks,
  type ClientOp,
  LIMITS,
  newId,
  OpError,
} from '@papertie/core'
import { announce } from '../app/liveRegion'
import { flushPlaces, type Place, recallPlace, rememberPlace } from '../app/screenMemory'
import { type BoardSession, stepHistory } from '../app/session'
import { pagePace } from '../sync/pace'
import type { EditorChange } from './editor/BookEditor'
import { type BlockEngine, createEngine } from './editor/blockEngine'
import { BookModel } from './editor/model'
import { bookDiff, changesToOps, opsToChanges } from './editorOps'
import { sayLimit } from './sayLimit'
import type { BookLang } from './typography'
import { counted, WordCount } from './wordCount'

/** Past this many changed chunks between two versions of the book, it is drawn again whole. */
const REDRAW_OVER = 16
/** The slicer's budget (`sync/pace.ts`). */
const SLICE_MS = 4
/** A book this long is built for the page in slices from the start (a short one at once). */
const LONG = 2048

const n = (v: number) => v.toLocaleString('en')
const notMade = 'so that change wasn’t made.'

/**
 * What the writer says of a change the book's limits refuse, naming the limit it met (a
 * paragraph's length or marks, the book's paragraphs or length); null for any other refusal.
 */
export function limitCopy(e: OpError): string | null {
  const m = e.message
  if (/book-too-long/.test(m))
    return `A book can’t be longer than ${n(LIMITS.maxBookChars)} characters, ${notMade}`
  if (/too-many-blocks/.test(m))
    return `A book can’t have more than ${n(LIMITS.maxBlocksPerBook)} paragraphs, ${notMade}`
  if (e.code !== 'limit') return null
  if (/ marks$/.test(m))
    return `A paragraph can’t hold more than ${n(LIMITS.maxMarksPerBlock)} bold or italic marks, ${notMade}`
  if (/ characters$/.test(m))
    return `A paragraph can’t be longer than ${n(LIMITS.maxBlockText)} characters, ${notMade}`
  return `That’s more than a book can hold, ${notMade}`
}

export interface Writer {
  readonly engine: BlockEngine
  /**
   * The page is shown (no longer inert): the caret goes to the place the book opened at, once,
   * when it was asked to (`place.focus`). An inert page takes no focus, so not before.
   */
  shown(): void
  destroy(): void
}

export interface WriterOptions {
  session: BoardSession
  bookId: string
  /** Where the page's text goes, and what scrolls it. */
  body: HTMLElement
  scroller: HTMLElement | null
  lang(): BookLang
  /** The book's words, once counted, and each time they change. */
  onWords(n: number): void
  /** The book's text is on the page (and can be written in), or waits for the book. */
  onShown(shown: boolean): void
  /** There is no such book: the board was restored to one without it (`restored`), or it went. */
  onGone(restored: boolean): void
  /**
   * The book could not be read just now (the store out of reach or busy): true until
   * it is on the page (it is read again by itself meanwhile, `bookStore`).
   */
  onUnread?(unread: boolean): void
  /**
   * Open at the place the app keeps for the book (`screenMemory.ts`), and keep it as the
   * page moves; `focus`: the caret put there (not when the title is to be typed in first).
   */
  place?: { focus: boolean }
}

/**
 * The ids a change names whose words may have changed: its text, or its kind (a prompt's words are
 * not the book's).
 */
function textIds(changes: readonly EditorChange[]): string[] {
  const out: string[] = []
  for (const c of changes) {
    if (c.t === 'edit' || c.t === 'create' || c.t === 'delete' || c.t === 'kind') out.push(c.id)
    else if (c.t === 'split') out.push(c.id, c.newId)
    else if (c.t === 'merge') out.push(c.from, c.into)
  }
  return out
}

export function startWriter(o: WriterOptions): Writer {
  const { session, bookId } = o
  const store = session.store
  const books = session.books
  const engine = createEngine({ lang: o.lang, scroller: o.scroller })
  let mounted = false
  /** The book the page shows (null while it is built: the board's changes wait for it). */
  let shown: BookBlocks | null = null
  /** The board `shown` is of (the words' "before"). */
  let shownState: BoardState | null = null
  /** The book being built for the page, a slice at a time (a newer one replaces it). */
  let building = 0
  let committing = false
  let stepping = false
  /** The board was replaced (a restore, a whole load): the page starts over once it is held. */
  let resetting = false
  let words: WordCount | null = null
  let off = false
  /** The board's revision when the book was last asked for (`books.open`) while not held. */
  let askedAt = store.getState().board.revision
  const boardId = session.boardId
  /**
   * Where the caret goes once the page is shown: the place it opened at, or where it was as the
   * page went calm (an inert page loses the focus); then null.
   */
  let caretAt: { blockId: string; offset: number } | null = null
  /** The page calm, waiting for the book: the caret, if it was in the text, kept for its return. */
  const calm = () => {
    const p = engine.selection()
    if (caretAt === null && p !== null && o.body.contains(document.activeElement)) caretAt = p
    o.onShown(false)
  }
  /** Ask the book store for the book: one that could not be read just now is said. */
  const ask = (): Promise<void> =>
    books
      ? books.open(bookId).then((ok) => {
          if (!ok && !off && !held(store.getState())) o.onUnread?.(true)
        })
      : Promise.resolve()
  /** Where to open: the place kept for this book, on the first mount only. */
  const at: Place | null =
    o.place !== undefined && boardId !== null ? recallPlace(boardId, bookId) : null

  const held = (s: BoardState) =>
    s.books.has(bookId) && (s.blocksHeld === 'all' || s.blocksHeld.has(bookId))

  const count = (ix: BookBlocks) => {
    words?.stop()
    words = new WordCount(o.onWords)
    void words.start(ix.chunks)
  }
  /** The words of the blocks `changes` named, from `was` (the board the page showed) to `s`. */
  const recount = (changes: readonly EditorChange[], was: BoardState | null, s: BoardState) => {
    for (const id of new Set(textIds(changes))) {
      words?.change(counted(was?.blocks.get(id)), counted(s.blocks.get(id)))
    }
  }
  /** A figure's aspect from its asset, as the board holds it now. */
  const aspectOf = (assetId: string) => {
    const a = store.getState().assets.get(assetId)
    return a && a.height > 0 ? a.width / a.height : undefined
  }

  const options = {
    newBlockId: () => newId('block'),
    onChange: written,
    onHistory: (dir: 'undo' | 'redo') => {
      stepping = true
      try {
        stepHistory(session, dir)
      } finally {
        stepping = false
      }
    },
  }

  /**
   * The book as `s` holds it, on the page whole: the first time, after a reset, or drawn again.
   * Its model is built from the board's chunks a step at a time, in 4 ms slices (a short book's
   * in this very task), the page calm meanwhile; what the board took while it was built follows.
   */
  const show = (s: BoardState) => {
    // Only a book the board holds: one let go is shown again once it is held again.
    if (!held(s)) return
    const ix = bookBlocks(s.blocks, bookId)
    const token = ++building
    shown = null
    const steps = BookModel.build(ix.chunks, { aspectOf })
    const done = (model: BookModel) => {
      if (off || token !== building) return
      // Let go while it was built (the board loaded whole): it waits, calmly, until it is held
      // again, and is built anew then.
      if (!held(store.getState())) {
        building = 0
        // Let go before the page had it, nothing else asks for it again: this does.
        if (!mounted && store.getState().books.has(bookId)) {
          askedAt = store.getState().board.revision
          void ask()
        }
        return
      }
      if (!mounted) {
        mounted = true
        engine.mountModel(o.body, model, options, at ?? undefined)
        if (at !== null && o.place?.focus) caretAt = { blockId: at.blockId, offset: at.offset }
        keepPlace()
      } else engine.resetModel(model)
      shown = ix
      shownState = s
      count(ix)
      o.onUnread?.(false)
      o.onShown(true)
      follow(store.getState())
    }
    let end = performance.now() + SLICE_MS
    let sliced = false
    const run = () => {
      if (off || token !== building) return
      for (;;) {
        const r = steps.next()
        if (r.done) {
          // Built in slices: onto the page in a task of its own (the first window's DOM).
          if (sliced) void pagePace.yield().then(() => done(r.value))
          else done(r.value)
          return
        }
        if (performance.now() >= end && !pagePace.hidden()) {
          // The rest in a task of its own, the page calm until it is all in.
          if (!sliced) calm()
          sliced = true
          void pagePace.yield().then(() => {
            end = performance.now() + SLICE_MS
            run()
          })
          return
        }
      }
    }
    // A long book's first slice is a task of its own too (not the one the board changed in).
    if (ix.count > LONG) {
      sliced = true
      calm()
      void pagePace.yield().then(() => {
        end = performance.now() + SLICE_MS
        run()
      })
    } else run()
  }

  /** What the editor wrote: one commit, under its typing session's key. */
  function written(changes: EditorChange[], meta: { coalesceKey?: string; label?: string }) {
    const before = store.getState()
    if (!held(before)) {
      // Written as the book was let go under the page (a composition's end, the page calm by
      // now): the board cannot take it now, so it is offered, never lost (or, with no way to
      // offer it, said, with no cause it does not know).
      try {
        offer(changesToOps(before, bookId, changes), 'let go')
      } catch {
        offer([], 'let go')
      }
      return
    }
    let ops: ClientOp[] = []
    let next: BoardState
    try {
      ops = changesToOps(before, bookId, changes)
      committing = true
      next = store.commit(ops, {
        label: meta.label ?? 'writing',
        ...(meta.coalesceKey === undefined ? {} : { coalesceKey: meta.coalesceKey }),
      })
    } catch (e) {
      committing = false
      // The page goes back to the board's in every case, then the board's answer is acted on.
      if (held(store.getState())) show(store.getState())
      if (e instanceof OpError && e.code === 'not-found') {
        // Written into a paragraph gone meanwhile (deleted by an undo, left out by a restore):
        // never made again; the text is offered, as a refused batch's is ("block gone").
        offer(ops)
        return
      }
      const say = e instanceof OpError ? limitCopy(e) : null
      if (say !== null) {
        // Said where it is seen (the board's notices), which read it out.
        sayLimit(session, say)
        return
      }
      throw e
    } finally {
      committing = false
    }
    shown = bookBlocks(next.blocks, bookId)
    shownState = next
    // The page and the board agree on every block the change named, or the board's is shown.
    for (const id of new Set(textIds(changes))) {
      const mine = engine.block(id)
      const theirs = next.blocks.get(id)
      if ((mine === undefined) !== (theirs === undefined)) {
        show(next)
        return
      }
      if (mine === undefined || theirs === undefined) continue
      const same =
        mine.text === theirs.text &&
        mine.kind === theirs.kind &&
        JSON.stringify(mine.marks) === JSON.stringify(theirs.marks)
      if (!same) {
        engine.apply([
          {
            t: 'edit',
            id,
            splices: [{ at: 0, del: mine.text.length, ins: theirs.text }],
            removeMarks: [...mine.marks],
            addMarks: [...theirs.marks],
          },
          { t: 'kind', id, kind: theirs.kind },
        ])
      }
    }
    recount(changes, before, next)
  }

  /**
   * Writing the board would not take (its paragraph gone meanwhile, the book let go under the
   * page): offered as a refused batch is, the unsaved-changes slip and its `.md`. A board with no
   * server (the bench's, the study's) keeps nothing to offer: it says so instead.
   */
  function offer(ops: ClientOp[], why: 'gone' | 'let go' = 'gone') {
    if (session.sync && ops.length > 0) session.sync.refuse(ops)
    else
      announce(
        why === 'gone'
          ? 'What you wrote there couldn’t be kept: that paragraph is gone.'
          : 'What you wrote there couldn’t be kept.',
      )
  }

  /**
   * The place on the page kept for the next open, once the page has rested (`rememberPlace`):
   * read a frame after each scroll or caret move, never in the event's own turn.
   */
  let placing = 0
  const notePlace = () => {
    if (placing !== 0 || off || !mounted || boardId === null || o.place === undefined) return
    placing = requestAnimationFrame(() => {
      placing = 0
      savePlace(false)
    })
  }
  const savePlace = (now: boolean) => {
    if (off || !mounted || boardId === null || o.place === undefined || shown === null) return
    const p = engine.place()
    if (p !== null) rememberPlace(boardId, bookId, p)
    if (now) flushPlaces()
  }
  const onHide = () => {
    if (document.visibilityState === 'hidden') savePlace(true)
  }
  const onPageHide = () => savePlace(true)
  const keepPlace = () => {
    if (o.place === undefined || boardId === null) return
    o.scroller?.addEventListener('scroll', notePlace, { passive: true })
    document.addEventListener('selectionchange', notePlace)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
  }
  const dropPlace = () => {
    o.scroller?.removeEventListener('scroll', notePlace)
    document.removeEventListener('selectionchange', notePlace)
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', onPageHide)
    if (placing !== 0) cancelAnimationFrame(placing)
    placing = 0
  }

  /** After an undo or redo, the caret goes to where it changed the text. */
  const caretTo = (changes: readonly EditorChange[]) => {
    for (let k = changes.length - 1; k >= 0; k--) {
      const c = changes[k] as EditorChange
      if (c.t === 'edit' && c.splices.length > 0) {
        const s = c.splices[c.splices.length - 1] as { at: number; ins: string }
        if (engine.block(c.id)) engine.focusAt({ blockId: c.id, offset: s.at + s.ins.length })
        return
      }
      if ((c.t === 'create' || c.t === 'split') && engine.block(c.id)) {
        engine.focusAt({ blockId: c.id, offset: c.t === 'split' ? c.at : 0 })
        return
      }
      if (c.t === 'merge' && engine.block(c.into)) {
        engine.focusAt({ blockId: c.into, offset: engine.block(c.into)?.text.length ?? 0 })
        return
      }
    }
  }

  /** The page brought to the book as `s` holds it: what changed since the book shown. */
  function follow(s: BoardState) {
    if (shown === null || !held(s)) return
    const ix = bookBlocks(s.blocks, bookId)
    if (ix === shown) return
    const ops = bookDiff(bookId, shown, ix, { most: REDRAW_OVER })
    if (ops === null) {
      show(s)
      return
    }
    const was = shownState
    shown = ix
    shownState = s
    if (ops.length === 0) return
    const changes = opsToChanges(ops, s)
    engine.apply(changes)
    recount(changes, was, s)
    if (stepping) caretTo(changes)
  }

  const offStore = store.subscribe((s) => {
    if (committing || off) return
    if (!held(s)) {
      // Let go under the page (the board loaded whole): it waits, calmly, for the book again.
      if (mounted && !resetting && s.books.has(bookId)) {
        resetting = true
        calm()
        void ask()
      } else if (!mounted && building === 0 && s.books.has(bookId)) {
        // Not on the page yet, and not held: asked for before the board was in (its first paint,
        // the sync client holding no book to hold yet), or let go. Asked again as the board moves
        // on, once a revision; the book store makes one hold of the asks that meet.
        if (s.board.revision !== askedAt) {
          askedAt = s.board.revision
          void ask()
        }
      }
      return
    }
    if (!mounted || resetting) {
      if (building > 0 && shown === null && !resetting) return
      resetting = false
      show(s)
      return
    }
    follow(s)
  })

  const offReset =
    books?.onReset((ids) => {
      if (off || !ids.includes(bookId)) return
      resetting = true
      calm()
      void ask().then(() => {
        if (off) return
        const s = store.getState()
        if (!s.books.has(bookId)) {
          o.onGone(true)
          return
        }
        if (resetting && held(s)) {
          resetting = false
          show(s)
        }
      })
    }) ?? (() => {})

  // Asked for while the board opens (its first paint), the sync client may hold no board to hold
  // the book on yet: asked again as the opening ends (the board handed over at the same revision).
  if (session.opening.open)
    void session.opening.done.then(
      () => {
        const s = store.getState()
        if (!off && !mounted && building === 0 && !held(s) && s.books.has(bookId)) {
          askedAt = s.board.revision
          void ask()
        }
      },
      () => {},
    )
  // Opened in the book store whether it is held already or not: it holds the book for
  // the page, and its work (the book chunk, the book-gone notice) is in.
  if (held(store.getState())) show(store.getState())
  else calm()
  void ask().then(() => {
    if (off) return
    const s = store.getState()
    if (!s.books.has(bookId)) o.onGone(false)
    // Held now (and not on its way to the page already).
    else if (!mounted && building === 0 && held(s)) show(s)
  })

  return {
    engine,
    shown() {
      const p = caretAt
      caretAt = null
      const b = p === null ? undefined : engine.block(p.blockId)
      if (p !== null && b !== undefined)
        engine.focusAt({ blockId: p.blockId, offset: Math.min(p.offset, b.text.length) })
    },
    destroy() {
      // Where the page was, kept as the book closes.
      savePlace(true)
      dropPlace()
      off = true
      offStore()
      offReset()
      words?.stop()
      engine.destroy()
      books?.close(bookId)
    },
  }
}
