import { useMemo } from 'react'
import { exportHref } from '../api/boards'
import type { BoardSession } from '../app/session'
import { useFeed } from '../sync/feed'
import { offerUnsaved } from '../sync/offerUnsaved'
import { Button, DownloadLink } from './controls'
import { ImportBoard } from './ImportBoard'

/**
 * Take the board with you: the canonical JSONL, the `.papertie` archive with photos, and unsent
 * edits; and bring one back (`ImportBoard`).
 */
export function Export({ session }: { session: BoardSession }) {
  const { boardId, sync, feed } = session
  const pending = useFeed(feed, (s) => s.pending)
  const notices = useFeed(feed, (s) => s.notices)
  // Read when the section opens and when what it depends on changes, as the save dot does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of either may change the download
  const unsaved = useMemo(() => sync?.unsavedJsonl() ?? '', [sync, pending, notices])
  return (
    <div className="settings-section">
      <p className="settings-lead">
        Your whole board, any time. The archive holds the board and its photos; the JSONL is the
        board’s text alone.
      </p>
      {boardId !== null && (
        <div className="settings-actions">
          <DownloadLink href={exportHref(boardId, 'papertie')}>Download .papertie</DownloadLink>
          <DownloadLink href={exportHref(boardId, 'jsonl')} tone="quiet">
            Download JSONL
          </DownloadLink>
        </div>
      )}
      {unsaved !== '' && (
        <div className="settings-group">
          <p className="settings-lead">
            Some changes are not saved yet. They are in neither file until they are.
          </p>
          <div className="settings-actions">
            <Button tone="quiet" onClick={() => void offerUnsaved(unsaved, sync?.unsavedParts?.())}>
              Download unsaved changes
            </Button>
          </div>
        </div>
      )}
      <ImportBoard session={session} />
    </div>
  )
}
