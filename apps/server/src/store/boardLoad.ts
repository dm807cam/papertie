import { isUtf8 } from 'node:buffer'
import { createHash, type Hash } from 'node:crypto'
import {
  BoardParser,
  type BoardState,
  type Eof,
  footnoteOfMark,
  type LoadIssue,
  type ParseOptions,
  type ParseResult,
  repairReferences,
  stateBuilder,
} from '@papertie/core'
import { CHECK, type Slicer } from './compact'

/**
 * A board's `board.jsonl` parsed on the server: `parseBoard`'s result, without holding the event
 * loop for more than one slice at a time. A 100,000-note board was one 560–650 ms
 * parse on a Mac and held a Raspberry Pi's loop for about 4.7 s.
 */

/** About this many bytes are decoded at a time, cut just after a newline (never in a character). */
export const DECODE_BYTES = 65_536
/** Records indexed into the board at a time (256 was a 3 ms step once the parse skipped the schema). */
const BUILD_BATCH = 32
/** Lines parsed between two reads of the clock. */
const LINES = 16

export type SlicedParse = ParseResult & {
  /** The file's eof record when it has a valid one: for a clean file, its last line. */
  eof: Eof | null
}

/**
 * `parseBoard(bytes.toString('utf8'), options)`, in slices of `s`: the same state (records, map
 * order, thread index), issues and integrity. The bytes are decoded a piece at a time (each cut
 * after a newline byte, which no UTF-8 character contains, so each piece decodes as it would in
 * the whole), split into lines as `parseBoard` splits them, parsed line by line, built into the
 * board a batch at a time (`stateBuilder`), and checked for dangling references in slices; only a
 * board that has any is repaired, by `repairReferences` itself.
 */
export async function parseBoardSliced(
  bytes: Buffer,
  s: Slicer,
  options: ParseOptions & { decodeBytes?: number } = {},
): Promise<SlicedParse> {
  // The eof checksum on Node's native SHA-256 (`parseBoard`'s own is pure JS, about 4× slower),
  // fed here rather than by the parser.
  //
  // First without the per-record schema check (a quarter of the parse's CPU): kept only
  // when the eof checksum vouches for every line, i.e. this is a file the server wrote from a
  // state it had validated (the board's directory is the server's own; a deliberate forger who
  // also recomputes the checksum is outside what the check is for, which is damage and edits by
  // hand). Records are deferred only after a valid board line of this build's schema version and
  // when every key is the schema's. Any other outcome, and the lines are parsed again with every
  // check, as `parseBoard`.
  const decodeBytes = options.decodeBytes ?? DECODE_BYTES
  const pass = async (deferRecords: boolean) => {
    const parser = new BoardParser(null, { deferRecords })
    const hash = createHash('sha256')
    await parseLines(bytes, parser, hash, s, decodeBytes)
    return parser.finish(options, hash.digest('hex'))
  }
  let parsed = await pass(true)
  // Any issue (an invalid board line under the fallback board, a duplicate id) means the lines
  // were not all this server's: the whole file again, with every check.
  if ('done' in parsed || parsed.integrity !== 'ok' || parsed.issues.length > 0) {
    await s.pause()
    parsed = await pass(false)
  }
  if ('done' in parsed) return { ...parsed.done, eof: null }

  // The maps start sized for the records, so no batch pays for a widening as they grow.
  const sizes = { assets: 0, notes: 0, yarns: 0, books: 0, blocks: 0 }
  for (let i = 0; i < parsed.records.length; i++) {
    const type = parsed.records[i]?.type
    if (type === 'asset') sizes.assets++
    else if (type === 'note') sizes.notes++
    else if (type === 'yarn') sizes.yarns++
    else if (type === 'book') sizes.books++
    else sizes.blocks++
    if (i % (CHECK * 64) === 0 && s.due()) await s.pause()
  }
  const builder = stateBuilder(parsed.board, sizes)
  for (let at = 0; at < parsed.records.length; at += BUILD_BATCH) {
    builder.add(parsed.records.slice(at, at + BUILD_BATCH))
    if (s.due()) await s.pause()
  }
  let state = builder.finish()
  let repairs: LoadIssue[] = []
  if (await dangling(state, s)) {
    // A damaged file (a recovery follows), or a leftover anchor (quiet): repaired whole, as
    // `parseBoard` does.
    const r = repairReferences(state)
    state = r.state
    repairs = r.issues
  }
  return {
    state,
    issues: repairs.length > 0 ? [...parsed.issues, ...repairs] : parsed.issues,
    integrity: parsed.integrity,
    eof: parsed.eof,
  }
}

/**
 * Every line of `bytes` into `parser`, as `parseBoard` splits its text (`\r?\n`, the BOM gone), and
 * the body lines it names into `hash`, each with its newline. A piece whose every line is a body
 * line, ending in its newline, and whose bytes are well-formed UTF-8 (so its text encodes back to
 * exactly them) is hashed as its bytes; any other piece (the first with a BOM, one with a `\r\n`
 * or a blank line, the eof's) as the text of its body lines.
 */
async function parseLines(
  bytes: Buffer,
  parser: BoardParser,
  hash: Hash,
  s: Slicer,
  decodeBytes: number,
): Promise<void> {
  let line = 0
  for (let pos = 0; ; ) {
    const cut = pos + decodeBytes >= bytes.length ? -1 : bytes.indexOf(0x0a, pos + decodeBytes)
    const end = cut === -1 ? bytes.length : cut + 1
    const last = end === bytes.length
    let text = bytes.toString('utf8', pos, end)
    let whole = !last
    if (pos === 0 && text.startsWith('\uFEFF')) {
      text = text.slice(1)
      whole = false
    }
    const body: string[] = []
    let from = 0
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', from)) {
      // `\r\n` ends a line as `\n` does; a `\r` elsewhere is the line's own.
      const cr = nl > from && text.charCodeAt(nl - 1) === 13
      if (cr) whole = false
      const raw = text.slice(from, cr ? nl - 1 : nl)
      if (parser.line(raw, ++line)) body.push(raw)
      else whole = false
      from = nl + 1
      if (line % LINES === 0 && s.due()) await s.pause()
    }
    // What follows the last newline (often nothing) is a line too, as `split` gives it.
    if (last) {
      const raw = text.slice(from)
      if (parser.line(raw, ++line)) body.push(raw)
      else whole = false
    }
    const piece = bytes.subarray(pos, end)
    if (whole && isUtf8(piece)) hash.update(piece)
    else if (body.length > 0) hash.update(`${body.join('\n')}\n`, 'utf8')
    if (last) return
    pos = end
    if (s.due()) await s.pause()
  }
}

/**
 * Whether `repairReferences(state)` would change anything: an image (a note's, a figure's), a
 * thread's note or a block's book missing, or a footnote anchor naming no footnote of its book
 * (a normal leftover, stripped quietly, so both load paths agree).
 */
async function dangling(state: BoardState, s: Slicer): Promise<boolean> {
  let i = 0
  for (const note of state.notes.values()) {
    if (note.image && !state.assets.has(note.image.assetId)) return true
    if (++i % CHECK === 0 && s.due()) await s.pause()
  }
  for (const yarn of state.yarns.values()) {
    for (const id of yarn.noteIds) if (!state.notes.has(id)) return true
    if (++i % CHECK === 0 && s.due()) await s.pause()
  }
  for (const block of state.blocks.values()) {
    if (!state.books.has(block.bookId)) return true
    if (block.image && !state.assets.has(block.image.assetId)) return true
    for (const m of block.marks) {
      const id = footnoteOfMark(m.t)
      if (id === null) continue
      const f = state.blocks.get(id)
      if (block.kind === 'footnote' || f?.kind !== 'footnote' || f.bookId !== block.bookId)
        return true
    }
    if (++i % CHECK === 0 && s.due()) await s.pause()
  }
  return false
}
