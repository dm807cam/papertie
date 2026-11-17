import type { Readable } from 'node:stream'
import { LIMITS } from '@papertie/core'

/** What an import may hold, and the errors that turn a file away (`importBoard.ts`). */

const MIB = 1_048_576

export const IMPORT_LIMITS = {
  /** `board.jsonl`, or a plain `.jsonl` file: the allowance beyond the photo quota. */
  jsonlBytes: 1024 * MIB,
  manifestBytes: 64 * 1024,
  /** One photo in the archive, as the upload route takes one. */
  assetBytes: 25 * MIB,
  /** An entry inflating more than this many times its stored size is refused (a zip bomb). */
  maxRatio: 100,
  /** One board record, one manifest, and at most one photo per note. */
  maxEntries: 2 + LIMITS.maxNotes,
  /** A line longer than this cannot be a record (a note's text is at most 20,000 characters). */
  maxLineChars: MIB,
} as const

/** The file is refused; nothing was changed. `line` (1-based) when one line is to blame. */
export class ImportInvalid extends Error {
  constructor(
    readonly reason: string,
    readonly line?: number,
  ) {
    super(reason)
    this.name = 'ImportInvalid'
  }
}

/** The file's photos do not fit in what is left of the account's quota. */
export class ImportQuota extends Error {
  constructor(
    readonly needBytes: number,
    readonly freeBytes: number,
  ) {
    super('quota')
    this.name = 'ImportQuota'
  }
}

/** `stream`, destroyed with `ImportInvalid(reason)` once more than `cap` bytes came. */
export async function* capped(
  stream: Readable | AsyncIterable<Buffer>,
  cap: number,
  reason: string,
): AsyncGenerator<Buffer> {
  let n = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      n += chunk.length
      if (n > cap) throw new ImportInvalid(reason)
      yield chunk
    }
  } finally {
    if ('destroy' in stream && typeof stream.destroy === 'function') stream.destroy()
  }
}

export async function readAll(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const c of chunks) out.push(c)
  return Buffer.concat(out)
}

/** The import was called off while it was being read: a newer one of the board, or a deletion. */
export class ImportAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'ImportAborted'
  }
}

/** The server's staging room for imports is used up (`ImportBudget`). */
export class ImportStagingFull extends Error {
  constructor() {
    super('staging-full')
    this.name = 'ImportStagingFull'
  }
}
