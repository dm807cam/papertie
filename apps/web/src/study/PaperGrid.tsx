import { PALETTE_TOKENS, type PaperStyle } from '@papertie/core'
import { PROTO_ASSET_ID } from '../dev/assets'
import { CorkPanel, studyIdForMask, studyNote } from './CorkPanel'

const TEXT = 'Tie ideas together.\nThought to thought, by thread.'
const NOTE_W = 220
const PAD = 40
const GAP = 24
const LABEL_H = 40
const ROW_GAP = 52

const ROWS: ReadonlyArray<{ style: PaperStyle; h: number; about: string }> = [
  { style: 'rustic', h: 150, about: 'fibres and a deckled edge' },
  { style: 'smooth', h: 150, about: 'fine cream stock' },
  { style: 'print', h: 250, about: 'a photo border for image notes' },
]

const columnX = (c: number) => PAD + c * (NOTE_W + GAP)
const GRID_W = columnX(PALETTE_TOKENS.length) - GAP + PAD

const rowTops: number[] = []
for (let r = 0, y = 24; r < ROWS.length; r++) {
  rowTops.push(y)
  y += LABEL_H + (ROWS[r]?.h ?? 0) + ROW_GAP
}

const GRID_NOTES = ROWS.flatMap(({ style, h }, r) =>
  PALETTE_TOKENS.map((paper, c) =>
    studyNote(100 + r * 10 + c, {
      x: columnX(c),
      y: (rowTops[r] ?? 0) + LABEL_H,
      w: NOTE_W,
      h,
      paper,
      style,
      text: TEXT,
      image: style === 'print' ? { assetId: PROTO_ASSET_ID, frame: 'print' } : null,
    }),
  ),
)

const DECKLE_W = 124
const DECKLE_GAP = 16
const DECKLE_NOTES = [1, 2, 3, 4, 5, 6, 7, 8].map((mask, i) =>
  studyNote(studyIdForMask(mask, 500 + mask * 100), {
    x: PAD + i * (DECKLE_W + DECKLE_GAP),
    y: 36,
    w: DECKLE_W,
    h: 104,
    text: `deckle ${mask}`,
  }),
)
const DECKLE_STRIP_W = PAD * 2 + 8 * DECKLE_W + 7 * DECKLE_GAP

const URL_300 = `https://papertie.example/search?q=${'%C3%A9t%C3%A9'.repeat(40)}`.slice(0, 300)
const WORD_120 = 'Rindfleischetikettierungsueberwachung'.repeat(4).slice(0, 120)

/** Review Focus 5: an unbroken address and a long unbroken word must wrap inside 220 px. */
export const LONG_NOTE = studyNote(900, {
  x: 48,
  y: 40,
  w: 220,
  h: 120,
  text: `${URL_300}\n${WORD_120}`,
})
const LONG_NOTES = [LONG_NOTE]

/** Three paper styles across the eight palette tokens, the deckle masks and the long-text note. */
export function PaperGrid() {
  return (
    <>
      <div className="study-bleed">
        <div className="paper-grid" style={{ width: GRID_W }} data-testid="paper-grid">
          <div className="paper-grid-cols" aria-hidden="true">
            {PALETTE_TOKENS.map((token, c) => (
              <div key={token} style={{ left: columnX(c), width: NOTE_W }}>
                <span className="study-roman">{token}</span>
              </div>
            ))}
          </div>
          <CorkPanel width={GRID_W} notes={GRID_NOTES} padBottom={44}>
            {ROWS.map(({ style, about }, r) => (
              <span
                key={style}
                className="study-tag study-tag--row"
                style={{ left: PAD, top: rowTops[r] }}
              >
                <b>{style}</b>
                <span className="study-tag-about">{about}</span>
              </span>
            ))}
          </CorkPanel>
        </div>
      </div>

      <div className="paper-pair">
        <figure className="study-figure">
          <CorkPanel
            width={DECKLE_STRIP_W}
            notes={DECKLE_NOTES}
            padBottom={36}
            testId="deckle-strip"
          />
          <figcaption>
            <span className="study-figure-num">1–8</span>
            <span>
              Deckle masks on cream. Each note picks one by seed, so neighbours rarely match.
            </span>
          </figcaption>
        </figure>
      </div>

      <div className="paper-long">
        <div className="paper-long-copy">
          <h3>Long unbroken text</h3>
          <p>
            A 300-character URL with no spaces, then a 120-character word. The note keeps its 220 px
            width and wraps anywhere; strict line breaking still keeps closing brackets off the
            start of a line.
          </p>
        </div>
        <div data-testid="long-note">
          <CorkPanel width={220 + 96} notes={LONG_NOTES} padBottom={48} />
        </div>
      </div>
    </>
  )
}
