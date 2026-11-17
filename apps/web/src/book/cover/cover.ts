import { type Book, COVER_INKS, COVER_MOTIFS, type CoverInk, PALETTE } from '@papertie/core'
import { mulberry32 } from './rng'

/*
 * A book's cover: cream fibre paper, one generated abstract drawing in a palette ink and a second
 * ink from the same palette, and the title set on plain paper. Everything is drawn from the
 * cover's seed, which is random when the book is made and fixed after: the title never enters it,
 * so renaming keeps the cover.
 *
 * Three families. Fields: flat rectangles of colour to the cover's edge, nested or offset, the
 * title on an inset label of bare paper. Overprint: discs, half discs and bars in two inks that
 * darken where they cross. Contour: the level lines of a seeded landscape, or a board's grain
 * bowing round a knot, in one ink. Pure data, cheap enough to run as a shelf scrolls (one cover
 * well under a millisecond, its SVG under 4 KB).
 */

export type Cover = Book['cover']
export type CoverMotif = Cover['motif']

/** Where the title sits; the drawing takes the space it leaves. */
export const COVER_LAYOUTS = ['head', 'foot', 'aside'] as const
export type CoverLayout = (typeof COVER_LAYOUTS)[number]

interface Paint {
  /** 0 to 1; absent when solid. */
  opacity?: number
}

/** One primitive of the drawing, in the cover's own units, painted in the order given. */
export type CoverShape =
  | (Paint & { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string })
  | (Paint & { kind: 'disc'; cx: number; cy: number; r: number; fill: string })
  | (Paint & {
      kind: 'ring'
      cx: number
      cy: number
      r: number
      stroke: string
      width: number
    })
  | (Paint & { kind: 'area'; d: string; fill: string; evenodd?: true })
  | { kind: 'line'; d: string; stroke: string; width: number }

export interface CoverSize {
  w: number
  h: number
}

export interface CoverBox {
  x: number
  y: number
  w: number
  h: number
}

/* Each use of the seed takes its own stream, so one never shifts another. */
const SALT_PICK = 0
const SALT_LAYOUT = 0x2c1b3c6d
const SALT_DRAW = 0x9e3779b9
const SALT_SECOND = 0x51ed270b

const stream = (seed: number, salt: number) => mulberry32((seed ^ salt) >>> 0)

/*
 * The inks, weighted: ink and indigo on most books; the softer dyes on fewer, so a shelf stays
 * quiet.
 */
const INK_WEIGHTS: Record<CoverInk, number> = {
  ink: 34,
  indigo: 26,
  sage: 14,
  ochre: 12,
  lilac: 8,
  rose: 6,
}
const INK_TOTAL = COVER_INKS.reduce((n, k) => n + INK_WEIGHTS[k], 0)

/** The cover a seed gives: its ink and motif, drawn from the seed. */
export function coverFromSeed(seed: number): Cover {
  const r = stream(seed, SALT_PICK)
  let pick = r() * INK_TOTAL
  let ink: CoverInk = COVER_INKS[0]
  for (const k of COVER_INKS) {
    ink = k
    pick -= INK_WEIGHTS[k]
    if (pick < 0) break
  }
  const motif = COVER_MOTIFS[Math.floor(r() * COVER_MOTIFS.length)] ?? COVER_MOTIFS[0]
  return { seed: seed >>> 0, ink, motif }
}

/** A new book's cover, or "New cover": a fresh random seed. */
export function newCover(): Cover {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return coverFromSeed(a[0] ?? 0)
}

/** Where the cover's title sits, from its seed. */
export function coverLayout(cover: Cover): CoverLayout {
  const r = stream(cover.seed, SALT_LAYOUT)
  return COVER_LAYOUTS[Math.floor(r() * COVER_LAYOUTS.length)] ?? 'head'
}

/* ---------- Colour ---------- */

/** The second ink a cover may take, by its first: one of a fixed pair, picked by the seed. */
const SECOND_INK: Record<CoverInk, readonly [string, string]> = {
  rose: [PALETTE.ochre.yarn, PALETTE.indigo.yarn],
  indigo: [PALETTE.apricot.yarn, PALETTE.ochre.yarn],
  sage: [PALETTE.ochre.yarn, PALETTE.indigo.yarn],
  lilac: [PALETTE.rose.yarn, PALETTE.indigo.yarn],
  ochre: [PALETTE.indigo.yarn, PALETTE.apricot.yarn],
  ink: [PALETTE.apricot.yarn, PALETTE.ochre.yarn],
}

/** The pale field of an ink cover, whose own paper is dark. */
const INK_TINT = '#D9D3C7'

export interface CoverColours {
  /** The cover's ink. */
  ink: string
  /** Its second ink. */
  second: string
  /** The ink's pale paper, for a quiet field. */
  tint: string
}

/** The colours a cover is drawn in, from its ink and seed. */
export function coverColours(cover: Cover): CoverColours {
  const pair = SECOND_INK[cover.ink]
  return {
    ink: PALETTE[cover.ink].yarn,
    second: pair[Math.floor(stream(cover.seed, SALT_SECOND)() * 2)] ?? pair[0],
    tint: cover.ink === 'ink' ? INK_TINT : PALETTE[cover.ink].paper,
  }
}

const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
const hexOf = (c: number[]) =>
  `#${c
    .map((v) => Math.round(v).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
const mix = (a: string, b: string, t: number) => {
  const B = channels(b)
  return hexOf(channels(a).map((v, i) => v + ((B[i] ?? 0) - v) * t))
}
/** Two inks printed one over the other. */
const multiply = (a: string, b: string) => {
  const B = channels(b)
  return hexOf(channels(a).map((v, i) => (v * (B[i] ?? 0)) / 255))
}

/* ---------- Room ---------- */

/** The drawing's width in its own units: the shelf's cover, in px. */
const UNIT_W = 104
/** The title's share of the cover's height: its three or four lines and their margin. */
const TITLE_SHARE = 0.4
/** The margin of a fields cover's label. */
const LABEL_INSET = 6

const tenth = (v: number) => Math.round(v * 10) / 10

/**
 * The paper kept bare for the title: the top of the cover, or the bottom under a `foot` title.
 * On a fields cover, whose colour runs to the edge, it is a label inset in that band.
 */
export function coverTitleBox(cover: Cover, size: CoverSize): CoverBox {
  const s = size.w / UNIT_W
  const zone = tenth(size.h * TITLE_SHARE)
  const y = coverLayout(cover) === 'foot' ? size.h - zone : 0
  if (cover.motif !== 'fields') return { x: 0, y, w: size.w, h: zone }
  const inset = LABEL_INSET * s
  return { x: inset, y: y === 0 ? inset : y, w: size.w - 2 * inset, h: zone - inset }
}

/** The room the drawing is kept to: the whole of a fields cover, the rest of the others. */
export function coverRoom(cover: Cover, size: CoverSize): CoverBox {
  if (cover.motif === 'fields') return { x: 0, y: 0, w: size.w, h: size.h }
  const zone = tenth(size.h * TITLE_SHARE)
  return { x: 0, y: coverLayout(cover) === 'foot' ? 0 : zone, w: size.w, h: size.h - zone }
}

/* ---------- Paths: relative, in tenths ---------- */

/** One number in tenths of a unit, as short as SVG allows (`.5`, `-1.2`, `3`). */
function num(tenths: number): string {
  const neg = tenths < 0
  const a = neg ? -tenths : tenths
  const int = Math.floor(a / 10)
  const frac = a - int * 10
  const body = frac === 0 ? String(int) : int === 0 ? `.${frac}` : `${int}.${frac}`
  return neg ? `-${body}` : body
}

class PathWriter {
  out = ''
  private last = ''
  private cmd = ''
  /** The pen, in tenths. */
  private cx = 0
  private cy = 0
  /** The last curve's control point, in tenths: the next `t` mirrors it. */
  private qx = 0
  private qy = 0

  constructor(private readonly scale: number) {}

  private push(tenths: number) {
    const s = num(tenths)
    // A separator only where the numbers would run together.
    const glue = s[0] === '-' || (s[0] === '.' && this.last.includes('.')) ? '' : ' '
    this.out += this.last === '' ? s : glue + s
    this.last = s
  }

  private op(c: string) {
    // A repeated command's letter is left out, but never a move's: its next pair would be a line.
    if (c === this.cmd && c !== 'm') return
    this.out += c
    this.cmd = c
    this.last = ''
  }

  private rel(x: number, y: number) {
    this.push(x - this.cx)
    this.push(y - this.cy)
    this.cx = x
    this.cy = y
  }

  private at(v: number) {
    return Math.round(v * this.scale * 10)
  }

  private move(x: number, y: number) {
    if (this.out === '') {
      this.out = 'M'
      this.cmd = 'M'
      this.last = ''
      this.cx = 0
      this.cy = 0
    } else this.op('m')
    this.rel(this.at(x), this.at(y))
  }

  /**
   * A curve through `pts` (x, y flat): each inner point the control of a quadratic that ends
   * midway to the next, written as one `q` and a run of `t`. Each end is rounded against the
   * control the `t` after it will mirror, so rounding never adds up along the line.
   */
  curve(pts: readonly number[], closed = false) {
    const n = pts.length / 2
    if (n < 2 || (closed && n < 3)) return
    const px = (i: number) => this.at(pts[2 * (((i % n) + n) % n)] ?? 0)
    const py = (i: number) => this.at(pts[2 * (((i % n) + n) % n) + 1] ?? 0)
    if (closed)
      this.move(
        ((pts[2 * n - 2] ?? 0) + (pts[0] ?? 0)) / 2,
        ((pts[2 * n - 1] ?? 0) + (pts[1] ?? 0)) / 2,
      )
    else this.move(pts[0] ?? 0, pts[1] ?? 0)
    const sx = this.cx
    const sy = this.cy
    if (!closed && n === 2) {
      this.op('l')
      this.rel(px(1), py(1))
      return
    }
    const first = closed ? 0 : 1
    const end = closed ? n - 1 : n - 2
    for (let i = first; i <= end; i++) {
      // The control this segment takes: its own point on the first, the mirrored one after.
      const kx = i === first ? px(i) : 2 * this.cx - this.qx
      const ky = i === first ? py(i) : 2 * this.cy - this.qy
      const last = !closed && i === end
      const ex = last ? px(i + 1) : Math.round((kx + px(i + 1)) / 2)
      const ey = last ? py(i + 1) : Math.round((ky + py(i + 1)) / 2)
      if (i === first) {
        this.op('q')
        this.push(kx - this.cx)
        this.push(ky - this.cy)
      } else this.op('t')
      this.rel(ex, ey)
      this.qx = kx
      this.qy = ky
    }
    if (closed) {
      this.op('z')
      this.cx = sx
      this.cy = sy
    }
  }
}

/* ---------- The three families ---------- */

interface Frame {
  /** The cover in the drawing's units: 104 across. */
  W: number
  H: number
  /** The title's band, and whether it is the bottom one. */
  zone: number
  foot: boolean
  /** The drawing's units in the size asked for. */
  s: number
}

/** Fields: nested or offset rectangles, flat colour to the edge, no blending. */
function fields(out: CoverShape[], r: () => number, c: CoverColours, f: Frame, label: CoverBox) {
  const { W, H, s } = f
  const rect = (x: number, y: number, w: number, h: number, fill: string) =>
    out.push({
      kind: 'rect',
      x: tenth(x * s),
      y: tenth(y * s),
      w: tenth(w * s),
      h: tenth(h * s),
      fill,
    })
  const scheme = Math.floor(r() * 3)
  const mid = mix(c.ink, c.tint, 0.55)
  const [ground, seq] =
    scheme === 0
      ? [c.ink, [mid, c.second, c.tint]]
      : scheme === 1
        ? [c.tint, [c.ink, mid, c.second]]
        : [c.ink, [c.tint, c.second, c.ink]]
  // The ground, with the label left out of it: the title sits on the cover's own paper.
  const n = (v: number) => num(Math.round(v * 10))
  out.push({
    kind: 'area',
    d: `M0 0H${n(W * s)}V${n(H * s)}H0zM${n(label.x)} ${n(label.y)}v${n(label.h)}h${n(label.w)}v${n(-label.h)}z`,
    fill: ground,
    evenodd: true,
  })
  const top = f.foot ? 12 : H - 80
  if (r() < 0.62) {
    // Nested, each field set off-centre inside the last.
    const count = 2 + Math.floor(r() * 2)
    const bx = [-1, 0, 1][Math.floor(r() * 3)] ?? 0
    const by = [1, 1, -1, 0][Math.floor(r() * 4)] ?? 0
    let x = 12
    let y = top
    let w = 80
    let h = 68
    for (let k = 0; k < count; k++) {
      rect(x, y, w, h, seq[k] ?? c.ink)
      const nw = w * 0.7
      const nh = h * 0.7
      x += (w - nw) * (0.5 + 0.36 * bx)
      y += (h - nh) * (0.5 + 0.36 * by)
      w = nw
      h = nh
    }
  } else {
    // Two fields offset, their overlap printed as the two inks multiplied.
    const flip = r() < 0.5
    const a = seq[0] ?? c.ink
    const b = seq[1] ?? c.second
    const ax = flip ? 34 : 12
    const bx = flip ? 12 : 40
    const aw = 58
    const bw = 52
    rect(ax, top, aw, 44, a)
    rect(bx, top + 26, bw, 42, b)
    const ox = Math.max(ax, bx)
    rect(ox, top + 26, Math.min(ax + aw, bx + bw) - ox, 18, multiply(a, b))
  }
}

/** Overprint: a disc, a half disc and a third form, two inks, darker where they cross. */
function overprint(out: CoverShape[], r: () => number, c: CoverColours, f: Frame) {
  const { W, H, s } = f
  const y0 = f.foot ? 0 : f.zone
  const ah = H - f.zone
  const t = (v: number) => tenth(v * s)
  const cx = 52 + (r() - 0.5) * 40
  const cy = y0 + ah / 2 + (r() - 0.5) * 22
  const rad = 27 + r() * 11
  out.push({ kind: 'disc', cx: t(cx), cy: t(cy), r: t(rad), fill: c.ink, opacity: 0.92 })
  // A half disc, its flat side one of four ways, set against the disc's edge.
  const r2 = 24 + r() * 14
  const ang = r() * Math.PI * 2
  const o = Math.floor(r() * 4)
  const hx = cx + Math.cos(ang) * rad * 0.85
  const hy = cy + Math.sin(ang) * rad * 0.7
  const dx = [r2, 0, -r2, 0][o] ?? 0
  const dy = [0, r2, 0, -r2][o] ?? 0
  out.push({
    kind: 'area',
    d: `M${t(hx - dx)} ${t(hy - dy)}A${t(r2)} ${t(r2)} 0 0 1 ${t(hx + dx)} ${t(hy + dy)}z`,
    fill: c.second,
    opacity: 0.9,
  })
  const kind = Math.floor(r() * 3)
  if (kind === 0) {
    // A quarter disc out of one of the room's corners.
    const q = 36 + r() * 16
    const left = r() < 0.5
    const up = r() < 0.5
    out.push({
      kind: 'disc',
      cx: left ? 0 : t(W),
      cy: t(up ? y0 : y0 + ah),
      r: t(q),
      fill: c.ink,
      opacity: 0.5,
    })
  } else if (kind === 1) {
    // A bar the height of the room.
    const bw = 12 + r() * 8
    const bx = 10 + r() * (W - 20 - bw)
    out.push({
      kind: 'rect',
      x: t(bx),
      y: t(y0),
      w: t(bw),
      h: t(ah),
      fill: c.second,
      opacity: 0.62,
    })
  } else {
    const rr = 30 + r() * 10
    const ox = r() < 0.5 ? 14 : W - 14
    const oy = y0 + (r() < 0.5 ? 16 : ah - 16)
    out.push({
      kind: 'ring',
      cx: t(ox),
      cy: t(oy),
      r: t(rr),
      stroke: c.ink,
      width: t(7),
      opacity: 0.55,
    })
  }
}

/** The weights of a contour cover's lines: most fine, every fourth or fifth heavier. */
const FINE = 0.62
const BOLD = 1.25

/** The level lines' grid: its cell, in units. Coarse, since each line is drawn as a curve. */
const CELL = 4
const LEVELS = 13

/**
 * Level lines of a few seeded hills, by marching squares over the room, each level's crossings
 * chained into whole lines so a line is one short curve, not a run of loose segments.
 */
function levelLines(fine: PathWriter, bold: PathWriter, r: () => number, f: Frame) {
  const { W, H } = f
  const count = 3 + Math.floor(r() * 2)
  const hx: number[] = []
  const hy: number[] = []
  const hk: number[] = []
  const ha: number[] = []
  for (let i = 0; i < count; i++) {
    hx.push(-10 + r() * (W + 20))
    hy.push(-10 + r() * (H + 20))
    const spread = 22 + r() * 26
    hk.push(-1 / (2 * spread * spread))
    ha.push((i % 2 ? -1 : 1) * (0.6 + r() * 0.6))
  }
  const tx = (r() - 0.5) * 0.008
  const ty = (r() - 0.5) * 0.008
  const height = (x: number, y: number) => {
    let v = tx * x + ty * y
    for (let i = 0; i < count; i++) {
      const dx = x - (hx[i] ?? 0)
      const dy = y - (hy[i] ?? 0)
      v += (ha[i] ?? 0) * Math.exp((dx * dx + dy * dy) * (hk[i] ?? 0))
    }
    return v
  }
  const y0 = f.foot ? 0 : f.zone
  const cols = Math.round(W / CELL) + 1
  const rows = Math.round((H - f.zone) / CELL) + 1
  const gx = W / (cols - 1)
  const gy = (H - f.zone) / (rows - 1)
  const v = new Float64Array(cols * rows)
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const z = height(i * gx, y0 + j * gy)
      v[j * cols + i] = z
      if (z < lo) lo = z
      if (z > hi) hi = z
    }
  // The levels are spread over the whole landscape, the part under the title too.
  const z0 = f.foot ? H - f.zone : 0
  for (let y = CELL; y < f.zone; y += 2 * CELL)
    for (let x = 0; x <= W; x += 2 * CELL) {
      const z = height(x, z0 + y)
      if (z < lo) lo = z
      if (z > hi) hi = z
    }
  // A grid edge is crossed once by a level: across edges first, then down edges, by their cell.
  const down = cols * rows
  const link = new Int16Array(4 * down)
  const ex = new Float64Array(2 * down)
  const ey = new Float64Array(2 * down)
  const seen = new Uint8Array(2 * down)
  const touched: number[] = []
  const pts: number[] = []
  for (let k = 1; k < LEVELS; k++) {
    const L = lo + ((hi - lo) * k) / LEVELS
    link.fill(-1)
    seen.fill(0)
    touched.length = 0
    const join = (a: number, b: number) => {
      link[2 * a + (link[2 * a] === -1 ? 0 : 1)] = b
      link[2 * b + (link[2 * b] === -1 ? 0 : 1)] = a
    }
    for (let j = 0; j < rows - 1; j++)
      for (let i = 0; i < cols - 1; i++) {
        const at = j * cols + i
        const a = v[at] ?? 0
        const b = v[at + 1] ?? 0
        const c = v[at + cols + 1] ?? 0
        const d = v[at + cols] ?? 0
        const idx = (a > L ? 1 : 0) | (b > L ? 2 : 0) | (c > L ? 4 : 0) | (d > L ? 8 : 0)
        if (idx === 0 || idx === 15) continue
        const top = at
        const bottom = at + cols
        const left = down + at
        const right = down + at + 1
        const x = i * gx
        const y = y0 + j * gy
        // Each crossed edge's point, set once (its other cell finds the same one).
        if ((idx & 1) !== ((idx >> 1) & 1) && seen[top] === 0) {
          seen[top] = 1
          touched.push(top)
          ex[top] = x + (gx * (L - a)) / (b - a)
          ey[top] = y
        }
        if (((idx >> 3) & 1) !== ((idx >> 2) & 1) && seen[bottom] === 0) {
          seen[bottom] = 1
          touched.push(bottom)
          ex[bottom] = x + (gx * (L - d)) / (c - d)
          ey[bottom] = y + gy
        }
        if ((idx & 1) !== ((idx >> 3) & 1) && seen[left] === 0) {
          seen[left] = 1
          touched.push(left)
          ex[left] = x
          ey[left] = y + (gy * (L - a)) / (d - a)
        }
        if (((idx >> 1) & 1) !== ((idx >> 2) & 1) && seen[right] === 0) {
          seen[right] = 1
          touched.push(right)
          ex[right] = x + gx
          ey[right] = y + (gy * (L - b)) / (c - b)
        }
        switch (idx) {
          case 1:
          case 14:
            join(left, top)
            break
          case 2:
          case 13:
            join(top, right)
            break
          case 3:
          case 12:
            join(left, right)
            break
          case 4:
          case 11:
            join(right, bottom)
            break
          case 6:
          case 9:
            join(top, bottom)
            break
          case 7:
          case 8:
            join(left, bottom)
            break
          case 5:
            join(left, top)
            join(right, bottom)
            break
          default:
            join(top, right)
            join(left, bottom)
        }
      }
    const out = k % 4 === 0 ? bold : fine
    // Lines that end at the room's edge first, from an end; what is left are closed rings.
    for (let pass = 0; pass < 2; pass++)
      for (const start of touched) {
        if (seen[start] !== 1) continue
        if (pass === 0 && link[2 * start + 1] !== -1) continue
        pts.length = 0
        let prev = -1
        let e = start
        while (e !== -1 && seen[e] === 1) {
          seen[e] = 2
          pts.push(ex[e] ?? 0, ey[e] ?? 0)
          const n0 = link[2 * e] ?? -1
          const next = n0 !== prev ? n0 : (link[2 * e + 1] ?? -1)
          prev = e
          e = next
        }
        out.curve(thinned(pts, pass === 1), pass === 1)
      }
  }
}

/** Every other point of a line (its two ends kept), or of a ring: enough for a curve. */
function thinned(pts: readonly number[], closed: boolean): number[] {
  const n = pts.length / 2
  if (n < 6) return pts.slice()
  const out: number[] = []
  for (let i = 0; i < n; i += 2) out.push(pts[2 * i] ?? 0, pts[2 * i + 1] ?? 0)
  if (!closed && n % 2 === 0) out.push(pts[2 * n - 2] ?? 0, pts[2 * n - 1] ?? 0)
  return out
}

/** The grain's lines: the gap between them, and between the points each is curved through. */
const GRAIN_GAP = 3.6
const GRAIN_STEP = 8

/** Grain: near-parallel lines, each bowing round one or two knots. */
function grain(fine: PathWriter, bold: PathWriter, r: () => number, f: Frame) {
  const { W, H } = f
  const knots: { x: number; y: number; kx: number; sy: number; k: number }[] = []
  const count = 1 + Math.floor(r() * 2)
  for (let i = 0; i < count; i++) {
    const x = 18 + r() * (W - 36)
    const y = 20 + r() * (H - 40)
    const sx = 12 + r() * 12
    knots.push({ x, y, kx: -1 / (2 * sx * sx), sy: 9 + r() * 9, k: 7 + r() * 7 })
  }
  const p1 = r() * 6.3
  const p2 = r() * 6.3
  const y0 = f.foot ? 0 : f.zone
  const y1 = y0 + H - f.zone
  // The furthest a line is moved off its own height: both knots' bows and the two waves.
  const reach = knots.reduce((n, k) => n + k.k, 3.3)
  const pts: number[] = []
  const bow: number[] = []
  let i = 0
  for (let y = -14; y < H + 14; y += GRAIN_GAP, i++) {
    if (y < y0 - reach || y > y1 + reach) continue
    pts.length = 0
    // How hard each knot bows this line, and which way: up above the knot, down below it.
    for (let k = 0; k < knots.length; k++) {
      const knot = knots[k]
      if (!knot) continue
      const dy = y - knot.y
      bow[k] = knot.k * (dy < 0 ? -1 : 1) * Math.exp(-Math.abs(dy) / knot.sy)
    }
    let inside = false
    for (let x = -GRAIN_STEP / 2; x <= W + GRAIN_STEP / 2; x += GRAIN_STEP) {
      let yy = y + 2.2 * Math.sin(x * 0.045 + p1 + y * 0.012) + 1.1 * Math.sin(x * 0.11 + p2)
      for (let k = 0; k < knots.length; k++) {
        const knot = knots[k]
        if (knot) yy += (bow[k] ?? 0) * Math.exp((x - knot.x) ** 2 * knot.kx)
      }
      if (yy > y0 - 1 && yy < y1 + 1) inside = true
      pts.push(x, yy)
    }
    // A line that never enters the room is not drawn.
    if (inside) (i % 5 === 0 ? bold : fine).curve(pts)
  }
}

/** Contour: level lines or grain, in the one ink, as two paths (fine and heavier). */
function contour(out: CoverShape[], r: () => number, c: CoverColours, f: Frame) {
  const fine = new PathWriter(f.s)
  const bold = new PathWriter(f.s)
  if (r() < 0.6) levelLines(fine, bold, r, f)
  else grain(fine, bold, r, f)
  if (fine.out)
    out.push({ kind: 'line', d: fine.out, stroke: c.ink, width: tenth(FINE * f.s * 10) / 10 })
  if (bold.out)
    out.push({ kind: 'line', d: bold.out, stroke: c.ink, width: tenth(BOLD * f.s * 10) / 10 })
}

/**
 * The cover's drawing as data: a handful of primitives in the cover's inks, to be clipped to
 * `coverRoom` (an overprint's shapes multiplied over one another).
 */
export function coverShapes(cover: Cover, size: CoverSize): CoverShape[] {
  const r = stream(cover.seed, SALT_DRAW)
  const s = size.w / UNIT_W
  const H = size.h / s
  const f: Frame = {
    W: UNIT_W,
    H,
    zone: tenth(size.h * TITLE_SHARE) / s,
    foot: coverLayout(cover) === 'foot',
    s,
  }
  const c = coverColours(cover)
  const out: CoverShape[] = []
  if (cover.motif === 'overprint') overprint(out, r, c, f)
  else if (cover.motif === 'contour') contour(out, r, c, f)
  else fields(out, r, c, f, coverTitleBox(cover, size))
  return out
}
