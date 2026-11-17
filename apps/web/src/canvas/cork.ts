/**
 * The two cork tiles: `px` pixels, drawn at half that many CSS px at zoom 1 and, through the
 * octaves (`corkLayers`), at most at `px` CSS px: one file serves every screen.
 */
export const CORK_TILES = {
  fine: { url: '/textures/cork-fine.webp', px: 1024 },
  mottle: { url: '/textures/cork-mottle.webp', px: 1597 },
} as const

/** A tile as a CSS image. */
export function corkImage(tile: { url: string }): string {
  return `url(${tile.url})`
}

export const CORK_MOTTLE_OPACITY = 0.6

export interface CorkLayer {
  tile: 'fine' | 'mottle'
  url: string
  sizePx: number
  /** The layer's octave centre: `sizePx / refPx` always lies in [1/√2, √2). */
  refPx: number
  opacity: number
  offsetX: number
  offsetY: number
  blend: 'normal' | 'multiply'
}

function posMod(a: number, m: number): number {
  return ((a % m) + m) % m
}

const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback)

/**
 * The four cork layers in paint order [fineBottom, fineTop, mottleBottom, mottleTop]. Each tile
 * has two scale octaves that crossfade with zoom; `originX`/`originY` is the screen position of
 * world (0, 0), so the grain stays anchored to the world.
 */
export function corkLayers(zoom: number, originX: number, originY: number): CorkLayer[] {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const ox = finite(originX, 0)
  const oy = finite(originY, 0)
  const t = Math.log2(z)
  const f = t - Math.floor(t)
  const layers: CorkLayer[] = []
  for (const tile of ['fine', 'mottle'] as const) {
    const { url, px } = CORK_TILES[tile]
    const base = px / 2
    const peak = tile === 'fine' ? 1 : CORK_MOTTLE_OPACITY
    const blend = tile === 'fine' ? 'normal' : 'multiply'
    const bottomSize = base * 2 ** f
    const topSize = base * 2 ** (f - 1)
    const make = (sizePx: number, refPx: number, opacity: number): CorkLayer => ({
      tile,
      url,
      sizePx,
      refPx,
      opacity,
      offsetX: posMod(ox, sizePx),
      offsetY: posMod(oy, sizePx),
      blend,
    })
    // The fine bottom layer is opaque; the mottle one fades out as the top one fades in.
    layers.push(make(bottomSize, base * Math.SQRT2, tile === 'fine' ? 1 : peak * (1 - f)))
    layers.push(make(topSize, base * Math.SQRT1_2, peak * f))
  }
  return layers
}
