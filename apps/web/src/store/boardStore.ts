import { applyBatch, type BoardState, type ClientOp, type Touched } from '@papertie/core'
import { type StoreApi, useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/** How one commit is sent and remembered. */
export interface CommitOptions {
  /** Batches with the same key merge while unsent (text typing); none sends at once. */
  coalesceKey?: string
  /**
   * What notices call this change, should it be dropped, and an undo of it that skipped parts
   * (`Edit text`, `Move 3 notes`).
   */
  label?: string
  /** Whether the undo stack records the batch: `record` (the default), or `skip` (undo, redo). */
  undo?: 'record' | 'skip'
}

/** Told of each commit that changed the board: the board before it, its ops and options. */
export type CommitListener = (
  before: BoardState,
  ops: readonly ClientOp[],
  o: CommitOptions,
) => void

/**
 * Applies a batch and answers the board to show. The local default applies it to the store's
 * board with core's `applyBatch`; a server session's applier is `SyncClient.submit`, whose view
 * is the confirmed board with every pending batch on top. Throws `OpError`, changing nothing,
 * when the ops do not apply; answers the current board unchanged for a batch that changes nothing.
 */
export type Applier = (ops: readonly ClientOp[], o: CommitOptions) => BoardState

/**
 * What a `replace` changed: the ids of the notes, threads and photos it adds, changes or removes
 * (every other record is the very one the board had, or one equal to it), or `all` when that is
 * not known (the board loaded again, restored, imported).
 */
export type BoardTouched = Touched | 'all'

/** The in-memory board. `commit` is the only way edits get in: one gesture, one batch. */
export interface BoardStore {
  getState(): BoardState
  subscribe(fn: (s: BoardState, prev: BoardState) => void): () => void
  /**
   * Apply `ops` as one all-or-nothing batch through the store's applier. Throws `OpError` with
   * the state untouched. A batch that changes nothing notifies nobody and is not counted.
   */
  commit(ops: readonly ClientOp[], o?: CommitOptions): BoardState
  /** Listen to commits that change the board (the undo stack records them), after subscribers. */
  onCommit(fn: CommitListener): () => void
  /**
   * Swap in a whole new board (loading, or a server session's view after a remote change);
   * notifies subscribers but is not a commit. `touched`: what it changes, when the caller knows
   * (an opening's slice, the hand-over to the whole board), so a subscriber need not compare the
   * boards ({@link touched}); `all` when the caller knows it cannot tell.
   */
  replace(s: BoardState, touched?: BoardTouched): void
  /**
   * What `replace` said took the board from `prev` to `s`; undefined when it was not told
   * (compare the maps).
   */
  touched(s: BoardState, prev: BoardState): BoardTouched | undefined
  /** Number of batches that changed the state. */
  readonly commits: number
  /** Now, as edits are stamped (ISO-8601 UTC): the server's clock on a server board. */
  now(): string
}

const apis = new WeakMap<BoardStore, StoreApi<BoardState>>()

/**
 * A board store on `initial`. Without `apply`, commits apply locally (`applyBatch`, stamped by
 * `clock`): the bench, study and e2e boards. A server session passes `SyncClient.submit`, and
 * the server's clock as `clock`, which new records are stamped with.
 */
export function createBoardStore(
  initial: BoardState,
  apply?: Applier,
  clock: () => string = () => new Date().toISOString(),
): BoardStore {
  const api = createStore<BoardState>()(() => initial)
  const applier: Applier = apply ?? ((ops) => applyBatch(api.getState(), ops, { now: clock() }))
  let commits = 0
  const listeners = new Set<CommitListener>()
  /** The last `replace` told of what it changed: from which board, to which, and what. */
  let told: { prev: BoardState; next: BoardState; touched: BoardTouched } | null = null
  const store: BoardStore = {
    getState: () => api.getState(),
    subscribe: (fn) => api.subscribe(fn),
    commit(ops, o = {}) {
      const prev = api.getState()
      const next = applier(ops, o)
      if (next === prev) return prev
      commits++
      api.setState(next, true)
      for (const fn of listeners) fn(prev, ops, o)
      return next
    },
    onCommit(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    replace: (s, touched) => {
      told = touched ? { prev: api.getState(), next: s, touched } : null
      api.setState(s, true)
    },
    touched: (s, prev) => (told?.next === s && told.prev === prev ? told.touched : undefined),
    get commits() {
      return commits
    },
    now: clock,
  }
  apis.set(store, api)
  return store
}

/**
 * Subscribe a component to a slice of the board. `selector` must return a stable value (a
 * record, a primitive, a memoised result), or React re-renders on every store change.
 */
export function useBoard<T>(store: BoardStore, selector: (s: BoardState) => T): T {
  const api = apis.get(store)
  if (!api) throw new Error('useBoard: store was not made by createBoardStore')
  return useStore(api, selector)
}
