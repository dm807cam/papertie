import { emptyBoardState } from '@papertie/core'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import type { SyncClient } from '../../src/sync/SyncClient'

export const BOARD_ID = 'board_01JBX0000000000000000000AA'
export const USER = { userId: 'user_a' }
const NOW = '2026-10-30T09:00:00.000Z'

/** The sync client's parts Settings uses; each can be replaced per test. */
export interface FakeSync {
  unsavedJsonl: () => string
  pending: number
  flush: () => Promise<void>
  saved: () => Promise<void>
  forget: () => unknown
}

/** A server session's shape on a local board, its client a stand-in with only what Settings asks. */
export function fakeSession(over: { recovered?: boolean; sync?: Partial<FakeSync> | null } = {}): {
  session: BoardSession
  sync: FakeSync | null
  dispose: ReturnType<typeof vi.fn>
} {
  const local = openLocalSession({
    kind: 'local',
    state: emptyBoardState(BOARD_ID, 'My board', NOW),
    label: 'test',
  })
  const sync: FakeSync | null =
    over.sync === null
      ? null
      : {
          unsavedJsonl: () => '',
          pending: 0,
          flush: async () => {},
          saved: async () => {},
          forget: vi.fn(),
          ...over.sync,
        }
  const dispose = vi.fn()
  const session: BoardSession = {
    ...local,
    sync: sync as unknown as SyncClient | null,
    boardId: BOARD_ID,
    recovered: over.recovered ?? false,
    dispose,
  }
  return { session, sync, dispose }
}
