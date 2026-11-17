/** The user-facing copy of sync notices. The dropped and rejected lines are the spec's. */

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`

/** Edits not yet saved that no longer apply to the board as it is. */
export const droppedMessage = (n: number): string =>
  `${changes(n)} couldn’t be applied — download them from Settings → Export.`

/** Batches the store refused (422); their ops stay in the unsaved-changes download. */
export const rejectedMessage = (n: number): string =>
  `${changes(n)} couldn’t be saved — download them from Settings → Export.`

/** A `reset`: the store replaced the board (a restore, an import) and it was read again. */
export const resetMessage = (): string => 'Your board was reloaded.'

/**
 * A part of the app this page needs cannot be fetched (a failed fetch the module map keeps):
 * nothing more is sent until a reload.
 */
export const reloadMessage = (): string => 'Papertie needs a reload to keep saving.'

/** A put back of a deleted book past its 30 days: refused (the server purges it then). */
export const tooLateMessage = (): string =>
  'It’s too late to put that book back: it was deleted more than 30 days ago.'
