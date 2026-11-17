import { type Asset, emptyBoardState, newId } from '@papertie/core'
import { type BoardSession, openLocalSession } from '../../src/app/session'
import { photoSpaceFor } from '../../src/images/space'
import type { ImageDeps } from '../../src/images/upload'
import { BOARD_ID, T0 } from './fakeServer'

/** A server-board session on a local store: commits apply at once, as a server's view does. */
export function session(): BoardSession {
  const local = openLocalSession({
    kind: 'local',
    state: emptyBoardState(BOARD_ID, 'test', T0),
    label: 'test',
  })
  return { ...local, boardId: BOARD_ID }
}

export const file = (name: string, type = 'image/jpeg', size = 1000) => {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const SIZES: Record<string, [number, number]> = { 'a.jpg': [4000, 3000], 'b.jpg': [3000, 4000] }

export interface Harness {
  deps: Partial<ImageDeps>
  uploads: string[]
  revoked: string[]
  /** Every blob URL made. */
  created: string[]
  /** Settle the nth call of `upload` (0-based). */
  fail(error: unknown): void
}

/** Fake browser parts; `upload` answers by `behave`, and puts the asset on the board as the server's event does. */
export function harness(
  s: BoardSession,
  behave: (n: number, f: Blob, o: { signal?: AbortSignal }) => Promise<void> = async () => {},
): Harness {
  const uploads: string[] = []
  const revoked: string[] = []
  const created: string[] = []
  let urls = 0
  const h: Harness = {
    uploads,
    revoked,
    created,
    fail: () => {},
    deps: {
      upload: async (_board, f, o) => {
        const n = uploads.length
        uploads.push((f as File).name)
        await behave(n, f, o ?? {})
        const asset: Asset = {
          type: 'asset',
          id: newId('asset'),
          mime: 'image/webp',
          width: 400,
          height: 300,
          bytes: 10,
          sha256: '0'.repeat(64),
          createdAt: T0,
        }
        const state = s.store.getState()
        s.store.replace({ ...state, assets: new Map(state.assets).set(asset.id, asset) })
        return { asset, revision: 1 }
      },
      heic: async (f) =>
        new File(['j'], f.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' }),
      measure: async (b) => {
        const [width, height] = SIZES[(b as File).name] ?? [800, 600]
        return { width, height }
      },
      createUrl: () => {
        const u = `blob:fake/${++urls}`
        created.push(u)
        return u
      },
      revokeUrl: (u) => void revoked.push(u),
      warm: async () => {},
      sleep: async () => {},
      releaseAfterMs: 0,
      assetWaitMs: 50,
    },
  }
  return h
}

/** The pending photos of `session`. */
export const pendingOf = (session: BoardSession) => photoSpaceFor(session).pending
