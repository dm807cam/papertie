import { mulberry32 } from '../rng'
import { fbm1D, smoothstep } from './noise'

/** Edge length of the mask viewBox and of the middle slice (128 - 2 × 12). */
const BOX = 128
const MIDDLE = 104
const CORNER_RADIUS = 2
/** Path sample spacing along an edge, fine enough for the torn teeth. */
const STEP = 0.5
const FIBRES_PER_EDGE = 30

/** Width of the 9-slice band (`12 fill / 12px stretch` in note.css). Every tear stays inside it. */
export const DECKLE_SLICE = 12
/** The shallowest and deepest inward bite of the opaque paper edge. */
export const DECKLE_MIN_BITE = 0.75
export const DECKLE_MAX_BITE = 8

/**
 * Inward edge displacement in [DECKLE_MIN_BITE, DECKLE_MAX_BITE] at position `s` along an edge:
 * a slow wobble, a mid-scale ragged run, sharp torn teeth and the odd deep notch. Periodic over
 * the 104-unit middle slice, so the 12-unit corner slices continue the pattern.
 */
export function deckleProfile(index: number, seed: number): (s: number) => number {
  return profile(seed + index)
}

function profile(seed: number): (s: number) => number {
  return (s) => {
    const u = s / MIDDLE
    const wobble = fbm1D(u, 5, 3, seed) * 0.5 + 0.5
    const ragged = fbm1D(u, 17, 2, seed + 11) * 0.5 + 0.5
    const teeth = Math.abs(fbm1D(u, 52, 2, seed + 23))
    const notch = smoothstep(0.05, 0.5, fbm1D(u, 9, 2, seed + 37))
    const d = 0.8 + 3 * smoothstep(0.2, 0.8, wobble) + 1.4 * ragged + 2.3 * teeth + 2.6 * notch
    return Math.min(DECKLE_MAX_BITE, Math.max(DECKLE_MIN_BITE, d))
  }
}

const fmt = (n: number) => String(Math.round(n * 100) / 100)

type Profile = (s: number) => number

/** A closed outline whose four edges sit `top(s)` … `left(t)` in from the box, rounded corners. */
function outline(top: Profile, right: Profile, bottom: Profile, left: Profile): string {
  const r = CORNER_RADIUS
  const pts: string[] = []
  const line = (x: number, y: number) => pts.push(`L${fmt(x)} ${fmt(y)}`)
  const curve = (cx: number, cy: number, x: number, y: number) =>
    pts.push(`Q${fmt(cx)} ${fmt(cy)} ${fmt(x)} ${fmt(y)}`)
  const up = (a: number) => Math.ceil(a / STEP) * STEP
  const down = (a: number) => Math.floor(a / STEP) * STEP

  // Corner control points: where the neighbouring edges' displacements meet.
  const tl = { x: left(0), y: top(0) }
  const tr = { x: BOX - right(0), y: top(BOX) }
  const br = { x: BOX - right(BOX), y: BOX - bottom(BOX) }
  const bl = { x: left(BOX), y: BOX - bottom(0) }

  const startX = tl.x + r
  const endTopX = tr.x - r
  const move = `M${fmt(startX)} ${fmt(top(startX))}`

  for (let s = up(startX); s <= down(endTopX); s += STEP) line(s, top(s))
  line(endTopX, top(endTopX))
  curve(tr.x, tr.y, BOX - right(tr.y + r), tr.y + r)
  for (let t = up(tr.y + r); t <= down(br.y - r); t += STEP) line(BOX - right(t), t)
  curve(br.x, br.y, br.x - r, BOX - bottom(br.x - r))
  for (let s = down(br.x - r); s >= up(bl.x + r); s -= STEP) line(s, BOX - bottom(s))
  curve(bl.x, bl.y, left(bl.y - r), bl.y - r)
  for (let t = down(bl.y - r); t >= up(tl.y + r); t -= STEP) line(left(t), t)
  curve(tl.x, tl.y, startX, top(startX))
  return `${move}${pts.join('')}Z`
}

/**
 * Fine fibre wisps pulled out of each torn edge: short, slightly curved strokes from just inside
 * the paper edge outward into the bite, never past 0.3 units from the box edge.
 */
function fibres(edges: Profile[], seed: number): string {
  const rand = mulberry32(seed)
  const out: string[] = []
  edges.forEach((depth, e) => {
    for (let k = 0; k < FIBRES_PER_EDGE; k++) {
      const s = DECKLE_SLICE / 2 + rand() * (BOX - DECKLE_SLICE)
      const d = depth(s)
      const root = d + 0.4
      const reach = Math.min(d - 0.3, 1.2 + rand() * 3.6)
      const tilt = (rand() * 2 - 1) * 0.9
      const bend = (rand() * 2 - 1) * 0.8
      const width = 0.2 + rand() * 0.35
      const alpha = 0.35 + rand() * 0.45
      if (reach < 0.6) continue
      // Edge-local frame: `a` runs along the edge, `b` is the distance in from the box edge.
      const tip = { a: s + Math.sin(tilt) * reach, b: root - Math.cos(tilt) * (reach + 0.4) }
      const mid = { a: (s + tip.a) / 2 + bend, b: (root + tip.b) / 2 }
      const tipB = Math.max(0.3, tip.b)
      const map = (a: number, b: number): [number, number] => {
        if (e === 0) return [a, b]
        if (e === 1) return [BOX - b, a]
        if (e === 2) return [BOX - a, BOX - b]
        return [b, BOX - a]
      }
      const [x0, y0] = map(s, root)
      const [cx, cy] = map(mid.a, Math.max(0.3, mid.b))
      const [x1, y1] = map(tip.a, tipB)
      out.push(
        `<path d="M${fmt(x0)} ${fmt(y0)}Q${fmt(cx)} ${fmt(cy)} ${fmt(x1)} ${fmt(y1)}" stroke-width="${fmt(width)}" stroke-opacity="${fmt(alpha)}"/>`,
      )
    }
  })
  return out.join('')
}

/**
 * A 128 × 128 torn-paper mask: an opaque closed path with deep, irregular edges, a translucent
 * fringe just outside it (the thinned rim of a tear) and fibre wisps reaching into the bite.
 * The explicit 128 px size matters: without it, CSS sizes the image to each note's box, which
 * scales the bites with the note and moves the 12 px slice lines off the 12-unit corners.
 */
export function generateDeckleSvg(index: number, seed: number): string {
  const edges = [0, 1000, 2000, 3000].map((o) => profile(seed + index + o))
  const [top, right, bottom, left] = edges as [Profile, Profile, Profile, Profile]
  const rims = [0, 1000, 2000, 3000].map((o, i) => {
    const edge = edges[i] as Profile
    return (s: number) => {
      const thin =
        0.2 + 1.6 * smoothstep(-0.3, 0.6, fbm1D(s / MIDDLE, 26, 2, seed + index + o + 500))
      return Math.max(0.3, edge(s) - thin)
    }
  }) as [Profile, Profile, Profile, Profile]
  const paper = outline(top, right, bottom, left)
  const fringe = outline(...rims)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BOX}" height="${BOX}" viewBox="0 0 ${BOX} ${BOX}"><path fill="#fff" fill-opacity="0.5" d="${fringe}"/><path fill="#fff" d="${paper}"/><g fill="none" stroke="#fff" stroke-linecap="round">${fibres(edges, seed + index * 7 + 4242)}</g></svg>\n`
}
