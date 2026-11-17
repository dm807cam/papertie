// The app icon (`pnpm --filter @papertie/desktop icons`), drawn by `iconArt.mjs`:
//   build/icons/       PNGs from 16 to 1024 px, the tile filling the square (Linux; 512 is the
//                      window's and the About box's `dist/icon.png`)
//   build/icon.svg     the same at 1024, as the SVG it is drawn from
//   build/icon.ico     Windows, from those PNGs
//   build/icon.icns    macOS, the tile on Apple's grid
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { iconPng, iconSvg } from './iconArt.mjs'
import { dib, icns, ico } from './iconFormats.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build', 'icons')
mkdirSync(out, { recursive: true })

const pngs = async (grid, sizes) =>
  new Map(await Promise.all(sizes.map(async (size) => [size, await iconPng({ grid, size })])))

writeFileSync(join(root, 'build', 'icon.svg'), iconSvg({ grid: 'bleed', size: 1024 }))
const bleed = await pngs('bleed', [16, 32, 48, 64, 128, 256, 512, 1024])
for (const [size, png] of bleed) writeFileSync(join(out, `${size}x${size}.png`), png)

writeFileSync(
  join(root, 'build', 'icon.icns'),
  icns(await pngs('apple', [32, 64, 128, 256, 512, 1024])),
)
// The small sizes as DIBs, 256 as a PNG (what Windows' own icons do).
const small = [16, 32, 48, 64, 128].map(async (size) => {
  const { data } = await sharp(bleed.get(size))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { size, data: dib(data, size) }
})
writeFileSync(
  join(root, 'build', 'icon.ico'),
  ico([...(await Promise.all(small)), { size: 256, data: bleed.get(256) }]),
)
console.log(`Icons in ${out}, and build/icon.icns and build/icon.ico`)
