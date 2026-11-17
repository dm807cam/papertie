import { PALETTE, PALETTE_TOKENS } from '@papertie/core'
import type { RgbaImage } from '../image'
import { generateCorkFine, generateCorkMottle } from './cork'
import { DECKLE_SLICE, generateDeckleSvg } from './deckle'
import { bakeFibre } from './derive'
import { generateFibre } from './fibre'
import { generateDeskScene, generateFieldLandscape, generateLakeLandscape } from './illustrations'
import { generateSamplePhoto } from './photo'

export const TEXTURE_SEED = 20261027

export interface TextureEntry {
  path: string
  image?: RgbaImage
  svg?: string
  webp?: { quality: number; lossless?: boolean }
  /** A bitmap drawn from an SVG of the set at `scale` px per unit (`make-textures`, by sharp). */
  raster?: { svg: string; scale: number }
}

/**
 * The fibre fibre overlay as note.css lays it on a light paper (multiplied at 0.55) and on ink
 * (screened at 0.25); the baked papers (`fibre-<token>.webp`) are those sheets, flattened.
 */
export const FIBRE_OVERLAY = { multiply: 0.55, screen: 0.25 } as const

/**
 * Device px per mask unit of the deckle bitmaps: one mask unit is one world px, so 4 is a device
 * px per bitmap px at zoom 2 on a DPR 2 screen (the reading band's top).
 */
export const DECKLE_RASTER_SCALE = 4
/** The mask bitmaps' 9-slice inset, in their own px (note.css). */
export const DECKLE_RASTER_SLICE = DECKLE_SLICE * DECKLE_RASTER_SCALE

/** An entry whose pixels are generated on first access, so listing the set stays cheap. */
function lazy(
  path: string,
  make: () => RgbaImage,
  webp: NonNullable<TextureEntry['webp']>,
): TextureEntry {
  let cached: RgbaImage | undefined
  return {
    path,
    webp,
    get image() {
      cached ??= make()
      return cached
    },
  }
}

type Illustration = (o: { width: number; height: number; seed: number }) => RgbaImage

/** Name, generator and aspect (width, height) of each print illustration. */
const ILLUSTRATIONS: ReadonlyArray<readonly [string, Illustration, number, number]> = [
  ['lake', generateLakeLandscape, 4, 3],
  ['desk', generateDeskScene, 4, 3],
  ['field', generateFieldLandscape, 3, 5],
]

/** Every generated texture file, in manifest order. */
export function buildTextureSet(seed: number): TextureEntry[] {
  let fibre: RgbaImage | undefined
  const fibreOf = () => {
    fibre ??= generateFibre({ size: 512, seed })
    return fibre
  }
  // One file a texture, for every screen: a world-space tile is drawn at the zoom's scale, so a
  // 1x screen at zoom 2 needs every pixel a 2x screen does at zoom 1 (no 1x twin).
  const entries: TextureEntry[] = [
    lazy('cork-fine.webp', () => generateCorkFine({ size: 1024, seed }), { quality: 86 }),
    lazy('cork-mottle.webp', () => generateCorkMottle({ size: 1597, seed }), { quality: 80 }),
    lazy('fibre.webp', fibreOf, { quality: 90 }),
  ]
  for (const token of PALETTE_TOKENS) {
    const blend = token === 'ink' ? 'screen' : 'multiply'
    const bake = () => bakeFibre(fibreOf(), PALETTE[token].paper, blend, FIBRE_OVERLAY[blend])
    entries.push(lazy(`fibre-${token}.webp`, bake, { quality: 100, lossless: true }))
  }
  for (let i = 1; i <= 8; i++) {
    const svg = generateDeckleSvg(i, seed)
    entries.push(
      { path: `deckle-${i}.svg`, svg },
      { path: `deckle-${i}.webp`, raster: { svg, scale: DECKLE_RASTER_SCALE } },
    )
  }
  entries.push(
    lazy('print-sample-256.webp', () => generateSamplePhoto({ width: 256, height: 171, seed }), {
      quality: 84,
    }),
    lazy('print-sample-1024.webp', () => generateSamplePhoto({ width: 1024, height: 683, seed }), {
      quality: 84,
    }),
  )
  // The demo board's print illustrations; the size in the name is the long side.
  for (const [name, make, w, h] of ILLUSTRATIONS) {
    for (const size of [256, 1024] as const) {
      const k = size / Math.max(w, h)
      const width = Math.round(w * k)
      const height = Math.round(h * k)
      entries.push(
        lazy(`print-${name}-${size}.webp`, () => make({ width, height, seed }), { quality: 84 }),
      )
    }
  }
  return entries
}
