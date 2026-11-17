import { MOTIFS, type Motif, type Note, PALETTE, type PaletteToken } from '@papertie/core'
import { StampMark } from '../notes/StampMark'
import { CorkPanel, studyNote } from './CorkPanel'

const W = 1580
const COL = 340
const ROW = 312
const NOTE = { w: 300, h: 240 }
const TAG_X = 48 + 4 * COL
const TAG_ROW = 340

const TEXT =
  'Call the printer\nProofs due Friday\n- Ask for the heavier stock\n- Two hundred copies'

/** The papers each row is shown on; the dot grid, the one decoration under text, on all eight. */
const PAPERS: Record<Motif, readonly PaletteToken[]> = {
  fold: ['cream', 'indigo', 'ink', 'apricot'],
  margin: ['cream', 'rose', 'ink', 'sage'],
  dots: ['cream', 'apricot', 'indigo', 'ink'],
  perforation: ['cream', 'lilac', 'ink', 'ochre'],
}
const MORE_DOTS: readonly PaletteToken[] = ['rose', 'sage', 'lilac', 'ochre']
const STAMPED: readonly PaletteToken[] = ['cream', 'indigo', 'ink', 'apricot']

function specimens(): Note[] {
  const out: Note[] = []
  let n = 1200
  const at = (col: number, row: number) => ({ x: 48 + col * COL, y: 48 + row * ROW, ...NOTE })
  MOTIFS.forEach((motif, row) => {
    PAPERS[motif].forEach((paper, col) => {
      // The last of each row on smooth paper: a straight edge instead of the torn one.
      const style = col === 3 ? 'smooth' : 'rustic'
      out.push(studyNote(n++, { ...at(col, row), motif, paper, style, text: TEXT }))
    })
    // A tag of each, the narrowest note there is.
    out.push(
      studyNote(n++, {
        x: TAG_X,
        y: 48 + row * TAG_ROW,
        w: 120,
        h: 290,
        motif,
        paper: row % 2 ? 'indigo' : 'cream',
        text: 'To do\n- Proofs\n- Stock',
      }),
    )
  })
  MORE_DOTS.forEach((paper, col) => {
    out.push(studyNote(n++, { ...at(col, 4), motif: 'dots', paper, text: TEXT }))
  })
  STAMPED.forEach((paper, col) => {
    const style = col === 3 ? 'smooth' : 'rustic'
    out.push(studyNote(n++, { ...at(col, 5), stamp: true, paper, style, text: TEXT }))
  })
  out.push(
    studyNote(n++, {
      x: TAG_X,
      y: 48 + 4 * TAG_ROW,
      w: 120,
      h: 290,
      stamp: true,
      text: 'Sent\n- Friday',
    }),
  )
  return out
}

export const DECOR_NOTES: readonly Note[] = specimens()

const STAMP_RED = '#C3352B'
const STAMP_RED_ON_INK = '#E0685C'

/**
 * Every decoration as the production note view draws it, on rustic and smooth paper, light and
 * ink, and on a tag; then the stamp large and at its size on a note.
 */
export function DecorNotes() {
  return (
    <>
      <div className="study-bleed">
        <CorkPanel width={W} notes={DECOR_NOTES} padBottom={56} testId="decor-notes" />
      </div>
      <div className="study-stamps" data-testid="decor-stamps">
        <figure style={{ background: PALETTE.cream.paper, color: STAMP_RED }}>
          <StampMark size={150} />
          <figcaption>150 px</figcaption>
        </figure>
        {(['cream', 'indigo', 'ink'] as const).map((paper) => (
          <figure
            key={paper}
            style={{
              background: PALETTE[paper].paper,
              color: paper === 'ink' ? STAMP_RED_ON_INK : STAMP_RED,
            }}
          >
            <StampMark size={26} />
            <figcaption style={{ color: PALETTE[paper].ink }}>26 px · {paper}</figcaption>
          </figure>
        ))}
      </div>
    </>
  )
}
