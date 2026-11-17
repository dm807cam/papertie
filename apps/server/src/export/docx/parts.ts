/**
 * The fixed parts of a book's `.docx`: content types, relationships, styles,
 * numbering, settings, the font table and the core properties. Pure strings; no macros, and no
 * external relationship but a footnote's link (`footnotesRels`).
 */
import type { BookLang } from '@papertie/core'
import { cleanText } from '../inline'

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** `&`, `<`, `>` and both quotes as entities: for text and attribute values alike. */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  )
}

/**
 * The page by the book's language: US Letter for English, A4 for German, an inch of margin all
 * round (twentieths of a point). The text block is what an image is fitted to.
 */
export const PAGE: Record<BookLang, { w: number; h: number; lang: string }> = {
  en: { w: 12_240, h: 15_840, lang: 'en-US' },
  de: { w: 11_906, h: 16_838, lang: 'de-DE' },
}
export const MARGIN = 1440
/** EMU (DrawingML's unit) per twip. */
export const EMU_PER_TWIP = 635

/** Papertie's faces, by name, with the fallbacks Word substitutes where they are not installed. */
const BODY = 'Instrument Sans'
const BODY_FALLBACK = 'Arial'
const DISPLAY = 'Newsreader'
const DISPLAY_FALLBACK = 'Georgia'
const fonts = (face: string, fallback: string) =>
  `<w:rFonts w:ascii="${face}" w:hAnsi="${face}" w:eastAsia="${face}" w:cs="${fallback}"/>`
const CRIMSON = 'B8364A'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface MediaRel {
  rId: string
  /** The file under `word/`, `media/<assetId>.jpg`. */
  target: string
}

export function contentTypes(hasJpeg: boolean): string {
  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
  const over = (part: string, type: string) =>
    `<Override PartName="${part}" ContentType="${type}"/>`
  return (
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (hasJpeg ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
    over('/word/document.xml', `${ct}.document.main+xml`) +
    over('/word/styles.xml', `${ct}.styles+xml`) +
    over('/word/numbering.xml', `${ct}.numbering+xml`) +
    over('/word/footnotes.xml', `${ct}.footnotes+xml`) +
    over('/word/settings.xml', `${ct}.settings+xml`) +
    over('/word/fontTable.xml', `${ct}.fontTable+xml`) +
    over('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml') +
    '</Types>'
  )
}

export function rootRels(): string {
  return (
    `${XML_DECL}<Relationships xmlns="${NS.rels}">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>'
  )
}

export function documentRels(media: readonly MediaRel[]): string {
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`
  return (
    `${XML_DECL}<Relationships xmlns="${NS.rels}">` +
    rel('rId1', 'styles', 'styles.xml') +
    rel('rId2', 'numbering', 'numbering.xml') +
    rel('rId3', 'footnotes', 'footnotes.xml') +
    rel('rId4', 'settings', 'settings.xml') +
    rel('rId5', 'fontTable', 'fontTable.xml') +
    media.map((m) => rel(m.rId, 'image', m.target)).join('') +
    '</Relationships>'
  )
}

/** The footnotes' links (`rIdL1`…), the only external relationships in the file. */
export function footnotesRels(links: readonly string[]): string {
  return (
    `${XML_DECL}<Relationships xmlns="${NS.rels}">` +
    links
      .map(
        (url, k) =>
          `<Relationship Id="rIdL${k + 1}" Type="${REL}/hyperlink" Target="${escapeXml(cleanText(url))}" TargetMode="External"/>`,
      )
      .join('') +
    '</Relationships>'
  )
}

export function styles(lang: BookLang): string {
  const para = (id: string, name: string, body: string, extra = '') =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>${extra}<w:qFormat/>${body}</w:style>`
  const char = (id: string, name: string, rPr: string) =>
    `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${name}"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>${rPr}</w:style>`
  const display = fonts(DISPLAY, DISPLAY_FALLBACK)
  return (
    `${XML_DECL}<w:styles xmlns:w="${NS.w}">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${fonts(BODY, BODY_FALLBACK)}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${PAGE[lang].lang}"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="324" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    para(
      'Title',
      'Title',
      `<w:pPr><w:spacing w:before="1440" w:after="720"/></w:pPr><w:rPr>${display}<w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr>`,
    ) +
    para(
      'Heading1',
      'heading 1',
      `<w:pPr><w:keepNext/><w:pageBreakBefore/><w:spacing w:before="720" w:after="360"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr>${display}<w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr>`,
    ) +
    para(
      'Heading2',
      'heading 2',
      `<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr>${display}<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>`,
    ) +
    para(
      'Quote',
      'Quote',
      `<w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="12" w:color="${CRIMSON}"/></w:pBdr><w:spacing w:before="240" w:after="240"/><w:ind w:left="360"/></w:pPr><w:rPr>${display}</w:rPr>`,
    ) +
    para(
      'ListBullet',
      'List Bullet',
      // Tight between its items, a paragraph's space after the list (`contextualSpacing`).
      '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="160"/><w:contextualSpacing/></w:pPr>',
    ) +
    para(
      'Caption',
      'caption',
      '<w:pPr><w:spacing w:before="80" w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>',
    ) +
    para(
      'FootnoteText',
      'footnote text',
      '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>',
    ) +
    char(
      'FootnoteReference',
      'footnote reference',
      '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>',
    ) +
    char(
      'Hyperlink',
      'Hyperlink',
      '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>',
    ) +
    '</w:styles>'
  )
}

export function numbering(): string {
  return (
    `${XML_DECL}<w:numbering xmlns:w="${NS.w}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
    `<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="${BODY_FALLBACK}" w:hAnsi="${BODY_FALLBACK}"/></w:rPr></w:lvl></w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
  )
}

export function settings(): string {
  return (
    `${XML_DECL}<w:settings xmlns:w="${NS.w}">` +
    '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
    '</w:settings>'
  )
}

/** Papertie's faces named, each with its fallback (`altName`), and the fallbacks themselves. */
export function fontTable(): string {
  const font = (name: string, family: string, alt?: string) =>
    `<w:font w:name="${name}">${alt ? `<w:altName w:val="${alt}"/>` : ''}<w:family w:val="${family}"/><w:pitch w:val="variable"/></w:font>`
  return (
    `${XML_DECL}<w:fonts xmlns:w="${NS.w}">` +
    font(BODY, 'swiss', BODY_FALLBACK) +
    font(DISPLAY, 'roman', DISPLAY_FALLBACK) +
    font(BODY_FALLBACK, 'swiss') +
    font(DISPLAY_FALLBACK, 'roman') +
    '</w:fonts>'
  )
}

/** The title, the language and the export's time; no author (no account detail is in the file). */
export function coreProps(title: string, lang: BookLang, now: string): string {
  const at = `${now.slice(0, 19)}Z`
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(cleanText(title).replace(/\n/g, ' '))}</dc:title><dc:language>${PAGE[lang].lang}</dc:language>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}
