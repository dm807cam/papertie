import { useId, useState } from 'react'
import { DELETE_ALL_WORD, deleteAllData } from '../api/data'
import type { BoardSession } from '../app/session'
import { Button, Message, TextField } from './controls'
import { leaveDevice } from './leave'

/** As the server compares it: trimmed, in any case. The text sent is exactly what was typed. */
const isTheWord = (typed: string): boolean => typed.trim().toLowerCase() === DELETE_ALL_WORD

/**
 * The Data section: "Delete all data", behind a typed confirmation. Done, the page lets go of
 * what it held and opens afresh on the one empty board left.
 */
export function DataSettings({ session }: { session: BoardSession }) {
  const id = useId()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')
  const [failed, setFailed] = useState(false)
  const ready = !busy && isTheWord(typed)

  const close = () => {
    setAsking(false)
    setTyped('')
    setFailed(false)
  }

  const run = async () => {
    setBusy(true)
    setFailed(false)
    try {
      await deleteAllData(typed)
    } catch {
      setBusy(false)
      setFailed(true)
      return
    }
    leaveDevice(session)
  }

  return (
    <div className="settings-section">
      <div className="settings-group settings-danger">
        <h2 className="settings-subhead">Delete all data</h2>
        {!asking ? (
          <Button tone="quiet" onClick={() => setAsking(true)}>
            Delete all data…
          </Button>
        ) : (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (ready) void run()
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
              e.preventDefault()
              close()
            }}
            aria-describedby={`${id}-warn`}
          >
            <p className="settings-warn" id={`${id}-warn`}>
              This deletes your board, photos, books and backups on this computer for good. Papertie
              starts again with an empty board. Export first to keep a copy.
            </p>
            <TextField
              label={`Type ${DELETE_ALL_WORD} to confirm`}
              type="text"
              value={typed}
              onChange={setTyped}
              autoComplete="off"
            />
            <Message tone="error">
              {failed ? 'Nothing was deleted. Try again in a moment.' : null}
            </Message>
            <div className="settings-actions">
              <Button tone="quiet" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" tone="danger" disabled={!ready} aria-busy={busy || undefined}>
                Delete all data
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
