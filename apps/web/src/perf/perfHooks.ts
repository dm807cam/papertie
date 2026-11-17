import { type ClientOp, commitBatch, newId } from '@papertie/core'
import { benchHubId } from '@papertie/tools/gen-board'
import { screenToWorld, worldToScreen } from '../canvas/Camera'
import type { CanvasRuntime } from '../canvas/runtime'
import type { Point } from '../canvas/types'
import {
  type GestureKind,
  type GestureOptions,
  RafRecorder,
  runGesture,
  runZoomTo,
} from './benchGestures'
import type { PerfSnapshot } from './frameStats'

/** What one remote commit cost the main thread, ms (`PapertiePerf.remoteCommit`). */
export interface RemoteCommitCost {
  /** From the event to the end of its handling: parse, `commitBatch`, the store swap, React. */
  eventMs: number
  /** The frame that draws it: from its start to after its style, layout and paint. */
  frameMs: number
}

/** The benchmark's handle on the page: `window.__papertiePerf`. */
export interface PapertiePerf {
  /** Start recording rAF intervals (restarting any recording). */
  record(): void
  /** Stop recording and summarise it. */
  stop(): PerfSnapshot
  loopRunning(): boolean
  /** Run a scripted gesture (default 4000 ms after a 500 ms warm-up) and summarise its frames. */
  runGesture(kind: GestureKind, ms?: number, options?: GestureOptions): Promise<PerfSnapshot>
  /** Ctrl-wheel step by step to `zoom` and summarise every frame until it has settled. */
  zoomTo(zoom: number): Promise<PerfSnapshot>
  /** Let go of a gesture run with `hold`; resolves two frames after the pointerup. */
  release(): Promise<void>
  /**
   * Apply `ops` as a commit of the store's own, the way a server session applies an SSE `commit`
   * (`SyncClient`: parse the frame, `commitBatch` onto the board, swap the store's board), and
   * measure it from the event to the end of the frame that draws it.
   */
  remoteCommit(ops: ClientOp[]): Promise<RemoteCommitCost>
}

declare global {
  interface Window {
    __papertiePerf?: PapertiePerf
  }
}

const KINDS: ReadonlySet<string> = new Set<GestureKind>(['pan', 'zoom', 'drag', 'grab'])

const FRACTIONS_Y = [0.75, 0.85, 0.65, 0.55, 0.45]
const FRACTIONS_X = [0.5, 0.35, 0.65, 0.2, 0.8]

/**
 * Overview mounts no notes: a client point on note `id`'s card, as drawn, where the element on
 * top is the board (not the UI) and `noteAt` finds that note.
 */
function cardPressPoint(rt: CanvasRuntime, id: string): { el: HTMLElement; client: Point } | null {
  const r = rt.notesRect([id])
  if (r === null) return null
  const box = rt.els.root.getBoundingClientRect()
  const camera = rt.drawnCamera()
  for (const fy of FRACTIONS_Y) {
    for (const fx of FRACTIONS_X) {
      const s = worldToScreen(camera, { x: r.x + r.w * fx, y: r.y + r.h * fy })
      const client = { x: box.left + s.x, y: box.top + s.y }
      const hitEl = document.elementFromPoint(client.x, client.y)
      if (!(hitEl instanceof HTMLElement) || !rt.els.root.contains(hitEl)) continue
      if (hitEl.closest('.ui') !== null) continue
      if (rt.noteAt(screenToWorld(camera, rt.toViewport(client.x, client.y))) !== id) continue
      return { el: hitEl, client }
    }
  }
  return null
}

/**
 * A client point on note `id`'s paper that a press would hand to the note itself: the note's
 * element is topmost there and no pin or yarn takes it. Searched from the lower middle outwards.
 * In overview, a point on its card.
 */
function pressPoint(rt: CanvasRuntime, id: string): { el: HTMLElement; client: Point } | null {
  if (rt.lod === 'overview') return cardPressPoint(rt, id)
  const el = rt.noteEls.get(id)
  if (el === undefined) return null
  const box = el.getBoundingClientRect()
  for (const fy of FRACTIONS_Y) {
    for (const fx of FRACTIONS_X) {
      const client = { x: box.left + box.width * fx, y: box.top + box.height * fy }
      const hitEl = document.elementFromPoint(client.x, client.y)
      if (!(hitEl instanceof HTMLElement) || hitEl.closest('article[data-note-id]') !== el) continue
      const p = rt.toViewport(client.x, client.y)
      if (rt.hitTest(p).kind !== 'none') continue
      if (rt.noteAt(screenToWorld(rt.drawnCamera(), p)) !== id) continue
      return { el: hitEl, client }
    }
  }
  return null
}

/** Install `window.__papertiePerf` for this runtime; the returned function removes it. */
export function installPerfHooks(rt: CanvasRuntime): () => void {
  const recorder = new RafRecorder()
  let busy = false
  // The hub follows the threads alone: found once per thread map, so a drag's first frame on a
  // 100,000-note board does not walk the board for the bench's sake (`buildMembership`, ~20 ms).
  let hub: { yarns: unknown; id: string } | null = null
  const hubNow = () => {
    const s = rt.store.getState()
    if (hub?.yarns !== s.yarns) hub = { yarns: s.yarns, id: benchHubId(s) }
    return hub.id
  }
  const target = {
    root: rt.els.root,
    zoom: () => rt.camera.get().zoom,
    dragStart: () => pressPoint(rt, hubNow()),
  }
  let held: (() => void) | null = null
  const remoteTab = newId('tab')
  let remoteSeq = 0
  const exclusive = async (run: () => Promise<PerfSnapshot>): Promise<PerfSnapshot> => {
    if (busy) throw new Error('a gesture is already running')
    if (held !== null) throw new Error('a held gesture is not released yet')
    busy = true
    try {
      return await run()
    } finally {
      busy = false
    }
  }
  const perf: PapertiePerf = {
    record: () => recorder.start(),
    stop: () => recorder.stop(),
    loopRunning: () => rt.loop.running,
    async runGesture(kind, ms, options) {
      if (!KINDS.has(kind)) throw new Error(`unknown gesture ${String(kind)}`)
      const onHold = options?.hold
        ? (release: () => void) => {
            held = release
          }
        : undefined
      return exclusive(() => runGesture(target, kind, ms, { ...options, onHold }))
    },
    async zoomTo(zoom) {
      if (!(Number.isFinite(zoom) && zoom > 0)) throw new Error(`unusable zoom ${String(zoom)}`)
      return exclusive(() => runZoomTo(target, zoom))
    },
    async release() {
      const up = held
      held = null
      if (up === null) return
      up()
      // The first frame restyles for the ended pan, the second has painted it.
      for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r))
    },
    async remoteCommit(ops) {
      const board = rt.store.getState().board
      const frame = JSON.stringify({
        revision: board.revision + 1,
        ops,
        now: new Date().toISOString(),
        originClientId: remoteTab,
        seq: ++remoteSeq,
      })
      const t0 = performance.now()
      const e = JSON.parse(frame) as {
        ops: ClientOp[]
        now: string
        originClientId: string
        seq: number
      }
      const next = commitBatch(rt.store.getState(), e.ops, e.now, {
        clientId: e.originClientId,
        seq: e.seq,
      })
      rt.store.replace(next)
      // React renders a store change in a microtask queued before this one.
      await Promise.resolve()
      const eventMs = performance.now() - t0
      // The runtime asked for its frame first, so this callback runs after the runtime's; the
      // message after it runs once the frame's style, layout and paint are done.
      const frameMs = await new Promise<number>((resolve) =>
        requestAnimationFrame((start) => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => resolve(performance.now() - start)
          ch.port2.postMessage(null)
        }),
      )
      return { eventMs, frameMs }
    },
  }
  window.__papertiePerf = perf
  return () => {
    recorder.stop()
    if (window.__papertiePerf === perf) delete window.__papertiePerf
  }
}
