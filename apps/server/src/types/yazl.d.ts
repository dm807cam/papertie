/** The part of yazl 3.3.1 (which ships no types) that the board export uses. */
declare module 'yazl' {
  import { EventEmitter } from 'node:events'
  import type { Readable } from 'node:stream'

  export interface EntryOptions {
    mtime?: Date
    mode?: number
    compress?: boolean
    /** The exact byte count of a lazily read entry; a stream of any other length is an error. */
    size?: number
  }

  /** Emits `error` (a stream or size failure); `outputStream` then never ends on its own. */
  export class ZipFile extends EventEmitter {
    readonly outputStream: Readable
    addBuffer(buffer: Buffer, metadataPath: string, options?: EntryOptions): void
    /** `getReadStream` is called only when the entry's turn comes. */
    addReadStreamLazy(
      metadataPath: string,
      options: EntryOptions,
      getReadStream: (cb: (err: Error | null, stream?: Readable) => void) => void,
    ): void
    end(): void
  }
}
