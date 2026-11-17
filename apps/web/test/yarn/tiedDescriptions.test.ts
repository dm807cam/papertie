import {
  applyBatch,
  type Board,
  type ClientOp,
  type Note,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import { openLocalSession, stepHistory } from '../../src/app/session'
import { createBoardStore } from '../../src/store/boardStore'
import { TiedDescriptions } from '../../src/yarn/tiedDescriptions'

const T0 = '2026-10-27T10:00:00.000Z'
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
const yid = (n: number) => `yarn_${String(n).padStart(26, '0')}`

const BOARD: Board = {
  type: 'board',
  schemaVersion: 6,
  id: `board_${'0'.repeat(25)}1`,
  name: 'Test',
  revision: 0,
  clients: {},
  createdAt: T0,
  updatedAt: T0,
}

const note = (n: number, text = `N${n}`): Note => ({
  type: 'note',
  id: nid(n),
  x: (n % 40) * 130,
  y: Math.floor(n / 40) * 90,
  w: 120,
  h: 80,
  z: n,
  paper: 'cream',
  style: 'rustic',
  text,
  image: null,
  createdAt: T0,
  updatedAt: T0,
})

const yarn = (n: number, notes: number[], color: Yarn['color'] = 'indigo'): Yarn => ({
  type: 'yarn',
  id: yid(n),
  noteIds: notes.map(nid),
  color,
  label: '',
  createdAt: T0,
  updatedAt: T0,
})

const text = (n: number, t: string): ClientOp => ({
  op: 'note.update',
  id: nid(n),
  set: { text: t },
})

/** A store over `notes` and `yarns`, every note "mounted" (subscribed) and read once. */
function mounted(notes: Note[], yarns: Yarn[]) {
  const store = createBoardStore(stateFromRecords(BOARD, [...notes, ...yarns]), undefined, () => T0)
  const tied = new TiedDescriptions(store)
  const told = new Map<string, number>()
  for (const n of notes) {
    tied.subscribe(n.id, () => told.set(n.id, (told.get(n.id) ?? 0) + 1))
    tied.get(n.id)
  }
  /** Read every mounted note's description, as the notes do as they render; what it cost. */
  const readAll = () => {
    const before = tied.computed
    for (const n of notes) tied.get(n.id)
    return tied.computed - before
  }
  return { store, tied, told, readAll }
}

describe('TiedDescriptions', () => {
  it('a keystroke recomputes nothing on an untied note, and on a tied one only who names it', () => {
    // 1,000 notes in view; ten threads of twenty among the first 200, two of them on note 5.
    const notes = Array.from({ length: 1000 }, (_, i) => note(i + 1))
    const yarns = Array.from({ length: 10 }, (_, k) =>
      yarn(
        k + 1,
        Array.from({ length: 20 }, (_, j) => 20 * k + j + 1),
      ),
    )
    yarns.push(yarn(11, [5, 25, 45], 'apricot'))
    // A thread on which note 5 comes too late to be named: its notes list 301 to 307 first.
    yarns.push(yarn(12, [301, 302, 303, 304, 305, 306, 307, 5], 'lilac'))
    const { store, tied, told, readAll } = mounted(notes, yarns)
    expect(tied.computed).toBe(1000)

    // Untied: nothing to recompute, nobody told.
    store.commit([text(500, 'N500 and more')])
    expect(readAll()).toBe(0)
    expect(told.size).toBe(0)

    // A nudge of a tied note changes no name: nothing either.
    store.commit([{ op: 'note.update', id: nid(5), set: { x: 9 } }])
    expect(readAll()).toBe(0)

    // Its text below its first line: its name is the same, so nobody is told.
    store.commit([text(5, 'N5\nand a body line')])
    expect(told.size).toBe(0)
    expect(readAll()).toBe(0)

    // Its name: only the descriptions that name it (19 on its first thread, 25 and 45 on the
    // other) are told and recomputed; the lilac thread's notes list it among "2 more notes".
    store.commit([text(5, 'Five')])
    const neighbours = [...Array.from({ length: 20 }, (_, j) => j + 1), 25, 45].filter(
      (n) => n !== 5,
    )
    expect([...told.keys()].sort()).toEqual(neighbours.map(nid).sort())
    expect(readAll()).toBe(neighbours.length)
    expect(tied.get(nid(1))).toBe(
      'Tied to “N2”, “N3”, “N4”, “Five”, “N6” and 14 more notes by indigo yarn.',
    )
    expect(tied.get(nid(301))).toBe(
      'Tied to “N302”, “N303”, “N304”, “N305”, “N306” and 2 more notes by lilac yarn.',
    )
    expect(tied.get(nid(45))).toMatch(/, and to “Five” and “N25” by crimson yarn\.$/)
  })

  it('names a tied note as its own accessible name does: first line as shown, bullets stripped', () => {
    const long = 'A title that runs on for more than forty characters, as titles may'
    const { tied } = mounted(
      [note(1, 'Hub'), note(2, '- Socks\n- Boots'), note(3, `${long}\nand a body`)],
      [yarn(1, [1, 2, 3])],
    )
    expect(tied.get(nid(1))).toBe(`Tied to “Socks” and “${long}” by indigo yarn.`)
  })

  it('a thread changing colour retells its notes, and only them', () => {
    const { store, tied, told } = mounted(
      [note(1), note(2), note(3), note(4)],
      [yarn(1, [1, 2]), yarn(2, [3, 4])],
    )
    store.commit([{ op: 'yarn.update', id: yid(1), set: { color: 'sage' } }])
    expect([...told.keys()].sort()).toEqual([nid(1), nid(2)])
    expect(tied.get(nid(1))).toBe('Tied to “N2” by moss yarn.')
    expect(tied.get(nid(3))).toBe('Tied to “N4” by indigo yarn.')
  })

  it('a note wound on or taken off a thread changes what every note on it says', () => {
    const { store, tied, told } = mounted([note(1), note(2), note(3), note(4)], [yarn(1, [1, 2])])
    store.commit([{ op: 'yarn.insertNote', id: yid(1), noteId: nid(3), afterNoteId: nid(2) }])
    expect([...told.keys()].sort()).toEqual([nid(1), nid(2), nid(3)])
    expect(tied.get(nid(1))).toBe('Tied to “N2” and “N3” by indigo yarn.')
    expect(tied.get(nid(3))).toBe('Tied to “N1” and “N2” by indigo yarn.')
    expect(tied.get(nid(4))).toBe('')

    told.clear()
    store.commit([{ op: 'yarn.removeNote', id: yid(1), noteId: nid(1) }])
    expect([...told.keys()].sort()).toEqual([nid(1), nid(2), nid(3)])
    expect(tied.get(nid(1))).toBe('')
    expect(tied.get(nid(2))).toBe('Tied to “N3” by indigo yarn.')
  })

  it('a deleted note leaves the descriptions of the notes it was tied to', () => {
    const { store, tied } = mounted([note(1), note(2), note(3)], [yarn(1, [1, 2, 3])])
    store.commit([{ op: 'note.delete', id: nid(3) }])
    expect(tied.get(nid(1))).toBe('Tied to “N2” by indigo yarn.')
  })

  it('a note on several threads lists each colour, and follows each thread', () => {
    const { store, tied } = mounted(
      [note(1, 'Hub'), note(2), note(3), note(4)],
      [yarn(1, [1, 2], 'indigo'), yarn(2, [3, 1], 'apricot'), yarn(3, [1, 4], 'indigo')],
    )
    expect(tied.get(nid(1))).toBe(
      'Tied to “N2” and “N4” by indigo yarn, and to “N3” by crimson yarn.',
    )
    store.commit([{ op: 'yarn.delete', id: yid(3) }])
    expect(tied.get(nid(1))).toBe('Tied to “N2” by indigo yarn, and to “N3” by crimson yarn.')
    expect(tied.get(nid(4))).toBe('')
  })

  it('a remote change (a replace, told or not) and an undo go the same way', () => {
    const notes = [note(1), note(2), note(3)]
    const session = openLocalSession({
      kind: 'local',
      state: stateFromRecords(BOARD, notes),
      label: 'test',
    })
    const tied = new TiedDescriptions(session.store)
    for (const n of notes) tied.subscribe(n.id, () => {})
    expect(tied.get(nid(1))).toBe('')

    // A commit of the store's own ties 1 and 2, then renames 2: told what it touched.
    const tiedState = applyBatch(
      session.store.getState(),
      [{ op: 'yarn.create', yarn: yarn(1, [1, 2], 'lilac') }],
      { now: T0 },
    )
    session.store.replace(tiedState, {
      assets: new Set(),
      notes: new Set(),
      yarns: new Set([yid(1)]),
      books: new Set(),
      blocks: new Set(),
    })
    expect(tied.get(nid(1))).toBe('Tied to “N2” by lilac yarn.')
    session.store.replace(applyBatch(tiedState, [text(2, 'Two')], { now: T0 }))
    expect(tied.get(nid(1))).toBe('Tied to “Two” by lilac yarn.')
    // The board loaded again whole: everything is read again.
    session.store.replace(stateFromRecords(BOARD, notes), 'all')
    expect(tied.get(nid(1))).toBe('')

    // The page ties 1 and 3; an undo takes it away again.
    session.store.commit([{ op: 'yarn.create', yarn: yarn(2, [1, 3], 'indigo') }], { label: 'tie' })
    expect(tied.get(nid(3))).toBe('Tied to “N1” by indigo yarn.')
    stepHistory(session, 'undo')
    expect(tied.get(nid(3))).toBe('')
    expect(tied.get(nid(1))).toBe('')
    session.dispose()
  })

  it('keeps nothing for a note no longer mounted, and stops listening when disposed', () => {
    const { store, tied, told } = mounted([note(1), note(2)], [yarn(1, [1, 2])])
    const off = tied.subscribe(nid(3), () => {})
    tied.get(nid(3))
    off()
    expect(tied.kept).toBe(2)
    tied.dispose()
    store.commit([text(2, 'Two')])
    expect(told.size).toBe(0)
  })
})
