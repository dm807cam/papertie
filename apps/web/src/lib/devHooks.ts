import type { CanvasRuntime } from '../canvas/runtime'
import type { BoardStore } from '../store/boardStore'

/** Test and benchmark hooks exposed on `window.__papertie`; later tasks add fields. */
export interface PapertieDevHooks {
  /** True once the page is usable: after the canvas's first applied frame, or the study mount. */
  ready: boolean
  /** Why `ready` will not come, when it will not (the bench's perf hooks failed to load). */
  notReady?: string
  /** Render counts by component, e.g. `canvasView`. */
  renders: Record<string, number>
  debug: Record<string, unknown>
  store?: BoardStore
  runtime?: CanvasRuntime
  [k: string]: unknown
}

declare global {
  interface Window {
    __papertie?: PapertieDevHooks
  }
}

/** Installs `window.__papertie` in dev builds or when the URL has a `bench` query param. */
export function devHooks(): PapertieDevHooks | undefined {
  if (typeof window === 'undefined') return undefined
  if (!window.__papertie) {
    const enabled = import.meta.env.DEV || new URLSearchParams(location.search).has('bench')
    if (!enabled) return undefined
    window.__papertie = { ready: false, renders: {}, debug: {} }
  }
  return window.__papertie
}
