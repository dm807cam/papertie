import {
  type BookBlocks,
  blockIndex,
  keepBlockIndex,
  type Owned,
  reindexBlock,
} from './book/blockIndex'
import { hasThreadIndex, keepThreadIndex, reindex, threadIndex } from './ops/threadIndex'
import { PMap, type TransientMap } from './pmap'
import type { Asset, Block, Board, Book, Note, Yarn } from './schema/records'

/** Any record of the board but the board itself (and eof). */
export type BoardRecord = Asset | Note | Yarn | Book | Block

/**
 * Which books' blocks a state holds: `'all'` (the server's states, a whole file's parse) or the
 * books named (a client, which reads the board without blocks and holds a book's once it opens
 * it, `book/held.ts`). A block op on a book not held changes nothing.
 */
export type BlocksHeld = 'all' | ReadonlySet<string>

/**
 * The whole in-memory board. Records are immutable; the maps are read-only views keyed by id.
 * States built by core hold {@link PMap}s, so an edit shares everything it does not change; a
 * hand-built state may hold plain `Map`s, which the first edit converts once.
 */
export interface BoardState {
  readonly board: Board
  readonly assets: ReadonlyMap<string, Asset>
  readonly notes: ReadonlyMap<string, Note>
  readonly yarns: ReadonlyMap<string, Yarn>
  /** Every book, held or not (books are few; their blocks are the weight). */
  readonly books: ReadonlyMap<string, Book>
  /** The blocks of the books held ({@link blocksHeld}). */
  readonly blocks: ReadonlyMap<string, Block>
  readonly blocksHeld: BlocksHeld
}

/** A fresh board at revision 0 with no clients and no content. */
export function emptyBoardState(id: string, name: string, now: string): BoardState {
  return {
    board: {
      type: 'board',
      schemaVersion: 6,
      id,
      name,
      revision: 0,
      clients: {},
      createdAt: now,
      updatedAt: now,
    },
    assets: PMap.from(),
    notes: PMap.from(),
    yarns: PMap.from(),
    books: PMap.from(),
    blocks: PMap.from(),
    blocksHeld: 'all',
  }
}

/**
 * Index already-validated records by id. A later record with the same id replaces an earlier one.
 * `blocksHeld` says which books' blocks `records` holds (all of them, unless told).
 */
export function stateFromRecords(
  board: Board,
  records: Iterable<BoardRecord>,
  blocksHeld: BlocksHeld = 'all',
): BoardState {
  const assets: Array<[string, Asset]> = []
  const notes: Array<[string, Note]> = []
  const yarns: Array<[string, Yarn]> = []
  const books: Array<[string, Book]> = []
  const blocks: Array<[string, Block]> = []
  for (const r of records) {
    if (r.type === 'asset') assets.push([r.id, r])
    else if (r.type === 'note') notes.push([r.id, r])
    else if (r.type === 'yarn') yarns.push([r.id, r])
    else if (r.type === 'book') books.push([r.id, r])
    else blocks.push([r.id, r])
  }
  const state: BoardState = {
    board,
    assets: PMap.from(assets),
    notes: PMap.from(notes),
    yarns: PMap.from(yarns),
    books: PMap.from(books),
    blocks: PMap.from(blocks),
    blocksHeld,
  }
  // Index the threads and the books now, while loading, so no first edit pays for it.
  threadIndex(state.yarns)
  blockIndex(state.blocks)
  return state
}

/**
 * About how many records a {@link stateBuilder} will be given, when known: its maps start sized for
 * them, so no batch pays for a map widening as it grows.
 */
export interface BuilderSizes {
  assets?: number
  notes?: number
  yarns?: number
  books?: number
  blocks?: number
}

/** A board built a batch of records at a time ({@link stateBuilder}). */
export interface StateBuilder {
  /**
   * Index these records; a later record with an id already given replaces it (a note given again
   * as the very object held changes nothing: the map taken next shares its slot).
   */
  add(records: Iterable<BoardRecord>): void
  /**
   * The notes added so far, as a map no later `add` changes: O(1). The next `add` copies what it
   * writes (the root and its notes' buckets), as a persistent map's edit does, so a board shown
   * while it is built (an opening's slices) is this map, never a second one built beside it.
   */
  notes(): ReadonlyMap<string, Note>
  /** Take the notes `ids` out again (ids never added are let be). */
  removeNotes(ids: Iterable<string>): void
  /**
   * The board: as {@link stateFromRecords} of every record added, in order, thread and block
   * indexes included, holding every book's blocks.
   * Asked again, the same board; nothing may be added or removed after it.
   */
  finish(): BoardState
}

/**
 * {@link stateFromRecords}, a batch at a time: each `add` costs O(batch × log n), so a board coming
 * in pieces (a worker's parse, a tiled read) is never indexed in one long task. The thread and
 * block indexes are kept as the records come, so `finish` costs no pass over the board either.
 */
export function stateBuilder(board: Board, expect: BuilderSizes = {}): StateBuilder {
  const assets = PMap.sized<string, Asset>(expect.assets ?? 0).asTransient()
  const yarns = PMap.sized<string, Yarn>(expect.yarns ?? 0).asTransient()
  const index = PMap.sized<string, readonly string[]>(expect.notes ?? 0).asTransient()
  const books = PMap.sized<string, Book>(expect.books ?? 0).asTransient()
  const blocks = PMap.sized<string, Block>(expect.blocks ?? 0).asTransient()
  const byBook = PMap.sized<string, BookBlocks>(expect.books ?? 0).asTransient()
  /** The block index's arrays made here, changed in place as blocks come (none is shown yet). */
  const owned: Owned = new WeakSet()
  /** The notes as last taken (`notes()`), and the transient writing on from them, if any. */
  let shown = PMap.sized<string, Note>(expect.notes ?? 0)
  let notes: TransientMap<string, Note> | null = null
  let done = false
  let built: BoardState | null = null
  const writable = () => {
    if (done) throw new Error('stateBuilder: add after finish')
    notes ??= shown.asTransient()
    return notes
  }
  const taken = () => {
    if (notes !== null) {
      shown = notes.persist()
      notes = null
    }
    return shown
  }
  return {
    add(records) {
      if (done) throw new Error('stateBuilder: add after finish')
      for (const r of records) {
        if (r.type === 'asset') assets.set(r.id, r)
        else if (r.type === 'note') {
          if ((notes ?? shown).get(r.id) !== r) writable().set(r.id, r)
        } else if (r.type === 'yarn') {
          reindex(index, r.id, yarns.get(r.id), r)
          yarns.set(r.id, r)
        } else if (r.type === 'book') books.set(r.id, r)
        else {
          reindexBlock(byBook, blocks.get(r.id), r, owned)
          blocks.set(r.id, r)
        }
      }
    },
    notes: taken,
    removeNotes(ids) {
      for (const id of ids) {
        if (notes?.has(id) ?? shown.has(id)) writable().delete(id)
      }
    },
    finish() {
      if (built !== null) return built
      const n = taken()
      done = true
      const y = yarns.persist()
      keepThreadIndex(y, index.persist())
      const b = blocks.persist()
      keepBlockIndex(b, byBook.persist())
      built = {
        board,
        assets: assets.persist(),
        notes: n,
        yarns: y,
        books: books.persist(),
        blocks: b,
        blocksHeld: 'all',
      }
      return built
    },
  }
}

/** `map` as a {@link PMap}: itself when it is one, otherwise a copy (O(n), once). */
export function asPMap<K, V>(map: ReadonlyMap<K, V>): PMap<K, V> {
  return map instanceof PMap ? map : PMap.from(map)
}

/**
 * `yarns` with `writes` applied in order (a thread set, or deleted where it is `undefined`), as a
 * {@link PMap} that keeps the thread index of `yarns` (or starts one, for an empty map): only the
 * threads written are re-indexed, as an op's draft does, so a board patched outside a batch (an
 * opening's slices, a `changes` answer) never makes {@link threadsOf} index every thread again.
 * O(writes × log n). `yarns` itself when nothing changed.
 */
export function patchYarns(
  yarns: ReadonlyMap<string, Yarn>,
  writes: Iterable<readonly [string, Yarn | undefined]>,
): ReadonlyMap<string, Yarn> {
  const base = asPMap(yarns)
  const t = base.asTransient()
  const carry = hasThreadIndex(yarns) || yarns.size === 0
  const ix = carry ? threadIndex(yarns).asTransient() : null
  let changed = false
  for (const [key, yarn] of writes) {
    const before = t.get(key)
    if (yarn === undefined) {
      if (before === undefined) continue
      t.delete(key)
    } else {
      if (before === yarn) continue
      t.set(key, yarn)
    }
    changed = true
    if (ix) reindex(ix, key, before, yarn)
  }
  if (!changed) return yarns
  const out = t.persist()
  if (ix) keepThreadIndex(out, ix.persist())
  return out
}

/**
 * The threads naming `noteId`, from the thread index kept with the yarn map (built once when a
 * board loads and carried through every edit), so no thread is scanned.
 */
export function threadsOf(state: BoardState, noteId: string): Yarn[] {
  const keys = threadIndex(state.yarns).get(noteId) ?? []
  const out: Yarn[] = []
  for (const key of keys) {
    const yarn = state.yarns.get(key)
    if (yarn) out.push(yarn)
  }
  return out
}
