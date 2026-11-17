/**
 * Where a photo on its way stands:
 * - `uploading`: being added (the moving line): sent, then processed by the store;
 * - `waiting`: the server asked for a pause (`Retry-After`); it tries again by itself after it;
 * - `late`: the server has the photo, but the board has not heard of it yet (Retry looks again);
 * - `failed`: the upload did not get through, and may if tried again;
 * - `rejected`: the server refuses this file, whatever is tried again (`message` says why).
 */
export type PhotoState = 'uploading' | 'waiting' | 'late' | 'failed' | 'rejected'

/** A photo on its way to the server, shown on its note from a blob URL: it is not in the board. */
export interface PendingImage {
  /** The preview, a blob URL. */
  url: string
  state: PhotoState
  /** Why a `rejected` photo was refused. */
  message?: string
  /**
   * The note now holds the uploaded image. The preview stays under it until it is decoded, then
   * the note (or a timer, for a note nobody is looking at) calls `release`.
   */
  committed: boolean
  /** Try again (a `failed` or `late` photo). */
  retry(): void
  /** Give the photo up: the note made for it goes (a replacement keeps its old image). */
  remove(): void
  /** Let the preview go: removes the entry and revokes the blob URL. Safe to call twice. */
  release(): void
}

/**
 * Photos being uploaded on one board, by note id. A note listens to its own id only, so one
 * upload's changes re-render nothing else on the board.
 */
export class PendingImages {
  private readonly map = new Map<string, PendingImage>()
  private readonly listeners = new Map<string, Set<() => void>>()

  get size(): number {
    return this.map.size
  }

  /** The notes with a photo on its way (a copy: entries may be released while it is walked). */
  ids(): string[] {
    return [...this.map.keys()]
  }

  has(noteId: string): boolean {
    return this.map.has(noteId)
  }

  get(noteId: string): PendingImage | undefined {
    return this.map.get(noteId)
  }

  set(noteId: string, p: PendingImage): void {
    this.map.set(noteId, p)
    this.emit(noteId)
  }

  /** Change fields of an entry; a new object each time, as a store snapshot needs. */
  patch(
    noteId: string,
    fields: Partial<Pick<PendingImage, 'state' | 'message' | 'committed'>>,
  ): void {
    const p = this.map.get(noteId)
    if (p === undefined) return
    this.map.set(noteId, { ...p, ...fields })
    this.emit(noteId)
  }

  delete(noteId: string): void {
    if (this.map.delete(noteId)) this.emit(noteId)
  }

  subscribe(noteId: string, fn: () => void): () => void {
    const set = this.listeners.get(noteId) ?? new Set<() => void>()
    this.listeners.set(noteId, set)
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0 && this.listeners.get(noteId) === set) this.listeners.delete(noteId)
    }
  }

  private emit(noteId: string): void {
    for (const fn of this.listeners.get(noteId) ?? []) fn()
  }
}
