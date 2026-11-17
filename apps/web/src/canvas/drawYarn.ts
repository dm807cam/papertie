import { PIN_BRASS } from '../styles/stationery'
import type { Point } from './types'

/**
 * The cord, as multiples of its width `w` where not px: width per world px and its screen
 * clamps; the shadow's colour and down-right offset; the twist: one slanted ply stripe per
 * `twist` along the strand, reaching `plyReach` either side of the centre and leaning `plyLean`
 * along it, lit (`plyWidth`, toward white by `plyLighten`) with a dark groove half a period
 * on (`grooveWidth`, toward black by `plyDarken`); and the crown, a narrow line toward white by
 * `crownLighten`, `crownOffset` toward the light (up-left), that rounds the cord. Strands
 * thinner than `twistMinPx` on screen skip twist and crown: sub-pixel noise, and dense to draw.
 * The cord was first drawn 9.5-10.5 px across with a fine twist
 * about 8 px a turn, low in contrast. Thinned by 28 % to 7.2 px, its cap with it;
 * its twist keeps its turn (8.2 px at zoom 1, so no more stripes than the 10 px cord
 * drew) and its 4.5 px floor (from zoom 0.625).
 */
export const YARN_STYLE = {
  widthWorld: 7.2,
  minPx: 1.5,
  maxPx: 17,
  shadow: 'rgba(43,28,14,0.26)',
  shadowOffset: [0.2, 0.4],
  twist: 1.14,
  plyReach: 0.38,
  plyLean: 0.3,
  plyWidth: 0.26,
  grooveWidth: 0.16,
  plyLighten: 0.24,
  plyDarken: 0.24,
  crownWidth: 0.24,
  crownOffset: [-0.08, -0.2],
  crownLighten: 0.3,
  twistMinPx: 4.5,
} as const

/** How much wider a selected strand is drawn. */
export const SELECTED_SCALE = 1.35
const PIN_GLOW = 'rgba(231,200,115,0.6)'

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const safeZoom = (zoom: number) => (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)

/**
 * On-screen strand width: 7.2 world px scaled by zoom, clamped
 * to 1.5-17 px. It meets overview's 1.5 px threads at the 0.15 handover.
 */
export function strandWidthPx(zoom: number): number {
  return clamp(YARN_STYLE.widthWorld * safeZoom(zoom), YARN_STYLE.minPx, YARN_STYLE.maxPx)
}

const shadeCache = new Map<string, string>()

/**
 * Mixes a #rgb / #rrggbb colour toward white (`amount` > 0) or black (< 0); other colour
 * strings come back unchanged.
 */
function shade(color: string, amount: number): string {
  const key = `${color}|${amount}`
  const hit = shadeCache.get(key)
  if (hit !== undefined) return hit
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  let out = color
  if (m?.[1] !== undefined) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
    const n = Number.parseInt(hex, 16)
    const to = amount >= 0 ? 255 : 0
    const a = Math.abs(amount)
    const mix = (c: number) => Math.round(c + (to - c) * a)
    out = `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`
  }
  if (shadeCache.size > 256) shadeCache.clear()
  shadeCache.set(key, out)
  return out
}

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly Point[], dx: number, dy: number) {
  ctx.beginPath()
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Point
    if (i === 0) ctx.moveTo(p.x + dx, p.y + dy)
    else ctx.lineTo(p.x + dx, p.y + dy)
  }
}

/** A rect by its corners. */
interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * The canvas's area in the coordinates paths are traced in (its current transform undone),
 * grown by `pad`; null when it cannot be told (no transform to read, or one that turns).
 */
function canvasBox(ctx: CanvasRenderingContext2D, pad: number): Box | null {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null
  const c = ctx.canvas as { width?: number; height?: number } | undefined
  if (m == null || c?.width === undefined || c.height === undefined) return null
  if (m.b !== 0 || m.c !== 0 || !(m.a > 0) || !(m.d > 0)) return null
  return {
    x0: -m.e / m.a - pad,
    y0: -m.f / m.d - pad,
    x1: (c.width - m.e) / m.a + pad,
    y1: (c.height - m.f) / m.d + pad,
  }
}

/**
 * One path of short slanted strokes across the strand, one every `period` px of its length
 * starting `phase` in: each runs from `reach` px on one side of the centre line to the other,
 * leaning `lean` px along it, so together they read as the plies of a twisted cord.
 */
function traceStripes(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  period: number,
  phase: number,
  reach: number,
  lean: number,
  view: Box | null = null,
) {
  ctx.beginPath()
  if (!(period > 0)) return
  let next = phase
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Point
    const b = pts[i] as Point
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (!(len > 0 && Number.isFinite(len))) continue
    // A piece wholly off the canvas paints nothing: its stripes are skipped, not traced (a
    // thread between clusters can run 100,000 px at reading zoom, a stripe every few px).
    if (
      view !== null &&
      (Math.max(a.x, b.x) < view.x0 ||
        Math.min(a.x, b.x) > view.x1 ||
        Math.max(a.y, b.y) < view.y0 ||
        Math.min(a.y, b.y) > view.y1)
    ) {
      acc += len
      // As the loop below would leave it: the first stripe past this piece.
      if (next <= acc) next += (Math.floor((acc - next) / period) + 1) * period
      continue
    }
    const tx = (b.x - a.x) / len
    const ty = (b.y - a.y) / len
    while (next <= acc + len) {
      const f = (next - acc) / len
      const x = a.x + (b.x - a.x) * f
      const y = a.y + (b.y - a.y) * f
      // Normal (-ty, tx): from the upper side leaning back to the lower side leaning forward.
      ctx.moveTo(x + ty * reach - tx * lean, y - tx * reach - ty * lean)
      ctx.lineTo(x - ty * reach + tx * lean, y + tx * reach + ty * lean)
      next += period
    }
    acc += len
  }
}

export interface StrandStyle {
  color: string
  zoom: number
  alpha?: number
  lite?: boolean
  selected?: boolean
  /** Width multiplier on top of the zoom's (a pulse swells the cord). */
  widthScale?: number
}

/**
 * Draws one strand in screen space as a twisted cord: an offset shadow, the base, then the
 * twist as slanted lit ply stripes with a dark groove between each pair and the lit crown on top
 * (`YARN_STYLE`); the stripes follow the path, so the twist runs along every curve (not below
 * `twistMinPx`). Lite mode is the base only.
 * Never uses `shadowBlur` or `filter`.
 */
export function drawStrand(
  ctx: CanvasRenderingContext2D,
  screenPts: readonly Point[],
  o: StrandStyle,
): void {
  if (screenPts.length < 2) return
  const zoom = safeZoom(o.zoom)
  const scale = o.widthScale !== undefined && o.widthScale > 0 ? o.widthScale : 1
  const w = strandWidthPx(zoom) * (o.selected ? SELECTED_SCALE : 1) * scale
  const alpha = o.alpha !== undefined && Number.isFinite(o.alpha) ? clamp(o.alpha, 0, 1) : 1
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (!o.lite) {
    const [sx, sy] = YARN_STYLE.shadowOffset
    tracePath(ctx, screenPts, sx * w, sy * w)
    ctx.strokeStyle = YARN_STYLE.shadow
    ctx.lineWidth = w
    ctx.stroke()
  }
  tracePath(ctx, screenPts, 0, 0)
  ctx.strokeStyle = o.color
  ctx.lineWidth = w
  ctx.stroke()
  if (!o.lite && w >= YARN_STYLE.twistMinPx) {
    const period = YARN_STYLE.twist * w
    const reach = YARN_STYLE.plyReach * w
    const lean = YARN_STYLE.plyLean * w
    const view = canvasBox(ctx, reach + lean + w)
    traceStripes(ctx, screenPts, period, period / 2, reach, lean, view)
    ctx.lineWidth = YARN_STYLE.grooveWidth * w
    ctx.strokeStyle = shade(o.color, -YARN_STYLE.plyDarken)
    ctx.stroke()
    traceStripes(ctx, screenPts, period, 0, reach, lean, view)
    ctx.lineWidth = YARN_STYLE.plyWidth * w
    ctx.strokeStyle = shade(o.color, YARN_STYLE.plyLighten)
    ctx.stroke()
    const [cx, cy] = YARN_STYLE.crownOffset
    tracePath(ctx, screenPts, cx * w, cy * w)
    ctx.lineWidth = YARN_STYLE.crownWidth * w
    ctx.strokeStyle = shade(o.color, YARN_STYLE.crownLighten)
    ctx.stroke()
  }
  ctx.restore()
}

/** World radius of each pin head: the hanging pin, an edge pin, a tag's edge pin, the hook. */
export const PIN_HEAD = { top: 10, edge: 10, tag: 7, hook: 5.5 } as const
export type PinKind = keyof typeof PIN_HEAD

/** On-screen pin head radius: the kind's world radius per zoom, clamped to [3, 2x] (lite 1.5-3). */
export function pinRadiusPx(zoom: number, lite: boolean, kind: PinKind = 'top'): number {
  const base = PIN_HEAD[kind]
  const r = base * safeZoom(zoom)
  return lite ? clamp(r, 1.5, 3) : clamp(r, 3, 2 * base)
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * A glossy brass dome seen from above-left: a soft cast shadow offset down-right (a wide faint
 * pass and a tighter contact pass), the dome shaded from a highlight up-left to a dark rim, a
 * crisp specular spot and a faint reflected light along the lower right. The head's centre
 * stays mid brass.
 */
function renderHead(r: number, dpr: number): { canvas: AnyCanvas; size: number } {
  const pad = Math.ceil(1.1 * r + 2)
  const size = 2 * (r + pad)
  const canvas = makeCanvas(Math.ceil(size * dpr), Math.ceil(size * dpr))
  const ctx = canvas.getContext('2d') as AnyContext | null
  if (ctx === null) return { canvas, size }
  ctx.scale(dpr, dpr)
  const c = size / 2

  for (const [dx, dy, grow, alpha] of [
    [0.55, 0.75, 1.35, 0.3],
    [0.3, 0.42, 1.02, 0.42],
  ] as const) {
    ctx.save()
    ctx.translate(c + dx * r, c + dy * r)
    ctx.scale(1, 0.78)
    const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * grow)
    shadow.addColorStop(0, `rgba(43,28,14,${alpha})`)
    shadow.addColorStop(0.55, `rgba(43,28,14,${alpha * 0.55})`)
    shadow.addColorStop(1, 'rgba(43,28,14,0)')
    ctx.fillStyle = shadow
    ctx.beginPath()
    ctx.arc(0, 0, r * grow, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  const dome = ctx.createRadialGradient(c - 0.38 * r, c - 0.42 * r, 0, c, c, r)
  dome.addColorStop(0, '#FFF4CC')
  dome.addColorStop(0.16, '#F1D48A')
  dome.addColorStop(0.5, '#C99E48')
  dome.addColorStop(0.82, '#8C6727')
  dome.addColorStop(1, '#5A3F14')
  ctx.fillStyle = dome
  ctx.beginPath()
  ctx.arc(c, c, r, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,228,160,0.38)'
  ctx.lineWidth = Math.max(0.6, 0.12 * r)
  ctx.beginPath()
  ctx.arc(c, c, 0.8 * r, 0.1 * Math.PI, 0.6 * Math.PI)
  ctx.stroke()

  const halo = ctx.createRadialGradient(
    c - 0.4 * r,
    c - 0.44 * r,
    0,
    c - 0.4 * r,
    c - 0.44 * r,
    0.42 * r,
  )
  halo.addColorStop(0, 'rgba(255,252,236,0.75)')
  halo.addColorStop(1, 'rgba(255,252,236,0)')
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(c - 0.4 * r, c - 0.44 * r, 0.42 * r, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,248,0.92)'
  ctx.beginPath()
  ctx.ellipse(c - 0.4 * r, c - 0.46 * r, 0.2 * r, 0.12 * r, -0.6, 0, Math.PI * 2)
  ctx.fill()
  return { canvas, size }
}

/** Tag hook proportions, in pin radii: the shank's length above the eyelet and its width. */
export const HOOK = { shankUp: 4.6, shankWidth: 0.7 } as const

interface Sprite {
  canvas: AnyCanvas
  /** CSS-px size and where the pin point sits inside it. */
  w: number
  h: number
  cx: number
  cy: number
}

/**
 * A brass cup hook seen from the front: a rounded shank coming down out of the cork into a flat
 * eyelet washer on the tag, with a soft shadow cast down-right. The pin point is the eyelet
 * centre, where the shank's brass covers it.
 */
function renderHook(r: number, dpr: number): Sprite {
  const pad = Math.ceil(0.9 * r + 1)
  const up = HOOK.shankUp * r
  const sw = HOOK.shankWidth * r
  const w = 2 * (r + pad)
  const h = up + r + 2 * pad
  const cx = w / 2
  const cy = pad + up
  const canvas = makeCanvas(Math.ceil(w * dpr), Math.ceil(h * dpr))
  const ctx = canvas.getContext('2d') as AnyContext | null
  if (ctx === null) return { canvas, w, h, cx, cy }
  ctx.scale(dpr, dpr)

  const capsule = (x: number, y0: number, y1: number, half: number) => {
    ctx.beginPath()
    ctx.moveTo(x - half, y0)
    ctx.lineTo(x - half, y1)
    ctx.arc(x, y1, half, Math.PI, 0, true)
    ctx.lineTo(x + half, y0)
    ctx.arc(x, y0, half, 0, Math.PI, true)
    ctx.closePath()
  }

  // Cast shadow: the washer's ellipse and the shank, offset down-right, in two soft passes.
  for (const [grow, alpha] of [
    [1.35, 0.12],
    [1, 0.2],
  ] as const) {
    ctx.save()
    ctx.translate(cx + 0.35 * r, cy + 0.45 * r)
    ctx.scale(1, 0.62)
    const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, r * grow)
    shade.addColorStop(0, `rgba(43,28,14,${alpha * 2})`)
    shade.addColorStop(1, 'rgba(43,28,14,0)')
    ctx.fillStyle = shade
    ctx.beginPath()
    ctx.arc(0, 0, r * grow, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    ctx.fillStyle = `rgba(43,28,14,${alpha})`
    capsule(cx + 0.45 * r, cy - up + 0.5 * r, cy + 0.3 * r, (sw / 2) * grow)
    ctx.fill()
  }

  // Eyelet washer, flattened by the viewing angle, with a darker rim and a pressed inner ring.
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, 0.62)
  const washer = ctx.createRadialGradient(-0.35 * r, -0.4 * r, 0, 0, 0, r)
  washer.addColorStop(0, '#E9CD7C')
  washer.addColorStop(0.55, PIN_BRASS)
  washer.addColorStop(1, '#6A4E1E')
  ctx.fillStyle = washer
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(70,48,16,0.55)'
  ctx.lineWidth = Math.max(0.6, 0.12 * r)
  ctx.beginPath()
  ctx.arc(0, 0, 0.6 * r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  // Shank: a rounded rod lit from the left, ending in the eyelet.
  const rod = ctx.createLinearGradient(cx - sw / 2, 0, cx + sw / 2, 0)
  rod.addColorStop(0, '#6E5220')
  rod.addColorStop(0.28, '#EBD08A')
  rod.addColorStop(0.5, '#C9A04A')
  rod.addColorStop(0.78, PIN_BRASS)
  rod.addColorStop(1, '#5E4418')
  ctx.fillStyle = rod
  capsule(cx, cy - up + sw / 2, cy + 0.08 * r, sw / 2)
  ctx.fill()
  // The bend where the shank meets the washer catches a little light.
  ctx.fillStyle = 'rgba(255,240,200,0.35)'
  ctx.beginPath()
  ctx.ellipse(cx - 0.1 * sw, cy - up + sw * 0.7, sw * 0.18, sw * 0.4, 0, 0, Math.PI * 2)
  ctx.fill()
  return { canvas, w, h, cx, cy }
}

/** Sprite sizes cached: radii on a 10% ladder from 1 px, so a zoom sweep renders few sprites. */
const SPRITE_STEP = 1.1

/** The ladder radius at or just above `r` (never below 1 px). */
export function spriteRadius(r: number): number {
  if (!(r > 1)) return 1
  return (
    Math.round(SPRITE_STEP ** Math.ceil(Math.log(r) / Math.log(SPRITE_STEP) - 1e-9) * 1e3) / 1e3
  )
}

/**
 * Brass pin renderer. Heads are pre-rendered at `dpr` on a 10% radius ladder (`spriteRadius`) and
 * drawn scaled down to the exact size;
 * `draw` expects a context already scaled by `dpr` and takes CSS-pixel positions. `kind` picks
 * the head size (hanging pin by default, or an edge pin, or a tag's edge pin); lite pins are a
 * flat disc. The specular highlight sits up-left so the head centre stays brass. `hook` draws
 * a tag's cup hook instead, its eyelet at the point and its shank rising above it.
 */
export function createPinSprites(dpr: number): {
  draw(
    ctx: CanvasRenderingContext2D,
    screenPt: Point,
    zoom: number,
    o?: { lite?: boolean; glow?: boolean; hook?: boolean; kind?: PinKind },
  ): void
  /**
   * Render the ladder sizes a full-detail pin can take, so zooming never has to: all of them,
   * or while `timeLeft()` (ms, e.g. an idle deadline's) stays above 2. True once all are done.
   */
  warm(timeLeft?: () => number): boolean
} {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 4) : 1
  const cache = new Map<string, Sprite>()
  const spriteOf = (hook: boolean, rs: number): Sprite => {
    const key = `${hook ? 'h' : 'd'}${rs}`
    let sprite = cache.get(key)
    if (sprite === undefined) {
      if (hook) sprite = renderHook(rs, ratio)
      else {
        const head = renderHead(rs, ratio)
        sprite = {
          canvas: head.canvas,
          w: head.size,
          h: head.size,
          cx: head.size / 2,
          cy: head.size / 2,
        }
      }
      cache.set(key, sprite)
    }
    return sprite
  }
  return {
    warm(timeLeft) {
      for (const [hook, max] of [
        [false, 2 * PIN_HEAD.top],
        [true, 2 * PIN_HEAD.hook],
      ] as const) {
        const top = Math.ceil(Math.log(max) / Math.log(SPRITE_STEP))
        for (let n = Math.floor(Math.log(3) / Math.log(SPRITE_STEP)); n <= top; n++) {
          const rs = spriteRadius(SPRITE_STEP ** n)
          if (cache.has(`${hook ? 'h' : 'd'}${rs}`)) continue
          if (timeLeft !== undefined && !(timeLeft() > 2)) return false
          spriteOf(hook, rs)
        }
      }
      return true
    },
    draw(ctx, screenPt, zoom, o) {
      const lite = o?.lite === true
      const hook = o?.hook === true
      const r = Math.round(pinRadiusPx(zoom, lite, hook ? 'hook' : (o?.kind ?? 'top')) * 2) / 2
      if (lite) {
        ctx.fillStyle = PIN_BRASS
        if (hook) {
          const sw = Math.max(1, HOOK.shankWidth * r)
          ctx.fillRect(screenPt.x - sw / 2, screenPt.y - HOOK.shankUp * r, sw, HOOK.shankUp * r)
        }
        ctx.beginPath()
        ctx.arc(screenPt.x, screenPt.y, r, 0, Math.PI * 2)
        ctx.fill()
      } else {
        const rs = spriteRadius(r)
        const sprite = spriteOf(hook, rs)
        const k = r / rs
        ctx.drawImage(
          sprite.canvas,
          screenPt.x - sprite.cx * k,
          screenPt.y - sprite.cy * k,
          sprite.w * k,
          sprite.h * k,
        )
      }
      if (o?.glow) {
        ctx.beginPath()
        ctx.arc(screenPt.x, screenPt.y, r + 1, 0, Math.PI * 2)
        ctx.strokeStyle = PIN_GLOW
        ctx.lineWidth = 2
        ctx.stroke()
      }
    },
  }
}
