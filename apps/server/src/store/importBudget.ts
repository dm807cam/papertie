import { statfs } from 'node:fs/promises'

/** Free disk that staging never takes: the boards' own writes need room to land. */
export const STAGING_DISK_RESERVE_BYTES = 2 * 1_073_741_824

/** Free bytes on the file system holding `dir`, for an unprivileged writer. */
export async function freeDiskBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return s.bavail * s.bsize
}

export interface ImportBudgetOptions {
  /** The cap on staged bytes. */
  capBytes: number
  dataDir: string
  /** Injectable for tests. */
  freeDisk?: (dir: string) => Promise<number>
}

/**
 * The bytes every import holds on disk while it is staged, server-wide: its upload as it streams
 * in, then its re-encoded photos until it is committed or discarded. They may not pass the
 * smaller of the configured cap and what the disk has free less 2 GB (the bytes already held are
 * on the disk, so they count as room). Free disk is looked at when an import begins (`refresh`).
 */
export class ImportBudget {
  private used = 0
  private limit: number

  constructor(private readonly o: ImportBudgetOptions) {
    this.limit = o.capBytes
  }

  /** Look at the disk again: the limit becomes min(cap, held + free − 2 GB). */
  async refresh(): Promise<void> {
    let free: number
    try {
      free = await (this.o.freeDisk ?? freeDiskBytes)(this.o.dataDir)
    } catch {
      // Unknown: the configured cap alone.
      this.limit = this.o.capBytes
      return
    }
    this.limit = Math.min(this.o.capBytes, this.used + free - STAGING_DISK_RESERVE_BYTES)
  }

  /** Hold `bytes` more; false (and nothing held) when that would pass the limit. */
  take(bytes: number): boolean {
    if (this.used + bytes > this.limit) return false
    this.used += bytes
    return true
  }

  /** Give back bytes held by `take`. */
  give(bytes: number): void {
    this.used = Math.max(0, this.used - bytes)
  }

  get held(): number {
    return this.used
  }
}
