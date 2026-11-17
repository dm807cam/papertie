export const PALETTE_TOKENS = [
  'cream',
  'rose',
  'apricot',
  'indigo',
  'sage',
  'lilac',
  'ochre',
  'ink',
] as const
export type PaletteToken = (typeof PALETTE_TOKENS)[number]

export interface PaletteEntry {
  /** The paper's name. */
  name: string
  /** The yarn's own name, where the dye is not the paper's colour. */
  yarnName: string
  /** Paper tint. */
  paper: string
  /** Text colour that sits on the paper tint. */
  ink: string
  /** Yarn dye. */
  yarn: string
}

/* The palette: the apricot paper's yarn is a crimson and the lilac yarn a lighter lavender. */
const DARK_INK = '#2B2724'
const LIGHT_INK = '#F3EBDD'

export const PALETTE: Record<PaletteToken, PaletteEntry> = {
  cream: {
    name: 'Cream',
    yarnName: 'Undyed',
    paper: '#F3EBDD',
    ink: DARK_INK,
    yarn: '#EDE4D3',
  },
  rose: {
    name: 'Rose',
    yarnName: 'Rose',
    paper: '#F4DEDC',
    ink: DARK_INK,
    yarn: '#D98A99',
  },
  apricot: {
    name: 'Apricot',
    yarnName: 'Crimson',
    paper: '#F2D5BF',
    ink: DARK_INK,
    yarn: '#B8364A',
  },
  indigo: {
    name: 'Indigo',
    yarnName: 'Indigo',
    paper: '#D9E0EA',
    ink: DARK_INK,
    yarn: '#2E4B7A',
  },
  sage: {
    name: 'Sage',
    yarnName: 'Moss',
    paper: '#DFE4CB',
    ink: DARK_INK,
    yarn: '#6E8B3D',
  },
  lilac: {
    name: 'Lilac',
    yarnName: 'Lilac',
    paper: '#E5DAE6',
    ink: DARK_INK,
    yarn: '#9B7EC6',
  },
  ochre: {
    name: 'Ochre',
    yarnName: 'Ochre',
    paper: '#EEDBAE',
    ink: DARK_INK,
    yarn: '#C9962E',
  },
  ink: {
    name: 'Ink',
    yarnName: 'Ink',
    paper: '#34312E',
    ink: LIGHT_INK,
    yarn: '#2B2A28',
  },
}

export const PAPER_STYLES = ['rustic', 'smooth', 'print'] as const
export type PaperStyle = (typeof PAPER_STYLES)[number]

export const IMAGE_FRAMES = ['none', 'print'] as const
export type ImageFrame = (typeof IMAGE_FRAMES)[number]

/** The decoration a note can carry. */
export const MOTIFS = ['fold', 'margin', 'dots', 'perforation'] as const
export type Motif = (typeof MOTIFS)[number]

/** The family of generated drawing on a book's cover. */
export const COVER_MOTIFS = ['fields', 'overprint', 'contour'] as const

/** The palette inks a cover's motif may take (cream is the paper; apricot's crimson only ever a second ink). */
export const COVER_INKS = ['rose', 'indigo', 'sage', 'lilac', 'ochre', 'ink'] as const
export type CoverInk = (typeof COVER_INKS)[number]
