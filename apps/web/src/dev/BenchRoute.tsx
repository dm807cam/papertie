import { useEffect, useState } from 'react'
import { localBoardFor } from '../app/boardSource'
import { openLocalSession } from '../app/session'
import { CanvasView } from '../canvas/CanvasView'

/** `/bench?board=`: a local dev board, resolved once per mount. Loaded lazily, dev builds only. */
export function BenchRoute({ board }: { board: string }) {
  const [src] = useState(() => localBoardFor(board, new Date().toISOString()))
  const [session] = useState(() => openLocalSession(src))
  useEffect(() => () => session.dispose(), [session])
  return <CanvasView session={session} label={src.label} frame={src.frame} />
}
