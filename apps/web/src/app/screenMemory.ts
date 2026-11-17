/**
 * The last screens of each board, as the app remembers them, the one store of them: the screen last
 * shown (the board, the shelf or a book), the last of the book screens, which the Books button
 * goes back to from the board, and the place in each book (where its caret and its page
 * were). Kept by the app, never in the board file. Unusable values read as nothing kept. Always
 * loaded, so it stays small.
 */

import { LIMITS } from '@papertie/core'
import { CAMERA_SAVE_MS } from './cameraMemory'
import { isBookId } from './router'

export type Screen = { screen: 'board' } | { screen: 'shelf' } | { screen: 'book'; bookId: string }

export interface Screens {
  last: Screen
  lastBook: Exclude<Screen, { screen: 'board' }> | null
}

const PREFIX = 'papertie.screen.'
export const screenKey = (boardId: string): string => PREFIX + boardId

const NONE: Screens = { last: { screen: 'board' }, lastBook: null }

/** `v` as a screen, or null when it is not one (a book screen needs a book's id). */
const screenOf = (v: { screen?: unknown; bookId?: unknown } | null | undefined): Screen | null =>
  v?.screen === 'board' || v?.screen === 'shelf'
    ? { screen: v.screen }
    : v?.screen === 'book' && isBookId(v.bookId)
      ? { screen: 'book', bookId: v.bookId }
      : null

/** The screens kept for `boardId`; the board and no book screen when none (or none usable). */
export function recallScreen(boardId: string): Screens {
  try {
    const v = JSON.parse(localStorage.getItem(screenKey(boardId)) ?? 'null') as Record<
      string,
      Parameters<typeof screenOf>[0]
    > | null
    const book = screenOf(v?.lastBook)
    return {
      last: screenOf(v?.last) ?? NONE.last,
      lastBook: book?.screen === 'board' ? null : book,
    }
  } catch {
    return NONE
  }
}

/** `s` is shown on `boardId` now: it is the last screen, and the last book screen if it is one. */
export function rememberScreen(boardId: string, s: Screen): void {
  try {
    const lastBook = s.screen === 'board' ? recallScreen(boardId).lastBook : s
    localStorage.setItem(screenKey(boardId), JSON.stringify({ last: s, lastBook }))
  } catch {
    // Storage full or blocked: not remembered, nothing more.
  }
}

// --- Places in books ---------------------------------------------------------------------------

/**
 * Where a book was left: the caret's block and offset (or the block at the top of the page, at
 * 0), and how far the page was scrolled past that block's top (px; negative when the block began
 * lower on the page: `book/editor/pageWindow.ts`).
 */
export interface Place {
  blockId: string
  offset: number
  scrollTop: number
}

const PLACES = 'papertie.places.'
/** The places in `boardId`'s books: up to `maxBooks`, by book, the one saved last at the end. */
export const placesKey = (boardId: string): string => PLACES + boardId

const isBlockId = (id: unknown): id is string =>
  typeof id === 'string' && /^block_[0-9A-Za-z]{1,40}$/.test(id)

/** `v` as a place, or null when it is not one. */
function placeOf(v: unknown): Place | null {
  if (typeof v !== 'object' || v === null) return null
  const { blockId, offset, scrollTop } = v as Record<string, unknown>
  return isBlockId(blockId) &&
    Number.isInteger(offset) &&
    (offset as number) >= 0 &&
    (offset as number) <= LIMITS.maxBlockText &&
    typeof scrollTop === 'number' &&
    Number.isFinite(scrollTop)
    ? { blockId, offset: offset as number, scrollTop }
    : null
}

/** The usable places kept for `boardId`, oldest first. */
function readPlaces(boardId: string): Map<string, Place> {
  const out = new Map<string, Place>()
  try {
    const v: unknown = JSON.parse(localStorage.getItem(placesKey(boardId)) ?? 'null')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return out
    for (const [bookId, raw] of Object.entries(v)) {
      const p = placeOf(raw)
      if (p !== null && isBookId(bookId)) out.set(bookId, p)
    }
  } catch {
    // Unreadable: none kept.
  }
  return out
}

/** Places waiting for the page to rest, by board and book. */
const waiting = new Map<string, Map<string, Place>>()
let timer: ReturnType<typeof setTimeout> | null = null

/** The place in `bookId` of `boardId`, or null (none kept, or none usable). */
export function recallPlace(boardId: string, bookId: string): Place | null {
  // One waiting to be saved is newer than the stored one.
  return waiting.get(boardId)?.get(bookId) ?? readPlaces(boardId).get(bookId) ?? null
}

/**
 * Keep `p` as the place in `bookId`, saved once the page has rested `CAMERA_SAVE_MS` (each call
 * only restarts the timer), or at `flushPlaces`. An unusable place is not kept.
 */
export function rememberPlace(boardId: string, bookId: string, p: Place): void {
  const place = placeOf(p)
  if (place === null || !isBookId(bookId)) return
  const board = waiting.get(boardId) ?? new Map<string, Place>()
  waiting.set(boardId, board)
  board.delete(bookId)
  board.set(bookId, place)
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(flushPlaces, CAMERA_SAVE_MS)
}

/** Save the places waiting now (the page goes, the book closes). */
export function flushPlaces(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  for (const [boardId, books] of waiting) {
    const all = readPlaces(boardId)
    for (const [bookId, p] of books) {
      all.delete(bookId)
      all.set(bookId, p)
    }
    // The ones saved longest ago go first.
    for (const bookId of all.keys()) {
      if (all.size <= LIMITS.maxBooks) break
      all.delete(bookId)
    }
    try {
      localStorage.setItem(placesKey(boardId), JSON.stringify(Object.fromEntries(all)))
    } catch {
      // Storage full or blocked: not remembered, nothing more.
    }
  }
  waiting.clear()
}

/** Forget every board's screens and places (all data deleted), and any place waiting. */
export function forgetScreens(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  waiting.clear()
  try {
    for (const k of Object.keys(localStorage))
      if (k.startsWith(PREFIX) || k.startsWith(PLACES)) localStorage.removeItem(k)
  } catch {
    // Blocked: nothing kept to forget.
  }
}

// --- The split view ---------------------------------------------------------------

/** The split preference: the app's, not a board's (one key). */
export const SPLIT_KEY = 'papertie.split'
export interface Split {
  /** The book's share of the window, 0..1. */
  ratio: number
  /** The board beside the book (else the book is full width over it). */
  board: boolean
}
export const SPLIT_DEFAULT: Split = { ratio: 0.5, board: true }
/** Below this window width a book is full width (phones, portrait tablets). */
export const SPLIT_MIN_WIDTH = 1024
/** What the board and the book each keep of the window beside each other. */
export const BOARD_MIN_PX = 360
export const BOOK_MIN_PX = 600
export const splitFits = (width: number): boolean => width >= SPLIT_MIN_WIDTH

/** `ratio` within what keeps both sides their least at `width` (at least the split's width). */
export function clampShare(ratio: number, width = typeof innerWidth === 'number' ? innerWidth : 0) {
  const w = Math.max(SPLIT_MIN_WIDTH, width)
  return Math.min(1 - BOARD_MIN_PX / w, Math.max(BOOK_MIN_PX / w, ratio))
}

/**
 * The board's part of a `width` × `height` window: with a book open (`book`) beside it, the split
 * kept by the app and fitting, the window less the book's share (as the split's CSS lays it
 * out: the book keeps its least, the board its); else the whole window. What a board's opening is
 * read for (a first paint's tiles, a remembered camera's clamp, a fitted camera).
 */
export function boardViewport(
  width: number,
  height: number,
  book: boolean,
): { width: number; height: number } {
  if (!book || !splitFits(width)) return { width, height }
  const split = recallSplit()
  if (!split.board) return { width, height }
  return { width: width - Math.round(clampShare(split.ratio, width) * width), height }
}

const splitWatchers = new Set<() => void>()
/** The split as this page last set it: what is read when storage is blocked. */
let splitHere: Split | null = null

/** The split kept by the app: unusable values read as the default; the ratio clamped. */
export function recallSplit(): Split {
  let v: { ratio?: unknown; board?: unknown } | null = null
  let text: string | null = null
  try {
    text = localStorage.getItem(SPLIT_KEY)
  } catch {
    // Storage blocked: as this page set it, else the default.
    v = splitHere
  }
  try {
    const raw: unknown = JSON.parse(text ?? 'null')
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) v = raw
  } catch {
    // Unreadable: the default.
  }
  const ratio =
    typeof v?.ratio === 'number' && Number.isFinite(v.ratio) ? v.ratio : SPLIT_DEFAULT.ratio
  const board = typeof v?.board === 'boolean' ? v.board : SPLIT_DEFAULT.board
  return { ratio: clampShare(ratio), board }
}

/** Keep `s`; whoever follows the split (`onSplit`) is told. */
export function rememberSplit(s: Split): void {
  splitHere = { ratio: s.ratio, board: s.board }
  try {
    localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: s.ratio, board: s.board }))
  } catch {
    // Storage full or blocked: not remembered, nothing more.
  }
  for (const fn of splitWatchers) fn()
}

/** Told when the split preference changes on this page; returns the way to stop. */
export function onSplit(fn: () => void): () => void {
  splitWatchers.add(fn)
  return () => splitWatchers.delete(fn)
}
