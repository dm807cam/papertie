import { type Asset, type BoardState, type Note, threadsOf, type Yarn } from '@papertie/core'
import RBush, { type BBox } from 'rbush'
import { CHECK, SLICE_MS, Slicer, sortSliced } from './compact'
import { byId, byZ, cmp } from './order'

/** The browser's cache tile, in world px. */
export const TILE = 4096

/** A region may span at most this many tiles' worth: `⌈w / TILE⌉ × ⌈h / TILE⌉`. */
export const REGION_MAX_TILES = 64

/**
 * A region answer of at most this many notes starts in the request's own turn:
 * it never waits behind another job's slices for a first one. A first paint at reading zoom asks
 * for about 1,200 to 1,500 notes of the grid board (a 2560 × 1440 view and a tile around it), a
 * few ms of work. It is held to the same budget as any slice: past `SLICE_MS` it yields and takes
 * its turns with the rest. A larger answer (a far view's), or a second small one in the same
 * event-loop iteration, starts in a turn of its own.
 */
export const REGION_INLINE_NOTES = 4096

/**
 * Whether this event-loop iteration has started a small answer inline already: only one does.
 * Several small requests read in one poll phase would otherwise
 * hold the iteration for a slice each; the second and later wait their turn as any slice does.
 * Cleared in the iteration's check phase.
 */
let inlineThisTurn = false

/** A slicer for an answer of `n` notes: at once for the turn's first small one, else in turn. */
async function regionSlicer(n: number): Promise<Slicer> {
  if (n > REGION_INLINE_NOTES || inlineThisTurn) return Slicer.start(SLICE_MS)
  inlineThisTurn = true
  setImmediate(() => {
    inlineThisTurn = false
  })
  return new Slicer(SLICE_MS)
}

/** A world rectangle by its corners, `x0 <= x1` and `y0 <= y1`. */
export interface RegionRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Whether `r` is within `REGION_MAX_TILES` (a zero-width side counts as one tile). */
export function regionFits(r: RegionRect): boolean {
  const span = (d: number) => Math.max(1, Math.ceil(d / TILE))
  return span(r.x1 - r.x0) * span(r.y1 - r.y0) <= REGION_MAX_TILES
}

interface Item extends BBox {
  id: string
}

const itemOf = (n: Note): Item => ({
  minX: n.x,
  minY: n.y,
  maxX: n.x + n.w,
  maxY: n.y + n.h,
  id: n.id,
})

/** Rects bulk-loaded at a time by `build`: well under a millisecond of work each on a Mac. */
const BUILD_CHUNK = 512

const sameBox = (a: Item, b: Item) =>
  a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY

/**
 * An rbush of one board's note rects (their stored `x, y, w, h`), built once from a loaded board
 * and then kept up to date commit by commit: a commit costs O(notes it wrote × log n).
 */
export class RegionIndex {
  private readonly tree = new RBush<Item>()
  private readonly items = new Map<string, Item>()

  /** The index of every note in `notes`, bulk-loaded (load time, never per commit). */
  static of(notes: ReadonlyMap<string, Note>): RegionIndex {
    const ix = new RegionIndex()
    const all: Item[] = []
    for (const note of notes.values()) {
      const item = itemOf(note)
      ix.items.set(note.id, item)
      all.push(item)
    }
    ix.tree.load(all)
    return ix
  }

  /**
   * `of(notes)` without holding the event loop for more than about `SLICE_MS` at a time: loaded
   * a few thousand rects at a time (each a bulk load merged into the tree), yielding between.
   * Finds the same notes as `of`. For a whole state taken on under the board's lock (a restore,
   * an import), where `of` would hold the loop for tens of ms at 100,000 notes.
   */
  static async build(notes: ReadonlyMap<string, Note>, budgetMs = SLICE_MS): Promise<RegionIndex> {
    const ix = new RegionIndex()
    const s = await Slicer.start(budgetMs)
    let chunk: Item[] = []
    const flush = async () => {
      ix.tree.load(chunk)
      chunk = []
      if (s.due()) await s.pause()
    }
    // The maps are persistent: iterating across yields sees one version throughout.
    for (const note of notes.values()) {
      const item = itemOf(note)
      ix.items.set(note.id, item)
      chunk.push(item)
      if (chunk.length === BUILD_CHUNK) await flush()
    }
    if (chunk.length > 0) await flush()
    s.note()
    return ix
  }

  /** Re-index the notes `ids` as `notes` now holds them (gone ones leave the index). */
  update(notes: ReadonlyMap<string, Note>, ids: Iterable<string>): void {
    for (const id of ids) {
      const before = this.items.get(id)
      const note = notes.get(id)
      const after = note ? itemOf(note) : undefined
      if (before && after && sameBox(before, after)) continue
      if (before) {
        this.tree.remove(before)
        this.items.delete(id)
      }
      if (after) {
        this.tree.insert(after)
        this.items.set(id, after)
      }
    }
  }

  /** `update`, giving the loop back between a few notes whenever `s`'s slice is due. */
  async updateSliced(
    notes: ReadonlyMap<string, Note>,
    ids: Iterable<string>,
    s: Slicer | null,
  ): Promise<void> {
    if (s === null) return this.update(notes, ids)
    let chunk: string[] = []
    for (const id of ids) {
      chunk.push(id)
      if (chunk.length === 64) {
        this.update(notes, chunk)
        chunk = []
        if (s.due()) await s.pause()
      }
    }
    this.update(notes, chunk)
  }

  /**
   * The rect that holds every note's stored rect, or null for a board without notes: the tree's
   * root box, O(1). What the page opens the board at with no camera remembered.
   */
  extent(): RegionRect | null {
    if (this.items.size === 0) return null
    const root = this.tree.toJSON() as { minX: number; minY: number; maxX: number; maxY: number }
    return { x0: root.minX, y0: root.minY, x1: root.maxX, y1: root.maxY }
  }

  /** Ids of the notes whose rect intersects `r` (edges touching count). */
  search(r: RegionRect): string[] {
    return this.tree.search({ minX: r.x0, minY: r.y0, maxX: r.x1, maxY: r.y1 }).map((i) => i.id)
  }
}

/**
 * The NDJSON the page opens a viewport with, from `ids` (the notes in the region):
 * 1. the board record;
 * 2. the assets those notes show;
 * 3. the notes, in `z` order;
 * 4. the threads touching the notes, whole (pins included);
 * 5. `{"type":"eof", revision}`.
 * Costs O(answer): the threads come from the board's thread index. A thread that leaves the
 * region is drawn once all its notes are in, as the whole board comes (the client never draws
 * one through a note it does not have), so nothing is sent of its other notes.
 *
 * Built in slices, outside the board's lock, since the answer is
 * not bounded by the area: `regionFits` caps the rect at 64 tiles (32,768 px square), but notes may
 * overlap without limit, so one region can hold every note of the board. The densest viewport of
 * the grid board (13,970 notes) was 21–31 ms in one turn on a Mac, the clustered board's (7,431)
 * 11.5–12.8 ms, so 60–150 ms on a CPU 5× slower; all 100,000 notes in one region, 101–118 ms. Left
 * in one step: the index search under the lock (2–3 ms with all 100,000 notes in the region) and
 * the final join of the lines. A small answer (`REGION_INLINE_NOTES`) starts at once, in the
 * request's turn; a larger one waits for a turn of its own.
 */
export async function regionText(state: BoardState, ids: readonly string[]): Promise<string> {
  // In slices: 13,970 notes, the densest viewport of the grid
  // board, were 21–31 ms in one turn on a Mac. The maps are persistent: `state` holds still.
  // A small answer's first slice is the request's own turn (`REGION_INLINE_NOTES`), one a turn.
  const s = await regionSlicer(ids.length)
  const step = async (i: number) => {
    if (i % CHECK === 0 && s.due()) await s.pause()
  }
  const found: Note[] = []
  for (let i = 0; i < ids.length; i++) {
    const note = state.notes.get(ids[i] as string)
    if (note) found.push(note)
    await step(i)
  }
  const notes = await sortSliced(found, byZ, s)
  const assets = new Map<string, Asset>()
  const yarns = new Map<string, Yarn>()
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i] as Note
    const assetId = note.image?.assetId
    const asset = assetId === undefined ? undefined : state.assets.get(assetId)
    if (asset) assets.set(asset.id, asset)
    for (const yarn of threadsOf(state, note.id)) yarns.set(yarn.id, yarn)
    await step(i)
  }
  const out: string[] = [JSON.stringify(state.board)]
  for (const id of [...assets.keys()].sort(cmp)) out.push(JSON.stringify(assets.get(id)))
  for (let i = 0; i < notes.length; i++) {
    out.push(JSON.stringify(notes[i]))
    await step(i)
  }
  const threads = await sortSliced([...yarns.values()], byId, s)
  for (let i = 0; i < threads.length; i++) {
    out.push(JSON.stringify(threads[i]))
    await step(i)
  }
  out.push(JSON.stringify({ type: 'eof', revision: state.board.revision }))
  const text = `${out.join('\n')}\n`
  s.note()
  return text
}
