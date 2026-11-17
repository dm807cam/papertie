import { useSyncExternalStore } from 'react'

/** Below this width the sidebar gives way to the mini-bar. */
export const NARROW_QUERY = '(max-width: 767px)'

const query = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null

function subscribe(onChange: () => void): () => void {
  const mq = query()
  mq?.addEventListener('change', onChange)
  return () => mq?.removeEventListener('change', onChange)
}

/** Whether the viewport is under 768 px wide, following the window as it resizes. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false)
}
