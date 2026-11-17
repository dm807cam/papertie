import { localBoardFor } from '../src/app/boardSource'
import { DEMO_FRAME, demoBoard } from '../src/dev/demoBoard'

const NOW = '2026-10-27T00:00:00.000Z'

describe('localBoardFor', () => {
  it('wraps resolveBoard as a local source', () => {
    const src = localBoardFor('500', NOW)
    expect(src.kind).toBe('local')
    expect(src.label).toBe('500')
    expect([src.state.notes.size, src.state.yarns.size]).toEqual([500, 500])
    expect(src.frame).toBeUndefined()
  })

  it('falls back to the demo board with its frame', () => {
    const src = localBoardFor('nonsense', NOW)
    expect(src.label).toBe('demo')
    expect(src.state).toEqual(demoBoard(NOW))
    expect(src.frame).toEqual(DEMO_FRAME)
  })

  it('treats a board name as a value, not a query', () => {
    expect(localBoardFor('x&board=500', NOW).label).toBe('demo')
  })
})
