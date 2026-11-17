import type { RecoveryInfo } from '../api/boards'

/**
 * The import or restore made last, per board: the store keeps a recovery notice for it, which
 * the page, having asked for it, does not need to be shown again on its next open. Kept as the safety backup's file name the request
 * returned, one per board; storage may be missing or refused, and then nothing is skipped.
 */
const key = (boardId: string) => `papertie.ownRecovery.${boardId}`

export function rememberOwnRecovery(boardId: string, safetyBackup: string): void {
  try {
    localStorage.setItem(key(boardId), safetyBackup)
  } catch {
    // no storage: the notice is shown on the next open
  }
}

/** Whether `info` is the notice of the import or restore the page asked for. */
export function isOwnRecovery(boardId: string, info: RecoveryInfo | null): boolean {
  if (info === null || (info.integrity !== 'imported' && info.integrity !== 'restored'))
    return false
  const file = info.latestBackup?.file
  if (file === undefined) return false
  try {
    return localStorage.getItem(key(boardId)) === file
  } catch {
    return false
  }
}
