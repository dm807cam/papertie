import type { Op } from '@papertie/core'

/** One commit as subscribers see it; `now` is the server time the commit was applied with. */
export interface CommitEvent {
  revision: number
  ops: Op[]
  originClientId: string | null
  seq: number | null
  now: string
  /**
   * `batchDigest([ops as posted])` when the store rewrote the batch: the page knows its own
   * commit by it, its `ops` being the ops as applied.
   */
  sent?: string
}

/** The most recent commits of one board, bounded by count and by serialized size. */
export class CommitRing {
  private entries: Array<{ event: CommitEvent; bytes: number }> = []
  private bytes = 0

  constructor(
    private readonly maxCommits: number,
    private readonly maxBytes: number,
  ) {}

  /**
   * `opsBytes`, when the caller has it: the UTF-8 size of `event.ops`'s JSON between its brackets,
   * so the event's size is counted without stringifying its ops again (a 400-op batch of long
   * notes: 720 KB, about 0.7 ms in one go on a Mac).
   */
  push(event: CommitEvent, opsBytes?: number): void {
    const bytes =
      opsBytes === undefined
        ? Buffer.byteLength(JSON.stringify(event), 'utf8')
        : Buffer.byteLength(JSON.stringify({ ...event, ops: [] }), 'utf8') + opsBytes
    this.entries.push({ event, bytes })
    this.bytes += bytes
    while (this.entries.length > this.maxCommits || this.bytes > this.maxBytes) {
      const dropped = this.entries.shift()
      if (!dropped) break
      this.bytes -= dropped.bytes
    }
  }

  /**
   * The commits after `rev` up to `current`, oldest first, or null when the ring cannot supply all
   * of them (they were dropped, the ring was cleared, or `rev` is ahead of `current`).
   */
  since(rev: number, current: number): CommitEvent[] | null {
    if (rev > current) return null
    if (rev === current) return []
    const first = this.entries[0]?.event
    const last = this.entries.at(-1)?.event
    if (!first || !last || first.revision > rev + 1 || last.revision !== current) return null
    return this.entries.filter((e) => e.event.revision > rev).map((e) => e.event)
  }

  clear(): void {
    this.entries = []
    this.bytes = 0
  }
}
