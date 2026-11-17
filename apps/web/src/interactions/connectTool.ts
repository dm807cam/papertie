import type { PaletteToken } from '@papertie/core'
import { announce } from '../app/liveRegion'
import type { Point } from '../canvas/types'
import { announceFailure, type PinChoice, type ThreadEnd, type YarnFlows } from '../yarn/yarnFlows'
import type { ToolHandlers, ToolPointer } from './selectTool'

/**
 * The thread being connected: from the pin it starts at to the pointer or, over another note
 * (`targetNoteId`), to the pin it would be tied at there: an existing pin under the pointer
 * (`shared`: the note's hanging pin or an edge pin), else the edge pin it would get. `color` is
 * the dye it will have.
 */
export interface LiveThread {
  from: Point
  to: Point
  /** The note whose hanging pin it leaves from, if it does: it runs beneath that note's paper. */
  under?: string
  targetNoteId?: string
  shared?: 'hanging' | 'edge'
  color?: PaletteToken
}

/** An existing pin of a note, where it is (world px), and how a thread end is tied at it. */
export interface PinSpot {
  pin: PinChoice
  at: Point
}

export interface ConnectToolDeps {
  fromNoteId: string
  /** The existing pin of the source the press was on: the thread starts there and shares it. */
  start?: PinSpot
  /** The existing pin under the pointer (its note's), if any: a drop there shares it. */
  pinAt?(e: ToolPointer): (PinSpot & { noteId: string }) | undefined
  pinOf(noteId: string): Point | undefined
  /** The topmost note under a world point, through gesture overrides. */
  noteAt(world: Point): string | undefined
  /** Where a thread from `fromNoteId` would attach on a target note (its edge pin). */
  landingOf?(targetNoteId: string, fromNoteId: string): Point | undefined
  /** A drop that connected nothing (on cork or the source note); not called for Esc or cancel. */
  onNoConnect?(): void
  /** The source changed: a Shift-drop went on winding from the note it landed on. */
  onSource?(noteId: string): void
  flows: Pick<YarnFlows, 'tie' | 'extend'>
  /** The dye of a new thread. */
  color(): PaletteToken
  /** The colour of a stored thread, for the live strand of one being wound or extended. */
  colorOf?(yarnId: string): PaletteToken | undefined
  /**
   * The gesture extends this thread from one of its end pins (the end pin of a selected thread)
   * instead of tying a new one.
   */
  extend?: { yarnId: string; end: ThreadEnd }
  /** The note at one end of a stored thread, as the board has it now; undefined if it is gone. */
  threadEnd(yarnId: string, end: ThreadEnd): string | undefined
  /** A note's first line, for what is said aloud. */
  leadOf?(noteId: string): string
  /** Show (or with null, hide) the live thread; its sag springs under the runtime's `'__live'` key. */
  setLive(l: LiveThread | null): void
}

export interface ConnectTool extends ToolHandlers {
  holds(id: string): boolean
  /**
   * Whether the gesture goes on with no button down: a Shift-drop landed on a note and the thread
   * follows the pointer on from it, until a click on cork, a click without Shift, or Esc.
   */
  winding(): boolean
  /** Whether a gesture is under way at all: a press held, or a thread winding on. */
  active(): boolean
}

/**
 * The connect gesture, started on a pin (or, in the yarn tool, anywhere on a note): a live thread
 * from that pin (else the source's hanging pin) follows the pointer, landing over another note
 * on the existing pin under the pointer or else on the target's would-be edge pin, and dropping
 * there ties the two with a 2-note yarn, or winds the target onto the thread being extended. Each
 * end is tied at the existing pin it started or dropped on (shared from then on), or else at an
 * edge pin of its own. Dropping on cork or on the source note, Esc and `cancel()` commit nothing.
 *
 * Dropping with Shift held keeps winding: the thread goes on from the dropped note, following the
 * pointer, and the next click (with Shift, to go on again) drops on the next note. A thread the
 * drop found already tied in that colour is only shown, so winding stops there.
 */
export function createConnectTool(deps: ConnectToolDeps): ConnectTool {
  let from: Point | null = null
  /** The note whose hanging pin `from` is; undefined when it is an edge pin. */
  let under: string | undefined
  let source = deps.fromNoteId
  /** The thread being wound or extended (a Shift-drop's first tie, or the extended thread). */
  let thread: { yarnId: string; end: ThreadEnd } | null = deps.extend ?? null
  let handsFree = false
  /** The click that dropped while winding: its release is not a drop. */
  let ignoreUp = false

  /**
   * Whether the thread being wound is no longer as this gesture left it (an undo, a redo or
   * a restore changed it): its end is not the note the strand hangs from. Then it stops.
   */
  const stale = () => thread !== null && deps.threadEnd(thread.yarnId, thread.end) !== source

  const colorNow = () => (thread && deps.colorOf?.(thread.yarnId)) || deps.color()

  const finite = (p: Point | undefined): p is Point =>
    p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)

  /** The note under the pointer and the existing pin of it there, if any. */
  const targetOf = (e: ToolPointer): { noteId?: string; spot?: PinSpot } => {
    const hit = deps.pinAt?.(e)
    if (hit !== undefined && hit.noteId !== source && finite(hit.at)) {
      return { noteId: hit.noteId, spot: { pin: hit.pin, at: hit.at } }
    }
    return { noteId: deps.noteAt(e.world) }
  }

  const show = (e: ToolPointer) => {
    if (from === null) return
    const color = colorNow()
    const base = under === undefined ? { from, color } : { from, under, color }
    const { noteId: target, spot } = targetOf(e)
    if (target === undefined || target === source) {
      deps.setLive({ ...base, to: e.world })
      return
    }
    if (spot !== undefined) {
      const shared = spot.pin === 'hanging' ? 'hanging' : 'edge'
      deps.setLive({ ...base, to: spot.at, targetNoteId: target, shared })
      return
    }
    const landing = deps.landingOf?.(target, source)
    deps.setLive({ ...base, to: finite(landing) ? landing : e.world, targetNoteId: target })
  }

  const end = () => {
    if (from === null) return false
    from = null
    handsFree = false
    ignoreUp = false
    deps.setLive(null)
    return true
  }

  /** Tie, wind or extend onto `target`; whether the gesture goes on from it (Shift held). */
  const connect = (target: string, pin: PinChoice | undefined, shift: boolean): boolean => {
    if (thread !== null) {
      deps.flows.extend(thread.yarnId, thread.end, target, pin)
      return shift
    }
    const res = deps.flows.tie(source, target, deps.color(), { from: deps.start?.pin, to: pin })
    if (!(shift && res.created)) return false
    // The first tie of a Shift-drop: wind on from this end.
    thread = { yarnId: res.yarnId, end: 'last' }
    return true
  }

  const drop = (e: ToolPointer) => {
    if (from === null) return
    const { noteId: target, spot } = targetOf(e)
    if (target !== undefined && target !== source) {
      let goOn = false
      try {
        goOn = connect(target, spot?.pin, e.shiftKey)
      } catch (err) {
        // The thread is full, or a note went: nothing was changed, and the gesture is over.
        end()
        announceFailure(err)
        return
      }
      // The strand hangs on from the thread's own end, whatever the drop did: from the pin it
      // was dropped on when that is where it is now tied, else from the note's hanging pin.
      const next = goOn && thread !== null ? deps.threadEnd(thread.yarnId, thread.end) : undefined
      const onSpot = next !== undefined && next === target && spot !== undefined
      const pin = next === undefined ? undefined : onSpot ? spot.at : deps.pinOf(next)
      if (next !== undefined && finite(pin)) {
        const changed = next !== source || !handsFree
        source = next
        from = pin
        under = onSpot && spot.pin !== 'hanging' ? undefined : next
        handsFree = true
        deps.onSource?.(next)
        if (changed) {
          const lead = deps.leadOf?.(next) ?? next
          announce(`Winding on from “${lead}”. Click notes to add, Esc to finish.`)
        }
        show(e)
        return
      }
      end()
      return
    }
    const wasWinding = handsFree
    end()
    if (!wasWinding) deps.onNoConnect?.()
  }

  return {
    pointerDown(e) {
      if (e.button !== 0) return
      if (from !== null) {
        // Winding with no button down: a click drops.
        if (handsFree) {
          if (stale()) {
            end()
            return
          }
          ignoreUp = true
          drop(e)
        }
        return
      }
      const p = deps.start?.at ?? deps.pinOf(source)
      if (!finite(p)) return
      from = p
      under = deps.start === undefined || deps.start.pin === 'hanging' ? source : undefined
      show(e)
    },
    pointerMove(e) {
      if (from !== null && stale()) {
        end()
        return
      }
      show(e)
    },
    pointerUp(e) {
      if (from === null) return
      if (ignoreUp) {
        ignoreUp = false
        return
      }
      drop(e)
    },
    cancel() {
      end()
    },
    key(e) {
      return e.key === 'Escape' && end()
    },
    holds(id) {
      return from !== null && id === source
    },
    winding() {
      return from !== null && handsFree
    },
    active() {
      return from !== null
    },
  }
}
