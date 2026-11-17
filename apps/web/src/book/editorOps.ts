/**
 * Between the writer's editor and the board (ADR-0007): the editor's changes as
 * the book's ops (`changesToOps`), the board's changes to a book as editor changes
 * (`opsToChanges`), and what changed between two versions of a book as ops (`bookDiff`), so
 * every change the board takes (an undo, a restore, the store's own) reaches the page
 * as the text that is there now. None of them reads the book: each reads what it names and its
 * neighbours (O(changes × log book)), or the chunks a change made (core's block index).
 */
import {
  type Block,
  type BoardState,
  type BookBlocks,
  bookBlocks,
  type ClientOp,
  diffSplices,
  type Mark,
  mapMarks,
  normalizeMarks,
  type Op,
  posBetween,
  posKeysBetween,
  sliceMarks,
  stateTakes,
  subtractMarks,
  takenSplices,
} from '@papertie/core'
import type { EditorChange, EditorImage, EditorMark } from './editor/BookEditor'
import { DEFAULT_ASPECT } from './editor/model'

/** A figure's image as the board keeps it: its asset and card (its aspect is the asset's). */
const boardImage = (i: { assetId: string; card?: string }) => ({
  assetId: i.assetId,
  ...(i.card === undefined ? {} : { card: i.card }),
})

/** A figure's image for the page: with its asset's aspect (as `state` holds the asset). */
export function pageImage(
  i: { assetId: string; card?: string },
  state: BoardState | undefined,
): EditorImage {
  const a = state?.assets.get(i.assetId)
  return { ...boardImage(i), aspect: a && a.height > 0 ? a.width / a.height : DEFAULT_ASPECT }
}

/** A key longer than this re-spaces its neighbours (the keys stay short as a book is typed). */
export const POS_RESPACE_AT = 64
/** How many blocks on each side of a new one are re-spaced with it. */
const RESPACE_SIDE = 32

/** `(pos, id)` order, as core's block index keeps a book. */
const before = (a: { pos: string; id: string }, b: { pos: string; id: string }) =>
  a.pos < b.pos || (a.pos === b.pos && a.id < b.id)

/** Where `b` (by its own `pos` and `id`) sits in `ix`: its chunk and slot, or the slot it would take. */
function find(ix: BookBlocks, b: { pos: string; id: string }): { c: number; k: number } {
  const chunks = ix.chunks
  let lo = 0
  let hi = chunks.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const chunk = chunks[mid] as readonly Block[]
    if (before(chunk[chunk.length - 1] as Block, b)) lo = mid + 1
    else hi = mid
  }
  const chunk = chunks[lo] ?? []
  let a = 0
  let z = chunk.length
  while (a < z) {
    const mid = (a + z) >> 1
    if (before(chunk[mid] as Block, b)) a = mid + 1
    else z = mid
  }
  return { c: lo, k: a }
}

/** The block before slot `(c, k)` of `ix`, or null at the start. */
function blockBefore(ix: BookBlocks, c: number, k: number): Block | null {
  if (k > 0) return (ix.chunks[c] as readonly Block[])[k - 1] as Block
  const prev = ix.chunks[c - 1]
  return prev === undefined ? null : (prev[prev.length - 1] as Block)
}

/** The block after slot `(c, k)` of `ix` (exclusive of the slot's own), or null at the end. */
function blockAfter(ix: BookBlocks, c: number, k: number): Block | null {
  const chunk = ix.chunks[c]
  if (chunk === undefined) return null
  if (k + 1 < chunk.length) return chunk[k + 1] as Block
  return ix.chunks[c + 1]?.[0] ?? null
}

const HEAD = ''

/** A prompt (beside its block in the margin) or a footnote (under its paragraph). */
const aside = (b: Block | null): b is Block => b?.kind === 'prompt' || b?.kind === 'footnote'

/**
 * Block `id` and the prompts and footnotes after it (they annotate it, so nothing comes between),
 * as `state` holds them; empty when it is not in the book. O(them × log book).
 */
export function withAsides(state: BoardState, bookId: string, id: string): Block[] {
  const b = state.blocks.get(id)
  if (b === undefined || b.bookId !== bookId) return []
  const ix = bookBlocks(state.blocks, bookId)
  let { c, k } = find(ix, b)
  const out: Block[] = [b]
  for (let n = blockAfter(ix, c, k); aside(n); n = blockAfter(ix, c, k)) {
    out.push(n)
    ;({ c, k } = find(ix, n))
  }
  return out
}

/**
 * The block an insert after `id` follows: `id`, or the last of the prompts and footnotes after it
 * (they annotate it, so nothing comes between). O(them × log book).
 */
export function afterPrompts(state: BoardState, bookId: string, id: string): string {
  return withAsides(state, bookId, id).at(-1)?.id ?? id
}

/**
 * The blocks of book `bookId` from `fromId` to `toId` (both included), in book order, as `state`
 * holds them; `until` stops the walk early when it says so of the blocks so far (a card's length
 * met). Empty when either is not in the book or `toId` comes first. O(log book + blocks walked).
 */
export function blocksFromTo(
  state: BoardState,
  bookId: string,
  fromId: string,
  toId: string,
  until?: (b: Block) => boolean,
): Block[] {
  const a = state.blocks.get(fromId)
  const z = state.blocks.get(toId)
  if (a === undefined || z === undefined || a.bookId !== bookId || z.bookId !== bookId) return []
  if (before(z, a)) return []
  const ix = bookBlocks(state.blocks, bookId)
  let { c, k } = find(ix, a)
  const out: Block[] = [a]
  for (let b: Block | null = a; b !== null && b.id !== toId; ) {
    if (until?.(b)) break
    b = blockAfter(ix, c, k)
    if (b === null) break
    out.push(b)
    if (k + 1 < (ix.chunks[c] as readonly Block[]).length) k++
    else {
      c++
      k = 0
    }
  }
  return out
}

/** The id of the block before `id` in book `bookId` as `state` holds it; null first (or not there). */
export function blockBeforeId(state: BoardState, bookId: string, id: string): string | null {
  const b = state.blocks.get(id)
  if (b === undefined || b.bookId !== bookId) return null
  const ix = bookBlocks(state.blocks, bookId)
  const at = find(ix, b)
  return blockBefore(ix, at.c, at.k)?.id ?? null
}

/**
 * The editor's `changes` (one gesture) as the book's ops against `state`, which holds the book
 * as the editor had it before them. A split's or create's `pos` is `posBetween` its neighbours as
 * they are by then; a run of creates one after another (a paste) takes its keys together
 * (`posKeysBetween`); a key that would pass {@link POS_RESPACE_AT} characters, or no room at all
 * (two neighbours of one key), re-spaces the 32 blocks on each side in the same batch. A create
 * says what it follows (`after`: the block before it, `null` first in the book), a block the
 * store then checks with the batch's others (core's `namesOf`). An edit
 * says the marks its typing takes (`takes`), where the batch knows the block's marks.
 */
export function changesToOps(
  state: BoardState,
  bookId: string,
  changes: readonly EditorChange[],
): ClientOp[] {
  const ix = bookBlocks(state.blocks, bookId)
  const ops: ClientOp[] = []
  // The book's order as the batch leaves it: the board's, with these links put over it.
  const nextOf = new Map<string, string | null>()
  const prevOf = new Map<string, string>()
  const posOf = new Map<string, string>()
  const lenOf = new Map<string, number>()
  /** The ops that place a block made in this batch (their `pos` is patched by a re-space). */
  const placing = new Map<string, { pos: string }>()
  /** Each block's marks as the batch has left them, where known (a split or merge forgets). */
  const marksOf = new Map<string, readonly Mark[] | null>()

  const stateAt = (id: string): { c: number; k: number } | null => {
    const b = state.blocks.get(id)
    return b === undefined || b.bookId !== bookId ? null : find(ix, b)
  }
  const next = (id: string): string | null => {
    const o = nextOf.get(id)
    if (o !== undefined) return o
    if (id === HEAD) return ix.chunks[0]?.[0]?.id ?? null
    const at = stateAt(id)
    return at === null ? null : (blockAfter(ix, at.c, at.k)?.id ?? null)
  }
  const prev = (id: string): string => {
    const o = prevOf.get(id)
    if (o !== undefined) return o
    const at = stateAt(id)
    return at === null ? HEAD : (blockBefore(ix, at.c, at.k)?.id ?? HEAD)
  }
  const pos = (id: string): string | null =>
    id === HEAD ? null : (posOf.get(id) ?? state.blocks.get(id)?.pos ?? null)
  const len = (id: string): number => lenOf.get(id) ?? state.blocks.get(id)?.text.length ?? 0
  const link = (a: string, b: string | null) => {
    nextOf.set(a, b)
    if (b !== null) prevOf.set(b, a)
  }
  const unlink = (id: string) => {
    const a = prev(id)
    const b = next(id)
    link(a, b)
    nextOf.set(id, null)
  }

  /** `ids` (a run, in order) placed between `a` and `b`: their keys, re-spacing when needed. */
  const place = (a: string, ids: readonly string[], b: string | null) => {
    const lo = pos(a)
    const hi = b === null ? null : pos(b)
    let keys: string[] | null = null
    if (lo === null || hi === null || lo < hi) {
      keys = ids.length === 1 ? [posBetween(lo, hi)] : posKeysBetween(lo, hi, ids.length)
      if (keys.some((k) => k.length > POS_RESPACE_AT)) keys = null
    }
    if (keys !== null) {
      for (let i = 0; i < ids.length; i++) posOf.set(ids[i] as string, keys[i] as string)
      return
    }
    // No room, or keys grown long: this run and its 32 neighbours each side, spaced out again.
    const left: string[] = []
    for (let p = a; p !== HEAD && left.length < RESPACE_SIDE; p = prev(p)) left.unshift(p)
    const right: string[] = []
    for (let n = b; n !== null && right.length < RESPACE_SIDE; n = next(n)) right.push(n)
    const outer = left.length > 0 ? prev(left[0] as string) : a
    const last = right.length > 0 ? right[right.length - 1] : undefined
    const far = last === undefined ? b : next(last)
    const run = [...left, ...ids, ...right]
    const spaced = posKeysBetween(pos(outer), far === null ? null : pos(far), run.length)
    run.forEach((id, i) => {
      const k = spaced[i] as string
      posOf.set(id, k)
      const made = placing.get(id)
      if (made) made.pos = k
      else if (!ids.includes(id) && state.blocks.get(id)?.pos !== k) {
        ops.push({ op: 'block.set', bookId, id, set: { pos: k } })
      }
    })
  }

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i] as EditorChange
    switch (c.t) {
      case 'edit': {
        let n = len(c.id)
        for (const s of c.splices) n += s.ins.length - s.del
        lenOf.set(c.id, n)
        const splices = c.splices.map((s) => ({ at: s.at, del: s.del, ins: s.ins }))
        const was = marksOf.has(c.id) ? marksOf.get(c.id) : state.blocks.get(c.id)?.marks
        if (was) {
          let m = mapMarks(was, splices)
          if (c.removeMarks) m = subtractMarks(m, c.removeMarks)
          marksOf.set(c.id, normalizeMarks([...m, ...(c.addMarks ?? [])]))
        }
        ops.push({
          op: 'block.edit',
          bookId,
          id: c.id,
          ...(was ? stateTakes(was, splices) : { splices }),
          ...(c.addMarks?.length ? { addMarks: c.addMarks.map((m) => ({ ...m })) } : {}),
          ...(c.removeMarks?.length ? { removeMarks: c.removeMarks.map((m) => ({ ...m })) } : {}),
        })
        break
      }
      case 'split': {
        const b = next(c.id)
        lenOf.set(c.newId, len(c.id) - c.at)
        lenOf.set(c.id, c.at)
        const op = {
          op: 'block.split' as const,
          bookId,
          id: c.id,
          at: c.at,
          newId: c.newId,
          pos: '',
          kind: c.kind,
        }
        placing.set(c.newId, op)
        ops.push(op)
        marksOf.set(c.id, null)
        marksOf.set(c.newId, null)
        place(c.id, [c.newId], b)
        op.pos = posOf.get(c.newId) as string
        link(c.id, c.newId)
        link(c.newId, b)
        break
      }
      case 'merge': {
        ops.push({ op: 'block.merge', bookId, from: c.from, into: c.into, at: len(c.into) })
        marksOf.set(c.into, null)
        lenOf.set(c.into, len(c.into) + len(c.from))
        unlink(c.from)
        break
      }
      case 'kind':
        ops.push({ op: 'block.set', bookId, id: c.id, set: { kind: c.kind } })
        break
      case 'image':
        ops.push({ op: 'block.set', bookId, id: c.id, set: { image: boardImage(c.image) } })
        break
      case 'create': {
        // A run of creates, each after the one before (a paste): their keys together.
        const run = [c]
        for (let j = i + 1; j < changes.length; j++) {
          const d = changes[j] as EditorChange
          if (d.t !== 'create' || d.after !== (run[run.length - 1] as typeof c).id) break
          run.push(d)
        }
        const a = c.after ?? HEAD
        const b = next(a)
        let at = a
        for (const r of run) {
          // The block it follows, as the op says it.
          const after = at === HEAD ? null : at
          const block: Block = {
            type: 'block',
            id: r.id,
            bookId,
            pos: '',
            kind: r.kind,
            text: r.text,
            marks: normalizeMarks(r.marks ?? []),
            ...(r.image === undefined ? {} : { image: boardImage(r.image) }),
          }
          placing.set(r.id, block)
          marksOf.set(r.id, block.marks)
          ops.push({ op: 'block.create', block, after })
          lenOf.set(r.id, r.text.length)
          link(at, r.id)
          at = r.id
        }
        link(at, b)
        place(
          a,
          run.map((r) => r.id),
          b,
        )
        for (const r of run) (placing.get(r.id) as { pos: string }).pos = posOf.get(r.id) as string
        i += run.length - 1
        break
      }
      case 'delete':
        ops.push({ op: 'block.delete', bookId, id: c.id })
        unlink(c.id)
        break
    }
  }
  return ops
}

/**
 * The editor changes that show `ops` (the board's, on one book), applied in order. A create, and
 * a move (`block.set pos`, as a delete and a create of the same id), is placed after the block
 * before it in `after`, the board with the ops applied, skipping blocks the ops make later; a
 * moved block is created as `after` holds it, so later ops in the list on it are left out.
 */
export function opsToChanges(ops: readonly Op[], after?: BoardState): EditorChange[] {
  const out: EditorChange[] = []
  /** The last op that makes (or moves) each block: one before it is not there yet. */
  const madeAt = new Map<string, number>()
  ops.forEach((op, i) => {
    if (op.op === 'block.create') madeAt.set(op.block.id, i)
    else if (op.op === 'block.split') madeAt.set(op.newId, i)
    else if (op.op === 'block.set' && op.set.pos !== undefined) madeAt.set(op.id, i)
  })
  const moved = new Set<string>()
  /** The block before `b` in `after` that is there by op `i`. */
  const afterOf = (b: Block, i: number): string | null => {
    if (after === undefined) return null
    const ix = bookBlocks(after.blocks, b.bookId)
    let { c, k } = find(ix, b)
    for (let p = blockBefore(ix, c, k); p !== null; p = blockBefore(ix, c, k)) {
      if ((madeAt.get(p.id) ?? -1) <= i) return p.id
      ;({ c, k } = find(ix, p))
    }
    return null
  }
  ops.forEach((op, i) => {
    switch (op.op) {
      case 'block.edit':
        if (moved.has(op.id)) return
        out.push({
          t: 'edit',
          id: op.id,
          splices: takenSplices(op.splices, op.takes).map((s) => ({ ...s })),
          ...(op.addMarks ? { addMarks: op.addMarks.map((m) => ({ ...m })) } : {}),
          ...(op.removeMarks ? { removeMarks: op.removeMarks.map((m) => ({ ...m })) } : {}),
        })
        return
      case 'block.split':
        out.push({ t: 'split', id: op.id, at: op.at, newId: op.newId, kind: op.kind })
        return
      case 'block.merge':
        out.push({ t: 'merge', from: op.from, into: op.into })
        return
      case 'block.set': {
        if (op.set.pos !== undefined) {
          out.push({ t: 'delete', id: op.id })
          moved.add(op.id)
          const b = after?.blocks.get(op.id)
          if (b !== undefined) {
            out.push({
              t: 'create',
              id: b.id,
              after: afterOf(b, i),
              kind: b.kind,
              text: b.text,
              ...(b.marks.length > 0 ? { marks: b.marks.map((m) => ({ ...m })) } : {}),
              ...(b.image === undefined ? {} : { image: pageImage(b.image, after) }),
            })
          }
        } else if (!moved.has(op.id)) {
          if (op.set.kind !== undefined) out.push({ t: 'kind', id: op.id, kind: op.set.kind })
          if (op.set.image !== undefined)
            out.push({ t: 'image', id: op.id, image: boardImage(op.set.image) })
        }
        return
      }
      case 'block.create': {
        const b = op.block
        out.push({
          t: 'create',
          id: b.id,
          after:
            after === undefined || !after.blocks.has(b.id)
              ? null
              : afterOf(after.blocks.get(b.id) as Block, i),
          kind: b.kind,
          text: b.text,
          ...(b.marks.length > 0 ? { marks: b.marks.map((m) => ({ ...m })) } : {}),
          ...(b.image === undefined ? {} : { image: pageImage(b.image, after) }),
        })
        return
      }
      case 'block.delete':
        out.push({ t: 'delete', id: op.id })
        return
      case 'block.purge':
        for (const id of op.ids) out.push({ t: 'delete', id })
        return
      default:
        return
    }
  })
  return out
}

const sameImage = (a: Block['image'], b: Block['image']) =>
  a === b || (a?.assetId === b?.assetId && a?.card === b?.card)

const sameMarks = (a: readonly EditorMark[], b: readonly EditorMark[]) =>
  a.length === b.length &&
  a.every((m, i) => {
    const n = b[i] as EditorMark
    return m.t === n.t && m.from === n.from && m.to === n.to
  })

/** The mark changes taking `have` to `want` (none when equal). */
const markOps = (have: readonly EditorMark[], want: readonly EditorMark[]) =>
  sameMarks(have, want)
    ? {}
    : { removeMarks: subtractMarks(have, want), addMarks: subtractMarks(want, have) }

/**
 * What changed in book `bookId` from `prev` to `next` (two versions of its block index) as ops:
 * an edit per paragraph whose text or marks changed (between the common prefix and suffix), a kind
 * set, a delete per paragraph gone and a create per new one (in book order), a split where a new
 * paragraph is the tail of the one before it and a merge where a gone one was appended to the one
 * before it (so a composition follows its text), and a move as a delete and a create. Only the
 * chunks `next` does not share with `prev` are read: O(chunks + what changed).
 */
export function bookDiff(bookId: string, prev: BookBlocks, next: BookBlocks): Op[]
/**
 * With `most`: null, before any block is read, once more than `most` chunks of either version are
 * not the other's (the book replaced, or most of it: drawing it again costs less).
 */
export function bookDiff(
  bookId: string,
  prev: BookBlocks,
  next: BookBlocks,
  o: { most: number },
): Op[] | null
export function bookDiff(
  bookId: string,
  prev: BookBlocks,
  next: BookBlocks,
  o?: { most: number },
): Op[] | null {
  if (prev === next) return []
  const inNext = new Set(next.chunks)
  const inPrev = new Set(prev.chunks)
  if (o !== undefined) {
    let changed = 0
    for (const c of next.chunks) if (!inPrev.has(c) && ++changed > o.most) return null
    changed = 0
    for (const c of prev.chunks) if (!inNext.has(c) && ++changed > o.most) return null
  }
  type Seen = { b: Block; pred: string | null }
  const scan = (ix: BookBlocks, shared: Set<readonly Block[]>) => {
    const seen = new Map<string, Seen>()
    const order: string[] = []
    /** The book's order in tokens: a block of a changed chunk by its id, a shared chunk whole. */
    const tokens: Array<string | readonly Block[]> = []
    ix.chunks.forEach((chunk, ci) => {
      if (shared.has(chunk)) {
        tokens.push(chunk)
        return
      }
      chunk.forEach((b, k) => {
        const p = k > 0 ? chunk[k - 1] : ix.chunks[ci - 1]?.[(ix.chunks[ci - 1]?.length ?? 1) - 1]
        seen.set(b.id, { b, pred: p?.id ?? null })
        order.push(b.id)
        tokens.push(b.id)
      })
    })
    return { seen, order, tokens }
  }
  const was = scan(prev, inNext)
  const now = scan(next, inPrev)
  const both = (id: string) => was.seen.has(id) && now.seen.has(id)
  // Moves: when the order of what both have (the shared chunks among it) changed, every block
  // whose key changed is moved (a key kept is a place kept); else a changed key is a re-space.
  const seq = (tokens: Array<string | readonly Block[]>) =>
    tokens.filter((t) => typeof t !== 'string' || both(t))
  const a = seq(was.tokens)
  const z = seq(now.tokens)
  const reordered = a.length !== z.length || a.some((t, i) => t !== z[i])
  const moved = new Set<string>()
  if (reordered) {
    for (const id of now.order) {
      if (both(id) && was.seen.get(id)?.b.pos !== now.seen.get(id)?.b.pos) moved.add(id)
    }
  }
  const gone = was.order.filter((id) => !now.seen.has(id))
  const made = now.order.filter((id) => !was.seen.has(id))
  const kept = (id: string | null): id is string => id !== null && both(id) && !moved.has(id)

  // A split: a new block right after a kept one whose old text is its text and the new block's.
  const splits = new Map<string, { head: string; at: number }>()
  const heads = new Set<string>()
  for (const id of made) {
    const { b, pred } = now.seen.get(id) as Seen
    if (!kept(pred) || heads.has(pred)) continue
    const old = was.seen.get(pred)?.b as Block
    const head = now.seen.get(pred)?.b as Block
    if (old.text === head.text + b.text && b.text.length > 0) {
      splits.set(id, { head: pred, at: head.text.length })
      heads.add(pred)
    }
  }
  // A merge: a gone block whose old text was appended to the kept one before it.
  const merges = new Map<string, { into: string; at: number }>()
  const intos = new Set<string>()
  for (const id of gone) {
    const { b, pred } = was.seen.get(id) as Seen
    if (!kept(pred) || intos.has(pred) || heads.has(pred)) continue
    const old = was.seen.get(pred)?.b as Block
    const into = now.seen.get(pred)?.b as Block
    if (into.text === old.text + b.text && b.text.length > 0) {
      merges.set(id, { into: pred, at: old.text.length })
      intos.add(pred)
    }
  }

  const ops: Op[] = []
  for (const id of gone) {
    if (!merges.has(id)) ops.push({ op: 'block.delete', bookId, id })
  }
  for (const id of moved) ops.push({ op: 'block.delete', bookId, id })
  for (const [from, { into, at }] of merges) {
    ops.push({ op: 'block.merge', bookId, from, into, at })
    const old = was.seen.get(into)?.b as Block
    const want = now.seen.get(into)?.b as Block
    const have = normalizeMarks([
      ...old.marks,
      ...sliceMarks(
        (was.seen.get(from) as Seen).b.marks,
        0,
        (was.seen.get(from) as Seen).b.text.length,
        at,
      ),
    ])
    const m = markOps(have, want.marks)
    if ('addMarks' in m) ops.push({ op: 'block.edit', bookId, id: into, splices: [], ...m })
    if (old.kind !== want.kind)
      ops.push({ op: 'block.set', bookId, id: into, set: { kind: want.kind } })
  }
  for (const id of now.order) {
    if (!both(id) || moved.has(id) || heads.has(id) || intos.has(id)) continue
    const old = was.seen.get(id)?.b as Block
    const b = now.seen.get(id)?.b as Block
    if (old === b) continue
    const splices = diffSplices(old.text, b.text)
    const m = markOps(mapMarks(old.marks, splices), b.marks)
    if (splices.length > 0 || 'addMarks' in m) {
      ops.push({ op: 'block.edit', bookId, id, splices, ...m })
    }
    if (old.kind !== b.kind) ops.push({ op: 'block.set', bookId, id, set: { kind: b.kind } })
    if (b.image !== undefined && !sameImage(old.image, b.image))
      ops.push({ op: 'block.set', bookId, id, set: { image: boardImage(b.image) } })
  }
  for (const id of now.order) {
    if (both(id) && !moved.has(id)) continue
    const b = now.seen.get(id)?.b as Block
    const split = splits.get(id)
    if (split === undefined) {
      ops.push({ op: 'block.create', block: b })
      continue
    }
    const old = was.seen.get(split.head)?.b as Block
    const head = now.seen.get(split.head)?.b as Block
    ops.push({
      op: 'block.split',
      bookId,
      id: split.head,
      at: split.at,
      newId: id,
      pos: b.pos,
      kind: b.kind,
    })
    const hm = markOps(sliceMarks(old.marks, 0, split.at, 0), head.marks)
    if ('addMarks' in hm) ops.push({ op: 'block.edit', bookId, id: split.head, splices: [], ...hm })
    if (old.kind !== head.kind) {
      ops.push({ op: 'block.set', bookId, id: split.head, set: { kind: head.kind } })
    }
    const tm = markOps(sliceMarks(old.marks, split.at, old.text.length, -split.at), b.marks)
    if ('addMarks' in tm) ops.push({ op: 'block.edit', bookId, id, splices: [], ...tm })
  }
  return ops
}
