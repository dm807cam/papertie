import { type ClientOp, LIMITS, type Note } from '@papertie/core'

/** Screen px a press must travel before it becomes a drag or resize. */
export const DRAG_THRESHOLD_PX = 3

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'e' | 's'

export interface NoteRect {
  x: number
  y: number
  w: number
  h: number
}

const finite = (v: number) => (Number.isFinite(v) ? v : 0)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clampCoord = (v: number) => clamp(v, -LIMITS.maxCoord, LIMITS.maxCoord)

/** New positions for `notes` moved by a world delta, rounded and kept within ±maxCoord. */
export function moveNotes(
  notes: readonly Note[],
  dxWorld: number,
  dyWorld: number,
): Map<string, { x: number; y: number }> {
  const dx = finite(dxWorld)
  const dy = finite(dyWorld)
  const out = new Map<string, { x: number; y: number }>()
  for (const n of notes) {
    out.set(n.id, { x: clampCoord(Math.round(n.x + dx)), y: clampCoord(Math.round(n.y + dy)) })
  }
  return out
}

/**
 * One `note.update {x, y, z}` per note that moved. Moved notes come to the top, keeping their
 * relative order: `z = topZ + 1 + i` by ascending original z. Empty when nothing moved.
 */
export function dragOps(
  before: readonly Note[],
  after: ReadonlyMap<string, { x: number; y: number }>,
  topZ: number,
): ClientOp[] {
  const moved = before.filter((n) => {
    const p = after.get(n.id)
    return p !== undefined && (p.x !== n.x || p.y !== n.y)
  })
  moved.sort((a, b) => a.z - b.z)
  return moved.map((n, i) => {
    const p = after.get(n.id) as { x: number; y: number }
    return { op: 'note.update', id: n.id, set: { x: p.x, y: p.y, z: topZ + 1 + i } }
  })
}

/** Integer range [lo, hi], or null when it is empty. */
function range(lo: number, hi: number): [number, number] | null {
  const a = Math.ceil(lo)
  const b = Math.floor(hi)
  return a <= b ? [a, b] : null
}

/**
 * The rect after dragging handle `h` by a world delta. Width and height clamp to the note
 * limits with the opposite edge fixed, and a moving edge never crosses ±maxCoord. With
 * `keepAspect` (w/h), corners follow whichever axis changed more and edges carry the other.
 * Everything is rounded to integers.
 */
export function resizeRect(
  n: Note,
  h: ResizeHandle,
  dxWorld: number,
  dyWorld: number,
  keepAspect?: number,
): NoteRect {
  const dx = finite(dxWorld)
  const dy = finite(dyWorld)
  const west = h === 'nw' || h === 'sw'
  const north = h === 'nw' || h === 'ne'
  const east = h === 'ne' || h === 'se' || h === 'e'
  const south = h === 'sw' || h === 'se' || h === 's'
  const right = n.x + n.w
  const bottom = n.y + n.h
  const M = LIMITS.maxCoord
  // A west or north edge moves: keep it inside ±maxCoord.
  const wr = range(
    Math.max(LIMITS.noteMinW, west ? right - M : -Infinity),
    Math.min(LIMITS.noteMaxW, west ? right + M : Infinity),
  ) ?? [n.w, n.w]
  const hr = range(
    Math.max(LIMITS.noteMinH, north ? bottom - M : -Infinity),
    Math.min(LIMITS.noteMaxH, north ? bottom + M : Infinity),
  ) ?? [n.h, n.h]

  let w = n.w + (east ? dx : west ? -dx : 0)
  let hh = n.h + (south ? dy : north ? -dy : 0)
  const a = keepAspect
  const aspectOk = a !== undefined && Number.isFinite(a) && a > 0
  const both = aspectOk ? range(Math.max(wr[0], hr[0] * a), Math.min(wr[1], hr[1] * a)) : null
  if (aspectOk && both !== null) {
    const byWidth = h === 'e' || (h !== 's' && Math.abs(w / n.w - 1) >= Math.abs(hh / n.h - 1))
    if (byWidth) w = clamp(Math.round(w), both[0], both[1])
    else w = clamp(Math.round(hh * a), both[0], both[1])
    hh = clamp(Math.round(w / a), hr[0], hr[1])
  } else {
    w = clamp(Math.round(w), wr[0], wr[1])
    hh = clamp(Math.round(hh), hr[0], hr[1])
  }
  return {
    x: west ? Math.round(right - w) : n.x,
    y: north ? Math.round(bottom - hh) : n.y,
    w,
    h: hh,
  }
}

/** One `note.update` setting the fields of `r` that differ from `n`; empty when none do. */
export function resizeOps(n: Note, r: NoteRect): ClientOp[] {
  const set: Partial<NoteRect> = {}
  for (const k of ['x', 'y', 'w', 'h'] as const) if (r[k] !== n[k]) set[k] = r[k]
  return Object.keys(set).length === 0 ? [] : [{ op: 'note.update', id: n.id, set }]
}
