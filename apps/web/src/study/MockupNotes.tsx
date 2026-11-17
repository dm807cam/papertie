import type { Note } from '@papertie/core'
import { PROTO_ASSET_ID } from '../dev/assets'
import { CorkPanel, studyNote } from './CorkPanel'

const print = { assetId: PROTO_ASSET_ID, frame: 'print' } as const

/**
 * The note specimens: every motif, the stamp, layered paper, a print and two tags.
 * Tags are real board notes: core's narrowest width (`LIMITS.noteMinW`, 120), drawn tall.
 */
export const MOCKUP_NOTES = {
  spring: studyNote(1100, {
    motif: 'fold',
    layered: 'rose',
    x: 48,
    y: 48,
    w: 400,
    h: 248,
    text: 'Spring trip\nSpring Journey\n- Orchard in bloom\n- Old town streets\n- The paper shop',
  }),
  stationery: studyNote(1101, {
    stamp: true,
    x: 520,
    y: 300,
    w: 340,
    h: 156,
    text: 'Paper goods\nStationery Design',
  }),
  inspiration: studyNote(1102, {
    motif: 'margin',
    x: 960,
    y: 52,
    w: 372,
    h: 232,
    paper: 'indigo',
    text: 'Ideas\nInspiration\n- Good stationery\n- Texture and space\n- Things that last',
  }),
  materials: studyNote(1103, {
    motif: 'dots',
    x: 1000,
    y: 360,
    w: 352,
    h: 252,
    paper: 'ochre',
    text: 'Stock\nMaterials\n- Cotton rag paper\n- Linen fibre\n- Natural colours',
  }),
  experience: studyNote(1104, {
    motif: 'perforation',
    x: 48,
    y: 400,
    w: 380,
    h: 236,
    paper: 'lilac',
    text: 'Practice\nExperience\n- Enjoy the time spent writing\n- Pleasant to the touch\n- A daily record',
  }),
  print: studyNote(1105, {
    x: 540,
    y: 40,
    w: 300,
    h: 214,
    style: 'print',
    image: print,
  }),
  tag: studyNote(1106, {
    motif: 'margin',
    x: 1420,
    y: 40,
    w: 120,
    h: 290,
    style: 'smooth',
    text: '',
  }),
  printTag: studyNote(1107, {
    x: 1420,
    y: 380,
    w: 120,
    h: 290,
    style: 'print',
    image: print,
  }),
  night: studyNote(1108, {
    motif: 'dots',
    x: 520,
    y: 520,
    w: 300,
    h: 150,
    paper: 'ink',
    text: 'Late hours\nNight Shift\n- Ink and silver',
  }),
} satisfies Record<string, Note>

const NOTES = Object.values(MOCKUP_NOTES)
const W = 1580

/** One cork panel with the mockup's note kinds, drawn by the production note view. */
export function MockupNotes() {
  return (
    <div className="study-bleed">
      <CorkPanel
        width={W}
        notes={NOTES}
        padBottom={56}
        testId="mockup-notes"
        canvasTestId="mockup-canvas"
      />
    </div>
  )
}
