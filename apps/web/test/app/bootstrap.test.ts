import { OpBatchSchema } from '@papertie/core'
import type { BoardSummary } from '../../src/api/boards'
import { ApiError } from '../../src/api/http'
import { BOARD_KEY, bootstrapBoard, rememberedBoard, WELCOME_TEXT } from '../../src/app/bootstrap'

const NOW = '2026-10-29T09:00:00.000Z'
const now = () => NOW

const summary = (id: string, over: Partial<BoardSummary> = {}): BoardSummary => ({
  id,
  name: 'My board',
  revision: 0,
  createdAt: NOW,
  updatedAt: NOW,
  recovered: false,
  ...over,
})

const ID_A = 'board_01JBX0000000000000000000AA'
const ID_B = 'board_01JBX0000000000000000000BB'

function fakeApi(
  boards: BoardSummary[],
  created: BoardSummary & { created?: boolean } = { ...summary(ID_A), created: true },
) {
  const calls = {
    created: [] as string[],
    first: [] as boolean[],
    posted: [] as [string, unknown][],
  }
  return {
    calls,
    api: {
      listBoards: vi.fn(async () => boards),
      createBoard: vi.fn(async (name: string, first?: boolean) => {
        calls.created.push(name)
        calls.first.push(first === true)
        return created
      }),
      postBatch: vi.fn(async (id: string, body: unknown) => {
        calls.posted.push([id, body])
        return { clientId: 'x', seq: 1, revision: 1, now: NOW, duplicate: false }
      }),
    },
  }
}

beforeEach(() => {
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
    clear: () => kept.clear(),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('bootstrapBoard', () => {
  it('opens the board opened last when it is still there', async () => {
    localStorage.setItem(BOARD_KEY, ID_B)
    const { api, calls } = fakeApi([summary(ID_A), summary(ID_B)])
    expect(await bootstrapBoard(now, api)).toBe(ID_B)
    expect(calls.created).toEqual([])
  })

  it('opens the first board when the one remembered is gone, and remembers it', async () => {
    localStorage.setItem(BOARD_KEY, ID_B)
    const { api } = fakeApi([summary(ID_A)])
    expect(await bootstrapBoard(now, api)).toBe(ID_A)
    expect(rememberedBoard()).toBe(ID_A)
  })

  it('a first run makes My board, with the welcome note pinned at the origin', async () => {
    const { api, calls } = fakeApi([])
    expect(await bootstrapBoard(now, api)).toBe(ID_A)
    expect(calls.created).toEqual(['My board'])
    expect(calls.first).toEqual([true])
    expect(rememberedBoard()).toBe(ID_A)
    const [id, body] = calls.posted[0] as [string, unknown]
    expect(id).toBe(ID_A)
    const batch = OpBatchSchema.parse(body)
    expect(batch).toMatchObject({ seq: 1, baseRevision: 0 })
    expect(batch.ops).toHaveLength(1)
    expect(batch.ops[0]).toMatchObject({
      op: 'note.create',
      note: { x: 0, y: 0, text: WELCOME_TEXT, createdAt: NOW, updatedAt: NOW },
    })
  })

  it('a board another launch made meanwhile is opened as it is: no second welcome note', async () => {
    const { api, calls } = fakeApi([], { ...summary(ID_B), created: false })
    expect(await bootstrapBoard(now, api)).toBe(ID_B)
    expect(calls.posted).toEqual([])
  })

  it('a welcome note that fails to send leaves an empty board, which still opens', async () => {
    const { api } = fakeApi([])
    api.postBatch.mockRejectedValue(new ApiError(503, 'storage'))
    expect(await bootstrapBoard(now, api)).toBe(ID_A)
  })

  it("a board list that fails is the boot's failure", async () => {
    const { api } = fakeApi([])
    api.listBoards.mockRejectedValue(new ApiError(0, 'network'))
    await expect(bootstrapBoard(now, api)).rejects.toMatchObject({ code: 'network' })
  })

  it('remembers nothing that is not a board id', () => {
    localStorage.setItem(BOARD_KEY, 'not a board')
    expect(rememberedBoard()).toBeNull()
  })
})
