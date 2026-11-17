import { Suspense, useEffect } from 'react'
import { lazyChunk } from '../app/ChunkBoundary'
import { prefsStore, usePrefs } from '../app/prefs'
import type { CanvasRuntime } from '../canvas/runtime'
import { isTypingTarget } from '../interactions/keys'

/** How often the HUD rewrites its numbers. */
export const HUD_REFRESH_MS = 250

/** The panel, loaded when the HUD is first on (a failed load shows nothing: it is a dev tool). */
const Panel = lazyChunk<{ runtime: CanvasRuntime }>(() =>
  import('./HudPanel').then(
    (m) => m.HudPanel,
    () => () => null,
  ),
)

/** Flip the HUD pref: the backtick key and the Controls button. */
export function toggleHud(): void {
  prefsStore.setState((p) => ({ hud: !p.hud }))
}

const isHudKey = (e: KeyboardEvent) =>
  (e.key === '`' || e.code === 'Backquote') &&
  !(e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target))

/**
 * The perf HUD, toggled by the backtick key or the Controls button. It never re-renders
 * `CanvasView`: the pref is read here, and the numbers bypass React.
 */
export function PerfHud({ runtime }: { runtime: CanvasRuntime | null }) {
  const on = usePrefs((p) => p.hud)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isHudKey(e) || e.repeat) return
      e.preventDefault()
      toggleHud()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return on && runtime !== null ? (
    <Suspense fallback={null}>
      <Panel.Component runtime={runtime} />
    </Suspense>
  ) : null
}
