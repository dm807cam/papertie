import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Book, COVER_INKS, COVER_MOTIFS, PALETTE } from '@papertie/core'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, vi } from 'vitest'
import { CoverSvg } from '../../src/book/cover/CoverSvg'
import {
  COVER_LAYOUTS,
  type CoverBox,
  type CoverShape,
  coverColours,
  coverFromSeed,
  coverLayout,
  coverRoom,
  coverShapes,
  coverTitleBox,
  newCover,
} from '../../src/book/cover/cover'

type Cover = Book['cover']

const SHELF = { w: 104, h: 150 }
const LARGE = { w: 208, h: 300 }
const SEEDS = Array.from({ length: 300 }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) % 2 ** 32)

const svgOf = (markup: string) => {
  const m = markup.match(/<svg[\s\S]*<\/svg>/)
  if (!m) throw new Error('no svg in the markup')
  return m[0]
}

const markupOf = (
  cover: Cover,
  title = 'The Art of Gathering',
  idBase = 'b_test-shelf',
  size = SHELF,
) => renderToStaticMarkup(<CoverSvg cover={cover} title={title} size={size} idBase={idBase} />)

/** Every family in every ink, over `seeds`. */
function* everyCover(seeds: readonly number[]): Generator<Cover> {
  for (const seed of seeds)
    for (const motif of COVER_MOTIFS) for (const ink of COVER_INKS) yield { seed, ink, motif }
}

const overlap = (a: CoverBox, b: CoverBox) =>
  a.x < b.x + b.w - 1e-6 &&
  b.x < a.x + a.w - 1e-6 &&
  a.y < b.y + b.h - 1e-6 &&
  b.y < a.y + a.h - 1e-6

const COLOUR = /^#[0-9A-F]{6}$/
const coloursOf = (s: CoverShape) => ('fill' in s ? s.fill : s.stroke)

/** WCAG 2 relative luminance and contrast of two `#RRGGBB` colours. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

afterEach(() => vi.restoreAllMocks())

describe('coverFromSeed and newCover', () => {
  it('all three motifs appear across 300 seeds, and no ink is cream or apricot', () => {
    const motifs = new Set<string>()
    const inks = new Set<string>()
    for (const seed of SEEDS) {
      const c = coverFromSeed(seed)
      expect(c.seed).toBe(seed)
      expect(COVER_MOTIFS).toContain(c.motif)
      expect(COVER_INKS).toContain(c.ink)
      expect(c.ink).not.toBe('cream')
      expect(c.ink).not.toBe('apricot')
      expect(coverFromSeed(seed)).toEqual(c)
      motifs.add(c.motif)
      inks.add(c.ink)
    }
    expect([...motifs].sort()).toEqual([...COVER_MOTIFS].sort())
    expect(inks.size).toBe(COVER_INKS.length)
  })

  it('newCover draws a uint32 seed from crypto.getRandomValues, never Math.random', () => {
    const random = vi.spyOn(Math, 'random')
    const grv = vi.spyOn(crypto, 'getRandomValues')
    const a = newCover()
    const b = newCover()
    expect(grv).toHaveBeenCalledTimes(2)
    expect(random).not.toHaveBeenCalled()
    for (const c of [a, b]) {
      expect(Number.isInteger(c.seed)).toBe(true)
      expect(c.seed).toBeGreaterThanOrEqual(0)
      expect(c.seed).toBeLessThanOrEqual(0xffff_ffff)
      expect(c).toEqual(coverFromSeed(c.seed))
    }
  })
})

describe('coverShapes', () => {
  it('draws every family in every ink from the seed alone, in a handful of palette-coloured shapes', () => {
    const random = vi.spyOn(Math, 'random')
    const yarns = new Set(Object.values(PALETTE).map((p) => p.yarn))
    for (const cover of everyCover(SEEDS.slice(0, 40))) {
      const shapes = coverShapes(cover, SHELF)
      expect(coverShapes({ ...cover }, SHELF)).toEqual(shapes)
      expect(shapes.length).toBeGreaterThan(0)
      expect(shapes.length).toBeLessThanOrEqual(5)
      const c = coverColours(cover)
      expect(c.ink).toBe(PALETTE[cover.ink].yarn)
      expect(yarns).toContain(c.second)
      expect(c.second).not.toBe(c.ink)
      expect(c.second).not.toBe(PALETTE.cream.yarn)
      for (const s of shapes) {
        expect(coloursOf(s)).toMatch(COLOUR)
        expect(JSON.stringify(s)).not.toMatch(/NaN|Infinity|null/)
        if ('opacity' in s && s.opacity !== undefined) {
          expect(s.opacity).toBeGreaterThan(0)
          expect(s.opacity).toBeLessThan(1)
        }
        if (s.kind === 'area' || s.kind === 'line') expect(s.d).toMatch(/^M[\d.\- ]/)
      }
      const kinds = shapes.map((s) => s.kind)
      if (cover.motif === 'fields') {
        // The ground, then two or three fields (or two and their overlap).
        expect(kinds[0]).toBe('area')
        expect(kinds.slice(1).every((k) => k === 'rect')).toBe(true)
        expect(kinds.length).toBeGreaterThanOrEqual(3)
      } else if (cover.motif === 'overprint') {
        // A disc, a half disc and a third form, in the two inks.
        expect(kinds.slice(0, 2)).toEqual(['disc', 'area'])
        expect(kinds).toHaveLength(3)
        for (const s of shapes) expect([c.ink, c.second]).toContain(coloursOf(s))
      } else {
        // Fine lines and heavier ones, in the one ink.
        expect(kinds.every((k) => k === 'line')).toBe(true)
        expect(kinds.length).toBeLessThanOrEqual(2)
        for (const s of shapes) expect(coloursOf(s)).toBe(c.ink)
      }
    }
    expect(random).not.toHaveBeenCalled()
  })

  it('the second ink is one of two for each ink, and both are used', () => {
    for (const ink of COVER_INKS) {
      const seconds = new Set(
        SEEDS.slice(0, 60).map((seed) => coverColours({ seed, ink, motif: 'overprint' }).second),
      )
      expect(seconds.size).toBe(2)
    }
  })

  it('draws the same cover at twice the size, to the tenth', () => {
    for (const cover of everyCover(SEEDS.slice(0, 20))) {
      const small = coverShapes(cover, SHELF)
      const large = coverShapes(cover, LARGE)
      expect(large.map((s) => s.kind)).toEqual(small.map((s) => s.kind))
      small.forEach((s, i) => {
        const l = large[i]
        if (s.kind === 'rect' && l?.kind === 'rect') {
          expect(l.x).toBeCloseTo(2 * s.x, 0)
          expect(l.h).toBeCloseTo(2 * s.h, 0)
        }
        if (s.kind === 'disc' && l?.kind === 'disc') expect(l.r).toBeCloseTo(2 * s.r, 0)
      })
    }
  })

  it('gives every seed one of the three layouts, and uses all three', () => {
    const seen = new Set<string>()
    for (const seed of SEEDS) {
      const layout = coverLayout(coverFromSeed(seed))
      expect(COVER_LAYOUTS).toContain(layout)
      seen.add(layout)
    }
    expect(seen.size).toBe(3)
  })

  it('a contour cover, the dearest family, is drawn in under a millisecond', () => {
    const covers = SEEDS.map((seed) => ({
      seed,
      ink: 'indigo' as const,
      motif: 'contour' as const,
    }))
    for (const c of covers) coverShapes(c, SHELF)
    // The quietest of ten rounds, so a busy machine does not fail a drawing that is cheap.
    let best = Number.POSITIVE_INFINITY
    for (let round = 0; round < 10; round++) {
      const t0 = performance.now()
      for (const c of covers) coverShapes(c, SHELF)
      best = Math.min(best, (performance.now() - t0) / covers.length)
    }
    console.log(`contour cover: ${best.toFixed(3)} ms each`)
    expect(best).toBeLessThan(1)
  })
})

describe("the title's paper", () => {
  it('the title box and the drawing never share paper: a label inside the fields, a bare band beside the others', () => {
    for (const size of [SHELF, LARGE]) {
      for (const cover of everyCover(SEEDS.slice(0, 40))) {
        const title = coverTitleBox(cover, size)
        const room = coverRoom(cover, size)
        const foot = coverLayout(cover) === 'foot'
        // The title's lines and margin (cover.css) take at most 37 % of the height, at its edge.
        expect(title.h).toBeGreaterThanOrEqual(0.36 * size.h)
        expect(title.x).toBeLessThanOrEqual(0.115 * size.w)
        expect(title.x + title.w).toBeGreaterThanOrEqual(0.885 * size.w)
        if (foot) expect(title.y + title.h).toBeGreaterThanOrEqual(size.h * 0.96)
        else expect(title.y).toBeLessThanOrEqual(size.h * 0.04)
        if (cover.motif !== 'fields') {
          // The band and the room share the cover between them.
          expect(overlap(title, room)).toBe(false)
          expect(title.h + room.h).toBeCloseTo(size.h, 6)
          expect([title.w, room.w]).toEqual([size.w, size.w])
          continue
        }
        const [ground, ...rects] = coverShapes(cover, size)
        // The ground is cut out under the label, so the title sits on the cover's own paper.
        if (ground?.kind !== 'area') throw new Error('a fields cover starts with its ground')
        expect(ground.evenodd).toBe(true)
        const n = (v: number) => String(Math.round(v * 10) / 10).replace(/^0\./, '.')
        expect(ground.d).toContain(
          `M${n(title.x)} ${n(title.y)}v${n(title.h)}h${n(title.w)}v-${n(title.h)}z`,
        )
        for (const s of rects) {
          if (s.kind !== 'rect') throw new Error('a field is a rect')
          expect(overlap(s, title)).toBe(false)
          // And every field lies on the cover.
          expect(s.x).toBeGreaterThanOrEqual(0)
          expect(s.y).toBeGreaterThanOrEqual(0)
          expect(s.x + s.w).toBeLessThanOrEqual(size.w)
          expect(s.y + s.h).toBeLessThanOrEqual(size.h)
        }
      }
    }
  })

  it('an overprint or contour drawing is clipped to its room in the markup', () => {
    for (const cover of everyCover(SEEDS.slice(0, 30))) {
      const svg = svgOf(markupOf(cover))
      const room = coverRoom(cover, SHELF)
      // Everything drawn is inside the one group.
      expect(svg).toMatch(
        /^<svg[^>]*>(<clipPath.*?<\/clipPath>)?<g class="cover-ink"[^>]*>.*<\/g><\/svg>$/,
      )
      if (cover.motif === 'fields') {
        expect(svg).not.toContain('clipPath')
        continue
      }
      expect(svg).toContain(
        `<clipPath id="b_test-shelf-room"><rect x="${room.x}" y="${room.y}" width="${room.w}" height="${room.h}"></rect></clipPath>`,
      )
      expect(svg).toContain('<g class="cover-ink" clip-path="url(#b_test-shelf-room)"')
    }
  })

  it('the title is ink on the cream paper, at 12.5:1', () => {
    const css = readFileSync(join(__dirname, '../../src/book/cover/cover.css'), 'utf8')
    expect(css).toMatch(/\.cover \{[^}]*background: var\(--paper-cream\)/)
    expect(css).toMatch(/\.cover-title \{[^}]*color: var\(--ink-cream\)/)
    const ratio = contrast(PALETTE.cream.ink, PALETTE.cream.paper)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(ratio).toBeCloseTo(12.5, 1)
    // Set on the drawing instead, four of the six inks would fail: why it is kept clear.
    const onInk = COVER_INKS.filter((k) => contrast(PALETTE.cream.ink, PALETTE[k].yarn) < 4.5)
    expect(onInk.length).toBeGreaterThanOrEqual(3)
  })
})

describe('CoverSvg', () => {
  it('the same cover renders byte-identical markup every time', () => {
    const random = vi.spyOn(Math, 'random')
    for (const seed of SEEDS.slice(0, 30)) {
      const cover = coverFromSeed(seed)
      const first = markupOf(cover)
      expect(markupOf(cover)).toBe(first)
      expect(markupOf({ ...cover })).toBe(first)
    }
    expect(random).not.toHaveBeenCalled()
  })

  it('renaming a book keeps its cover', () => {
    // The cover is the record's own field: nothing of the art or its layout comes from the title.
    for (const seed of SEEDS.slice(0, 30)) {
      const cover = coverFromSeed(seed)
      const before = markupOf(cover, 'Notes on Collecting')
      const after = markupOf(cover, 'A Field Guide to Small Rooms, Second Edition')
      expect(svgOf(after)).toBe(svgOf(before))
      expect(after.replace(/<span class="cover-title[^>]*>[^<]*<\/span>/, '')).toBe(
        before.replace(/<span class="cover-title[^>]*>[^<]*<\/span>/, ''),
      )
      expect(after).toContain('A Field Guide to Small Rooms, Second Edition')
    }
  })

  it("a cover's SVG is well-formed, under 4 KB, has no style attribute, and every id starts with its idBase", () => {
    const largest: Record<string, number> = {}
    for (const size of [SHELF, LARGE]) {
      for (const cover of everyCover(SEEDS.slice(0, 20))) {
        const idBase = `b_${cover.seed.toString(36)}-shelf`
        const markup = markupOf(cover, 'Untitled', idBase, size)
        const svg = svgOf(markup)
        const bytes = new TextEncoder().encode(svg).length
        largest[cover.motif] = Math.max(largest[cover.motif] ?? 0, bytes)
        expect(bytes).toBeLessThan(4 * 1024)
        expect(markup).toContain(`class="cover cover--${coverLayout(cover)} cover--${cover.motif} `)
        expect(markup).not.toMatch(/\sstyle=/)
        expect(markup).not.toMatch(/<style|<filter|<image/)
        expect(markup).not.toMatch(/data:|NaN|Infinity|undefined/)
        expect(svg).toContain(`viewBox="0 0 104 150"`)
        // Each family draws at least one path, and none more than a handful of elements.
        expect((svg.match(/<path/g) ?? []).length).toBeGreaterThanOrEqual(1)
        expect((svg.match(/<(path|rect|circle)/g) ?? []).length).toBeLessThanOrEqual(6)
        // Every tag opened is closed, in order.
        const open: string[] = []
        for (const tag of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*>/g)) {
          if (tag[1]) expect(open.pop()).toBe(tag[2])
          else open.push(tag[2] ?? '')
        }
        expect(open).toEqual([])
        for (const d of svg.matchAll(/\sd="([^"]*)"/g))
          expect(d[1]).toMatch(/^M[\d.\- ]+[\d.\- a-zA-Z]*$/)
        const ids = [...markup.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? '')
        for (const id of ids) expect(id.startsWith(idBase)).toBe(true)
        // Every reference inside resolves to one of the cover's own ids.
        for (const ref of markup.matchAll(/url\(#([^)]*)\)/g)) expect(ids).toContain(ref[1])
      }
    }
    console.log(`largest cover SVG, bytes: ${JSON.stringify(largest)}`)
    expect(Object.keys(largest).sort()).toEqual([...COVER_MOTIFS].sort())
  })

  it('sets the title as HTML text over the art, the art hidden from assistive tech', () => {
    const markup = markupOf(coverFromSeed(42), 'Essays & Letters')
    expect(svgOf(markup)).toMatch(/^<svg[^>]*aria-hidden="true"/)
    expect(svgOf(markup)).not.toContain('Essays')
    expect(markup).toMatch(/<span class="cover-title[^"]*"[^>]*>Essays &amp; Letters<\/span>/)
    expect(markupOf(coverFromSeed(42), '')).toContain('Untitled')
  })
})
