import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Picker } from '../search/LazyPicker'
import type { BoardStore } from '../store/boardStore'
import { closeConnect, useConnectFrom } from './connectStore'
import { announceFailure, type YarnFlows } from './yarnFlows'

/** What the yarn layer asks of the canvas. */
export interface YarnTarget {
  readonly yarnFlows: YarnFlows
}

/** `Connect to…` for the note C was pressed on: Enter ties it to the one picked. */
function ConnectPicker({
  runtime,
  store,
  from,
}: {
  runtime: YarnTarget
  store: BoardStore
  from: string
}) {
  const [shown, setShown] = useState(false)
  const returnTo = useRef<HTMLElement | null>(null)
  const exclude = useMemo(() => new Set([from]), [from])

  useLayoutEffect(() => {
    const active = document.activeElement
    returnTo.current = active instanceof HTMLElement ? active : null
    setShown(true)
    return () => {
      const back = returnTo.current
      returnTo.current = null
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  if (!shown) return null
  const pick = (to: string) => {
    closeConnect()
    try {
      runtime.yarnFlows.tie(from, to)
    } catch (err) {
      announceFailure(err)
    }
  }
  return (
    <div className="search-stage">
      <Picker
        store={store}
        title="Connect to…"
        placeholder="Search notes"
        exclude={exclude}
        onPick={pick}
        onClose={closeConnect}
      />
    </div>
  )
}

/**
 * The yarn UI on the board: the picker C opens to tie the selected note to another, in the
 * colour the Yarn tool was last armed with. Mounted in the canvas's UI layer. A selected thread
 * has no UI of its own: the sidebar's selection section offers Delete.
 */
export function YarnLayer({ runtime, store }: { runtime: YarnTarget | null; store: BoardStore }) {
  const from = useConnectFrom()
  // The picker belongs to the note it was opened for: a board without it has nothing to tie.
  useEffect(() => {
    if (from !== null && !store.getState().notes.has(from)) closeConnect()
  }, [from, store])
  useEffect(() => closeConnect, [])

  if (runtime === null || from === null) return null
  return <ConnectPicker runtime={runtime} store={store} from={from} />
}
