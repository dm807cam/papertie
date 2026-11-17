import { Suspense, useEffect, useState } from 'react'
import { boardMeta, type RecoveryInfo } from '../api/boards'
import { ChunkBoundary, lazyChunk } from '../app/ChunkBoundary'
import type { BoardSession } from '../app/session'
import { isOwnRecovery } from './ownRecovery'
import '../sync/sync.css'

/** The slip's chunk: loaded only when there is a recovery to say. */
const Slip = lazyChunk(() => import('./RecoverySlip').then((m) => m.RecoverySlip))

/**
 * Said once the server has repaired a damaged board, put a backup back, or found a restore cut
 * short (the board as it was, no backup offered): a calm paper slip at the foot, stacked with the
 * notice slips (`SyncNotices`), not a bar, that stays until it is dismissed. An import or restore
 * this page asked for brings none (`SyncFeed.ownReset`): the sheet that asked has said it. It can
 * set the board's counts beside the latest backup's, and restore that backup (the board as it
 * stands is saved first). The server's word is `meta.recovery`; it is asked for when a board opens
 * that was recovered and after every `reset` (a restore, an import), so the slip follows the
 * server. This watch is in the board's own chunk; the slip it shows (`RecoverySlip.tsx`) is a
 * chunk of its own, never part of the Settings chunk.
 */
export function RecoveryNotice({
  session,
  hidden = false,
}: {
  session: BoardSession
  /** A full-screen sheet is over the board (narrow): the slip waits, its state kept. */
  hidden?: boolean
}) {
  const { boardId, feed } = session
  const [info, setInfo] = useState<RecoveryInfo | null>(null)
  /** Bumped by each word of the server: the slip starts over with it. */
  const [said, setSaid] = useState(0)

  useEffect(() => {
    if (boardId === null) return
    let live = true
    // A server reset's slip waits for the check: when this slip says the change (a board replaced
    // or restored), the reload needs no slip of its own.
    const offHold = feed.watchResets()
    const check = (held?: number) =>
      boardMeta(boardId).then(
        (m) => {
          if (!live) return
          // The import or restore asked for here is said where it was asked, not here.
          const shown = isOwnRecovery(boardId, m.recovery) ? null : m.recovery
          setInfo(shown)
          setSaid((n) => n + 1)
          if (held !== undefined) feed.releaseReset(held, shown !== null)
        },
        () => {
          // not worth a notice of its own (the next load asks again); the reset's slip shows
          if (held !== undefined) feed.releaseReset(held, false)
        },
      )
    // Whether the board was recovered is known once it has opened whole.
    session.opening.done.then(
      () => {
        if (live && session.recovered) void check()
      },
      () => {},
    )
    let last = 0
    const off = feed.subscribe((s) => {
      const n = s.notices.find((x) => x.kind === 'reset')
      const id = n?.id ?? 0
      if (id === 0 || id === last) return
      last = id
      void check(n?.held ? id : undefined)
    })
    return () => {
      live = false
      off()
      offHold()
    }
  }, [boardId, feed, session])

  if (boardId === null) return null
  return (
    // Read out by the notices' live region it is stacked in (SyncNotices).
    <section className="recovery" aria-label="Board recovery" hidden={hidden}>
      {info && (
        <ChunkBoundary>
          <Suspense fallback={null}>
            <Slip.Component
              key={said}
              session={session}
              info={info}
              onClear={() => setInfo(null)}
            />
          </Suspense>
        </ChunkBoundary>
      )}
    </section>
  )
}
