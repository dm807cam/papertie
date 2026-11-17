import type { AssetSize } from '../api/assets'

const SIZES: readonly AssetSize[] = [256, 1024, 2560]

/**
 * The smallest variant at least `noteW × zoom × dpr` device px wide, so a print is never
 * upscaled; the largest when none is. Not a finite number of pixels asks for the middle one.
 * Overview never mounts images; a lite note takes 256 without asking.
 */
export function variantFor(zoom: number, dpr: number, noteW: number): AssetSize {
  const need = noteW * zoom * dpr
  if (!Number.isFinite(need)) return 1024
  return SIZES.find((s) => s >= need) ?? 2560
}

/**
 * The camera's zoom, rounded up to a half octave (2^(k/2)). Images read this, not the camera,
 * so a pan or a zoom re-renders nothing and only crossing a band step re-renders the mounted
 * prints (each a small component of its own), and a variant is never smaller than the zoom needs.
 */
export function zoomBandOf(zoom: number): number {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return 1
  return 2 ** (Math.ceil(Math.log2(zoom) * 2 - 1e-9) / 2)
}

let band = 1
const listeners = new Set<() => void>()

/** The camera moved to `zoom`: listeners hear of it only when its band changes. */
export function setZoomBand(zoom: number): void {
  const next = zoomBandOf(zoom)
  if (next === band) return
  band = next
  for (const fn of listeners) fn()
}

export const zoomBand = {
  get: (): number => band,
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
