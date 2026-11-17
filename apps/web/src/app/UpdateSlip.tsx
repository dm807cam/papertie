import { useEffect, useRef } from 'react'
import { announce } from './liveRegion'
import { useSlipOnPane } from './slipPlace'
import { downloadUpdate, laterUpdate, updateCopy, useUpdate } from './updates'
import '../sync/sync.css'

/**
 * A newer Papertie exists (desktop app): a quiet slip in the notices' paper, at the foot, with
 * "Download" (the release page, in the system browser) and "Later" (not said again for this
 * version). It takes no focus and is read out politely, once. It never lies on the writer's text:
 * beside an open book it stands on the board's pane, and while a book fills the window it waits
 * for the board or the shelf, unless the person asked for the check themselves (the menu).
 */
export function UpdateSlip({
  writing,
  waiting,
}: {
  /** An open book: `full` fills the window, `split` has the board beside it. */
  writing: 'full' | 'split' | null
  /** Another slip stands here (the page waits for a reload): this one waits. */
  waiting: boolean
}) {
  const update = useUpdate()
  const shown = update !== null && !waiting && (writing !== 'full' || update.manual)
  const version = update?.version ?? null
  useEffect(() => {
    if (shown && version !== null) announce(updateCopy(version))
  }, [shown, version])
  const slip = useRef<HTMLElement>(null)
  useSlipOnPane(slip, shown, writing === 'split' ? 'board' : undefined)
  if (!shown || update === null) return null
  return (
    <section ref={slip} className="sync-updated" aria-label="Updates">
      <div className="sync-slip sync-paper" role="note" data-kind="update">
        <p className="sync-slip-text">{updateCopy(update.version)}</p>
        <button type="button" className="sync-text-button" onClick={downloadUpdate}>
          Download
        </button>
        <button type="button" className="sync-text-button" onClick={laterUpdate}>
          Later
        </button>
      </div>
    </section>
  )
}
