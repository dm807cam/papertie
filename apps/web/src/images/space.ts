import type { BoardSession } from '../app/session'
import { PendingImages } from './pending'

/** At most `limit` of the tasks given to it run at a time. */
export function createGate(limit: number) {
  let running = 0
  const waiting: Array<() => void> = []
  return async function gated<T>(task: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    running++
    try {
      return await task()
    } finally {
      running--
      waiting.shift()?.()
    }
  }
}

/** Photos prepared, and uploads sent, at once: a drop of many goes through in small waves. */
const CONCURRENT = 3

/**
 * Everything a board session's photos hold: the photos on their way (previews, states), the
 * concurrency gates and the means to cancel. It belongs to the session, so one board's blobs and
 * uploads never outlive it or show on another, and `dispose` (the canvas going) aborts what is
 * in flight and lets go of every preview. It stays usable after: a new canvas on the same
 * session starts clean.
 */
export class PhotoSpace {
  readonly pending = new PendingImages()
  readonly prepares = createGate(CONCURRENT)
  readonly uploads = createGate(CONCURRENT)
  private readonly jobs = new Map<string, AbortController>()
  /**
   * Bumped by `dispose`. Work that awaits (preparing a photo) notes it at the start and gives
   * up if it changed: a canvas that went takes the photos it was still preparing with it.
   */
  generation = 0

  constructor(session: Pick<BoardSession, 'store'>) {
    // A note deleted or undone while its photo travels (or shows Retry) takes the photo with it.
    // Walks the pending ones only, never the board.
    session.store.subscribe((s) => {
      if (this.pending.size === 0) return
      for (const id of this.pending.ids()) if (!s.notes.has(id)) this.drop(id)
    })
  }

  /** Start work for `noteId`'s photo: what it is given aborts when the photo is dropped. */
  begin(noteId: string): AbortController {
    this.jobs.get(noteId)?.abort()
    const ctl = new AbortController()
    this.jobs.set(noteId, ctl)
    return ctl
  }

  /** `noteId`'s photo is done with: forget its work (unless a newer photo has taken its place). */
  end(noteId: string, ctl: AbortController): void {
    if (this.jobs.get(noteId) === ctl) this.jobs.delete(noteId)
  }

  /** Stop `noteId`'s photo: abort its work and let go of its preview. */
  drop(noteId: string): void {
    this.jobs.get(noteId)?.abort()
    this.jobs.delete(noteId)
    this.pending.get(noteId)?.release()
  }

  /** Abort everything in flight and let go of every preview. */
  dispose(): void {
    this.generation++
    for (const ctl of this.jobs.values()) ctl.abort()
    this.jobs.clear()
    for (const id of this.pending.ids()) this.pending.get(id)?.release()
  }
}

const spaces = new WeakMap<object, PhotoSpace>()

/** The photo space of `session` (keyed by its store), made on first use. */
export function photoSpaceFor(session: Pick<BoardSession, 'store'>): PhotoSpace {
  let space = spaces.get(session.store)
  if (space === undefined) {
    space = new PhotoSpace(session)
    spaces.set(session.store, space)
  }
  return space
}
