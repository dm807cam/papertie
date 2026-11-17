/**
 * Each level is entered below `enterBelow` and left at `exitAtOrAbove`; the gaps stop flicker.
 * Notes go lite below 0.35 and become canvas cards (overview, no DOM) below 0.15: at that zoom
 * lite still mounts every note in the cull rect, about 800 on the wide board and every one of a
 * 1,000-note bench board, the most DOM notes lite carried before the overview level existed.
 */
export const LOD = {
  lite: { enterBelow: 0.35, exitAtOrAbove: 0.38 },
  overview: { enterBelow: 0.15, exitAtOrAbove: 0.18 },
} as const

export type LodMode = 'full' | 'lite' | 'overview'

/**
 * The level of detail at `zoom`, coming from `prev`. A jump can skip a level either way; coming
 * up from overview, lite's exit threshold decides between lite and full. A non-finite zoom keeps
 * `prev`.
 */
export function nextLod(prev: LodMode, zoom: number): LodMode {
  if (!Number.isFinite(zoom)) return prev
  if (prev === 'overview') {
    if (zoom < LOD.overview.exitAtOrAbove) return 'overview'
    return zoom >= LOD.lite.exitAtOrAbove ? 'full' : 'lite'
  }
  if (zoom < LOD.overview.enterBelow) return 'overview'
  if (prev === 'full') return zoom < LOD.lite.enterBelow ? 'lite' : 'full'
  return zoom >= LOD.lite.exitAtOrAbove ? 'full' : 'lite'
}
