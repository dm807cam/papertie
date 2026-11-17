import type { Note } from '@papertie/core'
import { TransientOverrides } from '../src/canvas/transient'
import { DEMO_IDS, demoBoard } from '../src/dev/demoBoard'

const NOW = '2026-10-27T00:00:00.000Z'
const hub = demoBoard(NOW).notes.get(DEMO_IDS.hub) as Note

describe('TransientOverrides', () => {
  it('effective() applies an override; clear() resets and bumps version', () => {
    const o = new TransientOverrides()
    expect(o.effective(hub)).toBe(hub)
    const v0 = o.version
    o.set(hub.id, { x: 5, y: 7, z: 99 })
    expect(o.version).toBeGreaterThan(v0)
    expect(o.effective(hub)).toEqual({ ...hub, x: 5, y: 7, z: 99 })
    expect(o.get(hub.id)).toEqual({ x: 5, y: 7, z: 99 })
    expect(o.ids()).toEqual([hub.id])
    expect(o.size).toBe(1)
    const v1 = o.version
    o.clear()
    expect(o.version).toBeGreaterThan(v1)
    expect(o.effective(hub)).toBe(hub)
    expect(o.ids()).toEqual([])
    expect(o.get(hub.id)).toBeUndefined()
  })

  it('ignores undefined fields, and delete() bumps only when something was removed', () => {
    const o = new TransientOverrides()
    o.set(hub.id, { x: 1, w: undefined })
    expect(o.effective(hub).w).toBe(hub.w)
    const v = o.version
    o.delete('note_missing')
    o.clear()
    expect(o.version).toBe(v + 1)
    o.clear()
    expect(o.version).toBe(v + 1)
  })

  it('notifies subscribers on every change until unsubscribed', () => {
    const o = new TransientOverrides()
    const seen: number[] = []
    const off = o.subscribe(() => seen.push(o.version))
    o.set(hub.id, { x: 1 })
    o.set(hub.id, { x: 2 })
    o.delete(hub.id)
    off()
    o.set(hub.id, { x: 3 })
    expect(seen).toEqual([1, 2, 3])
  })
})
