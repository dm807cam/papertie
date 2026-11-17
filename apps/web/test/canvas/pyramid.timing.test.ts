// @vitest-environment node
/**
 * The far-zoom picture pyramid: its levels reach the zoom
 * floor 2× apart; a commit re-sends only what changed and redraws exactly the tiles its notes
 * touched, old rect and new, drawing the change over the stale tile until then; what is drawn
 * live is left out of the tiles; and the worker paints a tile as the card overview paints.
 */
import type { Note, PMap } from '@papertie/core'
import { generateBoard } from '@papertie/tools/gen-board'
import { SpatialIndex } from '../../src/canvas/spatialIndex'

// The timed row of pyramid.test.ts (a wall-time bound; the file keeps its untimed proof), in the
// timing project (`vitest.config.ts`).
describe('the index tells the pyramid what changed', () => {
  it('a single-note move on a 100,000-note board reports that note and its threads only', () => {
    const s = generateBoard({ notes: 100_000, yarns: 10_000, seed: 4242 })
    const index = new SpatialIndex()
    index.rebuild(s, new Map())
    expect(index.takeChanges().all).toBe(true)
    expect(index.takeChanges()).toEqual({ all: false, notes: new Set(), segments: new Set() })
    const id = [...s.notes.keys()][0] as string
    const n = s.notes.get(id)
    if (n === undefined) throw new Error('no note')
    const moved = { ...s, notes: (s.notes as PMap<string, Note>).set(id, { ...n, x: n.x + 500 }) }
    const t0 = performance.now()
    index.updateNotes(moved, [id], new Map())
    const changes = index.takeChanges()
    const took = performance.now() - t0
    expect(changes.all).toBe(false)
    expect([...changes.notes]).toEqual([id])
    // Its threads and its neighbours' (their edge pins face it): a handful, never the board's.
    expect(changes.segments.size).toBeGreaterThan(0)
    expect(changes.segments.size).toBeLessThan(200)
    for (const key of changes.segments) expect(index.segment(key)).toBeDefined()
    expect(took).toBeLessThan(20)
  })
})
