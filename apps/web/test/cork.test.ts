import { ZOOM_MAX, ZOOM_MIN } from '../src/canvas/Camera'
import { CORK_MOTTLE_OPACITY, CORK_TILES, type CorkLayer, corkLayers } from '../src/canvas/cork'
import { mountCork } from '../src/canvas/mountCork'

describe('corkLayers', () => {
  it('base sizes at zoom 1', () => {
    expect(corkLayers(1, 0, 0).map((l) => [l.sizePx, l.opacity])).toEqual([
      [512, 1],
      [256, 0],
      [798.5, 0.6],
      [399.25, 0],
    ])
  })

  it('lists layers in paint order with the right tiles and blends', () => {
    const ls = corkLayers(1.3, 0, 0)
    expect(ls.map((l) => l.tile)).toEqual(['fine', 'fine', 'mottle', 'mottle'])
    expect(ls.map((l) => l.blend)).toEqual(['normal', 'normal', 'multiply', 'multiply'])
    expect(ls[0]?.url).toBe(CORK_TILES.fine.url)
    expect(ls[2]?.url).toBe(CORK_TILES.mottle.url)
    expect(CORK_MOTTLE_OPACITY).toBe(0.6)
  })

  it('fine grain stays within one octave at every zoom, down to ZOOM_MIN', () => {
    expect(ZOOM_MIN).toBe(0.005)
    for (let i = 0; i <= 400; i++) {
      const zoom = ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (i / 400)
      const [bottom, top] = corkLayers(zoom, 0, 0)
      expect(bottom?.sizePx).toBeGreaterThanOrEqual(512 - 1e-9)
      expect(bottom?.sizePx).toBeLessThan(1024)
      expect(top?.sizePx).toBeGreaterThanOrEqual(256 - 1e-9)
      expect(top?.sizePx).toBeLessThan(512)
    }
  })

  it('is continuous across octave boundaries', () => {
    for (const boundary of [0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2]) {
      const below = corkLayers(boundary * (1 - 1e-9), 0, 0)
      const at = corkLayers(boundary, 0, 0)
      for (const [topIdx, bottomIdx] of [
        [1, 0],
        [3, 2],
      ] as const) {
        const b = below[topIdx] as CorkLayer
        const a = at[bottomIdx] as CorkLayer
        expect(Math.abs(b.sizePx - a.sizePx)).toBeLessThan(1e-6)
        expect(Math.abs(b.opacity - a.opacity)).toBeLessThan(1e-6)
      }
    }
  })

  it('anchors to the world', () => {
    const base = corkLayers(1.7, 123.4, -56.7)
    const shifted = corkLayers(1.7, 123.4 + 40, -56.7 - 25)
    base.forEach((l, i) => {
      const s = shifted[i] as (typeof base)[number]
      expect(l.offsetX).toBeGreaterThanOrEqual(0)
      expect(l.offsetX).toBeLessThan(l.sizePx)
      expect(l.offsetY).toBeGreaterThanOrEqual(0)
      expect(l.offsetY).toBeLessThan(l.sizePx)
      const dx = (((s.offsetX - l.offsetX - 40) % l.sizePx) + l.sizePx) % l.sizePx
      const dy = (((s.offsetY - l.offsetY + 25) % l.sizePx) + l.sizePx) % l.sizePx
      expect(Math.min(dx, l.sizePx - dx)).toBeLessThan(1e-9)
      expect(Math.min(dy, l.sizePx - dy)).toBeLessThan(1e-9)
    })
    const wrapped = corkLayers(1.7, 123.4 + (base[0]?.sizePx as number), -56.7)
    expect(wrapped[0]?.offsetX).toBeCloseTo(base[0]?.offsetX as number, 9)
  })

  it('survives non-finite input', () => {
    for (const l of corkLayers(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)) {
      expect(Number.isFinite(l.sizePx + l.offsetX + l.offsetY + l.opacity)).toBe(true)
    }
  })
})

interface FakeEl {
  style: Record<string, string>
  writes: Record<string, number>
  removed: boolean
  remove(): void
}

function fakeContainer() {
  const children: FakeEl[] = []
  const makeEl = (): FakeEl => {
    const writes: Record<string, number> = {}
    const store: Record<string, string> = {}
    const el: FakeEl = {
      style: new Proxy(store, {
        set(t, k: string, v: string) {
          writes[k] = (writes[k] ?? 0) + 1
          t[k] = v
          return true
        },
      }),
      writes,
      removed: false,
      remove() {
        el.removed = true
      },
    }
    return el
  }
  const container = {
    style: {} as Record<string, string>,
    ownerDocument: { createElement: () => makeEl() },
    appendChild(el: FakeEl) {
      children.push(el)
      return el
    },
  }
  return { container: container as unknown as HTMLElement, children }
}

describe('mountCork', () => {
  it('creates four layers, and panning changes only transform', () => {
    const { container, children } = fakeContainer()
    const cork = mountCork(container)
    expect(children).toHaveLength(4)
    const viewport = { width: 1200, height: 800 }
    cork.update(1, 10, 20, viewport)
    const snapshot = children.map((c) => ({ ...c.writes }))
    cork.update(1, 55, -70, viewport)
    cork.update(1, 90, -71, viewport)
    children.forEach((c, i) => {
      for (const k of Object.keys(c.writes)) {
        if (k === 'transform') expect(c.writes[k]).toBeGreaterThan(snapshot[i]?.[k] ?? 0)
        else expect(c.writes[k]).toBe(snapshot[i]?.[k])
      }
    })
    const layers = corkLayers(1, 90, -71)
    const ref = layers[0]?.refPx as number
    expect(children[0]?.style.width).toBe(`${Math.ceil(1200 * Math.SQRT2 + ref)}px`)
    expect(children[0]?.style.backgroundSize).toBe(`${ref}px ${ref}px`)
    expect(children[0]?.style.transform).toBe(
      `translate3d(${(layers[0]?.offsetX as number) - 512}px, ${(layers[0]?.offsetY as number) - 512}px, 0) scale(${512 / ref})`,
    )
    expect(children[2]?.style.mixBlendMode).toBe('multiply')
  })

  it('zooming scales each layer by transform alone: background size and box stay fixed', () => {
    const { container, children } = fakeContainer()
    const cork = mountCork(container)
    const viewport = { width: 1200, height: 800 }
    cork.update(1, 0, 0, viewport, true)
    const snapshot = children.map((c) => ({ ...c.writes }))
    for (let i = 1; i <= 60; i++) cork.update(0.25 * 8 ** (i / 60), 13, -7, viewport, true)
    children.forEach((c, i) => {
      for (const k of Object.keys(c.writes)) {
        if (k === 'transform' || k === 'opacity') continue
        expect([k, c.writes[k]]).toEqual([k, snapshot[i]?.[k]])
      }
    })
    const layers = corkLayers(2, 13, -7)
    layers.forEach((l, i) => {
      const scale = l.sizePx / l.refPx
      expect(scale).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-9)
      expect(scale).toBeLessThan(Math.SQRT2)
      // The scaled box still covers the viewport plus one tile.
      const w = Number.parseFloat(children[i]?.style.width ?? '0')
      const h = Number.parseFloat(children[i]?.style.height ?? '0')
      expect(w * scale).toBeGreaterThanOrEqual(viewport.width + l.sizePx)
      expect(h * scale).toBeGreaterThanOrEqual(viewport.height + l.sizePx)
      expect(children[i]?.style.transform).toContain(`scale(${scale})`)
    })
  })

  it('hints will-change only while the camera moves, and removes layers on dispose', () => {
    const { container, children } = fakeContainer()
    const cork = mountCork(container)
    cork.update(1, 0, 0, { width: 100, height: 100 })
    expect(children.map((c) => c.style.willChange)).toEqual(['auto', 'auto', 'auto', 'auto'])
    cork.update(1.5, 0, 0, { width: 100, height: 100 }, true)
    expect(children.map((c) => c.style.willChange)).toEqual([
      'transform',
      'transform',
      'transform',
      'transform',
    ])
    cork.update(1.5, 0, 0, { width: 100, height: 100 }, false)
    expect(children[0]?.style.willChange).toBe('auto')
    expect(children[0]?.style.backgroundSize).toBe(`${512 * Math.SQRT2}px ${512 * Math.SQRT2}px`)
    cork.dispose()
    expect(children.every((c) => c.removed)).toBe(true)
  })
})
