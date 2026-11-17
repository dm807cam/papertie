import { loadPage } from '../app/router'
import { forgetScreens } from '../app/screenMemory'
import type { BoardSession } from '../app/session'
import { forgetTopZ } from '../notes/noteCommands'

/**
 * Let go of what this page holds of the data once it has been deleted ("Delete all data"): stop
 * the client, forget the screens and places remembered, and load the page afresh at the board,
 * the empty one that is left.
 */
export function leaveDevice(session: BoardSession): void {
  forgetScreens()
  forgetTopZ()
  session.dispose()
  loadPage('/')
}
