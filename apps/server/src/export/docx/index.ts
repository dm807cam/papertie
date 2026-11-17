/**
 * A book as a `.docx`: WordprocessingML written by our own small writer,
 * zipped by the route with yazl. Pure.
 */
import type { Block } from '@papertie/core'
import { exportFootnotes, isExported, touchesFootnotes } from '../inline'
import {
  contentTypes,
  coreProps,
  documentRels,
  fontTable,
  footnotesRels,
  numbering,
  rootRels,
  settings,
  styles,
} from './parts'
import { type DocxBook, type DocxImage, DocxWriter } from './writer'

export type { DocxBook, DocxImage } from './writer'
export { DocxWriter } from './writer'

/** The photo of asset `assetId` in the file: `word/media/<assetId>.jpg`, relationship `rIdImg<k>`. */
export function docxImage(assetId: string, k: number, width: number, height: number): DocxImage {
  return { rId: `rIdImg${k}`, target: `media/${assetId}.jpg`, width, height }
}

/**
 * Every part but `word/document.xml`, `word/footnotes.xml` and the media, once the writer has
 * written those (its links are known then): name → XML.
 */
export function docxFixedParts(w: DocxWriter): Array<[string, string]> {
  const media = [...w.images.values()]
  const out: Array<[string, string]> = [
    ['[Content_Types].xml', contentTypes(media.length > 0)],
    ['_rels/.rels', rootRels()],
    ['docProps/core.xml', coreProps(w.book.title, w.book.lang, w.book.now)],
    ['word/styles.xml', styles(w.book.lang)],
    ['word/numbering.xml', numbering()],
    ['word/settings.xml', settings()],
    ['word/fontTable.xml', fontTable()],
    ['word/_rels/document.xml.rels', documentRels(media)],
  ]
  if (w.links.length > 0) out.push(['word/_rels/footnotes.xml.rels', footnotesRels(w.links)])
  return out
}

/**
 * The whole book at once (the blocks in book order; `sizes` the photos' pixel sizes by asset id):
 * every XML part by name, the media left out.
 */
export function bookDocx(
  book: DocxBook,
  blocks: readonly Block[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
): Map<string, string> {
  const kept = blocks.filter(isExported)
  const images = new Map<string, DocxImage>()
  for (const [id, s] of sizes) images.set(id, docxImage(id, images.size + 1, s.width, s.height))
  const w = new DocxWriter(book, exportFootnotes(kept.filter(touchesFootnotes)), images)
  let doc = w.documentHead()
  for (const b of kept) doc += w.block(b)
  doc += w.documentTail()
  let notes = w.footnotesHead()
  for (const b of w.footnotes.blocks) notes += w.note(b)
  notes += w.footnotesTail()
  return new Map([...docxFixedParts(w), ['word/document.xml', doc], ['word/footnotes.xml', notes]])
}
