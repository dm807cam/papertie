import { type ClientOp, LIMITS, type Note } from '@papertie/core'
import type { TransientOverrides } from '../canvas/transient'
import type { Point } from '../canvas/types'
import type { SelectMode } from '../selection/selection'
import type { CommitOptions } from '../store/boardStore'
import {
  DRAG_THRESHOLD_PX,
  dragOps,
  moveNotes,
  type NoteRect,
  type ResizeHandle,
  resizeOps,
  resizeRect,
} from './drag'

/** A pointer event as a tool sees it: viewport and world position, and what it landed on. */
export interface ToolPointer {
  screen: Point
  world: Point
  button: number
  shiftKey: boolean
  target: { noteId?: string; handle?: ResizeHandle }
}

/** One tool's state machine. `key` returns true when it handled the key. */
export interface ToolHandlers {
  pointerDown(e: ToolPointer): void
  pointerMove(e: ToolPointer): void
  pointerUp(e: ToolPointer): void
  cancel(): void
  key(e: { key: string }): boolean
  /** Whether a gesture under way acts on note `id` (so that it ends if the note goes). */
  holds?(id: string): boolean
  /** The note ids a drag under way moves, else null (a drop across the seam takes them). */
  dragged?(): readonly string[] | null
}

export interface SelectToolDeps {
  getNote(id: string): Note | undefined
  overrides: TransientOverrides
  commit(ops: readonly ClientOp[], o?: CommitOptions): void
  /** Make one note (or none) the whole selection. */
  select(id: string | null): void
  /** The notes selected now. */
  selection(): ReadonlySet<string>
  /** Change the selection by many ids: replace it, add to it, or flip them in it. */
  selectNotes(ids: Iterable<string>, mode: SelectMode): void
  topZ(): number
  /** Current camera zoom; deltas come from world points, so they already account for it. */
  zoom(): number
  /** The w/h a resize must keep (an image note's asset), if any. */
  aspectOf(n: Note): number | undefined
  /** The height the note is drawn at (its measured content may exceed `h`); `n.h` by default. */
  heightOf?(n: Note): number
  /** Follows a single note's drag (merging it into a note it is held beside). */
  watch?: DragWatch
}

/** What follows a drag of one note: where it is on each move, and its end. */
export interface DragWatch {
  /** The dragged note, where the drag holds it now. */
  move(n: Note): void
  /**
   * The drag is released with the note at `n`. True: the watch took the release (and committed
   * its own batch), so the move is not committed.
   */
  release(n: Note): boolean
  /** The drag ended, released or not. */
  end(): void
}

type State =
  | { kind: 'idle' }
  | {
      kind: 'pressing'
      start: ToolPointer
      note: Note
      handle?: ResizeHandle
      /** Pressed on one of several selected notes: a release without a drag narrows to it. */
      narrow: boolean
    }
  | {
      kind: 'dragging'
      start: ToolPointer
      /** The pressed note alone: dragged through an override of its own. */
      single: Note | null
      /** Several selected notes: one shared delta, never an entry or a read per note. */
      group: GroupDrag | null
      topZ: number
      /** The ids it moves, listed once when first asked (`dragged`). */
      ids?: readonly string[]
    }
  | {
      kind: 'resizing'
      start: ToolPointer
      /** The note as displayed: `h` is its drawn height, so the handle starts under the pointer. */
      base: Note
      /** The stored note, which the commit diffs against. */
      note: Note
      handle: ResizeHandle
      aspect?: number
      rect: NoteRect
    }

const IDLE: State = { kind: 'idle' }

/**
 * A drag of several selected notes. Its cost per pointer move is one `setGroup`; the notes are
 * read once, when it begins (for the room the group has inside the coordinate limits and the
 * lift), and once more at the release, which builds the batch.
 */
interface GroupDrag {
  /** The selection as it was when the drag began (selections are never mutated). */
  ids: ReadonlySet<string>
  /** The delta (integers) that keeps every member inside ±maxCoord. */
  room: { loX: number; hiX: number; loY: number; hiY: number }
  /** Lifts the lowest member to `topZ + 1`; the rest follow in their own order. */
  dz: number
  dx: number
  dy: number
}

/** What notices and undo announcements call a drag's and a resize's commit. */
export const GESTURE_LABELS = { dragging: 'move', resizing: 'resize' } as const

/**
 * The select tool: idle → pressing → dragging | resizing → idle. A press selects; past
 * `DRAG_THRESHOLD_PX` it drags the note (or resizes from a handle) through `overrides` only, and
 * the release commits one batch. `cancel()` and Esc drop the overrides and commit nothing.
 * Shift toggles a note in the selection. A press on a selected note keeps the selection, so the
 * drag moves all of it together (one batch, the notes keeping their order on top); a click
 * without a drag then narrows the selection to that note.
 */
export function createSelectTool(deps: SelectToolDeps): ToolHandlers {
  let state: State = IDLE

  const delta = (start: ToolPointer, e: ToolPointer) => ({
    dx: e.world.x - start.world.x,
    dy: e.world.y - start.world.y,
  })

  /** The drawn height, within the note limits and never below the stored `h`. */
  const shownH = (n: Note) => {
    const h = deps.heightOf?.(n) ?? n.h
    return Number.isFinite(h) ? Math.min(LIMITS.noteMaxH, Math.max(n.h, h)) : n.h
  }

  /** An unchanged height stays the stored one: only a moved s/n edge sets `h`. */
  const stored = (s: Extract<State, { kind: 'resizing' }>, r: NoteRect): NoteRect =>
    r.h === s.base.h ? { ...r, h: s.note.h } : r

  const begin = (s: Extract<State, { kind: 'pressing' }>) => {
    if (s.handle === undefined) {
      const members = deps.selection()
      const topZ = deps.topZ()
      if (!(members.has(s.note.id) && members.size > 1)) {
        state = { kind: 'dragging', start: s.start, single: s.note, group: null, topZ }
        return
      }
      let loX = Number.POSITIVE_INFINITY
      let hiX = Number.NEGATIVE_INFINITY
      let loY = loX
      let hiY = hiX
      let minZ = loX
      for (const id of members) {
        const n = deps.getNote(id)
        if (n === undefined) continue
        loX = Math.min(loX, n.x)
        hiX = Math.max(hiX, n.x)
        loY = Math.min(loY, n.y)
        hiY = Math.max(hiY, n.y)
        minZ = Math.min(minZ, n.z)
      }
      const M = LIMITS.maxCoord
      state = {
        kind: 'dragging',
        start: s.start,
        single: null,
        group: {
          ids: members,
          room: { loX: -M - loX, hiX: M - hiX, loY: -M - loY, hiY: M - hiY },
          dz: topZ + 1 - minZ,
          dx: 0,
          dy: 0,
        },
        topZ,
      }
      return
    }
    const base = { ...s.note, h: shownH(s.note) }
    const keep = deps.aspectOf(s.note) ?? (s.start.shiftKey ? base.w / base.h : undefined)
    state = {
      kind: 'resizing',
      start: s.start,
      base,
      note: s.note,
      handle: s.handle,
      aspect: keep,
      rect: { x: s.note.x, y: s.note.y, w: s.note.w, h: s.note.h },
    }
  }

  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  const track = (e: ToolPointer) => {
    if (state.kind === 'dragging') {
      const { start, single, group, topZ } = state
      const { dx, dy } = delta(start, e)
      if (group !== null) {
        const rx = Number.isFinite(dx) ? Math.round(dx) : 0
        const ry = Number.isFinite(dy) ? Math.round(dy) : 0
        group.dx = clamp(rx, group.room.loX, group.room.hiX)
        group.dy = clamp(ry, group.room.loY, group.room.hiY)
        deps.overrides.setGroup(group.ids, { dx: group.dx, dy: group.dy, dz: group.dz })
        return undefined
      }
      const notes = [single as Note]
      const after = moveNotes(notes, dx, dy)
      const p = after.get((single as Note).id)
      if (p) {
        deps.overrides.set((single as Note).id, { ...p, z: topZ + 1 })
        deps.watch?.move({ ...(single as Note), ...p, z: topZ + 1 })
      }
      return after
    }
    if (state.kind === 'resizing') {
      const { dx, dy } = delta(state.start, e)
      state.rect = stored(state, resizeRect(state.base, state.handle, dx, dy, state.aspect))
      deps.overrides.set(state.note.id, state.rect)
    }
    return undefined
  }

  /** The batch of a finished drag: every moved note, the lift in their own order. */
  const dragBatch = (
    s: Extract<State, { kind: 'dragging' }>,
    after: Map<string, { x: number; y: number }> | undefined,
  ): ClientOp[] => {
    if (s.group === null) return dragOps(s.single ? [s.single] : [], after ?? new Map(), s.topZ)
    const { ids, dx, dy } = s.group
    const before: Note[] = []
    const moved = new Map<string, { x: number; y: number }>()
    for (const id of ids) {
      const n = deps.getNote(id)
      if (n === undefined) continue
      before.push(n)
      moved.set(id, { x: n.x + dx, y: n.y + dy })
    }
    return dragOps(before, moved, s.topZ)
  }

  const reset = () => {
    const watched = state.kind === 'dragging' && state.single !== null
    const active = state.kind === 'dragging' || state.kind === 'resizing'
    state = IDLE
    if (active) deps.overrides.clear()
    if (watched) deps.watch?.end()
  }

  return {
    pointerDown(e) {
      if (state.kind !== 'idle' || e.button !== 0) return
      const note = e.target.noteId === undefined ? undefined : deps.getNote(e.target.noteId)
      if (note === undefined) {
        // Shift on cork leaves the selection alone (a marquee would add to it).
        if (!e.shiftKey) deps.select(null)
        return
      }
      if (e.shiftKey && e.target.handle === undefined) {
        deps.selectNotes([note.id], 'toggle')
        // A note just left out is not dragged; one just added can be.
        if (!deps.selection().has(note.id)) return
        state = { kind: 'pressing', start: e, note, narrow: false }
        return
      }
      const members = deps.selection()
      const inGroup = members.has(note.id) && members.size > 1 && e.target.handle === undefined
      if (!inGroup) deps.select(note.id)
      state = { kind: 'pressing', start: e, note, handle: e.target.handle, narrow: inGroup }
    },

    pointerMove(e) {
      if (state.kind === 'pressing') {
        const s = state.start.screen
        if (Math.hypot(e.screen.x - s.x, e.screen.y - s.y) < DRAG_THRESHOLD_PX) return
        begin(state)
      }
      track(e)
    },

    pointerUp(e) {
      const s = state
      if (s.kind !== 'dragging' && s.kind !== 'resizing') {
        state = IDLE
        // A click on one of several selected notes narrows the selection to it.
        if (s.kind === 'pressing' && s.narrow) deps.select(s.note.id)
        return
      }
      const after = track(e)
      const single = s.kind === 'dragging' ? s.single : null
      const p = single === null ? undefined : after?.get(single.id)
      if (single !== null && p !== undefined) {
        let taken: boolean
        try {
          taken = deps.watch?.release({ ...single, ...p }) === true
        } catch (err) {
          reset()
          throw err
        }
        if (taken) {
          reset()
          return
        }
      }
      const ops = s.kind === 'dragging' ? dragBatch(s, after) : resizeOps(s.note, s.rect)
      // A group's move is a delta laid over the stored positions: it goes before the batch is
      // committed, or the commit (which the canvas reacts to at once) would see it twice. A
      // single note's override is absolute, so it can stay until after.
      if (s.kind === 'dragging' && s.group !== null) reset()
      try {
        if (ops.length > 0) deps.commit(ops, { label: GESTURE_LABELS[s.kind] })
      } finally {
        reset()
      }
    },

    cancel: reset,

    key(e) {
      if (e.key !== 'Escape' || state.kind === 'idle') return false
      reset()
      return true
    },

    dragged() {
      if (state.kind !== 'dragging') return null
      state.ids ??= state.group === null ? [(state.single as Note).id] : [...state.group.ids]
      return state.ids
    },

    holds(id) {
      if (state.kind === 'dragging') {
        return state.group === null ? state.single?.id === id : state.group.ids.has(id)
      }
      return state.kind !== 'idle' && state.note.id === id
    },
  }
}

const HANDLES = new Set<string>(['nw', 'ne', 'sw', 'se', 'e', 's'])

/** What a DOM event target is to the tools: a selection handle (with its note), a note, or cork. */
export function toolTarget(t: EventTarget | null): ToolPointer['target'] {
  const el = t as Element | null
  if (el === null || typeof el.closest !== 'function') return {}
  const handle = el.closest<HTMLElement>('[data-handle]')
  const h = handle?.dataset.handle
  if (handle && h !== undefined && HANDLES.has(h)) {
    const noteId = handle.closest<HTMLElement>('[data-note-id]')?.dataset.noteId
    return noteId === undefined ? {} : { noteId, handle: h as ResizeHandle }
  }
  const noteId = el.closest<HTMLElement>('article[data-note-id]')?.dataset.noteId
  return noteId === undefined ? {} : { noteId }
}
