import { open } from 'node:fs/promises'
import { ApiError } from './errors'

/** What a multipart body may hold besides the file itself: boundaries and part headers. */
export const MULTIPART_SLACK_BYTES = 65_536
const MAX_HEADER_BYTES = 8192

const CRLF = Buffer.from('\r\n')
const HEADERS_END = Buffer.from('\r\n\r\n')

/** The `boundary` of a `multipart/form-data` Content-Type, or null. */
function boundaryOf(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) return null
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType)
  return m?.[1] ?? m?.[2] ?? null
}

/** `name="…"` of a part's Content-Disposition, or null. */
function fieldOf(headers: string): string | null {
  for (const line of headers.split('\r\n')) {
    if (!/^content-disposition\s*:/i.test(line)) continue
    const m = /;\s*name="([^"]*)"/i.exec(line)
    return m ? (m[1] as string) : null
  }
  return null
}

/**
 * Stream the multipart field `field` of `req` into the new file `dest` (created 0600, never
 * buffered whole), reading at most `maxBytes` of body: a Content-Length above that, or a body
 * that grows past it, is 413 `too-large` (with `extra` in the body). Anything that is not a
 * well-formed multipart body with that field is 400 `invalid`. Other fields are read past and
 * dropped. Resolves to the file's size.
 *
 * `onChunk` is told each chunk's size before it is written and may throw to stop the upload.
 * `signal` stops it too: the body is cancelled and `onAbort()`'s error is thrown.
 */
export async function receiveFile(
  req: Request,
  field: string,
  dest: string,
  maxBytes: number,
  extra: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; onAbort?: () => Error; onChunk?: (bytes: number) => void } = {},
): Promise<number> {
  const boundary = boundaryOf(req.headers.get('content-type'))
  if (!boundary) throw new ApiError(400, 'invalid')
  const declared = req.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new ApiError(413, 'too-large', extra)
  }
  if (!req.body) throw new ApiError(400, 'invalid')

  const first = Buffer.from(`--${boundary}`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const fh = await open(dest, 'wx', 0o600)
  let written = 0
  let found = false
  try {
    let buf = Buffer.alloc(0)
    let total = 0
    /** `preamble` (before the first boundary), `headers` (of a part), `body` (of a part), `end`. */
    let state: 'preamble' | 'headers' | 'body' | 'end' = 'preamble'
    let into = false
    const reader = req.body.getReader()
    const aborted = () => opts.onAbort?.() ?? new ApiError(409, 'superseded')
    // A stalled upload is let go at once: the pending read ends.
    const stop = () => void reader.cancel().catch(() => {})
    opts.signal?.addEventListener('abort', stop, { once: true })
    try {
      for (;;) {
        if (opts.signal?.aborted) throw aborted()
        const { value, done } = await reader.read()
        if (opts.signal?.aborted) throw aborted()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) throw new ApiError(413, 'too-large', extra)
        opts.onChunk?.(value.byteLength)
        buf = buf.length === 0 ? Buffer.from(value) : Buffer.concat([buf, value])
        for (;;) {
          if (state === 'preamble') {
            const at = buf.indexOf(first)
            if (at < 0) {
              buf = buf.subarray(Math.max(0, buf.length - first.length))
              break
            }
            buf = buf.subarray(at + first.length)
            state = 'headers'
          } else if (state === 'headers') {
            // After a boundary: `--` ends the body, CRLF starts a part.
            if (buf.length < 2) break
            if (buf[0] === 0x2d && buf[1] === 0x2d) {
              state = 'end'
              continue
            }
            const end = buf.indexOf(HEADERS_END)
            if (end < 0) {
              if (buf.length > MAX_HEADER_BYTES) throw new ApiError(400, 'invalid')
              break
            }
            if (!buf.subarray(0, 2).equals(CRLF)) throw new ApiError(400, 'invalid')
            const name = fieldOf(buf.subarray(2, end).toString('latin1'))
            into = name === field && !found
            if (into) found = true
            buf = buf.subarray(end + HEADERS_END.length)
            state = 'body'
          } else if (state === 'body') {
            const at = buf.indexOf(delimiter)
            // Keep what could be the start of a delimiter cut by the chunk's end.
            const upto = at >= 0 ? at : Math.max(0, buf.length - delimiter.length)
            if (into && upto > 0) {
              await fh.write(buf.subarray(0, upto))
              written += upto
            }
            if (at < 0) {
              buf = Buffer.from(buf.subarray(upto))
              break
            }
            buf = buf.subarray(at + delimiter.length)
            state = 'headers'
          } else {
            buf = Buffer.alloc(0)
            break
          }
        }
      }
    } catch (e) {
      // What is left of the body is not wanted.
      await reader.cancel().catch(() => {})
      throw e
    } finally {
      opts.signal?.removeEventListener('abort', stop)
    }
    if (state !== 'end' || !found) throw new ApiError(400, 'invalid')
  } finally {
    await fh.close()
  }
  return written
}
