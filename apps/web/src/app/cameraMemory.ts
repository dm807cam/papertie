import { type Camera, clampZoom, zoomAt } from '../canvas/Camera'
import type { Size } from '../canvas/types'

/** How long the camera must rest before it is saved. */
export const CAMERA_SAVE_MS = 500

export const cameraKey = (boardId: string): string => `papertie.camera.${boardId}`

type CameraStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface CameraMemory {
  /** Save `cam` for `boardId` once the camera has rested for `CAMERA_SAVE_MS`. */
  remember(boardId: string, cam: Camera): void
  /**
   * The saved camera of `boardId`, or null (nothing saved, or what is saved is unusable). A zoom
   * out of range (left at 4× before the closest zoom became 2×) comes back clamped, about the
   * centre of `viewport` when it is given, so the note that was being read stays in the middle.
   */
  recall(boardId: string, viewport?: Size): Camera | null
  /** Save whatever is waiting now (the board closes, the page goes). */
  flush(): void
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

function parse(raw: string | null, viewport: Size | undefined): Camera | null {
  if (raw === null) return null
  try {
    const c: unknown = JSON.parse(raw)
    if (c === null || typeof c !== 'object') return null
    const { x, y, zoom } = c as Record<string, unknown>
    if (!(finite(x) && finite(y) && finite(zoom)) || zoom <= 0) return null
    if (clampZoom(zoom) === zoom || viewport === undefined) return { x, y, zoom: clampZoom(zoom) }
    return zoomAt({ x, y, zoom }, { x: viewport.width / 2, y: viewport.height / 2 }, zoom)
  } catch {
    return null
  }
}

/**
 * Where each board's camera was left, kept by the app in `storage` (never in the board file). The
 * canvas calls `remember` from the camera's apply hook, outside React: each call only restarts a
 * timer, and the write happens once the camera has rested.
 */
export function createCameraMemory(storage: CameraStorage | undefined): CameraMemory {
  const waiting = new Map<string, { cam: Camera; timer: ReturnType<typeof setTimeout> }>()

  const write = (boardId: string, cam: Camera) => {
    try {
      storage?.setItem(cameraKey(boardId), JSON.stringify(cam))
    } catch {
      // Storage full or blocked: the camera is not remembered, nothing more.
    }
  }

  return {
    remember(boardId, cam) {
      const prev = waiting.get(boardId)
      if (prev) clearTimeout(prev.timer)
      const timer = setTimeout(() => {
        waiting.delete(boardId)
        write(boardId, cam)
      }, CAMERA_SAVE_MS)
      waiting.set(boardId, { cam, timer })
    },
    recall(boardId, viewport) {
      // A camera still waiting to be saved is newer than the stored one.
      const pending = waiting.get(boardId)
      if (pending) return pending.cam
      try {
        return parse(storage?.getItem(cameraKey(boardId)) ?? null, viewport)
      } catch {
        return null
      }
    },
    flush() {
      for (const [boardId, { cam, timer }] of waiting) {
        clearTimeout(timer)
        write(boardId, cam)
      }
      waiting.clear()
    },
  }
}

function browserStorage(): CameraStorage | undefined {
  try {
    // `window.`: bare `localStorage` warns in Node, where there is none.
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

const memory = createCameraMemory(browserStorage())

export const rememberCamera = memory.remember
export const recallCamera = memory.recall
export const flushCameraMemory = memory.flush
