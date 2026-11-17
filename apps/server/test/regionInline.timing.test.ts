/**
 * A small region answer past its budget still gives the loop back: its longest slice's CPU, a
 * timing row (`regionInline.test.ts` has the rest), run by the timing project a file at a time.
 */
import { describe, expect, it } from 'vitest'
import { longestSliceCpuMs, resetLongestSlice, SLICE_MS, stretchSlices } from '../src/store/compact'
import { RegionIndex, regionText, TILE } from '../src/store/region'
import { hugeState } from './helpers/boards'

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

describe('a small region answer', () => {
  it('still gives the loop back once it passes the budget', async () => {
    const ids = index.search(readingRect(TILE, TILE))
    // On a CPU 20× slower the inline answer runs past its budget, and yields.
    stretchSlices(20)
    resetLongestSlice()
    try {
      await regionText(state, ids)
    } finally {
      stretchSlices(1)
    }
    expect(longestSliceCpuMs()).toBeLessThanOrEqual(4 * SLICE_MS)
  })
})
