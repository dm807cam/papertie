import type { CommitEvent } from './ring'

export type BoardEvent =
  | { type: 'commit'; commit: CommitEvent }
  | { type: 'reset'; revision: number }
  | { type: 'closed' }

type Listener = (e: BoardEvent) => void

/** Fan-out of board events to subscribers, keyed `${userId}/${boardId}`. */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>()

  /** `onError` hears a listener that threw; the other listeners still get the event. */
  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  subscribe(key: string, fn: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    // Wrapped so the same function subscribed twice is two subscriptions.
    const entry: Listener = (e) => fn(e)
    set.add(entry)
    return () => {
      const cur = this.listeners.get(key)
      if (!cur?.delete(entry)) return
      if (cur.size === 0) this.listeners.delete(key)
    }
  }

  publish(key: string, e: BoardEvent): void {
    const set = this.listeners.get(key)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(e)
      } catch (err) {
        this.onError(err)
      }
    }
  }

  count(key: string): number {
    return this.listeners.get(key)?.size ?? 0
  }

  countUser(userId: string): number {
    let n = 0
    for (const key of this.keys(userId)) n += this.count(key)
    return n
  }

  /** Keys that have subscribers: all of them, or only those of `userId`'s boards. */
  keys(userId?: string): string[] {
    const all = [...this.listeners.keys()]
    return userId === undefined ? all : all.filter((k) => k.startsWith(`${userId}/`))
  }

  /** Drop every subscriber of `key` (after `closed`, nothing more is delivered). */
  drop(key: string): void {
    this.listeners.delete(key)
  }
}
