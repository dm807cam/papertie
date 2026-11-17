/**
 * One-off: the metric-matched local fallbacks for the web faces, written to
 * `apps/web/src/styles/fallbackFonts.css`. Run with `pnpm --filter @papertie/tools font-metrics`
 * on a Mac (the fallbacks are the system's own faces).
 *
 * - The web faces' metrics come from the Fontsource woff2 files in `apps/web/node_modules`
 *   (`head`, `hhea` and `OS/2`; widths from `cmap` and `hmtx`), decompressed with Node's own
 *   Brotli. The local faces' come from `/System/Library/Fonts` (TrueType collections).
 * - `ascent-override`, `descent-override` and `line-gap-override` give the fallback the web
 *   face's `hhea` line metrics (what Chrome and Safari on macOS lay lines out with), divided by
 *   `size-adjust`, which scales them too.
 * - `size-adjust` is the ratio of the two faces' average advance over English text, weighted by
 *   letter frequency.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'
import { shippedStylesheet } from './src/uiFonts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FONTSOURCE = join(ROOT, 'apps', 'web', 'node_modules', '@fontsource')
const OUT = join(ROOT, 'apps', 'web', 'src', 'styles', 'fallbackFonts.css')
const SYSTEM = '/System/Library/Fonts'

// ---- sfnt tables -------------------------------------------------------------------------------

type Tables = Map<string, Buffer>

// biome-ignore format: the table, 63 tags in order
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
]

/** The tables of a woff2 file: one Brotli stream holding them in directory order. */
function woff2Tables(buf: Buffer): Tables {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not woff2')
  const numTables = buf.readUInt16BE(12)
  const compressed = buf.readUInt32BE(20)
  let p = 48
  const base128 = () => {
    let v = 0
    for (let i = 0; i < 5; i++) {
      const b = buf[p++] as number
      v = v * 128 + (b & 0x7f)
      if ((b & 0x80) === 0) return v
    }
    throw new Error('bad UIntBase128')
  }
  const dir: Array<{ tag: string; length: number }> = []
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++] as number
    let tag = WOFF2_TAGS[flags & 0x3f]
    if ((flags & 0x3f) === 63) {
      tag = buf.toString('latin1', p, p + 4)
      p += 4
    }
    if (tag === undefined) throw new Error('bad tag')
    const version = (flags >> 6) & 3
    const orig = base128()
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0
    const length = transformed ? base128() : orig
    dir.push({ tag, length })
  }
  const data = brotliDecompressSync(buf.subarray(p, p + compressed))
  const out: Tables = new Map()
  let at = 0
  for (const { tag, length } of dir) {
    out.set(tag, data.subarray(at, at + length))
    at += length
  }
  return out
}

/** The tables of one face of a TrueType file or collection. */
function sfntTables(buf: Buffer, index = 0): Tables {
  let base = 0
  if (buf.toString('latin1', 0, 4) === 'ttcf') base = buf.readUInt32BE(12 + 4 * index)
  const numTables = buf.readUInt16BE(base + 4)
  const out: Tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const r = base + 12 + 16 * i
    const off = buf.readUInt32BE(r + 8)
    out.set(buf.toString('latin1', r, r + 4), buf.subarray(off, off + buf.readUInt32BE(r + 12)))
  }
  return out
}

/** Every face of a TrueType collection, by PostScript name. */
function collection(path: string): Map<string, Tables> {
  const buf = readFileSync(path)
  const count = buf.toString('latin1', 0, 4) === 'ttcf' ? buf.readUInt32BE(8) : 1
  const out = new Map<string, Tables>()
  for (let i = 0; i < count; i++) {
    const t = sfntTables(buf, i)
    out.set(names(t).postscript, t)
  }
  return out
}

const table = (t: Tables, tag: string): Buffer => {
  const b = t.get(tag)
  if (b === undefined) throw new Error(`no ${tag}`)
  return b
}

function names(t: Tables): { postscript: string; full: string } {
  const b = table(t, 'name')
  const count = b.readUInt16BE(2)
  const strings = b.readUInt16BE(4)
  const found: Record<number, string> = {}
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i
    const platform = b.readUInt16BE(r)
    const id = b.readUInt16BE(r + 6)
    const len = b.readUInt16BE(r + 8)
    const off = strings + b.readUInt16BE(r + 10)
    if ((id !== 4 && id !== 6) || found[id] !== undefined) continue
    const raw = b.subarray(off, off + len)
    if (platform === 3 || platform === 0) found[id] = Buffer.from(raw).swap16().toString('utf16le')
    else if (platform === 1) found[id] = raw.toString('latin1')
  }
  return { postscript: found[6] ?? '', full: found[4] ?? '' }
}

interface LineMetrics {
  upm: number
  ascent: number
  descent: number
  lineGap: number
}

function lineMetrics(t: Tables): LineMetrics {
  const hhea = table(t, 'hhea')
  return {
    upm: table(t, 'head').readUInt16BE(18),
    ascent: hhea.readInt16BE(4),
    descent: -hhea.readInt16BE(6),
    lineGap: hhea.readInt16BE(8),
  }
}

/** The glyph for a code point (cmap formats 4 and 12), or 0. */
function glyphOf(t: Tables, cp: number): number {
  const cmap = table(t, 'cmap')
  const n = cmap.readUInt16BE(2)
  for (let i = 0; i < n; i++) {
    const off = cmap.readUInt32BE(4 + 8 * i + 4)
    const format = cmap.readUInt16BE(off)
    if (format === 12) {
      const groups = cmap.readUInt32BE(off + 12)
      for (let g = 0; g < groups; g++) {
        const r = off + 16 + 12 * g
        const start = cmap.readUInt32BE(r)
        if (cp >= start && cp <= cmap.readUInt32BE(r + 4))
          return cmap.readUInt32BE(r + 8) + cp - start
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const off = cmap.readUInt32BE(4 + 8 * i + 4)
    if (cmap.readUInt16BE(off) !== 4 || cp > 0xffff) continue
    const segs = cmap.readUInt16BE(off + 6) / 2
    const ends = off + 14
    const starts = ends + 2 * segs + 2
    const deltas = starts + 2 * segs
    const ranges = deltas + 2 * segs
    for (let s = 0; s < segs; s++) {
      if (cp > cmap.readUInt16BE(ends + 2 * s)) continue
      const start = cmap.readUInt16BE(starts + 2 * s)
      if (cp < start) break
      const delta = cmap.readInt16BE(deltas + 2 * s)
      const ro = cmap.readUInt16BE(ranges + 2 * s)
      if (ro === 0) return (cp + delta) & 0xffff
      const g = cmap.readUInt16BE(ranges + 2 * s + ro + 2 * (cp - start))
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
  }
  return 0
}

/** Every code point a face maps to a glyph (cmap formats 4 and 12). */
function codePoints(t: Tables): Set<number> {
  const cmap = table(t, 'cmap')
  const out = new Set<number>()
  const n = cmap.readUInt16BE(2)
  for (let i = 0; i < n; i++) {
    const off = cmap.readUInt32BE(4 + 8 * i + 4)
    const format = cmap.readUInt16BE(off)
    if (format === 12) {
      const groups = cmap.readUInt32BE(off + 12)
      for (let g = 0; g < groups; g++) {
        const r = off + 16 + 12 * g
        for (let cp = cmap.readUInt32BE(r); cp <= cmap.readUInt32BE(r + 4); cp++) out.add(cp)
      }
    } else if (format === 4) {
      const segs = cmap.readUInt16BE(off + 6) / 2
      const ends = off + 14
      const starts = ends + 2 * segs + 2
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(ends + 2 * s)
        for (let cp = cmap.readUInt16BE(starts + 2 * s); cp <= end && cp < 0xffff; cp++) {
          if (glyphOf(t, cp) !== 0) out.add(cp)
        }
      }
    }
  }
  return out
}

/** Code points as a CSS unicode-range, in runs. */
function rangeOf(cps: Iterable<number>): string {
  const sorted = [...cps].sort((a, b) => a - b)
  const hex = (v: number) => v.toString(16).toUpperCase().padStart(4, '0')
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j++
    const a = sorted[i] as number
    const b = sorted[j] as number
    out.push(a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)
    i = j + 1
  }
  return out.join(', ')
}

/** Parse a CSS unicode-range into [from, to] pairs. */
function parseRange(range: string): Array<[number, number]> {
  return range.split(',').map((r): [number, number] => {
    const [a, b = a] = r.trim().replace('U+', '').split('-')
    return [Number.parseInt(a as string, 16), Number.parseInt(b as string, 16)]
  })
}

/** A code point's advance in font units, or undefined when the face has no glyph for it. */
function advanceOf(t: Tables, cp: number): number | undefined {
  const g = glyphOf(t, cp)
  if (g === 0) return undefined
  const hmtx = table(t, 'hmtx')
  const metrics = table(t, 'hhea').readUInt16BE(34)
  return hmtx.readUInt16BE(4 * Math.min(g, metrics - 1))
}

// ---- samples -----------------------------------------------------------------------------------

/** English letter frequencies (per cent of letters), and a space every ~4.7 letters. */
// biome-ignore format: a table
const LATIN: Record<string, number> = {
  a: 8.2, b: 1.5, c: 2.8, d: 4.3, e: 12.7, f: 2.2, g: 2.0, h: 6.1, i: 7.0, j: 0.15, k: 0.77,
  l: 4.0, m: 2.4, n: 6.7, o: 7.5, p: 1.9, q: 0.095, r: 6.0, s: 6.3, t: 9.1, u: 2.8, v: 0.98,
  w: 2.4, x: 0.15, y: 2.0, z: 0.074, ' ': 21,
}

const LATIN_SAMPLE = new Map(Object.entries(LATIN))

/** Average advance (em) over a weighted sample; `faceFor` finds the file holding each glyph. */
function averageEm(sample: Map<string, number>, faceFor: (cp: number) => Tables): number {
  let sum = 0
  let total = 0
  for (const [ch, w] of sample) {
    const cp = ch.codePointAt(0) as number
    const t = faceFor(cp)
    const adv = advanceOf(t, cp)
    if (adv === undefined) throw new Error(`no glyph for ${ch}`)
    sum += (w * adv) / lineMetrics(t).upm
    total += w
  }
  return sum / total
}

// ---- Fontsource faces --------------------------------------------------------------------------

interface Subset {
  file: string
  ranges: Array<[number, number]>
}

/** The woff2 subsets of a Fontsource CSS file that the app ships, with their unicode ranges. */
function subsets(pkg: string, css: string): Subset[] {
  const text = shippedStylesheet(readFileSync(join(FONTSOURCE, pkg, css), 'utf8'))
  const out: Subset[] = []
  for (const block of text.split('@font-face').slice(1)) {
    const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1]
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]
    if (file === undefined || range === undefined) continue
    out.push({ file, ranges: parseRange(range) })
  }
  return out
}

function webFace(pkg: string, css: string) {
  const subs = subsets(pkg, css)
  const cache = new Map<string, Tables>()
  const load = (file: string) => {
    let t = cache.get(file)
    if (t === undefined) {
      t = woff2Tables(readFileSync(join(FONTSOURCE, pkg, 'files', file)))
      cache.set(file, t)
    }
    return t
  }
  const faceFor = (cp: number) => {
    const s = subs.find((s) => s.ranges.some(([a, b]) => cp >= a && cp <= b))
    if (s === undefined) throw new Error(`${pkg}/${css} has no subset for U+${cp.toString(16)}`)
    return load(s.file)
  }
  /**
   * What the web face will draw, within `within`: each subset's own range, as far as its cmap
   * maps it. A fallback covers only that, so it never stands in for good where the web face has
   * no glyph (that text keeps falling through the stack, as without fallbacks).
   */
  const coverage = (within: Array<[number, number]>) => {
    const out = new Set<number>()
    const inside = (cp: number) => within.some(([a, b]) => cp >= a && cp <= b)
    for (const s of subs) {
      for (const cp of codePoints(load(s.file))) {
        if (s.ranges.some(([a, b]) => cp >= a && cp <= b) && inside(cp)) out.add(cp)
      }
    }
    return out
  }
  return { faceFor, coverage, metrics: lineMetrics(load((subs[0] as Subset).file)) }
}

// ---- the fallbacks -----------------------------------------------------------------------------

interface Local {
  file: string
  postscript: string
}

interface Rule {
  family: string
  pkg: string
  css: string
  weight: number
  style: 'normal' | 'italic'
  local: Local
}

/** Everything a face may hold. */
const ALL: Array<[number, number]> = [[0, 0x10ffff]]

const HELVETICA_NEUE = (ps: string): Local => ({
  file: `${SYSTEM}/HelveticaNeue.ttc`,
  postscript: ps,
})
const GEORGIA: Local = { file: `${SYSTEM}/Supplemental/Georgia.ttf`, postscript: 'Georgia' }
const HOEFLER_ITALIC: Local = {
  file: `${SYSTEM}/Supplemental/Hoefler Text.ttc`,
  postscript: 'HoeflerText-Italic',
}

const RULES: Rule[] = [
  ...(
    [
      [400, 'HelveticaNeue'],
      [500, 'HelveticaNeue-Medium'],
      [600, 'HelveticaNeue-Medium'],
    ] as const
  ).map(
    ([weight, ps]): Rule => ({
      family: 'Instrument Sans',
      pkg: 'instrument-sans',
      css: `${weight}.css`,
      weight,
      style: 'normal',
      local: HELVETICA_NEUE(ps),
    }),
  ),
  ...([400, 500, 600] as const).map(
    (weight): Rule => ({
      family: 'Newsreader',
      pkg: 'newsreader',
      css: `${weight}.css`,
      weight,
      style: 'normal',
      local: GEORGIA,
    }),
  ),
  {
    family: 'Patrick Hand',
    pkg: 'patrick-hand',
    css: '400.css',
    weight: 400,
    style: 'normal',
    local: HELVETICA_NEUE('HelveticaNeue'),
  },
  ...([400, 500] as const).map(
    (weight): Rule => ({
      family: 'Cormorant Garamond',
      pkg: 'cormorant-garamond',
      css: `${weight}-italic.css`,
      weight,
      style: 'italic',
      local: HOEFLER_ITALIC,
    }),
  ),
]

const pct = (v: number) => `${(v * 100).toFixed(2)}%`

function face(rule: Rule, local: Tables): string {
  const web = webFace(rule.pkg, rule.css)
  // Where both draw: the web face's coverage the local face can stand in for.
  const own = codePoints(local)
  const range = rangeOf([...web.coverage(ALL)].filter((cp) => own.has(cp)))
  const adjust = averageEm(LATIN_SAMPLE, web.faceFor) / averageEm(LATIN_SAMPLE, () => local)
  const m = web.metrics
  const n = names(local)
  const lines = [
    '@font-face {',
    `  font-family: "${rule.family} Fallback";`,
    `  font-style: ${rule.style};`,
    `  font-weight: ${rule.weight};`,
    `  src: local("${n.full}"), local("${n.postscript}");`,
    `  size-adjust: ${pct(adjust)};`,
    `  ascent-override: ${pct(m.ascent / m.upm / adjust)};`,
    `  descent-override: ${pct(m.descent / m.upm / adjust)};`,
    `  line-gap-override: ${pct(m.lineGap / m.upm / adjust)};`,
  ]
  // As the repo's formatter writes it: a value too long for one line goes on the next.
  const one = `  unicode-range: ${range};`
  lines.push(one.length <= 100 ? one : `  unicode-range:\n    ${range};`)
  lines.push('}')
  return lines.join('\n')
}

/** The faces with their installed versions, as the header names them. */
function versions(): string {
  const seen = new Map<string, string>()
  for (const r of RULES) {
    const pkg = JSON.parse(readFileSync(join(FONTSOURCE, r.pkg, 'package.json'), 'utf8')) as {
      version: string
    }
    seen.set(r.family, pkg.version)
  }
  return [...seen].map(([family, v]) => `${family} ${v}`).join(', ')
}

function main(): void {
  const locals = new Map<string, Map<string, Tables>>()
  const localFace = (l: Local): Tables => {
    let c = locals.get(l.file)
    if (c === undefined) {
      c = collection(l.file)
      locals.set(l.file, c)
    }
    const t = c.get(l.postscript)
    if (t === undefined) throw new Error(`${l.postscript} is not in ${l.file}`)
    return t
  }
  const out: string[] = []
  let family = ''
  for (const rule of RULES) {
    if (rule.family !== family) {
      family = rule.family
      out.push(`/* ${family} (@fontsource/${rule.pkg}) → ${names(localFace(rule.local)).full}… */`)
    }
    out.push(face(rule, localFace(rule.local)))
  }
  const header = `/*
 * Metric-matched local fallbacks for the web faces: while a face (or a subset of
 * it) is still on its way, text is set in a system face with the web face's line metrics and,
 * through size-adjust, its average advance, so nothing moves when the web face swaps in.
 *
 * GENERATED by tools/font-metrics.ts (\`pnpm --filter @papertie/tools font-metrics\`); do not edit.
 * Source: the hhea, head, cmap and hmtx tables of the @fontsource woff2 files in
 * apps/web/node_modules and of the macOS system faces named in each src. The web faces:
 * ${versions()}.
 * size-adjust: average advance over English letter frequencies; the overrides are the web face's
 * hhea ascent, descent and line gap divided by size-adjust (which scales them too).
 * unicode-range: what the web face's shipped subsets map (their cmaps, within their declared
 * ranges) and the local face also has, so a fallback never stands in for good for a glyph its web
 * face lacks.
 */
`
  writeFileSync(OUT, `${header}\n${out.join('\n\n')}\n`)
  console.log(`wrote ${OUT}`)
}

main()
