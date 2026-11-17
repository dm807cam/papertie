import type { Point, Rect } from '../canvas/types'
import { DRAG_THRESHOLD_PX } from '../interactions/drag'
import type { ToolHandlers, ToolPointer } from '../interactions/selectTool'

/** The rect between two corners, whichever way the drag went. */
export function marqueeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  }
}

/** The notes whose paper (as indexed: unturned, at its drawn height) meets `rect`, world px. */
export function marqueeHits(index: { notesIn(r: Rect): string[] }, rect: Rect): string[] {
  return index.notesIn(rect)
}

export interface MarqueeDeps {
  /** The ids of the notes meeting a world rect: an rbush query, so it costs the hits only. */
  hits(rect: Rect): string[]
  selection(): ReadonlySet<string>
  /** Make exactly these ids the selection. */
  setSelection(ids: Iterable<string>): void
  /** Draw the rubber band over this world rect, or take it away for null. */
  show(rect: Rect | null): void
  /** A drag ended with this many notes selected. */
  done(count: number): void
}

type State =
  | { kind: 'idle' }
  | { kind: 'pressing'; start: ToolPointer; before: ReadonlySet<string> }
  | {
      kind: 'dragging'
      start: ToolPointer
      /** The selection at the press: a frozen base, which Shift adds the band's notes to. */
      before: ReadonlySet<string>
      /** The notes the band met at the last move, so a move that meets the same ones is free. */
      hit: ReadonlySet<string> | null
    }

const IDLE: State = { kind: 'idle' }

/**
 * The marquee: press, drag a rubber band, release. The notes whose paper meets the band are
 * selected live, in world space, so it is the same at every level of detail (overview too).
 * Shift keeps the selection the press found and adds to it. A press without a drag is a click on
 * cork: the selection is cleared (not with Shift). Esc and `cancel()` put the old selection back.
 */
export function createMarqueeTool(deps: MarqueeDeps): ToolHandlers {
  let state: State = IDLE

  const restore = (before: ReadonlySet<string>) => {
    deps.show(null)
    deps.setSelection(before)
  }

  const track = (s: Extract<State, { kind: 'dragging' }>, e: ToolPointer) => {
    const rect = marqueeRect(s.start.world, e.world)
    const hits = deps.hits(rect)
    deps.show(rect)
    // Most moves meet the notes the last one did: the selection is then left alone, however
    // many notes it holds. Only a change in the band's notes costs the size of the selection.
    const prev = s.hit
    if (prev !== null && prev.size === hits.length && hits.every((id) => prev.has(id))) return
    s.hit = new Set(hits)
    deps.setSelection(s.start.shiftKey ? [...s.before, ...hits] : hits)
  }

  const cancel = () => {
    const s = state
    state = IDLE
    if (s.kind !== 'idle') restore(s.before)
  }

  return {
    pointerDown(e) {
      if (state.kind !== 'idle' || e.button !== 0) return
      state = { kind: 'pressing', start: e, before: deps.selection() }
      if (!e.shiftKey) deps.setSelection([])
    },

    pointerMove(e) {
      if (state.kind === 'pressing') {
        const s = state.start.screen
        if (Math.hypot(e.screen.x - s.x, e.screen.y - s.y) < DRAG_THRESHOLD_PX) return
        state = { kind: 'dragging', start: state.start, before: state.before, hit: null }
      }
      if (state.kind === 'dragging') track(state, e)
    },

    pointerUp(e) {
      const s = state
      state = IDLE
      if (s.kind !== 'dragging') return
      track(s, e)
      deps.show(null)
      deps.done(deps.selection().size)
    },

    cancel,

    key(e) {
      if (e.key !== 'Escape' || state.kind === 'idle') return false
      cancel()
      return true
    },
  }
}
