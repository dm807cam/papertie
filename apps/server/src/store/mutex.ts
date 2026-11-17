/** Serializes async work per key. A key's entry is removed once its chain goes idle. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  get size(): number {
    return this.tails.size
  }

  /** True while work for `key` is running or waiting. */
  isHeld(key: string): boolean {
    return this.tails.has(key)
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const result = prev.then(fn)
    // Registered before the caller can await `result`, so the entry is gone by the time it resumes.
    const tail: Promise<void> = result.then(
      () => this.release(key, tail),
      () => this.release(key, tail),
    )
    this.tails.set(key, tail)
    return result
  }

  private release(key: string, tail: Promise<void>): void {
    if (this.tails.get(key) === tail) this.tails.delete(key)
  }
}
