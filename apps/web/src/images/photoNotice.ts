import { announce } from '../app/liveRegion'
import type { BoardSession } from '../app/session'

/**
 * What the board's photo intake (`ImageDrop`, always loaded) and the upload code (`upload.ts`, a
 * chunk of its own) both say and use.
 */

/** Each further photo of a drop sits this far down and right of the one before. */
export const STAGGER = 28

/** Said of a photo that did not get onto the board. */
export const couldNotAdd = (name: string) => `Couldn’t add ${name} to the board.`

/** Says `message` calmly: a slip on a server board (the notices there), and to screen readers. */
export function tell(session: BoardSession, message: string): void {
  announce(message)
  session.feed.notice({ kind: 'reset', count: 0, message })
}
