// The app icon's drawing: the Papertie mark (a crimson P, a green ribbon tied across its stem)
// centred on a rounded tile of cream paper. Large sizes take the artwork itself
// (docs/assets/logo.svg); small ones the flat drawing the favicon uses
// (apps/web/public/favicon.svg), set larger on the tile, so the tie still reads at 16 px.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const inner = (file) =>
  readFileSync(join(repo, file), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[\s\S]*?<\/title>|<style>[\s\S]*?<\/style>/g, '')

/** The artwork and the box its mark fills. */
const FULL = { art: inner('docs/assets/logo.svg'), x: 336, y: 352, w: 561, h: 553 }
/** The flat drawing in its 32-unit box, in the favicon's light-ground inks. */
const FLAT = {
  art: inner('apps/web/public/favicon.svg')
    .replace('class="p"', 'fill="#A21D45"')
    .replace('class="tie"', 'fill="#86A755"'),
  x: 2,
  y: 2,
  w: 28,
  h: 28,
}

/** Cream paper (`--paper-cream`, packages/core `PALETTE.cream.paper`) and the tile's edge. */
const PAPER = '#F3EBDD'
const EDGE = '#E2D6C1'

/**
 * The icon as an SVG on a 1024 grid, to be shown at `size` px. `grid: 'apple'` is macOS's tile
 * (an 824 px body with its transparent margin, corner 22.37 % of the body); `'bleed'` fills the
 * square, for Windows and Linux.
 */
export function iconSvg({ grid, size }) {
  const body = grid === 'apple' ? 824 : 1024
  const px = size / 1024
  const flat = body * px < 56
  const mark = flat ? FLAT : FULL
  // The mark's width on the tile: within Apple's 80 % at full size, larger where pixels are few.
  let k = (body * (flat ? 0.76 : 0.62)) / mark.w
  let x = 512 - (mark.x + mark.w / 2) * k
  let y = 512 - (mark.y + mark.h / 2) * k
  // The flat drawing lies on even lines: at half a pixel a unit and a whole-pixel place, every
  // edge of it is sharp. Taken where that is near the width wanted (the 16 px icon).
  const half = Math.round(k * px * 2) / 2
  if (flat && half > 0 && Math.abs(half - k * px) < 0.2 * k * px) {
    k = half / px
    x = Math.round((512 - (mark.x + mark.w / 2) * k) * px) / px
    y = Math.round((512 - (mark.y + mark.h / 2) * k) * px) / px
  }
  const edge = flat ? '' : ` stroke="${EDGE}" stroke-width="4"`
  const at = (1024 - body) / 2 + (flat ? 0 : 2)
  const side = 1024 - 2 * at
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}">
  <title>Papertie</title>
  <rect x="${at}" y="${at}" width="${side}" height="${side}" rx="${(body * 0.2237).toFixed(1)}" fill="${PAPER}"${edge}/>
  <g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(4)})">${mark.art}</g>
</svg>
`
}

/** The icon as a PNG of `size` px, drawn at four times that and brought down. */
export function iconPng({ grid, size }) {
  return sharp(Buffer.from(iconSvg({ grid, size })), { density: 72 * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer()
}
