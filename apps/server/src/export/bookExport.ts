import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type Block, type BoardState, bookBlocks } from '@papertie/core'
import sharp from 'sharp'
import { ASSET_SIZES } from '../limits'
import type { Logger } from '../log'
import { exportSlug, type ZipInput } from '../routes/export'
import { CHECK, SLICE_MS, Slicer, yieldTurn } from '../store/compact'
import { assetDir } from '../store/paths'
import { MarkdownWriter } from './bookMarkdown'
import { type DocxImage, DocxWriter, docxFixedParts, docxImage } from './docx'
import { exportFootnotes, isExported, touchesFootnotes } from './inline'

export type BookFormat = 'md' | 'docx'

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export interface BookExportDeps {
  dataDir: string
  userId: string
  boardId: string
  log: Logger
  /** The export's time: the Word file's dates. */
  now: Date
}

export interface BookExport {
  /** `<slug>.zip` or `<slug>.docx`, the slug `exportSlug` of the title. */
  filename: string
  contentType: string
  /** The zip's entries, for `zipBody`. */
  entries: ZipInput[]
  /** How many slices the export took (`Slicer`): what a test counts, never a clock. */
  slices: number
}

/** The bytes of one piece of a big part (as the book stream's). */
const PIECE_BYTES = 131_072

/** Text gathered into buffer pieces of about `PIECE_BYTES`: a big part, never one buffer. */
class Pieces {
  readonly parts: Buffer[] = []
  private bytes = 0
  private lines: string[] = []
  private size = 0

  /** Adds `s`; true when that filled a piece (a clock read is due then). */
  put(s: string): boolean {
    if (s === '') return false
    this.lines.push(s)
    // UTF-16 units, up to 3 bytes each.
    this.size += s.length
    if (this.size * 3 < PIECE_BYTES) return false
    this.flush()
    return true
  }

  done(): { parts: Buffer[]; size: number } {
    this.flush()
    return { parts: this.parts, size: this.bytes }
  }

  private flush(): void {
    if (this.lines.length === 0) return
    const piece = Buffer.from(this.lines.join(''), 'utf8')
    this.parts.push(piece)
    this.bytes += piece.length
    this.lines = []
    this.size = 0
  }
}

/** `bytes` as a zip entry streamed in pieces: checksummed and deflated a piece at a time. */
function pieced(name: string, bytes: Buffer): ZipInput {
  const parts: Buffer[] = []
  for (let at = 0; at < bytes.length; at += PIECE_BYTES)
    parts.push(bytes.subarray(at, at + PIECE_BYTES))
  return { name, parts, size: bytes.length }
}

const missing = (log: Logger) => log.warn('export: asset file missing', { kind: 'missing-asset' })

/** The 2560 variant of `assetId`, or null (logged by kind only) when its file is gone. */
async function variant(
  deps: BookExportDeps,
  assetId: string,
): Promise<{ path: string; size: number } | null> {
  const path = join(
    assetDir(deps.dataDir, deps.userId, deps.boardId, assetId),
    `${ASSET_SIZES[0]}.webp`,
  )
  try {
    const s = await stat(path)
    if (s.isFile()) return { path, size: s.size }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  missing(deps.log)
  return null
}

/**
 * The export's last slice closed, then the loop given back before it returns: what its caller does
 * next (the zip's start, `zipBody`: its entries added, the first deflate) is a turn of its own,
 * never the tail of the last slice's.
 */
async function ended(s: Slicer): Promise<void> {
  s.note()
  await yieldTurn()
}

/**
 * Book `bookId` of `state` (one immutable version of the board: the store's held state, as the
 * book stream reads it) as Markdown (a zip of `<slug>.md` and `images/<assetId>.webp`, the 2560
 * variants) or Word (`.docx`, its photos as JPEG on white). Null when the board has no such book
 * or the book is in the trash.
 *
 * A `Slicer` job: the blocks are gathered, and their text written into buffer pieces, a few at a
 * time, and the big parts go to the zip piece by piece (`zipBody`). The photos are read (and, for
 * Word, converted by sharp off the loop) between slices. The book's text never leaves these
 * buffers: nothing of it is logged.
 */
export async function exportBook(
  state: BoardState,
  bookId: string,
  format: BookFormat,
  deps: BookExportDeps,
): Promise<BookExport | null> {
  const book = state.books.get(bookId)
  if (!book || book.trashedAt !== null) return null
  const s = await Slicer.start(SLICE_MS)
  const { chunks } = bookBlocks(state.blocks, bookId)
  const kept: Block[] = []
  const touching: Block[] = []
  const figures = new Set<string>()
  let i = 0
  for (const chunk of chunks) {
    for (const b of chunk) {
      if (!isExported(b)) continue
      kept.push(b)
      if (touchesFootnotes(b)) touching.push(b)
      if (b.kind === 'figure' && b.image) figures.add(b.image.assetId)
      if (++i % CHECK === 0 && s.due()) await s.pause()
    }
  }
  // Only the footnotes and the blocks anchoring them: O(those), not O(book).
  const footnotes = exportFootnotes(touching)
  const slug = exportSlug(book.title, 'book')

  /** Each block (then each footnote) through `write`, into pieces, in slices. */
  const written = async (pieces: Pieces, write: (b: Block) => string, blocks: readonly Block[]) => {
    for (const b of blocks) {
      const filled = pieces.put(write(b))
      if ((filled || ++i % CHECK === 0) && s.due()) await s.pause()
    }
  }

  if (format === 'md') {
    s.note()
    const files: ZipInput[] = []
    for (const id of figures) {
      const file = await variant(deps, id)
      if (file) files.push({ name: `images/${id}.webp`, ...file })
    }
    await s.resume()
    const w = new MarkdownWriter(footnotes)
    const md = new Pieces()
    md.put(w.head(book.title))
    await written(md, (b) => w.block(b), kept)
    await written(md, (b) => w.note(b), footnotes.blocks)
    md.put(w.end())
    const text = md.done()
    await ended(s)
    return {
      filename: `${slug}.zip`,
      contentType: 'application/zip',
      entries: [{ name: `${slug}.md`, parts: text.parts, size: text.size }, ...files],
      slices: s.slices,
    }
  }

  s.note()
  const images = new Map<string, DocxImage>()
  const media: ZipInput[] = []
  for (const id of figures) {
    const asset = state.assets.get(id)
    const file = asset ? await variant(deps, id) : null
    if (!asset || !file) {
      if (!asset) missing(deps.log)
      continue
    }
    let jpeg: Buffer
    try {
      // Off the loop (libvips' threads). JPEG, not WebP: every Word opens it.
      jpeg = await sharp(file.path)
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 85 })
        .toBuffer()
    } catch (e) {
      // Never the message: it names the file's path (user and board ids).
      deps.log.warn('export: photo unreadable', { kind: e instanceof Error ? e.name : 'unknown' })
      continue
    }
    const image = docxImage(id, images.size + 1, asset.width, asset.height)
    images.set(id, image)
    media.push(pieced(`word/${image.target}`, jpeg))
  }
  await s.resume()
  const w = new DocxWriter(
    { title: book.title, lang: book.lang, now: deps.now.toISOString() },
    footnotes,
    images,
  )
  const doc = new Pieces()
  doc.put(w.documentHead())
  await written(doc, (b) => w.block(b), kept)
  doc.put(w.documentTail())
  const notes = new Pieces()
  notes.put(w.footnotesHead())
  await written(notes, (b) => w.note(b), footnotes.blocks)
  notes.put(w.footnotesTail())
  const fixed = docxFixedParts(w).map(
    ([name, xml]): ZipInput => ({ name, bytes: Buffer.from(xml, 'utf8') }),
  )
  const document = doc.done()
  const footnotesXml = notes.done()
  await ended(s)
  return {
    filename: `${slug}.docx`,
    contentType: DOCX_TYPE,
    entries: [
      ...fixed.slice(0, 3),
      { name: 'word/document.xml', parts: document.parts, size: document.size },
      { name: 'word/footnotes.xml', parts: footnotesXml.parts, size: footnotesXml.size },
      ...fixed.slice(3),
      ...media,
    ],
    slices: s.slices,
  }
}
