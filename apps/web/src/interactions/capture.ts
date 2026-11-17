import { prefsStore } from '../app/prefs'
import { screenToWorld } from '../canvas/Camera'
import type { Hit } from '../canvas/hitTest'
import type { CanvasRuntime } from '../canvas/runtime'
import { deleteSelection, duplicateSelection } from '../notes/noteCommands'
import { openConnect } from '../yarn/connectStore'
import { newYarnColor, noteLead, type ThreadEnd } from '../yarn/yarnFlows'
import { type ConnectTool, createConnectTool, type PinSpot } from './connectTool'
import { connectKey, historyKey, isTypingTarget, noteKey, photoKey, toolKey } from './keys'
import { toolTarget } from './selectTool'

/**
 * The hit-testing stage of the runtime's capture-phase pointer dispatch. The runtime calls it
 * after its own pan and pinch handling and before anything reaches a note: `down` returning true
 * means the press was taken, and the runtime stops its propagation.
 */
export interface CaptureStage {
  down(e: PointerEvent): boolean
  move(e: PointerEvent): void
  /** pointerup, pointercancel or the root losing capture. */
  end(e: PointerEvent): void
  /** Abandon any connect gesture and clear the hover. */
  cancel(): void
  key(e: KeyboardEvent): boolean
  /** Whether a connect under way starts from note `id`. */
  holds(id: string): boolean
}

const NONE: Hit = { kind: 'none' }

const inUi = (t: EventTarget | null) => t instanceof Element && t.closest('.ui') !== null

/**
 * Whether `t` is on the note being written on: its paper is the editor's, a press there places
 * the caret (no tool, pin or yarn takes it, and the double-click is the textarea's).
 */
export const onEditedNote = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest('.note--editing') !== null

/** Whether `t` is in the editor's field itself, or in its ref field. */
export const inEditor = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest('.note-edit, .note-ref-input') !== null

/** A mouse move with no button down: the press it belongs to ended without a pointer-up. */
export const releasedMouse = (e: PointerEvent) => e.pointerType === 'mouse' && e.buttons === 0

/** Drop the root's capture of `id`, if it still holds it. */
export function releaseCapture(root: HTMLElement, id: number): void {
  try {
    if (root.hasPointerCapture(id)) root.releasePointerCapture(id)
  } catch {
    // Not an active pointer.
  }
}

/**
 * Pins and yarn above the notes. A capture-phase press runs `hitTest`:
 * - with the Yarn tool (the one way to tie a thread), a pin starts the connect tool from that
 *   pin, and the new thread is tied there too (the hanging pin, or an edge pin shared with the
 *   thread it holds); a press anywhere else on a note starts it with an edge pin of its own. A
 *   drop on an existing pin of the target shares it, elsewhere on the note it gets its own. A
 *   press on an edge pin that connects nothing (released on its own note or on cork) selects the
 *   yarn it holds. With either tool an end pin of the selected thread extends it to the note it
 *   is dropped on, and Shift on the drop keeps winding (see `createConnectTool`). With the select
 *   tool another edge pin is its thread's (a press selects it) and a hanging pin its note's;
 * - a yarn selects it, except under a select-tool resize handle (drawn above the yarn), which
 *   wins; a pin still wins over a handle;
 * - otherwise the press passes through to the tools (on bare cork, a pan or a marquee).
 * Hover sets the cursor (`data-hover` on the root) and the pin glow; in overview it marks the
 * root over a card (`data-card`, for the tools' cursors) and outlines the card instead. A
 * double-click on a note (select tool, not after a drag) edits it, the caret at the click; one
 * on cork does nothing ("+" is the one way to a new note). Keys, outside text
 * fields and the UI: Delete or Backspace unties the selected yarn, or else removes the selected
 * notes; Enter edits the selected note; C opens `Connect to…` for it; ⌘D duplicates the
 * selection; Esc cancels a connect, or clears the selection. While writing is on but its field
 * has no focus, Esc leaves it and the board's keys do nothing.
 */
export function installCaptureHandlers(root: HTMLElement, rt: CanvasRuntime): () => void {
  let connect: { id: number; tool: ConnectTool } | null = null
  let hover: Hit = NONE

  const setHover = (hit: Hit) => {
    const kind = hit.kind === 'none' ? undefined : hit.kind
    if (root.dataset.hover !== kind) {
      if (kind === undefined) delete root.dataset.hover
      else root.dataset.hover = kind
    }
    hover = hit
    if (hit.kind === 'pin') rt.setHoverPin(hit.noteId, hit.edge)
    else rt.setHoverPin(null)
  }

  /** Overview: mark the root while the pointer is over a card, which sets the tool's cursor. */
  const setCard = (on: boolean) => {
    if (on === (root.dataset.card !== undefined)) return
    if (on) root.dataset.card = ''
    else delete root.dataset.card
  }

  const hoverAt = (e: PointerEvent) => {
    const idle = e.pointerType !== 'touch' && e.buttons === 0 && !rt.panning && !inUi(e.target)
    const screen = rt.toViewport(e.clientX, e.clientY)
    const hit = idle ? toolHit(rt.hitTest(screen)) : NONE
    if (!sameTarget(hit, hover)) setHover(hit)
    // Overview mounts no notes, so no note element sets the cursor: the card under the pointer
    // does, and it is outlined.
    const card =
      idle && rt.lod === 'overview' ? rt.noteAt(screenToWorld(rt.drawnCamera(), screen)) : undefined
    setCard(card !== undefined)
    rt.setHoverCard(card)
  }

  const endConnect = () => {
    connect = null
    setHover(NONE)
  }

  /** The existing pin a pin hit is: the note's hanging pin, or the one holding a thread's end. */
  const spotOf = (hit: Hit): (PinSpot & { noteId: string }) | undefined => {
    if (hit.kind !== 'pin') return undefined
    const { noteId, edge } = hit
    if (edge === undefined) {
      const at = rt.pinWorld(noteId)
      return at && { noteId, pin: 'hanging', at }
    }
    const at = rt.attachWorld(edge.yarnId, edge.segIndex, edge.end)
    return at && { noteId, pin: { yarnId: edge.yarnId, end: edge.end }, at }
  }

  /** The end of the selected thread an edge pin is: the pin a drag extends it from. */
  const endOfSelected = (hit: Hit): ThreadEnd | undefined => {
    if (hit.kind !== 'pin' || hit.edge === undefined) return undefined
    const { yarnId, segIndex, end } = hit.edge
    if (yarnId !== rt.selectedYarnId) return undefined
    // Judged on the thread as drawn, the one the hit's segment is of.
    const count = rt.drawnYarn(yarnId)?.noteIds.length
    if (count === undefined) return undefined
    if (segIndex === 0 && end === 'a') return 'first'
    return segIndex === count - 2 && end === 'b' ? 'last' : undefined
  }

  /**
   * What a hit is to the tool in hand. The Yarn tool ties from any pin. The select tool ties
   * nothing: a selected thread's end pin still extends it, a thread's other edge pins are that
   * thread (a press selects it), and a hanging pin is its note's (the press goes to the note).
   */
  const toolHit = (hit: Hit): Hit => {
    if (hit.kind !== 'pin' || prefsStore.getState().tool !== 'select') return hit
    if (endOfSelected(hit) !== undefined) return hit
    if (hit.edge === undefined) return NONE
    return { kind: 'yarn', yarnId: hit.edge.yarnId, segIndex: hit.edge.segIndex }
  }

  const stage: CaptureStage = {
    down(e) {
      if (connect !== null) {
        // Winding on with no button down: this click drops the thread (see `connectTool`).
        if (connect.tool.winding()) {
          const { id, tool } = connect
          try {
            tool.pointerDown(rt.toolPointer(e))
          } catch (err) {
            tool.cancel()
            releaseCapture(root, id)
            endConnect()
            throw err
          }
          if (!tool.winding()) {
            releaseCapture(root, id)
            endConnect()
          }
        }
        return true
      }
      const tool = prefsStore.getState().tool
      if (e.button !== 0) return false
      const p = rt.toolPointer(e)
      let hit = toolHit(rt.hitTest(p.screen))
      // While the canvas catches up, a pin's note and threads are taken first, as a press on a
      // note takes it: the gesture starts from the store's thread, hit as it is now drawn.
      if (hit.kind === 'pin' && rt.takeBeforeGesture([hit.noteId])) {
        hit = toolHit(rt.hitTest(p.screen))
      }
      // The select tool's handles are drawn above the yarn: a press there resizes.
      const onHandle = tool === 'select' && p.target.handle !== undefined
      if (onHandle && hit.kind !== 'pin') return false
      if (hit.kind === 'yarn') {
        rt.selectYarn(hit.yarnId)
        return true
      }
      const from =
        hit.kind === 'pin'
          ? hit.noteId
          : tool === 'yarn'
            ? (p.target.noteId ?? rt.noteAt(p.world))
            : undefined
      if (from === undefined) return false
      const edge = hit.kind === 'pin' ? hit.edge : undefined
      const extendEnd = endOfSelected(hit)
      const t = createConnectTool({
        fromNoteId: from,
        start: spotOf(hit),
        pinAt: (e) => spotOf(rt.hitTest(e.screen)),
        pinOf: (id) => rt.pinWorld(id),
        noteAt: (w) => rt.noteAt(w),
        landingOf: (id, source) => rt.landingWorld(id, source),
        flows: rt.yarnFlows,
        color: newYarnColor,
        colorOf: (id) => rt.store.getState().yarns.get(id)?.color,
        threadEnd: (id, end) => {
          const ids = rt.store.getState().yarns.get(id)?.noteIds
          return end === 'first' ? ids?.[0] : ids?.at(-1)
        },
        leadOf: (id) => noteLead(rt.store.getState().notes.get(id)),
        extend:
          edge !== undefined && extendEnd !== undefined
            ? { yarnId: edge.yarnId, end: extendEnd }
            : undefined,
        setLive: (l) => rt.setLiveThread(l),
        onSource: (id) => setHover({ kind: 'pin', noteId: id }),
        onNoConnect: edge === undefined ? undefined : () => rt.selectYarn(edge.yarnId),
      })
      connect = { id: e.pointerId, tool: t }
      setHover({ kind: 'pin', noteId: from })
      t.pointerDown(p)
      try {
        root.setPointerCapture(e.pointerId)
      } catch {
        // Not an active pointer (synthetic events): they still reach the root.
      }
      return true
    },

    move(e) {
      if (connect === null) hoverAt(e)
      else if (e.pointerId !== connect.id) return
      else if (releasedMouse(e) && !connect.tool.winding()) stage.cancel()
      else {
        connect.tool.pointerMove(rt.toolPointer(e))
        // A winding thread the board changed under (an undo) ended itself.
        if (!connect.tool.active()) {
          releaseCapture(root, connect.id)
          endConnect()
        }
      }
    },

    end(e) {
      if (connect === null || e.pointerId !== connect.id) return
      const { tool } = connect
      // A thread winding on with no button down outlives the release that started it, and the
      // capture that release lets go of.
      if (e.type === 'pointerup') {
        // However the drop ends (a commit that throws too), the gesture does not outlive it:
        // a stuck one would swallow every press on the board.
        try {
          tool.pointerUp(rt.toolPointer(e))
        } catch (err) {
          tool.cancel()
          endConnect()
          throw err
        }
        if (tool.winding()) return
        endConnect()
        hoverAt(e)
        return
      }
      if (e.type === 'lostpointercapture' && tool.winding()) return
      endConnect()
      tool.cancel()
    },

    holds(id) {
      return connect?.tool.holds?.(id) ?? false
    },

    cancel() {
      if (connect !== null) releaseCapture(root, connect.id)
      connect?.tool.cancel()
      endConnect()
    },

    key(e) {
      if (connect?.tool.key({ key: e.key })) {
        endConnect()
        return true
      }
      if (connect !== null) return false
      if (rt.editing !== null && !isTypingTarget(e.target) && !inUi(e.target)) {
        // Writing is on but its field has no focus yet (the camera easing in to it): Esc leaves
        // it, and no key meant for the field acts on the board meanwhile.
        if (e.key === 'Escape') {
          rt.stopEditing()
          return true
        }
        return noteKey(e) !== null || historyKey(e) !== null || toolKey(e) !== null || photoKey(e)
      }
      const cmd = inUi(e.target) || rt.pressing ? null : noteKey(e)
      if (cmd === 'duplicate' && rt.selection.size > 0) {
        duplicateSelection(rt.store, rt.selection, rt)
        return true
      }
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return false
      const yarnId = rt.selectedYarnId
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        yarnId !== undefined &&
        !inUi(e.target)
      ) {
        rt.selectYarn(null)
        rt.yarnFlows.untie(yarnId)
        return true
      }
      if (cmd === 'delete' && rt.selection.size > 0) {
        deleteSelection(rt.store, rt.selection)
        return true
      }
      const [selected] = rt.selection
      if (!inUi(e.target) && connectKey(e) && rt.selection.size === 1 && selected !== undefined) {
        openConnect(selected)
        return true
      }
      if (cmd === 'edit' && !e.isComposing && rt.selection.size === 1 && selected !== undefined) {
        rt.startEditing(selected)
        return true
      }
      if (e.key === 'Escape' && (yarnId !== undefined || rt.selection.size > 0)) {
        rt.clearSelection()
        return true
      }
      return false
    },
  }

  const onDoubleClick = (e: MouseEvent) => {
    if (e.button !== 0 || inUi(e.target) || onEditedNote(e.target)) return
    const screen = rt.toViewport(e.clientX, e.clientY)
    if (rt.hitTest(screen).kind !== 'none') return
    const world = screenToWorld(rt.drawnCamera(), screen)
    // The tools' pointer capture makes the root the target of the clicks: find the note by place.
    const noteId = toolTarget(e.target).noteId ?? rt.noteAt(world)
    if (noteId === undefined) return
    // A drag's release can make a double-click; it never starts writing. Overview has no text.
    // The yarn tool presses notes to tie them.
    const tool = prefsStore.getState().tool
    if (tool !== 'select' || rt.panning || rt.pressTravelled || rt.lod === 'overview') return
    e.preventDefault()
    rt.startEditing(noteId, { clientX: e.clientX, clientY: e.clientY })
  }
  const onLeave = () => {
    if (connect === null) setHover(NONE)
    setCard(false)
    rt.setHoverCard(undefined)
  }

  rt.setCaptureStage(stage)
  root.addEventListener('dblclick', onDoubleClick)
  root.addEventListener('pointerleave', onLeave)
  return () => {
    stage.cancel()
    rt.setCaptureStage(null)
    root.removeEventListener('dblclick', onDoubleClick)
    root.removeEventListener('pointerleave', onLeave)
  }
}

function sameTarget(a: Hit, b: Hit): boolean {
  if (a.kind === 'pin' && b.kind === 'pin') {
    return (
      a.noteId === b.noteId &&
      a.edge?.yarnId === b.edge?.yarnId &&
      a.edge?.segIndex === b.edge?.segIndex &&
      a.edge?.end === b.edge?.end
    )
  }
  if (a.kind === 'yarn' && b.kind === 'yarn') return a.yarnId === b.yarnId
  return a.kind === b.kind
}
