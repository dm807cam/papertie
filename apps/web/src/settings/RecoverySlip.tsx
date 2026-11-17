import { useState } from 'react'
import { dismissRecovery, type RecoveryInfo, restoreBackup } from '../api/boards'
import { failureText } from '../api/failure'
import type { BoardSession } from '../app/session'
import { backupTime, formatTime, IMPORTED, RESTORED_SLIP, restoreQuestion } from './format'
import { rememberOwnRecovery } from './ownRecovery'
import './recovery.css'

export const REPAIRED_COPY = 'Papertie repaired your board after a problem saving it.'
export const RESTORED_COPY = 'This board was restored from a backup.'
export const INTERRUPTED_COPY = 'A restore did not finish. Your board is as it was.'
export const IMPORTED_COPY = IMPORTED
export const IMPORT_INTERRUPTED_COPY = 'An import did not finish. Your board is as it was.'

const COPY: Record<string, string> = {
  restored: RESTORED_COPY,
  'restore-interrupted': INTERRUPTED_COPY,
  imported: IMPORTED_COPY,
  'import-interrupted': IMPORT_INTERRUPTED_COPY,
}

/** What the slip says for the server's kind of recovery. */
const copyOf = (integrity: string) => COPY[integrity] ?? REPAIRED_COPY

type Step = 'idle' | 'compare' | 'ask'

/**
 * The recovery slip itself (`RecoveryNotice.tsx` says when): what the server did, the counts
 * beside the latest backup's, its restore, and the dismissal. A chunk of its own, loaded only
 * when there is a recovery to say (the budget), so most boards never fetch it.
 * Mounted afresh for each word of the server (`key`), so it starts at its first step.
 */
export function RecoverySlip({
  session,
  info,
  onClear,
}: {
  session: BoardSession
  info: RecoveryInfo
  /** Dismissed, or restored: the slip goes. */
  onClear(): void
}) {
  const { boardId, feed, store } = session
  const [step, setStep] = useState<Step>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (boardId === null) return null
  const backup = info.latestBackup ?? null

  const dismiss = async () => {
    setBusy(true)
    setError(null)
    try {
      await dismissRecovery(boardId)
      onClear()
    } catch (e) {
      setError(failureText(e))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!backup) return
    setBusy(true)
    setError(null)
    const own = feed.ownReset()
    try {
      const done = await restoreBackup(boardId, backup.file).catch((e: unknown) => {
        own.failed()
        throw e
      })
      own.done(done.revision)
      // Asked for here, so not shown here again; and said, as this slip goes.
      rememberOwnRecovery(boardId, done.safetyBackup)
      feed.notice({ kind: 'reset', count: 0, message: RESTORED_SLIP })
      // The store tells the page to reset; the slip then follows what it says of the restore.
      onClear()
    } catch (e) {
      setError(failureText(e))
    } finally {
      setBusy(false)
    }
  }

  const when = backup ? backupTime(backup.file) : null
  const now = step === 'compare' ? store.getState() : null
  return (
    <div className="recovery-slip sync-paper" role="note" data-integrity={info.integrity}>
      <p className="recovery-text">{copyOf(info.integrity)}</p>
      {step === 'compare' && backup && now && (
        <table className="recovery-counts">
          <caption className="recovery-caption">Counts, side by side</caption>
          <thead>
            <tr>
              <td />
              <th scope="col">Now</th>
              <th scope="col">Latest backup</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Notes</th>
              <td>{now.notes.size}</td>
              <td>{backup.notes}</td>
            </tr>
            <tr>
              <th scope="row">Threads</th>
              <td>{now.yarns.size}</td>
              <td>{backup.yarns}</td>
            </tr>
          </tbody>
        </table>
      )}
      {step === 'ask' && backup && (
        <p className="recovery-text recovery-ask">
          {when
            ? restoreQuestion(formatTime(when))
            : 'Replace the board with the latest backup? Your current board is saved first, so you can come back to it.'}
        </p>
      )}
      <p className="recovery-error" aria-live="polite">
        {error}
      </p>
      <div className="recovery-actions">
        {step === 'ask' ? (
          <>
            <button type="button" className="sync-text-button" disabled={busy} onClick={restore}>
              Restore this version
            </button>
            <button type="button" className="sync-text-button" onClick={() => setStep('idle')}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {backup && (
              <button
                type="button"
                className="sync-text-button"
                aria-expanded={step === 'compare'}
                onClick={() => setStep(step === 'compare' ? 'idle' : 'compare')}
              >
                Compare with latest backup
              </button>
            )}
            {backup && (
              <button
                type="button"
                className="sync-text-button"
                disabled={busy}
                onClick={() => setStep('ask')}
              >
                Restore that backup
              </button>
            )}
          </>
        )}
      </div>
      {/* Dismissed from its corner, as the other notices are: the actions keep their row.
              Not while the restore question is open: Cancel is that question's way back. */}
      {step !== 'ask' && (
        <button
          type="button"
          className="sync-slip-close"
          aria-label="Dismiss"
          disabled={busy}
          onClick={dismiss}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      )}
    </div>
  )
}
