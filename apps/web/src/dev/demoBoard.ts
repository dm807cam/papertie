import {
  type Asset,
  type Board,
  type BoardState,
  type Note,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import { FIT_PADDING_PX } from '../canvas/Camera'
import type { Rect } from '../canvas/types'
import { PROTO_ASSET_ID, PROTO_ASSETS } from './assets'

const id = (prefix: string, n: number) => `${prefix}_01JBDEM0${String(n).padStart(18, '0')}`

/** Fixed ids of the demo board's notable parts, for tests and the e2e specs. */
export const DEMO_IDS = {
  /** On 4 threads. */
  hub: id('note', 1),
  /** The yarn of 3 notes: hub, print and one more. */
  threeNote: id('yarn', 1),
  /** The 2-note yarn that `overlap` lies across. */
  crossed: id('yarn', 5),
  /** Above both of `crossed`'s notes, covering part of its rest curve. */
  overlap: id('note', 10),
  /** The image note. */
  print: id('note', 2),
  /** One sentence for a title. */
  knot: id('note', 4),
} as const

/**
 * The demo composition, framed at first load. Ids are picked for their seeded
 * look: the lake and field prints tilt clockwise, the desk print anticlockwise, as in the
 * mockup.
 */
export const DEMO_MOCKUP = {
  /** Paper goods, the centre: on five threads. */
  centre: id('note', 23),
  spring: id('note', 50),
  lake: id('note', 26),
  inspiration: id('note', 54),
  /** The margin tag, top right. */
  marginTag: id('note', 21),
  desk: id('note', 44),
  materials: id('note', 52),
  /** Its hanging pin sits left of centre, clear of the lavender thread's edge pin. */
  experience: id('note', 155),
  /** The field print tag. */
  fieldTag: id('note', 24),
} as const

/**
 * World origin of the mockup composition: a world px there is a mockup px, so at the mockup's
 * own 1672 x 941 viewport the initial fit is zoom 1 with this point at the top-left. It sits
 * above the test notes, clear of every camera the e2e specs use on them.
 */
const MOCKUP_ORIGIN = { x: -200, y: -1900 } as const

/**
 * The rect the demo's initial camera fits: the mockup viewport less the fit's padding, so
 * `fitRect` gives exactly zoom 1 at 1672 x 941 and scales the same view to other sizes.
 */
export const DEMO_FRAME: Rect = {
  x: MOCKUP_ORIGIN.x + FIT_PADDING_PX,
  y: MOCKUP_ORIGIN.y + FIT_PADDING_PX,
  w: 1672 - 2 * FIT_PADDING_PX,
  h: 941 - 2 * FIT_PADDING_PX,
}

type Spec = Pick<Note, 'x' | 'y' | 'w' | 'h' | 'paper' | 'style' | 'text'> & {
  n: number
  image?: string
}

/*
 * World layout (px), all within 2400 x 1600. Five columns at x = 80, 560, 1040, 1520, 2000 and
 * three rows at y = 120, 560, 1040.
 *
 *   row 1  extra(80,120)  print(560,120)  b(1040,120)   jp(1520,120)
 *   row 2  i(80,560)      f(560,560)      hub(1040,560) d(1520,560)   e(2000,560)
 *   row 3  X1(80,1060)  overlap(360,1040)  X2(1000,1060)  g(1520,1040)  h(2000,1040)
 *
 * crossed = X1-X2: pins about 930 px apart, so the rest curve (sag ~75) bottoms out at (663, 1149),
 * on open cork. overlap (z above both) covers the curve from x ~360 to ~560; P at (476, 1137) is at
 * least 84 px inside it. The curve is in the open (Q) between X1 and overlap (x ~320-360) and from
 * x ~570 to ~1000.
 */
const SPECS: Spec[] = [
  {
    n: 1,
    x: 1040,
    y: 560,
    w: 280,
    h: 200,
    paper: 'cream',
    style: 'rustic',
    text: 'Hub\n\nEverything on this board routes through here.',
  },
  { n: 2, x: 560, y: 120, w: 260, h: 250, paper: 'rose', style: 'print', text: 'Lisbon, spring' },
  {
    n: 3,
    x: 1040,
    y: 120,
    w: 240,
    h: 170,
    paper: 'apricot',
    style: 'rustic',
    text: 'Ask about the apricot dye workshop.',
  },
  {
    n: 4,
    x: 1520,
    y: 120,
    w: 240,
    h: 170,
    paper: 'indigo',
    style: 'smooth',
    text: 'A knot ties thoughts together.',
  },
  {
    n: 5,
    x: 1520,
    y: 560,
    w: 260,
    h: 190,
    paper: 'sage',
    style: 'rustic',
    text: 'Tea notes\n\nSecond flush, 80 degrees, 60 seconds.',
  },
  {
    n: 6,
    x: 2000,
    y: 560,
    w: 260,
    h: 180,
    paper: 'lilac',
    style: 'rustic',
    text: 'Lilacs bloom in late April.',
  },
  {
    n: 7,
    x: 560,
    y: 560,
    w: 240,
    h: 170,
    paper: 'ochre',
    style: 'smooth',
    text: 'Autumn palette: ochre first, then red.',
  },
  {
    n: 8,
    x: 80,
    y: 1060,
    w: 240,
    h: 170,
    paper: 'ink',
    style: 'rustic',
    text: 'Crossed, left\n\nA thread runs under the note beside me.',
  },
  {
    n: 9,
    x: 1000,
    y: 1060,
    w: 240,
    h: 170,
    paper: 'cream',
    style: 'rustic',
    text: 'Crossed, right',
  },
  {
    n: 10,
    x: 360,
    y: 1040,
    w: 200,
    h: 200,
    paper: 'rose',
    style: 'smooth',
    text: 'On top of the thread.',
  },
  {
    n: 11,
    x: 80,
    y: 560,
    w: 260,
    h: 180,
    paper: 'apricot',
    style: 'rustic',
    text: 'Weekend plans\nMarket at nine, then the framer.',
  },
  {
    n: 12,
    x: 80,
    y: 120,
    w: 240,
    h: 170,
    paper: 'sage',
    style: 'rustic',
    text: 'A loose note, no threads yet.',
  },
  {
    n: 13,
    x: 1520,
    y: 1040,
    w: 240,
    h: 170,
    paper: 'indigo',
    style: 'rustic',
    text: 'Two small ideas, one thread.',
  },
  {
    n: 14,
    x: 2000,
    y: 1040,
    w: 260,
    h: 180,
    paper: 'lilac',
    style: 'rustic',
    text: 'Pin it. Move on.',
  },
]

/** The mockup's notes, in mockup px from `MOCKUP_ORIGIN`. */
const MOCKUP_SPECS: Spec[] = [
  {
    n: 50,
    x: 180,
    y: 106,
    w: 416,
    h: 258,
    paper: 'cream',
    style: 'rustic',
    text: 'Spring trip\nSpring Journey\n- Orchard in bloom\n- Old town streets\n- The paper shop',
  },
  { n: 26, x: 668, y: 66, w: 330, h: 248, paper: 'cream', style: 'print', text: '' },
  {
    n: 54,
    x: 1086,
    y: 124,
    w: 388,
    h: 244,
    paper: 'indigo',
    style: 'rustic',
    text: 'Ideas\nInspiration\n- Good stationery\n- Texture and space\n- Things that last',
  },
  { n: 21, x: 1494, y: 92, w: 120, h: 288, paper: 'cream', style: 'smooth', text: '' },
  {
    n: 23,
    x: 670,
    y: 362,
    w: 362,
    h: 166,
    paper: 'cream',
    style: 'rustic',
    text: 'Paper goods\nStationery Design',
  },
  { n: 44, x: 150, y: 438, w: 330, h: 280, paper: 'cream', style: 'print', text: '' },
  {
    n: 52,
    x: 1230,
    y: 398,
    w: 376,
    h: 262,
    paper: 'ochre',
    style: 'rustic',
    text: 'Stock\nMaterials\n- Cotton rag paper\n- Linen fibre\n- Natural colours',
  },
  {
    n: 155,
    x: 562,
    y: 612,
    w: 400,
    h: 244,
    paper: 'lilac',
    style: 'rustic',
    text: 'Practice\nExperience\n- Enjoy the time spent writing\n- Pleasant to the touch\n- A daily record',
  },
  { n: 24, x: 1062, y: 592, w: 120, h: 288, paper: 'cream', style: 'print', text: '' },
]

const MOCKUP_IMAGES: Readonly<Record<number, string>> = {
  26: PROTO_ASSETS.lake,
  44: PROTO_ASSETS.desk,
  24: PROTO_ASSETS.field,
}

const YARNS: Array<{ n: number; notes: number[]; color: Yarn['color']; label: string }> = [
  { n: 1, notes: [1, 2, 3], color: 'apricot', label: 'origins' },
  { n: 2, notes: [1, 4], color: 'indigo', label: '' },
  { n: 3, notes: [1, 5, 6], color: 'sage', label: 'tea' },
  { n: 4, notes: [1, 7], color: 'ochre', label: '' },
  { n: 5, notes: [8, 9], color: 'lilac', label: '' },
  { n: 6, notes: [13, 14], color: 'rose', label: '' },
  { n: 7, notes: [11, 12], color: 'cream', label: '' },
  // The mockup's threads, all from the centre. The crimson one runs materials - centre - desk.
  { n: 20, notes: [52, 23, 44], color: 'apricot', label: '' },
  { n: 21, notes: [50, 23], color: 'rose', label: '' },
  { n: 22, notes: [23, 54], color: 'ochre', label: '' },
  { n: 23, notes: [23, 155], color: 'lilac', label: '' },
  { n: 24, notes: [23, 24], color: 'sage', label: '' },
]

/** Note decorations, as the record fields (keys in schema order: motif, stamp, layered). */
const NOTE_DECOR: Readonly<Record<string, Pick<Note, 'motif' | 'stamp' | 'layered'>>> = {
  [DEMO_MOCKUP.centre]: { stamp: true },
  [DEMO_MOCKUP.spring]: { motif: 'fold', layered: 'rose' },
  [DEMO_MOCKUP.inspiration]: { motif: 'margin' },
  [DEMO_MOCKUP.marginTag]: { motif: 'margin' },
  [DEMO_MOCKUP.materials]: { motif: 'dots' },
  [DEMO_MOCKUP.experience]: { motif: 'perforation' },
}

/** The 1024 px file of each illustration, as committed (`tools/make-textures.ts`). */
const ILLUSTRATIONS = [
  {
    id: PROTO_ASSETS.lake,
    width: 1024,
    height: 768,
    bytes: 26200,
    sha256: '28f5d416696b8e56a3b9de3beaff2c6c63663f619b817413daed73c8cd216f87',
  },
  {
    id: PROTO_ASSETS.desk,
    width: 1024,
    height: 768,
    bytes: 16140,
    sha256: '00d849191882ed85211283ffec835a9d28055a2eaef823f6b06f63c3c3cf62a4',
  },
  {
    id: PROTO_ASSETS.field,
    width: 614,
    height: 1024,
    bytes: 18716,
    sha256: '29d3124b4a897a05c014a615a5bd133692e4b6b244c2bd28466fe9f45cb2bc39',
  },
] as const

/** The prototype's asset records: the sample print and the three illustrations. */
export function protoAssetRecords(now: string): Asset[] {
  const sample: Asset = {
    type: 'asset',
    id: PROTO_ASSET_ID,
    mime: 'image/webp',
    width: 1024,
    height: 683,
    bytes: 7094,
    sha256: '351c1ad4796ac7ebf8154d34dbc584abe03df9ae182ce2a6fcfb8073c96a630a',
    createdAt: now,
  }
  return [
    sample,
    ...ILLUSTRATIONS.map(
      (a): Asset => ({ type: 'asset', mime: 'image/webp', ...a, createdAt: now }),
    ),
  ]
}

/**
 * A hand-built board: the demo composition (9 notes, 5 yarns, 3 illustrations), framed by
 * `DEMO_FRAME`, above 14 test notes and 7 yarns that exercise every look and edge case.
 */
export function demoBoard(now: string): BoardState {
  const board: Board = {
    type: 'board',
    schemaVersion: 6,
    id: id('board', 1),
    name: 'Papertie demo',
    revision: 0,
    clients: {},
    createdAt: now,
    updatedAt: now,
  }
  const assets = protoAssetRecords(now)
  const mockup = MOCKUP_SPECS.map((m) => ({
    ...m,
    x: MOCKUP_ORIGIN.x + m.x,
    y: MOCKUP_ORIGIN.y + m.y,
    image: MOCKUP_IMAGES[m.n],
  }))
  const notes: Note[] = [...SPECS, ...mockup].map(({ n, image, ...s }) => ({
    type: 'note',
    id: id('note', n),
    ...s,
    z: n,
    image: s.style === 'print' ? { assetId: image ?? PROTO_ASSET_ID, frame: 'print' } : null,
    ...NOTE_DECOR[id('note', n)],
    createdAt: now,
    updatedAt: now,
  }))
  const yarns: Yarn[] = YARNS.map((y) => ({
    type: 'yarn',
    id: id('yarn', y.n),
    noteIds: y.notes.map((n) => id('note', n)),
    color: y.color,
    label: y.label,
    createdAt: now,
    updatedAt: now,
  }))
  return stateFromRecords(board, [...assets, ...notes, ...yarns])
}
