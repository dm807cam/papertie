/**
 * A book's `word/document.xml` and `word/footnotes.xml`, a block at a time.
 * Pure. Styles by kind: the title `Title`, h1 `Heading1`, h2 `Heading2`, a paragraph `Normal`, a
 * quote `Quote`, a list item `ListBullet`, a figure's caption `Caption`. Footnotes are Word's own
 * (`w:footnoteReference` here, the text in footnotes.xml). Prompts and card marks are never
 * written. Every text and attribute is escaped (`escapeXml`) after what XML forbids is dropped.
 */
import type { Block, BookLang } from '@papertie/core'
import { cleanText, FootnoteRefs, type Footnotes, linksIn, type Run, runsOf } from '../inline'
import { EMU_PER_TWIP, escapeXml, MARGIN, NS, PAGE, XML_DECL } from './parts'

export interface DocxBook {
  title: string
  lang: BookLang
  /** The export's time, ISO. */
  now: string
}

/** A figure's photo in the file. */
export interface DocxImage {
  rId: string
  /** Under `word/`: `media/<assetId>.jpg`. */
  target: string
  width: number
  height: number
}

/** The tallest an image is set, of the text block's height: room for its caption. */
const MAX_HEIGHT = 0.75

/** A run's text: tabs as `w:tab`, newlines as `w:br`. */
function textXml(text: string): string {
  return cleanText(text)
    .split('\n')
    .map((line) =>
      line
        .split('\t')
        .map((t) => (t === '' ? '' : `<w:t xml:space="preserve">${escapeXml(t)}</w:t>`))
        .join('<w:tab/>'),
    )
    .join('<w:br/>')
}

function runXml(text: string, b: boolean, i: boolean, style?: string): string {
  const body = textXml(text)
  if (body === '') return ''
  const rPr =
    (style ? `<w:rStyle w:val="${style}"/>` : '') + (b ? '<w:b/>' : '') + (i ? '<w:i/>' : '')
  return `<w:r>${rPr === '' ? '' : `<w:rPr>${rPr}</w:rPr>`}${body}</w:r>`
}

const refXml = (n: number) =>
  `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${n}"/></w:r>`

const para = (style: string | null, body: string, pPr = '') =>
  `<w:p>${style || pPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${pPr}</w:pPr>` : ''}${body}</w:p>`

const STYLE: Partial<Record<Block['kind'], string>> = {
  h1: 'Heading1',
  h2: 'Heading2',
  quote: 'Quote',
  li: 'ListBullet',
}

export class DocxWriter {
  /** The footnotes' links, in order: `rIdL1`… in footnotes.xml.rels. */
  readonly links: string[] = []
  private readonly refs: FootnoteRefs
  private drawings = 0

  constructor(
    readonly book: DocxBook,
    readonly footnotes: Footnotes,
    /** The figures' photos by asset id; a figure whose photo is missing keeps its caption. */
    readonly images: ReadonlyMap<string, DocxImage>,
  ) {
    this.refs = new FootnoteRefs(footnotes)
  }

  documentHead(): string {
    const title = this.book.title.trim() === '' ? 'Untitled' : this.book.title
    return (
      `${XML_DECL}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"><w:body>` +
      para('Title', runXml(title.replace(/\n/g, ' '), false, false))
    )
  }

  /** The block's paragraphs; '' for a prompt, a footnote (footnotes.xml has it) or an empty block. */
  block(b: Block): string {
    if (b.kind === 'prompt' || b.kind === 'footnote') return ''
    const runs = this.runs(runsOf(b, this.refs))
    if (b.kind !== 'figure') {
      if (runs === '' && b.kind !== 'p') return ''
      return para(STYLE[b.kind] ?? null, runs)
    }
    const image = b.image ? this.images.get(b.image.assetId) : undefined
    const caption = runs === '' ? '' : para('Caption', runs)
    if (!image) return caption
    return para(null, this.drawing(image, b.text), '<w:keepNext/><w:jc w:val="center"/>') + caption
  }

  documentTail(): string {
    const page = PAGE[this.book.lang]
    return (
      `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/>` +
      `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="720" w:footer="720" w:gutter="0"/>` +
      '</w:sectPr></w:body></w:document>'
    )
  }

  footnotesHead(): string {
    const sep = (type: string, id: number, el: string) =>
      `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r>${el}</w:r></w:p></w:footnote>`
    return (
      `${XML_DECL}<w:footnotes xmlns:w="${NS.w}" xmlns:r="${NS.r}">` +
      sep('separator', -1, '<w:separator/>') +
      sep('continuationSeparator', 0, '<w:continuationSeparator/>')
    )
  }

  /** An anchored footnote (`Footnotes.blocks`), its http(s) addresses as links. */
  note(b: Block): string {
    const n = this.footnotes.numbers.get(b.id)
    if (n === undefined) return ''
    const found = linksIn(b.text)
    const ids = found.map((l) => {
      this.links.push(l.url)
      return `rIdL${this.links.length}`
    })
    let body = ''
    let open = -1
    for (const run of runsOf(b, null, found)) {
      if (!('text' in run)) continue
      if (run.link !== open) {
        if (open >= 0) body += '</w:hyperlink>'
        if (run.link >= 0) body += `<w:hyperlink r:id="${ids[run.link]}" w:history="1">`
        open = run.link
      }
      body += runXml(run.text, run.b, run.i, run.link >= 0 ? 'Hyperlink' : undefined)
    }
    if (open >= 0) body += '</w:hyperlink>'
    return (
      `<w:footnote w:id="${n}">` +
      para(
        'FootnoteText',
        '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' +
          `<w:r><w:t xml:space="preserve"> </w:t></w:r>${body}`,
      ) +
      '</w:footnote>'
    )
  }

  footnotesTail(): string {
    return '</w:footnotes>'
  }

  private runs(runs: readonly Run[]): string {
    let out = ''
    for (const r of runs) out += 'ref' in r ? refXml(r.ref) : runXml(r.text, r.b, r.i)
    return out
  }

  /** The photo inline, at the text block's width by its aspect (no taller than `MAX_HEIGHT` of the block). */
  private drawing(image: DocxImage, caption: string): string {
    const page = PAGE[this.book.lang]
    const maxW = (page.w - 2 * MARGIN) * EMU_PER_TWIP
    const maxH = Math.round((page.h - 2 * MARGIN) * EMU_PER_TWIP * MAX_HEIGHT)
    let cx = maxW
    let cy = Math.round((maxW * image.height) / image.width)
    if (cy > maxH) {
      cx = Math.round((maxH * image.width) / image.height)
      cy = maxH
    }
    const id = ++this.drawings
    const descr = escapeXml(cleanText(caption).replace(/\s+/g, ' ').trim())
    return (
      '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Figure ${id}" descr="${descr}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="Figure ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${image.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )
  }
}
