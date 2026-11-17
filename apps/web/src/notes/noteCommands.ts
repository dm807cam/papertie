import {
  type BoardState,
  type ClientOp,
  LIMITS,
  mapChangesWithin,
  type Note,
  newId,
  OpError,
  PALETTE,
  type PaletteToken,
} from '@papertie/core'
import { announce } from '../app/liveRegion'
import type { SelectMode } from '../selection/selection'
import type { BoardStore } from '../store/boardStore'

/** The coalesce key of a note's typing: one pending batch and one undo step per writing session. */
export const textKey = (noteId: string): string => `text:${noteId}`

/** What notices and undo announcements call these changes. */
export const LABELS = {
  edit: 'edit',
  delete: 'delete',
  duplicate: 'duplicate',
  create: 'new note',
  photo: 'photo',
} as const

/** What a screen reader hears as "+" pins a note open for writing: its paper, and the way out. */
export const newNoteCopy = (paper: PaletteToken): string =>
  `New ${PALETTE[paper].name} note. Write, then Esc.`

/** The coalesce key of a photo note's creation and the image that lands on it: one undo step. */
export const photoKey = (noteId: string): string => `photo:${noteId}`

/**
 * The notes `topZOf` last answered for and their top: exact, or (after the top note was lowered
 * or deleted) a bound above it until a walk in idle time makes it exact again.
 */
let lastTop: { notes: BoardState['notes']; z: number; exact: boolean } | null = null
/** Bumped by `forgetTopZ`: idle work queued before it does nothing after. */
let generation = 0
/** The walk in idle time under way, if any: one at a time. */
let walking: { gen: number; notes: BoardState['notes'] } | null = null
/** A walk asked for while one was under way: run once that ends. */
let queued: (() => BoardState['notes']) | null = null

/** Changes past this many make `topZOf` meet the board afresh (see `followTopZ`). */
const TOP_CHANGES = 256
/** An idle walk's slice: at most this long, then it yields. */
const WALK_SLICE_MS = 8
/** Notes between two reads of the clock. */
const WALK_CHECK = 512

const highest = (notes: BoardState['notes']): number => {
  let z = 0
  for (const n of notes.values()) if (n.z > z) z = n.z
  return z
}

type Idle = { timeRemaining(): number }

/** Run `fn` in idle time (a timer where there is none): never on the input that asked. */
const inIdle = (fn: (d: Idle) => void): void => {
  const idle = (globalThis as { requestIdleCallback?: (cb: (d: Idle) => void) => number })
    .requestIdleCallback
  if (idle !== undefined) idle(fn)
  else setTimeout(() => fn({ timeRemaining: () => WALK_SLICE_MS }), 0)
}

/**
 * Walk the notes `get` gives for their top in idle time, at most `WALK_SLICE_MS` a slice. If the
 * answer is still for that board (or none was met yet and the board is still that one), it
 * becomes the exact answer; if the board moved on meanwhile and the answer there is not exact, the
 * newer board is walked. One walk at a time; nothing after `forgetTopZ`.
 */
function walkInIdle(get: () => BoardState['notes']): void {
  if (walking !== null && walking.gen === generation) {
    queued = get
    return
  }
  const gen = generation
  const notes = get()
  walking = { gen, notes }
  let it: Iterator<{ z: number }> | null = null
  let z = 0
  // Each slice is a User Timing measure, `papertie:top-z` (its cost is a benchmark row's).
  const measure = (start: number) => performance.measure?.('papertie:top-z', { start })
  const slice = (d: Idle) => {
    if (gen !== generation) return
    const start = performance.now()
    it ??= notes.values()
    const end = start + Math.min(WALK_SLICE_MS, Math.max(1, d.timeRemaining()))
    do {
      for (let i = 0; i < WALK_CHECK; i++) {
        const r = it.next()
        if (r.done) {
          measure(start)
          walking = null
          const t = lastTop
          // The board walked is still the one held, or is the board now (a whole-board swap while
          // an older board was held): either way the walk is that board's exact answer.
          if (t?.notes === notes || get() === notes) lastTop = { notes, z, exact: true }
          else if (t === null || !t.exact) queued ??= get
          const next = queued
          queued = null
          if (next !== null && !(lastTop?.notes === next() && lastTop.exact)) walkInIdle(next)
          return
        }
        if (r.value.z > z) z = r.value.z
      }
    } while (performance.now() < end)
    measure(start)
    inIdle(slice)
  }
  inIdle(slice)
}

/**
 * The highest z on the board (0 when empty), or for a while after the top note was lowered or
 * deleted a z above it: either way a note given one more is on top. A drag's start and a create
 * ask it. On the canvas's board it is O(1): the canvas tells it every change it takes
 * (`followTopZ`, O(changed)), meets a board in idle time (`primeTopZ`, sliced), and a lost top is
 * walked for in idle time. Elsewhere it follows the board it last answered for by what changed
 * (`mapChangesWithin`, O(changes) up to `TOP_CHANGES`). It walks the board at once only for a
 * board it has not met: before the canvas's first idle walk of it has finished, or off the canvas.
 */
export function topZOf(s: BoardState): number {
  const notes = s.notes
  const last = lastTop
  if (last !== null && last.notes === notes) return last.z
  const changes = last === null ? null : mapChangesWithin(last.notes, notes, TOP_CHANGES)
  if (last === null || changes === null) {
    lastTop = { notes, z: highest(notes), exact: true }
    return lastTop.z
  }
  followTopZ(last.notes, notes, [...changes.set, ...changes.deleted])
  return (lastTop as { z: number }).z
}

/**
 * The board went from `before` to `after` by the notes `ids` (set or deleted): the top follows
 * in O(ids) when it was `before`'s. A note can only raise the top by its own z; a top note lowered
 * or deleted leaves a bound, made exact in idle time.
 */
export function followTopZ(
  before: BoardState['notes'],
  after: BoardState['notes'],
  ids: Iterable<string>,
): void {
  const t = lastTop
  if (t === null || t.notes !== before || before === after) return
  let z = t.z
  let exact = t.exact
  for (const id of ids) {
    const was = before.get(id)
    const n = after.get(id)
    if (was !== undefined && was.z >= t.z && (n === undefined || n.z < t.z)) exact = false
    if (n !== undefined && n.z > z) z = n.z
  }
  lastTop = { notes: after, z, exact }
  if (!exact) walkInIdle(() => lastTop?.notes ?? after)
}

/** Meet the board `get` gives in idle time (sliced), so the next `topZOf` is O(1). */
export function primeTopZ(get: () => BoardState): void {
  const t = lastTop
  if (t !== null && t.notes === get().notes && t.exact) return
  walkInIdle(() => get().notes)
}

/** Let go of the last board met (a sign-out, the canvas closing): it holds no board after. */
export function forgetTopZ(): void {
  generation++
  lastTop = null
  walking = null
  queued = null
}

/** Tests: whether a board is held. */
export const topZHolds = (): boolean => lastTop !== null

/** Tests: make the answer exact now (the idle walk, at once). */
export function settleTopZ(): void {
  const t = lastTop
  if (t === null || t.exact) return
  lastTop = { notes: t.notes, z: highest(t.notes), exact: true }
}

/** `v` moved into the coordinate limits for a box `size` wide (or high). */
export const clampCoord = (v: number, size: number): number =>
  Math.min(LIMITS.maxCoord - size, Math.max(-LIMITS.maxCoord, v))

/** A note id minted from the store's clock (the server's, on a server board). */
export function noteIdAt(now: string): string {
  const t = Date.parse(now)
  return Number.isFinite(t) ? newId('note', t) : newId('note')
}

/**
 * Set a note's text: one `note.update`, coalesced under `textKey` with the label `edit`, so a
 * writing session sends as one batch after a pause and undoes as one step. Throws `OpError` as
 * `store.commit` does (the note is gone, the text too long).
 */
export function setNoteText(store: BoardStore, noteId: string, text: string): void {
  store.commit([{ op: 'note.update', id: noteId, set: { text } }], {
    coalesceKey: textKey(noteId),
    label: LABELS.edit,
  })
}

/**
 * Delete the notes `ids` that are on the board, as one batch labelled `delete`. Core closes up
 * the threads they hung on (a thread left with one note is untied); undo puts them back.
 */
export function deleteNotes(store: BoardStore, ids: Iterable<string>): void {
  const { notes } = store.getState()
  const ops: ClientOp[] = []
  for (const id of new Set(ids)) if (notes.has(id)) ops.push({ op: 'note.delete', id })
  if (ops.length > 0) store.commit(ops, { label: LABELS.delete })
}

/**
 * Copy the notes `ids` that are on the board, `offset` px down and right, as one batch labelled
 * `duplicate`: new ids, the same paper, text, image and decoration, stacked above every note in
 * their own order. Threads are not copied. Returns the copies' ids in the order of `ids`.
 */
export function duplicateNotes(store: BoardStore, ids: Iterable<string>, offset = 24): string[] {
  const s = store.getState()
  const sources: Note[] = []
  for (const id of new Set(ids)) {
    const n = s.notes.get(id)
    if (n !== undefined) sources.push(n)
  }
  if (sources.length === 0) return []
  const now = store.now()
  const copyOf = new Map<string, string>()
  const ops: ClientOp[] = []
  let z = topZOf(s)
  for (const n of [...sources].sort((a, b) => a.z - b.z)) {
    const id = noteIdAt(now)
    copyOf.set(n.id, id)
    const note: Note = {
      ...n,
      id,
      x: clampCoord(n.x + offset, n.w),
      y: clampCoord(n.y + offset, n.h),
      z: ++z,
      createdAt: now,
      updatedAt: now,
    }
    ops.push({ op: 'note.create', note })
  }
  store.commit(ops, { label: LABELS.duplicate })
  return sources.map((n) => copyOf.get(n.id) as string)
}

/** What takes the selection a command leaves behind (the runtime). */
export interface SelectionTarget {
  selectNotes(ids: Iterable<string>, mode?: SelectMode, o?: { bringIn?: boolean }): void
}

/**
 * Say why a note command was refused (the board is full, the notes went); rethrows anything
 * that is not an `OpError`, which is a bug.
 */
function announceRefusal(err: unknown, what: 'duplicate' | 'delete'): void {
  if (!(err instanceof OpError)) throw err
  if (what === 'duplicate' && err.code === 'limit') {
    announce(
      `Couldn’t duplicate: a board holds at most ${LIMITS.maxNotes.toLocaleString('en')} notes`,
    )
  } else
    announce(what === 'duplicate' ? 'Couldn’t duplicate the notes' : 'Couldn’t delete the notes')
}

/**
 * Duplicate the selected notes `ids` (⌘D, the sidebar) and select the copies, bringing them
 * into the focus when it is on. A refused copy (a full board) adds nothing and is said aloud.
 */
export function duplicateSelection(
  store: BoardStore,
  ids: Iterable<string>,
  rt: SelectionTarget,
): void {
  let copies: string[]
  try {
    copies = duplicateNotes(store, ids)
  } catch (err) {
    announceRefusal(err, 'duplicate')
    return
  }
  if (copies.length > 0) rt.selectNotes(copies, 'replace', { bringIn: true })
}

/** Delete the selected notes `ids` (⌫, the sidebar); a refusal is said aloud. */
export function deleteSelection(store: BoardStore, ids: Iterable<string>): void {
  try {
    deleteNotes(store, ids)
  } catch (err) {
    announceRefusal(err, 'delete')
  }
}
