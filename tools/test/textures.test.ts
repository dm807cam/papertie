import { PALETTE_TOKENS } from '@papertie/core'
import { type RgbaImage, rawSha256, seamScore } from '../src/image'
import { CORK_FINE, generateCorkFine, generateCorkMottle } from '../src/textures/cork'
import { bakeFibre } from '../src/textures/derive'
import { generateFibre } from '../src/textures/fibre'
import {
  generateDeskScene,
  generateFieldLandscape,
  generateLakeLandscape,
} from '../src/textures/illustrations'
import { generateSamplePhoto } from '../src/textures/photo'
import {
  buildTextureSet,
  DECKLE_RASTER_SCALE,
  DECKLE_RASTER_SLICE,
  FIBRE_OVERLAY,
  TEXTURE_SEED,
} from '../src/textures/set'

const small = {
  corkFine: () => generateCorkFine({ size: 256, seed: 3, cells: 24 }),
  corkMottle: () => generateCorkMottle({ size: 256, seed: 3 }),
  fibre: () => generateFibre({ size: 256, seed: 3, fibres: 225 }),
}

describe('generators', () => {
  it('are deterministic per seed', () => {
    const a = generateCorkFine({ size: 128, seed: 1, cells: 12 })
    expect(rawSha256(a)).toBe(rawSha256(generateCorkFine({ size: 128, seed: 1, cells: 12 })))
    expect(rawSha256(generateCorkFine({ size: 128, seed: 2, cells: 12 }))).not.toBe(rawSha256(a))
  })

  it('produce images of the requested size', () => {
    const img = generateCorkMottle({ size: 64, seed: 1 })
    expect([img.width, img.height, img.data.length]).toEqual([64, 64, 64 * 64 * 4])
    const photo = generateSamplePhoto({ width: 64, height: 43, seed: 1 })
    expect([photo.width, photo.height, photo.data.length]).toEqual([64, 43, 64 * 43 * 4])
  })

  it.each(['corkFine', 'corkMottle', 'fibre'] as const)('%s tiles without a seam', (k) => {
    const s = seamScore(small[k]())
    expect(s.wrapX).toBeLessThanOrEqual(1.5 * s.interior + 1)
    expect(s.wrapY).toBeLessThanOrEqual(1.5 * s.interior + 1)
  })

  it('seamScore flags a hard seam', () => {
    const img: RgbaImage = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) }
    for (let y = 0; y < 4; y++) img.data.fill(0, (y * 4 + 3) * 4, (y * 4 + 3) * 4 + 3)
    const s = seamScore(img)
    expect(s.wrapX).toBeGreaterThan(100)
    expect(s.interior).toBeLessThan(s.wrapX)
  })

  it('cork reads warm', () => {
    const { data } = small.corkFine()
    let r = 0
    let g = 0
    let b = 0
    const n = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      r += data[i] as number
      g += data[i + 1] as number
      b += data[i + 2] as number
    }
    r /= n
    g /= n
    b /= n
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(luma).toBeGreaterThanOrEqual(90)
    expect(luma).toBeLessThanOrEqual(170)
  })

  it('cork granules are coarse but soft: larger than 12 tile px, a gentle luma spread', () => {
    // Every granule spans at least 12 px of the 1024 tile (6 screen px at zoom 1).
    expect(1024 / CORK_FINE.cells).toBeGreaterThanOrEqual(12)
    // At the shipped density (a 256 tile with a quarter of the cells), lit relief and crevices
    // without the high-contrast gravel of the first version (luma sd about 50).
    const { data } = generateCorkFine({ size: 256, seed: 3, cells: CORK_FINE.cells / 4 })
    const luma: number[] = []
    for (let i = 0; i < data.length; i += 4) {
      luma.push(
        0.299 * (data[i] as number) +
          0.587 * (data[i + 1] as number) +
          0.114 * (data[i + 2] as number),
      )
    }
    const mean = luma.reduce((a, b) => a + b, 0) / luma.length
    const sd = Math.sqrt(luma.reduce((a, b) => a + (b - mean) ** 2, 0) / luma.length)
    expect(sd).toBeGreaterThan(10)
    expect(sd).toBeLessThan(32)
  })

  it('cork is warm brown, not saturated orange: its lit granules stay brown', () => {
    // The first tile and this one share a mean hue (b/r 0.41 against 0.42). What read as orange
    // was its lit side: the brightest tenth blew out to (255, 210, 131), a yellow-orange glare.
    // Here the light end of the ramp is a lit brown, so the brightest tenth keeps red below
    // 230, luma below 180 and blue at least 0.4 of red.
    const { data } = generateCorkFine({ size: 256, seed: 3, cells: CORK_FINE.cells / 4 })
    const px: Array<[number, number, number]> = []
    for (let i = 0; i < data.length; i += 4) {
      px.push([data[i] as number, data[i + 1] as number, data[i + 2] as number])
    }
    const luma = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b
    px.sort((a, b) => luma(a) - luma(b))
    const top = px.slice(Math.floor(px.length * 0.9))
    const mean = [0, 1, 2].map((c) => top.reduce((a, p) => a + p[c as 0 | 1 | 2], 0) / top.length)
    const [r = 0, g = 0, b = 0] = mean
    expect(r).toBeLessThan(230)
    expect(luma([r, g, b])).toBeLessThan(180)
    expect(b / r).toBeGreaterThanOrEqual(0.4)
    // The whole tile stays in a warm range (a guard, not the discriminator).
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
  })

  it('fibre is mostly transparent', () => {
    const { data } = small.fibre()
    let sum = 0
    for (let i = 3; i < data.length; i += 4) sum += data[i] as number
    expect(sum / (data.length / 4)).toBeLessThan(60)
    expect(sum).toBeGreaterThan(0)
  })
})

/** Mean colour and the share of pixels matching `pick`, over an RGBA image. */
function stats(img: RgbaImage, pick: (r: number, g: number, b: number) => boolean) {
  const { data } = img
  let r = 0
  let g = 0
  let b = 0
  let hits = 0
  let opaque = true
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    const [pr, pg, pb] = [data[i] as number, data[i + 1] as number, data[i + 2] as number]
    r += pr
    g += pg
    b += pb
    if (pick(pr, pg, pb)) hits++
    if (data[i + 3] !== 255) opaque = false
  }
  return { r: r / n, g: g / n, b: b / n, share: hits / n, opaque }
}

describe('print illustrations', () => {
  const lake = generateLakeLandscape({ width: 160, height: 120, seed: 5 })
  const desk = generateDeskScene({ width: 160, height: 120, seed: 5 })
  const field = generateFieldLandscape({ width: 96, height: 160, seed: 5 })

  it.each([
    ['lake', generateLakeLandscape, lake],
    ['desk', generateDeskScene, desk],
    ['field', generateFieldLandscape, field],
  ] as const)('%s is deterministic per seed', (_name, make, img) => {
    const size = { width: img.width, height: img.height }
    expect(rawSha256(make({ ...size, seed: 5 }))).toBe(rawSha256(img))
    expect(rawSha256(make({ ...size, seed: 6 }))).not.toBe(rawSha256(img))
  })

  it('are sized as asked and opaque', () => {
    for (const [img, w, h] of [
      [lake, 160, 120],
      [desk, 160, 120],
      [field, 96, 160],
    ] as const) {
      expect([img.width, img.height, img.data.length]).toEqual([w, h, w * h * 4])
      expect(stats(img, () => false).opaque).toBe(true)
    }
  })

  it('the lake has pale blue water and sky, and a green tree and shore', () => {
    const blue = stats(lake, (r, _g, b) => b > r + 12 && b > 150)
    expect(blue.share).toBeGreaterThan(0.3)
    const green = stats(lake, (r, g, b) => g > r + 12 && g > b + 12)
    expect(green.share).toBeGreaterThan(0.15)
  })

  it('the desk scene reads warm, with a dark ink bottle and pen', () => {
    const s = stats(desk, (r, g, b) => r + g + b < 150)
    expect(s.r).toBeGreaterThan(s.g)
    expect(s.g).toBeGreaterThan(s.b)
    expect(s.share).toBeGreaterThan(0.02)
  })

  it('the field is ripe crop under a blue sky with white cloud', () => {
    const crop = stats(field, (r, g, b) => r > 170 && g > 130 && b < g - 50)
    expect(crop.share).toBeGreaterThan(0.3)
    const sky = stats(field, (r, _g, b) => b > r + 15 && b > 180)
    expect(sky.share).toBeGreaterThan(0.1)
    const cloud = stats(field, (r, g, b) => r > 222 && g > 220 && b > 208)
    expect(cloud.share).toBeGreaterThan(0.03)
  })
})

describe('texture set', () => {
  it('lists the expected files: the textures, the baked papers, the masks', () => {
    const papers = PALETTE_TOKENS.map((t) => `fibre-${t}.webp`)
    const masks = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((i) => [`deckle-${i}.svg`, `deckle-${i}.webp`])
    expect(
      buildTextureSet(TEXTURE_SEED)
        .map((e) => e.path)
        .sort(),
    ).toEqual(
      [
        'cork-fine.webp',
        'cork-mottle.webp',
        ...masks,
        'print-desk-1024.webp',
        'print-desk-256.webp',
        'print-field-1024.webp',
        'print-field-256.webp',
        'print-lake-1024.webp',
        'print-lake-256.webp',
        'print-sample-1024.webp',
        'print-sample-256.webp',
        'fibre.webp',
        ...papers,
      ].sort(),
    )
  })

  it('gives svg entries an svg, bitmap masks their svg and scale, webp entries an image', () => {
    for (const e of buildTextureSet(TEXTURE_SEED)) {
      if (e.path.endsWith('.svg')) {
        expect(e.svg).toMatch(/^<svg /)
        expect(e.image).toBeUndefined()
        expect(e.webp).toBeUndefined()
      } else if (e.raster !== undefined) {
        expect(e.path).toMatch(/^deckle-\d\.webp$/)
        expect(e.raster.svg).toMatch(/^<svg /)
        expect(e.raster.scale).toBe(DECKLE_RASTER_SCALE)
        expect(DECKLE_RASTER_SLICE).toBe(12 * DECKLE_RASTER_SCALE)
      } else {
        expect(e.svg).toBeUndefined()
        expect(e.webp?.quality).toBeGreaterThan(0)
      }
    }
  })
})

describe('derived textures', () => {
  it('bakeFibre flattens the overlay as CSS blends it: multiply on paper, screen on ink', () => {
    // One fibre pixel: a mid brown at half alpha.
    const fibre: RgbaImage = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([128, 64, 32, 128]),
    }
    const paper = '#F3EBDD'
    const p = [0xf3, 0xeb, 0xdd].map((c) => c / 255)
    const f = [128, 64, 32].map((c) => c / 255)
    const a = (128 / 255) * FIBRE_OVERLAY.multiply
    const multiplied = bakeFibre(fibre, paper, 'multiply', FIBRE_OVERLAY.multiply)
    expect([...multiplied.data]).toEqual([
      ...p.map((c, i) => Math.round(((1 - a) * c + a * c * (f[i] as number)) * 255)),
      255,
    ])
    const s = (128 / 255) * FIBRE_OVERLAY.screen
    const screened = bakeFibre(fibre, '#34312E', 'screen', FIBRE_OVERLAY.screen)
    const q = [0x34, 0x31, 0x2e].map((c) => c / 255)
    expect([...screened.data]).toEqual([
      ...q.map((c, i) => {
        const fi = f[i] as number
        return Math.round(((1 - s) * c + s * (c + fi - c * fi)) * 255)
      }),
      255,
    ])
    // A transparent fibre pixel leaves the paper as it is.
    const clear: RgbaImage = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) }
    expect([...bakeFibre(clear, paper, 'multiply', 0.55).data]).toEqual([0xf3, 0xeb, 0xdd, 255])
  })
})
