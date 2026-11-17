import { applyBatch, type Board, type Note, stateFromRecords, type Yarn } from '@papertie/core'
import { tiedToCopy } from '../../src/yarn/tiedTo'

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

const note = (n: number, text: string, image = false): Note => ({
  type: 'note',
  id: nid(n),
  x: n * 300,
  y: 0,
  w: 240,
  h: 160,
  z: n,
  paper: 'cream',
  style: image ? 'print' : 'rustic',
  text,
  image: image ? { assetId: `asset_${'0'.repeat(26)}`, frame: 'print' } : null,
  createdAt: T0,
  updatedAt: T0,
})

const yarn = (n: number, notes: number[], color: Yarn['color']): Yarn => ({
  type: 'yarn',
  id: yid(n),
  noteIds: notes.map(nid),
  color,
  label: '',
  createdAt: T0,
  updatedAt: T0,
})

const board = (notes: Note[], yarns: Yarn[] = []) => stateFromRecords(BOARD, [...notes, ...yarns])

describe('tiedToCopy', () => {
  it('names the notes a note is tied to, by the thread’s colour', () => {
    const s = board(
      [note(1, 'Spring trip'), note(2, 'Packing list\nsocks'), note(3, 'Train times')],
      [yarn(1, [2, 1], 'indigo')],
    )
    expect(tiedToCopy(s, nid(1))).toBe('Tied to “Packing list” by indigo yarn.')
    expect(tiedToCopy(s, nid(2))).toBe('Tied to “Spring trip” by indigo yarn.')
    // A note on no thread says nothing.
    expect(tiedToCopy(s, nid(3))).toBe('')
    expect(tiedToCopy(s, nid(9))).toBe('')
  })

  it('lists every note of a colour once, and each colour in turn', () => {
    const s = board(
      [note(1, 'Hub'), note(2, 'Two'), note(3, 'Three'), note(4, 'Four'), note(5, '')],
      [yarn(1, [1, 2, 3], 'indigo'), yarn(2, [3, 1], 'indigo'), yarn(3, [4, 1, 5], 'apricot')],
    )
    expect(tiedToCopy(s, nid(1))).toBe(
      'Tied to “Two” and “Three” by indigo yarn, and to “Four” and “Empty note” by crimson yarn.',
    )
    expect(tiedToCopy(s, nid(2))).toBe('Tied to “Hub” and “Three” by indigo yarn.')
  })

  it('names three or more with commas, a picture by its own name, and cuts a long list short', () => {
    const many = Array.from({ length: 9 }, (_, i) => note(i + 2, `N${i + 2}`))
    const s = board(
      [note(1, 'Hub'), note(20, '', true), ...many],
      [yarn(1, [1, 20, 2, 3], 'sage'), yarn(2, [1, ...many.map((_, i) => i + 2)], 'lilac')],
    )
    expect(tiedToCopy(s, nid(20))).toBe('Tied to “Hub”, “N2” and “N3” by moss yarn.')
    expect(tiedToCopy(s, nid(1))).toBe(
      'Tied to “Empty note”, “N2” and “N3” by moss yarn, and to “N2”, “N3”, “N4”, “N5”, “N6” ' +
        'and 4 more notes by lilac yarn.',
    )
  })

  it('names each tied note by its own accessible name: the first line as shown, in full', () => {
    const long = 'A title that runs on for more than forty characters, as titles may'
    const s = board(
      [note(1, 'Hub'), note(2, '- Socks\n- Boots'), note(3, `${long}\nand a body`)],
      [yarn(1, [1, 2, 3], 'indigo')],
    )
    expect(tiedToCopy(s, nid(1))).toBe(`Tied to “Socks” and “${long}” by indigo yarn.`)
    expect(tiedToCopy(s, nid(2))).toBe(`Tied to “Hub” and “${long}” by indigo yarn.`)
  })

  it('follows the board: a thread made or untied changes what is said', () => {
    let s = board([note(1, 'A'), note(2, 'B')])
    expect(tiedToCopy(s, nid(1))).toBe('')
    s = applyBatch(s, [{ op: 'yarn.create', yarn: yarn(1, [1, 2], 'ink') }], { now: T0 })
    expect(tiedToCopy(s, nid(1))).toBe('Tied to “B” by ink yarn.')
    s = applyBatch(s, [{ op: 'note.update', id: nid(2), set: { text: 'Bee' } }], { now: T0 })
    expect(tiedToCopy(s, nid(1))).toBe('Tied to “Bee” by ink yarn.')
    s = applyBatch(s, [{ op: 'yarn.delete', id: yid(1) }], { now: T0 })
    expect(tiedToCopy(s, nid(1))).toBe('')
  })

  it('reads only the note’s own threads, never the whole board', () => {
    const notes = Array.from({ length: 2000 }, (_, i) => note(i + 1, `N${i + 1}`))
    const yarns = Array.from({ length: 999 }, (_, i) =>
      yarn(i + 1, [2 * i + 1, 2 * i + 2], 'indigo'),
    )
    const s = board(notes, yarns)
    tiedToCopy(s, nid(1)) // builds the thread index once, as a board load does
    // A note map that counts its reads: only the notes on the thread are looked up.
    let reads = 0
    const counted = new Proxy(s.notes, {
      get(target, prop) {
        if (prop === 'get') {
          return (id: string) => {
            reads++
            return target.get(id)
          }
        }
        if (
          prop === Symbol.iterator ||
          prop === 'values' ||
          prop === 'keys' ||
          prop === 'entries'
        ) {
          throw new Error('iterated the board')
        }
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    // Nor the threads: the index is warm, so the yarn map is only looked up by key.
    const yarnMap = s.yarns as unknown as Record<string | symbol, () => unknown>
    const scans = (['values', 'keys', 'entries', 'forEach', Symbol.iterator] as const).map((k) =>
      vi.spyOn(yarnMap, k),
    )
    expect(tiedToCopy({ ...s, notes: counted }, nid(1))).toBe('Tied to “N2” by indigo yarn.')
    for (const scan of scans) expect(scan).not.toHaveBeenCalled()
    expect(reads).toBe(1)
  })
})
