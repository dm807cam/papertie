import { describe, expect, it, vi } from 'vitest'
import { yieldTurn } from '../src/store/compact'
import { REGION_INLINE_NOTES, RegionIndex, regionText, TILE } from '../src/store/region'
import { hugeState } from './helpers/boards'

/**
 * A small region answer is built in the request's own turn, under the same CPU time budget as a
 * slice: it never waits behind other jobs' slices for a
 * first turn. One that runs past the budget still gives the loop back.
 */

// 20,000 notes of the grid board: 50 rows of 400, 300 × 260 world px apart.
const state = hugeState('board_inline', 20_000)
const index = RegionIndex.of(state.notes)

/** The rect a first paint reads at reading zoom (1) for a 2560 × 1440 view: one tile around it. */
const readingRect = (x: number, y: number) => ({
  x0: x - TILE,
  y0: y - TILE,
  x1: x + 2560 + TILE,
  y1: y + 1440 + TILE,
})

/**
 * Which of a region answer and another job's next slice comes first. The clock holds still while
 * they run, so no slice is ever due: what is raced is where the answer starts, not how fast this
 * machine builds it (a loaded machine could take past the budget, and yield, honestly).
 */
async function race(ids: readonly string[]): Promise<string[]> {
  const now = performance.now()
  const clock = vi.spyOn(performance, 'now').mockReturnValue(now)
  try {
    const order: string[] = []
    const other = yieldTurn().then(() => order.push('another job'))
    const answer = regionText(state, ids).then(() => order.push('region'))
    await Promise.all([other, answer])
    return order
  } finally {
    clock.mockRestore()
  }
}

describe('a small region answer', () => {
  it('a reading-zoom view of the grid board is small', () => {
    const ids = index.search(readingRect(TILE, TILE))
    expect(ids.length).toBeGreaterThan(1000)
    expect(ids.length).toBeLessThanOrEqual(REGION_INLINE_NOTES)
  })

  it('answers without queuing behind another job', async () => {
    const ids = index.search(readingRect(TILE, TILE))
    expect(await race(ids)).toEqual(['region', 'another job'])
  })

  it('is the same answer the slices give', async () => {
    const small = index.search(readingRect(TILE, TILE))
    const all = index.search({ x0: 0, y0: 0, x1: 400 * 300, y1: 50 * 260 })
    expect(all.length).toBeGreaterThan(REGION_INLINE_NOTES)
    // The large one waits its turn; the text is built the same way either side of the line.
    expect(await race(all)).toEqual(['another job', 'region'])
    const text = await regionText(state, small)
    const whole = await regionText(state, all)
    const lines = new Set(whole.split('\n'))
    for (const l of text.split('\n')) expect(lines.has(l)).toBe(true)
    expect(text.split('\n').filter((l) => l.startsWith('{"type":"note"'))).toHaveLength(
      small.length,
    )
  })

  it('one inline answer a turn: a second small request in the same turn waits its turn', async () => {
    // Several small requests read in one poll phase would each run an inline slice, holding the
    // iteration for one slice each. Only the first starts at once.
    const ids = index.search(readingRect(TILE, TILE))
    const now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now)
    try {
      const order: string[] = []
      const other = yieldTurn().then(() => order.push('another job'))
      const first = regionText(state, ids).then(() => order.push('first'))
      const second = regionText(state, ids).then(() => order.push('second'))
      await Promise.all([other, first, second])
      expect(order).toEqual(['first', 'another job', 'second'])
      // The next turn may answer inline again.
      const later: string[] = []
      const job = yieldTurn().then(() => later.push('another job'))
      const third = regionText(state, ids).then(() => later.push('third'))
      await Promise.all([job, third])
      expect(later).toEqual(['third', 'another job'])
    } finally {
      clock.mockRestore()
    }
  })
})
