// The search module alone: the worker needs none of core's schemas.
import { foldForSearch, type SearchHit, searchSnippet } from '@papertie/core/search'

/**
 * The search index's worker: every note's text, folded as core's search folds
 * it (NFKC, lowercase, one sigma), with a posting list per trigram and per character (UTF-16
 * unit), kept up to date per commit.
 * It answers exactly what core's `searchNotes` answers for the same board: the same hits, in the
 * same order, with the same snippets. The page side is `searchIndex.ts`; tests run this module in
 * node, where it only exports.
 */

/** A needle shorter than this has no trigram to look up: it is looked up by its characters. */
const GRAM = 3
/** Narrowing stops once this few candidates are left: checking them is cheaper. */
const FEW = 16
const NO_IDS: ReadonlySet<string> = new Set()

/**
 * A trigram (three UTF-16 units of folded text from `i`) hashed into 30 bits, so the posting
 * map keys are small integers. Two trigrams that share a hash share a list, which only adds
 * candidates: every candidate's folded text is checked for the whole needle.
 */
function gramAt(s: string, i: number): number {
  const h =
    Math.imul(s.charCodeAt(i), 0x9e3779b1) ^
    Math.imul(s.charCodeAt(i + 1), 0x85ebca6b) ^
    Math.imul(s.charCodeAt(i + 2), 0xc2b2ae35)
  return (h ^ (h >>> 15)) & 0x3fffffff
}

/**
 * The posting key of the UTF-16 unit at `i`: below zero, apart from every trigram's. A needle too
 * short for a trigram is looked up by these, so a search for one or two characters reads only the
 * notes that hold them all, never every note's text (a miss there cost a scan of the whole board).
 */
const unitAt = (s: string, i: number): number => -1 - s.charCodeAt(i)

/** The keys a needle is looked up by: its trigrams, or (shorter than one) its units. */
function needleKeys(needle: string): Set<number> {
  if (needle.length >= GRAM) {
    const out = new Set<number>()
    for (let i = 0; i + GRAM <= needle.length; i++) out.add(gramAt(needle, i))
    return out
  }
  const out = new Set<number>()
  for (let i = 0; i < needle.length; i++) out.add(unitAt(needle, i))
  return out
}

/** Where `x` is in the ascending `list`, or where it would go. */
function seek(list: readonly number[], x: number, from = 0): number {
  let lo = from
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((list[mid] as number) < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The slots in both ascending lists: a merge, or a search per slot of a much shorter one. */
function intersect(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = []
  if (a.length * 8 < b.length) {
    let at = 0
    for (const x of a) {
      at = seek(b, x, at)
      if (at === b.length) break
      if (b[at] === x) out.push(x)
    }
    return out
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a[i] as number
    const y = b[j] as number
    if (x === y) {
      out.push(x)
      i++
      j++
    } else if (x < y) i++
    else j++
  }
  return out
}

/** A compaction starts once this many slots are dead, and more than half as many as live. */
const COMPACT_MIN = 4096
/** A compaction copies notes for this long at a time, then lets the worker answer again. */
const COMPACT_STEP_MS = 4

/**
 * The index itself. Notes live in slots, each posting list holding the ascending slots whose
 * folded text has that trigram (or character). A new note, or a note whose text changed, takes
 * the next slot (so its postings are appends); the slot it leaves, or a removed note's, is only
 * marked dead, its postings left where they are (a dead slot never matches: its text is ''). So
 * an edit or a removal costs what the note holds, never a posting list's length. The dead slots
 * are cleared out by a compaction ({@link compactStep}), a few milliseconds at a time.
 */
export class TrigramIndex {
  private slotOf = new Map<string, number>()
  /** Per slot; '' marks a dead one. */
  private ids: string[] = []
  private texts: string[] = []
  private folded: string[] = []
  private stamps: string[] = []
  private postings = new Map<number, number[]>()
  /** Slots let go of (a note removed, or moved on by an edit), whose postings remain. */
  private dead = 0
  /**
   * A compaction under way: the live notes copied into a fresh index slot by slot (`at`), and the
   * notes changed since it began (`dirty`), which are copied as they stand once it is through.
   */
  private compaction: { into: TrigramIndex; at: number; dirty: Set<string> } | null = null

  get size(): number {
    return this.slotOf.size
  }

  /** Add a note, or change one's text and edit time. */
  put(id: string, text: string, updatedAt: string): void {
    this.compaction?.dirty.add(id)
    const slot = this.slotOf.get(id)
    if (slot === undefined) {
      this.insert(id, text, this.fold(text), updatedAt)
      return
    }
    this.stamps[slot] = updatedAt
    if (this.texts[slot] === text) return
    const f = this.fold(text)
    if (f === this.folded[slot]) {
      this.texts[slot] = text
      return
    }
    // Other text: the note moves on to the next slot, and this one is let go.
    this.letGo(slot)
    this.insert(id, text, f, updatedAt)
  }

  remove(id: string): void {
    const slot = this.slotOf.get(id)
    if (slot === undefined) return
    this.compaction?.dirty.add(id)
    this.slotOf.delete(id)
    this.letGo(slot)
  }

  clear(): void {
    this.slotOf.clear()
    this.postings.clear()
    for (const a of [this.ids, this.texts, this.folded, this.stamps]) a.length = 0
    this.dead = 0
    this.compaction = null
  }

  /** Dead slots are worth clearing out, or a compaction is under way. */
  get wantsCompaction(): boolean {
    return (
      this.compaction !== null || (this.dead >= COMPACT_MIN && this.dead * 2 > this.slotOf.size)
    )
  }

  /**
   * Go on with the compaction for about `ms`: the live notes are copied into a fresh index (no
   * dead slots, nothing but appends) while this one answers and takes edits as before; once all
   * are copied, the notes changed meanwhile are copied as they stand and the fresh index takes
   * over. Answers are the same before, during and after. True while there is more to do.
   */
  compactStep(ms = COMPACT_STEP_MS): boolean {
    if (!this.wantsCompaction) return false
    this.compaction ??= { into: new TrigramIndex(), at: 0, dirty: new Set() }
    const c = this.compaction
    const end = performance.now() + ms
    while (c.at < this.ids.length) {
      const id = this.ids[c.at] as string
      if (id !== '' && !c.dirty.has(id)) {
        c.into.insert(
          id,
          this.texts[c.at] as string,
          this.folded[c.at] as string,
          this.stamps[c.at] as string,
        )
      }
      c.at++
      if ((c.at & 255) === 0 && performance.now() >= end) return true
    }
    // The notes changed meanwhile, as they stand now, a slice at a time as well: a pour during the
    // copy leaves thousands. One changed again after its turn is simply dirty again.
    let done = 0
    for (const id of c.dirty) {
      c.dirty.delete(id)
      c.into.remove(id)
      const slot = this.slotOf.get(id)
      if (slot !== undefined) {
        c.into.insert(
          id,
          this.texts[slot] as string,
          this.folded[slot] as string,
          this.stamps[slot] as string,
        )
      }
      if ((++done & 63) === 0 && performance.now() >= end) return true
    }
    const { into } = c
    this.slotOf = into.slotOf
    this.ids = into.ids
    this.texts = into.texts
    this.folded = into.folded
    this.stamps = into.stamps
    this.postings = into.postings
    this.dead = into.dead
    this.compaction = null
    return false
  }

  /** Put a note in the next slot, its text already folded. */
  private insert(id: string, text: string, f: string, updatedAt: string): void {
    const s = this.ids.length
    this.slotOf.set(id, s)
    this.ids.push(id)
    this.texts.push(text)
    this.folded.push(f)
    this.stamps.push(updatedAt)
    for (let i = 0; i + GRAM <= f.length; i++) this.post(gramAt(f, i), s)
    for (let i = 0; i < f.length; i++) this.post(unitAt(f, i), s)
  }

  /** Mark `slot` dead; its postings stay until a compaction. */
  private letGo(slot: number): void {
    this.ids[slot] = ''
    this.texts[slot] = ''
    this.folded[slot] = ''
    this.stamps[slot] = ''
    this.dead++
  }

  /**
   * What core's `searchNotes(board, q, limit)` answers: notes whose folded text contains the
   * folded, trimmed query, ranked by match position, then newest edit, then id. Notes in `skip`
   * are passed over, so a list that leaves them out still fills.
   */
  query(
    q: string,
    limit: number,
    skip: ReadonlySet<string> = NO_IDS,
    only?: ReadonlySet<string>,
  ): SearchHit[] {
    const needle = foldForSearch(q).trim()
    if (needle === '' || !(limit > 0)) return []
    const top = new Top(Math.floor(limit), this.stamps, this.ids)
    const check = (slot: number) => {
      const id = this.ids[slot] as string
      if (skip.size > 0 && skip.has(id)) return
      if (only !== undefined && !only.has(id)) return
      const pos = (this.folded[slot] as string).indexOf(needle)
      if (pos >= 0) top.offer(slot, pos)
    }
    const lists: number[][] = []
    for (const g of needleKeys(needle)) {
      const list = this.postings.get(g)
      if (list === undefined) return []
      lists.push(list)
    }
    lists.sort((a, b) => a.length - b.length)
    let found = lists[0] ?? []
    for (let i = 1; i < lists.length && found.length > FEW; i++) {
      found = intersect(found, lists[i] as number[])
    }
    for (const s of found) check(s)
    return top.slots().map((s) => ({
      id: this.ids[s] as string,
      snippet: searchSnippet(this.texts[s] as string, needle),
    }))
  }

  /**
   * The `limit` notes edited last, newest first (then by id), but those in `skip`; with `only`,
   * among those notes alone (read by their slots: O(only)).
   */
  recent(limit: number, skip: ReadonlySet<string> = NO_IDS, only?: readonly string[]): string[] {
    if (!(limit > 0)) return []
    const top = new Top(Math.floor(limit), this.stamps, this.ids)
    if (only !== undefined) {
      for (const id of only) {
        const s = this.slotOf.get(id)
        if (s !== undefined && !(skip.size > 0 && skip.has(id))) top.offer(s, 0)
      }
      return top.slots().map((s) => this.ids[s] as string)
    }
    for (let s = 0; s < this.ids.length; s++) {
      const id = this.ids[s] as string
      if (id !== '' && !(skip.size > 0 && skip.has(id))) top.offer(s, 0)
    }
    return top.slots().map((s) => this.ids[s] as string)
  }

  /** The fold, sharing the note's own string when folding changes nothing (most text). */
  private fold(text: string): string {
    const f = foldForSearch(text)
    return f === text ? text : f
  }

  /** Post `slot`, the newest slot: an append, unless the key is posted for it already. */
  private post(g: number, slot: number): void {
    const list = this.postings.get(g)
    if (list === undefined) this.postings.set(g, [slot])
    else if (list[list.length - 1] !== slot) list.push(slot)
  }
}

/**
 * The best `k` slots seen, kept in rank order: match position, then newer edit, then id
 * (core's order). Most offers lose to the last kept one at once, so nothing is sorted whole.
 */
class Top {
  private readonly kept: number[] = []
  private readonly pos: number[] = []

  constructor(
    private readonly k: number,
    private readonly stamps: readonly string[],
    private readonly ids: readonly string[],
  ) {}

  /** Whether (slot a at pa) ranks before (slot b at pb). */
  private before(a: number, pa: number, b: number, pb: number): boolean {
    if (pa !== pb) return pa < pb
    const sa = this.stamps[a] as string
    const sb = this.stamps[b] as string
    if (sa !== sb) return sa > sb
    return (this.ids[a] as string) < (this.ids[b] as string)
  }

  offer(slot: number, p: number): void {
    const n = this.kept.length
    if (
      n === this.k &&
      !this.before(slot, p, this.kept[n - 1] as number, this.pos[n - 1] as number)
    ) {
      return
    }
    let i = n
    while (i > 0 && this.before(slot, p, this.kept[i - 1] as number, this.pos[i - 1] as number)) i--
    this.kept.splice(i, 0, slot)
    this.pos.splice(i, 0, p)
    if (this.kept.length > this.k) {
      this.kept.pop()
      this.pos.pop()
    }
  }

  slots(): number[] {
    return this.kept
  }
}

// ---- messages ---------------------------------------------------------------------------------

/** What the page sends: notes in parallel arrays (cheap to clone), and questions with a number. */
export type IndexRequest =
  | { t: 'put'; ids: string[]; texts: string[]; stamps: string[] }
  | { t: 'remove'; ids: string[] }
  | { t: 'clear' }
  /** The notes later questions leave out (Bring in…'s focus, Connect to…'s own note). */
  | { t: 'exclude'; ids: string[] }
  /** `only`: among these notes alone (the ref picker's kept set). */
  | { t: 'query'; seq: number; q: string; limit: number; only?: string[] }
  | { t: 'recent'; seq: number; limit: number; only?: string[] }

/** An answer to question `seq`, and how long the worker took over it. */
export type IndexReply =
  | { seq: number; hits: SearchHit[]; ms: number }
  | { seq: number; ids: string[]; ms: number }

/** Either end of the channel: a worker's global scope, a `Worker`, or a `MessagePort`. */
export interface IndexPort<In, Out> {
  onmessage: ((e: MessageEvent<In>) => void) | null
  postMessage(m: Out): void
}

/**
 * Answer the page on `port`, in the order it asked; the index is returned for tests. Dead slots
 * are compacted between messages, a step at a time, so a question waits at most one step.
 */
export function serve(port: IndexPort<IndexRequest, IndexReply>): TrigramIndex {
  const index = new TrigramIndex()
  let skip: ReadonlySet<string> = NO_IDS
  let compacting: ReturnType<typeof setTimeout> | null = null
  const compactLater = () => {
    if (compacting !== null || !index.wantsCompaction) return
    compacting = setTimeout(() => {
      compacting = null
      if (index.compactStep()) compactLater()
    }, 0)
  }
  const answer = ({ data: m }: MessageEvent<IndexRequest>) => {
    switch (m.t) {
      case 'put':
        for (let i = 0; i < m.ids.length; i++) {
          index.put(m.ids[i] as string, m.texts[i] as string, m.stamps[i] as string)
        }
        return
      case 'remove':
        for (const id of m.ids) index.remove(id)
        return
      case 'clear':
        index.clear()
        return
      case 'exclude':
        skip = m.ids.length === 0 ? NO_IDS : new Set(m.ids)
        return
      case 'query': {
        const t0 = performance.now()
        const hits = index.query(m.q, m.limit, skip, m.only && new Set(m.only))
        port.postMessage({ seq: m.seq, hits, ms: performance.now() - t0 })
        return
      }
      case 'recent': {
        const t0 = performance.now()
        const ids = index.recent(m.limit, skip, m.only)
        port.postMessage({ seq: m.seq, ids, ms: performance.now() - t0 })
        return
      }
    }
  }
  port.onmessage = (e) => {
    answer(e)
    compactLater()
  }
  return index
}

// Inside a worker, the scope itself is the port.
if (typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  serve(globalThis as unknown as IndexPort<IndexRequest, IndexReply>)
}
