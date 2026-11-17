/** Idle work for the page: what can wait for the first paint and the user's first moves. */
interface IdleApi {
  requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

/** Run `fn` once the page is idle (within 2 s); returns the undo. */
export function atIdle(fn: () => void): () => void {
  const g = globalThis as IdleApi
  if (g.requestIdleCallback && g.cancelIdleCallback) {
    const id = g.requestIdleCallback(fn, { timeout: 2000 })
    return () => g.cancelIdleCallback?.(id)
  }
  const t = setTimeout(fn, 200)
  return () => clearTimeout(t)
}
