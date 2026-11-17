/**
 * The upload's wall-time row (`assets.test.ts` keeps its untimed proof: 422, nothing left): the
 * timing project runs it, a file at a time (`vitest.config.ts`).
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard } from './helpers/boards'
import type { TestUser } from './helpers/client'
import { startTestServer, type TestServer } from './helpers/harness'
import { pngHeaderBomb } from './helpers/images'

let server: TestServer
let user: TestUser
let board: string

async function start(config: Parameters<typeof startTestServer>[0] = {}) {
  server = await startTestServer(config)
  user = server.user
  board = await createBoard(user)
}
beforeEach(() => start())
afterEach(() => server.close())

/** Multipart upload of `bytes`; `name` and `type` are what a browser would claim. */
function upload(
  who: TestUser,
  boardId: string,
  bytes: Uint8Array,
  claim: { name?: string; type?: string } = {},
) {
  const form = new FormData()
  form.append(
    'file',
    new File([new Uint8Array(bytes)], claim.name ?? 'photo.png', {
      type: claim.type ?? 'image/png',
    }),
  )
  return who.request(`/api/boards/${boardId}/assets`, { method: 'POST', body: form })
}

const assetsRoot = (who = user, boardId = board) =>
  join(server.dataDir, 'users', who.id, 'boards', boardId, 'assets')
const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : [])

describe('upload: rejected input', () => {
  const rejected = async (bytes: Uint8Array, claim?: { name?: string; type?: string }) => {
    const res = await upload(user, board, bytes, claim)
    expect(leftovers(assetsRoot())).toEqual([])
    return res
  }

  it('a PNG header declaring 50000x50000 is 422 undecodable-image, fast, leaving nothing', async () => {
    const t0 = performance.now()
    const res = await rejected(pngHeaderBomb(50_000, 50_000))
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'undecodable-image' })
  })
})
