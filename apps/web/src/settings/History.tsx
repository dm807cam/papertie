import { useCallback, useEffect, useRef, useState } from 'react'
import { type BackupRow, listBackups, restoreBackup } from '../api/boards'
import { failureText } from '../api/failure'
import type { BoardSession } from '../app/session'
import { Ask, Button, Message } from './controls'
import {
  backupTime,
  countsLine,
  formatTime,
  RESTORE_FAILED_SLIP,
  RESTORED_SLIP,
  restoreQuestion,
  UNDO_FAILED_SLIP,
  UNDONE_SLIP,
} from './format'
import { rememberOwnRecovery } from './ownRecovery'

type Load = { kind: 'loading' } | { kind: 'ready'; rows: BackupRow[] } | { kind: 'failed' }

/** The server's file name for the board as it was just before the restore, as a time. */
const safetyTime = (file: string): string | null => {
  const t = backupTime(file)
  return t === null ? null : formatTime(t)
}

/**
 * The board's backups, newest first. A restore is asked about first, then done; the board
 * reloads by itself (the store tells the page to `reset`), and the line that follows
 * names the backup of the board it replaced, which can be restored the same way.
 */
export function History({ session }: { session: BoardSession }) {
  const { boardId, feed } = session
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [asking, setAsking] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{
    tone: 'error' | 'notice'
    text: string
    /** The backup of the board a restore replaced: what "Undo restore" brings back. */
    undo?: string
  } | null>(null)
  // A restore keeps going if Settings closes meanwhile; then the board says it, on a slip.
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the load
  useEffect(() => {
    if (boardId === null) return
    let live = true
    listBackups(boardId).then(
      (rows) =>
        live &&
        setLoad({
          kind: 'ready',
          // Newest first, whatever order they came in.
          rows: [...rows].sort((a, b) => b.takenAt.localeCompare(a.takenAt)),
        }),
      () => live && setLoad((l) => (l.kind === 'ready' ? l : { kind: 'failed' })),
    )
    return () => {
      live = false
    }
  }, [boardId, attempt])

  /**
   * Put the backup `backupId` back. A restore is asked about first (`asking`); the undo of one is not: it only
   * brings back the board the restore saved, and saves the board it replaces in turn.
   */
  const restore = useCallback(
    async (backupId: string, undoing = false) => {
      if (boardId === null) return
      setBusy(true)
      setNote(null)
      // Said here: the reset the server sends for it brings no slip of its own.
      const own = feed.ownReset()
      try {
        const done = await restoreBackup(boardId, backupId).catch((e: unknown) => {
          own.failed()
          throw e
        })
        own.done(done.revision)
        // Asked for here: its recovery notice is not shown again.
        rememberOwnRecovery(boardId, done.safetyBackup)
        if (!live.current) {
          // Settings closed meanwhile: the board says it, quietly, on a slip.
          feed.notice({ kind: 'reset', count: 0, message: undoing ? UNDONE_SLIP : RESTORED_SLIP })
          return
        }
        const when = safetyTime(done.safetyBackup)
        setNote(
          undoing
            ? {
                tone: 'notice',
                text: 'Undone. The board is back as it was before the restore; the version it replaced is kept in this list.',
              }
            : {
                tone: 'notice',
                text: `Restored. The board as it was ${when ? `at ${when}` : 'a moment ago'} is kept in this list, in case you want it back.`,
                undo: done.safetyBackup,
              },
        )
        setAttempt((n) => n + 1) // the safety backup joins the list
      } catch (e) {
        if (!live.current) {
          // Settings closed meanwhile: the board says it, quietly, on a slip.
          const message = undoing ? UNDO_FAILED_SLIP : RESTORE_FAILED_SLIP
          feed.notice({ kind: 'reset', count: 0, message })
          return
        }
        setNote({ tone: 'error', text: failureText(e) })
      } finally {
        if (live.current) {
          setAsking(null)
          setBusy(false)
        }
      }
    },
    [boardId, feed],
  )

  if (boardId === null) return null
  if (load.kind === 'loading') return <p className="settings-lead">Looking up your backups…</p>
  if (load.kind === 'failed')
    return (
      <div className="settings-section">
        <p className="settings-lead">Couldn’t load your backups.</p>
        <div className="settings-actions">
          <Button
            tone="quiet"
            onClick={() => {
              setLoad({ kind: 'loading' })
              setAttempt((n) => n + 1)
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    )
  return (
    <div className="settings-section">
      <p className="settings-lead">
        Papertie keeps copies of your board as you work. Restoring one saves the current board
        first.
      </p>
      <Message tone={note?.tone}>{note?.text}</Message>
      {note?.undo !== undefined && (
        <div className="settings-actions">
          <Button
            tone="quiet"
            disabled={busy}
            onClick={() => note.undo !== undefined && restore(note.undo, true)}
          >
            Undo restore
          </Button>
        </div>
      )}
      {load.rows.length === 0 ? (
        <p className="settings-lead">No backups yet. The first one is taken as you work.</p>
      ) : (
        <ul className="settings-rows" aria-label="Backups">
          {load.rows.map((row) => {
            const time = formatTime(row.takenAt)
            return (
              <li
                className="settings-row"
                key={row.id}
                data-asking={asking === row.id || undefined}
              >
                <div className="settings-row-body">
                  <p className="settings-row-title" id={`backup-${row.id}`}>
                    {time}
                  </p>
                  <p className="settings-row-line">
                    {countsLine(row.notes, row.yarns, row.books, row.words)}
                  </p>
                  {row.damaged && (
                    <p className="settings-row-line settings-damaged">
                      Damaged — some lines will be set aside
                    </p>
                  )}
                  {asking === row.id && (
                    <Ask
                      onCancel={() => setAsking(null)}
                      buttons={
                        <>
                          <Button tone="quiet" onClick={() => setAsking(null)}>
                            Cancel
                          </Button>
                          <Button disabled={busy} onClick={() => restore(row.id)}>
                            Restore this version
                          </Button>
                        </>
                      }
                    >
                      {restoreQuestion(time)}
                    </Ask>
                  )}
                </div>
                {asking !== row.id && (
                  <Button
                    tone="quiet"
                    disabled={busy || row.notes < 0}
                    aria-describedby={`backup-${row.id}`}
                    onClick={() => {
                      setNote(null)
                      setAsking(row.id)
                    }}
                  >
                    Restore
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
