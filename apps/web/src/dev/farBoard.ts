import { type Board, type BoardState, type Note, stateFromRecords, type Yarn } from '@papertie/core'
import type { Point } from '../canvas/types'
import { PROTO_ASSETS } from './assets'
import { protoAssetRecords } from './demoBoard'

const id = (prefix: string, n: number) => `${prefix}_01JBFAR0${String(n).padStart(18, '0')}`

/** Fixed ids of the far board's parts, for the e2e specs. */
export const FAR_IDS = {
  /** Rustic, on both threads. */
  hub: id('note', 1),
  /** A tilted print. */
  print: id('note', 2),
  /** A tag. */
  tag: id('note', 3),
  smooth: id('note', 4),
  /** hub, print, tag. */
  chain: id('yarn', 1),
  /** hub, smooth. */
  drop: id('yarn', 2),
} as const

/**
 * Where `?board=far` puts its cluster: near (+maxCoord, -maxCoord), and a whole number of both
 * cork tiles' world periods (2048 x 1597 x 3) for every zoom from 0.25 up, so the same board at
 * the origin (`?board=far0`) shows the same cork under the same relative camera.
 */
export const FAR_ORIGIN: Point = { x: 9_811_968, y: -9_811_968 }

type Spec = Pick<Note, 'x' | 'y' | 'w' | 'h' | 'paper' | 'style' | 'text'> & { n: number }

const SPECS: Spec[] = [
  {
    n: 1,
    x: 0,
    y: 0,
    w: 260,
    h: 180,
    paper: 'cream',
    style: 'rustic',
    text: 'Far away\n\nAbout ten million px from the origin.',
  },
  { n: 2, x: 380, y: -20, w: 300, h: 240, paper: 'cream', style: 'print', text: '' },
  { n: 3, x: 760, y: 10, w: 120, h: 288, paper: 'cream', style: 'smooth', text: '' },
  {
    n: 4,
    x: 60,
    y: 300,
    w: 260,
    h: 170,
    paper: 'indigo',
    style: 'smooth',
    text: 'Still crisp out here.',
  },
]

/** Four notes (fibre, a tilted print, a tag, smooth) and two threads, offset by `at`. */
export function farBoard(now: string, at: Point = FAR_ORIGIN): BoardState {
  const board: Board = {
    type: 'board',
    schemaVersion: 6,
    id: id('board', 1),
    name: 'Papertie far',
    revision: 0,
    clients: {},
    createdAt: now,
    updatedAt: now,
  }
  const notes: Note[] = SPECS.map(({ n, ...s }) => ({
    type: 'note',
    id: id('note', n),
    ...s,
    x: at.x + s.x,
    y: at.y + s.y,
    z: n,
    image: s.style === 'print' ? { assetId: PROTO_ASSETS.lake, frame: 'print' } : null,
    createdAt: now,
    updatedAt: now,
  }))
  const yarns: Yarn[] = [
    { n: 1, notes: [1, 2, 3], color: 'apricot' as const },
    { n: 2, notes: [1, 4], color: 'indigo' as const },
  ].map((y) => ({
    type: 'yarn',
    id: id('yarn', y.n),
    noteIds: y.notes.map((n) => id('note', n)),
    color: y.color,
    label: '',
    createdAt: now,
    updatedAt: now,
  }))
  return stateFromRecords(board, [...protoAssetRecords(now), ...notes, ...yarns])
}
