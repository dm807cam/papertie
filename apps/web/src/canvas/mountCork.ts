import { CORK_TILES, corkImage, corkLayers } from './cork'
import type { Size } from './types'

interface Mounted {
  el: HTMLElement
  ref: number
  width: number
  height: number
  transform: string
  opacity: number
  willChange: string
}

/**
 * Mounts the four cork layers into `container`. Each tile is painted once at its octave's
 * reference size and scaled by `transform`, so neither panning nor zooming repaints it: a layer's
 * box (`viewport * √2 + refPx`, enough at the smallest scale) and `background-size` change only
 * with the viewport. `moving` hints `will-change: transform` so the compositor keeps the raster
 * while the camera moves, and re-rasters at the new scale once it rests.
 */
export function mountCork(container: HTMLElement): {
  update(zoom: number, originX: number, originY: number, viewport: Size, moving?: boolean): void
  dispose(): void
} {
  container.style.overflow = 'hidden'
  container.style.isolation = 'isolate'
  const mounted: Mounted[] = []
  for (const layer of corkLayers(1, 0, 0)) {
    const el = container.ownerDocument.createElement('div')
    const s = el.style
    s.position = 'absolute'
    s.left = '0'
    s.top = '0'
    s.pointerEvents = 'none'
    s.transformOrigin = '0 0'
    s.backgroundImage = corkImage(CORK_TILES[layer.tile])
    s.backgroundRepeat = 'repeat'
    s.mixBlendMode = layer.blend
    container.appendChild(el)
    mounted.push({
      el,
      ref: Number.NaN,
      width: Number.NaN,
      height: Number.NaN,
      transform: '',
      opacity: Number.NaN,
      willChange: '',
    })
  }

  return {
    update(zoom, originX, originY, viewport, moving = false) {
      corkLayers(zoom, originX, originY).forEach((layer, i) => {
        const m = mounted[i] as Mounted
        const s = m.el.style
        if (m.ref !== layer.refPx) {
          m.ref = layer.refPx
          s.backgroundSize = `${layer.refPx}px ${layer.refPx}px`
        }
        const width = Math.ceil(viewport.width * Math.SQRT2 + layer.refPx)
        if (m.width !== width) {
          m.width = width
          s.width = `${width}px`
        }
        const height = Math.ceil(viewport.height * Math.SQRT2 + layer.refPx)
        if (m.height !== height) {
          m.height = height
          s.height = `${height}px`
        }
        if (m.opacity !== layer.opacity) {
          m.opacity = layer.opacity
          s.opacity = String(layer.opacity)
        }
        const scale = layer.sizePx / layer.refPx
        const transform = `translate3d(${layer.offsetX - layer.sizePx}px, ${layer.offsetY - layer.sizePx}px, 0) scale(${scale})`
        if (m.transform !== transform) {
          m.transform = transform
          s.transform = transform
        }
        const willChange = moving ? 'transform' : 'auto'
        if (m.willChange !== willChange) {
          m.willChange = willChange
          s.willChange = willChange
        }
      })
    },
    dispose() {
      for (const m of mounted) m.el.remove()
      mounted.length = 0
    },
  }
}
