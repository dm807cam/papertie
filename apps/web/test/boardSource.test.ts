import { LIMITS, validateInvariants } from '@papertie/core'
import { FIT_PADDING_PX, fitRect, ZOOM_MIN } from '../src/canvas/Camera'
import { noteBounds } from '../src/canvas/geometry'
import { unionRects } from '../src/canvas/types'
import { resolveBoard } from '../src/dev/boardSource'
import { DEMO_FRAME, demoBoard } from '../src/dev/demoBoard'
import { FAR_IDS, FAR_ORIGIN } from '../src/dev/farBoard'

const NOW = '2026-10-27T00:00:00.000Z'

describe('resolveBoard', () => {
  it('resolves ?board=500', () => {
    const { state, label, frame } = resolveBoard('?board=500', NOW)
    expect([state.notes.size, state.yarns.size]).toEqual([500, 500])
    expect(label).toBe('500')
    expect(frame).toBeUndefined()
  })

  it('resolves ?board=empty: a valid board with no notes, yarns or assets', () => {
    const { state, label, frame } = resolveBoard('?board=empty', NOW)
    expect([state.notes.size, state.yarns.size, state.assets.size]).toEqual([0, 0, 0])
    expect(label).toBe('empty')
    expect(frame).toBeUndefined()
    expect(validateInvariants(state)).toEqual([])
  })

  it.each(['100', '1000'])('resolves ?board=%s', (size) => {
    const { state, label } = resolveBoard(`?board=${size}`, NOW)
    expect(state.notes.size).toBe(Number(size))
    expect(label).toBe(size)
  })

  it('resolves ?board=5000: the wide board, which fit-all shows whole at zoom 0.02 or above', () => {
    const { state, label, frame } = resolveBoard('?board=5000', NOW)
    expect([state.notes.size, state.yarns.size]).toEqual([5000, 5000])
    expect(label).toBe('5000')
    expect(frame).toBeUndefined()
    const all = unionRects([...state.notes.values()].map((n) => noteBounds(n)))
    const vp = { width: 1280, height: 720 }
    const room = Math.min(
      (vp.width - 2 * FIT_PADDING_PX) / (all?.w ?? 1),
      (vp.height - 2 * FIT_PADDING_PX) / (all?.h ?? 1),
    )
    expect(room).toBeGreaterThanOrEqual(ZOOM_MIN)
    expect(room).toBeLessThan(0.025)
    expect(fitRect(all, vp).zoom).toBe(room)
  })

  it('resolves ?board=clusters: 100,000 notes in clusters, which fit-all shows whole', () => {
    const { state, label, frame } = resolveBoard('?board=clusters', NOW)
    expect([state.notes.size, state.yarns.size]).toEqual([100_000, 10_000])
    expect(label).toBe('clusters')
    expect(frame).toBeUndefined()
    const all = unionRects([...state.notes.values()].map((n) => noteBounds(n)))
    const vp = { width: 1200, height: 720 }
    const room = Math.min(
      (vp.width - 2 * FIT_PADDING_PX) / (all?.w ?? 1),
      (vp.height - 2 * FIT_PADDING_PX) / (all?.h ?? 1),
    )
    expect(room).toBeGreaterThanOrEqual(ZOOM_MIN)
    expect(fitRect(all, vp).zoom).toBe(room)
  })

  it('resolves ?board=demo and the other query params around it', () => {
    const { state, label, frame } = resolveBoard('?x=1&board=demo&y=2', NOW)
    expect(state.notes.size).toBe(23)
    expect(label).toBe('demo')
    expect(frame).toEqual(DEMO_FRAME)
  })

  it('resolves ?board=far near the coordinate limit and ?board=far0 at the origin', () => {
    const far = resolveBoard('?board=far', NOW)
    const near = resolveBoard('?board=far0', NOW)
    expect([far.label, near.label]).toEqual(['far', 'far0'])
    expect(far.frame).toBeUndefined()
    for (const { state } of [far, near]) {
      expect(validateInvariants(state)).toEqual([])
      expect([state.notes.size, state.yarns.size]).toEqual([4, 2])
    }
    for (const [id, n] of far.state.notes) {
      const m = near.state.notes.get(id)
      expect([n.x - FAR_ORIGIN.x, n.y - FAR_ORIGIN.y]).toEqual([m?.x, m?.y])
      expect(Math.abs(n.x) < LIMITS.maxCoord && Math.abs(n.y) < LIMITS.maxCoord).toBe(true)
    }
    expect(far.state.notes.get(FAR_IDS.print)?.style).toBe('print')
    expect(far.state.notes.get(FAR_IDS.tag)?.w).toBeLessThanOrEqual(120)
    // A whole number of both cork tiles' world periods at every zoom from 1/4 up.
    expect(FAR_ORIGIN.x % (2048 * 1597)).toBe(0)
  })

  it.each(['', '?', '?board=', '?board=7', '?board=50000', '?board=%E0%A4%A', '?board=DEMO'])(
    'falls back to demo for %j',
    (search) => {
      const { state, label } = resolveBoard(search, NOW)
      expect(label).toBe('demo')
      expect(state).toEqual(demoBoard(NOW))
    },
  )

  it('accepts a search string without the leading question mark', () => {
    expect(resolveBoard('board=100', NOW).label).toBe('100')
  })
})
