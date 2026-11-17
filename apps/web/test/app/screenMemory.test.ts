// @vitest-environment jsdom
import { LIMITS } from '@papertie/core'
import { CAMERA_SAVE_MS } from '../../src/app/cameraMemory'
import {
  BOARD_MIN_PX,
  BOOK_MIN_PX,
  flushPlaces,
  forgetScreens,
  placesKey,
  recallPlace,
  recallScreen,
  recallSplit,
  rememberPlace,
  rememberScreen,
  rememberSplit,
  SPLIT_DEFAULT,
  SPLIT_KEY,
  SPLIT_MIN_WIDTH,
  screenKey,
  splitFits,
} from '../../src/app/screenMemory'

const BOARD = `board_${'0'.repeat(25)}1`
const OTHER = `board_${'0'.repeat(25)}2`
const BOOK = `book_${'0'.repeat(25)}3`

beforeEach(() => localStorage.clear())

describe('screen memory', () => {
  it('screen memory round-trips the last screen and last book screen, and ignores unusable values', () => {
    expect(screenKey(BOARD)).toBe(`papertie.screen.${BOARD}`)
    // Nothing kept yet: the board, no book screen.
    expect(recallScreen(BOARD)).toEqual({ last: { screen: 'board' }, lastBook: null })

    rememberScreen(BOARD, { screen: 'shelf' })
    expect(recallScreen(BOARD)).toEqual({
      last: { screen: 'shelf' },
      lastBook: { screen: 'shelf' },
    })
    rememberScreen(BOARD, { screen: 'book', bookId: BOOK })
    expect(recallScreen(BOARD)).toEqual({
      last: { screen: 'book', bookId: BOOK },
      lastBook: { screen: 'book', bookId: BOOK },
    })
    // Back on the board: the last book screen is kept for the Books button.
    rememberScreen(BOARD, { screen: 'board' })
    expect(recallScreen(BOARD)).toEqual({
      last: { screen: 'board' },
      lastBook: { screen: 'book', bookId: BOOK },
    })
    // Per board.
    expect(recallScreen(OTHER)).toEqual({ last: { screen: 'board' }, lastBook: null })

    // What cannot be used is read as nothing kept, part by part.
    for (const raw of [
      'not json',
      'null',
      '[]',
      '{"last":{"screen":"attic"},"lastBook":null}',
      '{"last":{"screen":"book"},"lastBook":null}',
      '{"last":{"screen":"book","bookId":7},"lastBook":null}',
      '{"last":{"screen":"book","bookId":"../x"},"lastBook":null}',
    ]) {
      localStorage.setItem(screenKey(BOARD), raw)
      expect(recallScreen(BOARD).last).toEqual({ screen: 'board' })
    }
    localStorage.setItem(
      screenKey(BOARD),
      '{"last":{"screen":"shelf"},"lastBook":{"screen":"board"}}',
    )
    expect(recallScreen(BOARD)).toEqual({ last: { screen: 'shelf' }, lastBook: null })

    // Storage that throws: nothing kept, nothing thrown.
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(recallScreen(BOARD)).toEqual({ last: { screen: 'board' }, lastBook: null })
    expect(() => rememberScreen(BOARD, { screen: 'shelf' })).not.toThrow()
    get.mockRestore()
    set.mockRestore()

    // Forgotten once all data is deleted: every board's.
    rememberScreen(BOARD, { screen: 'shelf' })
    rememberScreen(OTHER, { screen: 'book', bookId: BOOK })
    localStorage.setItem('papertie.camera.x', '{}')
    forgetScreens()
    expect(recallScreen(BOARD).lastBook).toBeNull()
    expect(recallScreen(OTHER).lastBook).toBeNull()
    expect(localStorage.getItem('papertie.camera.x')).toBe('{}')
  })
})

describe('places in books', () => {
  const book = (n: number) => `book_B${String(n).padStart(25, '0')}`
  const BLOCK = `block_${'0'.repeat(25)}7`
  const at = (n: number) => ({ blockId: BLOCK, offset: n, scrollTop: n * 10 })

  afterEach(() => vi.useRealTimers())

  it('places round-trip, ignore unusable values, and are cleared on sign-out with the screens', () => {
    vi.useFakeTimers()
    expect(placesKey(BOARD)).toBe(`papertie.places.${BOARD}`)
    expect(recallPlace(BOARD, BOOK)).toBeNull()

    // Saved once it has rested CAMERA_SAVE_MS; read back meanwhile as the newest.
    rememberPlace(BOARD, BOOK, at(3))
    rememberPlace(BOARD, BOOK, at(4))
    expect(localStorage.getItem(placesKey(BOARD))).toBeNull()
    expect(recallPlace(BOARD, BOOK)).toEqual(at(4))
    vi.advanceTimersByTime(CAMERA_SAVE_MS - 1)
    expect(localStorage.getItem(placesKey(BOARD))).toBeNull()
    vi.advanceTimersByTime(1)
    expect(JSON.parse(localStorage.getItem(placesKey(BOARD)) ?? 'null')).toEqual({ [BOOK]: at(4) })
    expect(recallPlace(BOARD, BOOK)).toEqual(at(4))
    // Per board and per book.
    expect(recallPlace(OTHER, BOOK)).toBeNull()
    expect(recallPlace(BOARD, book(1))).toBeNull()

    // Flushed when the page goes, before the rest.
    rememberPlace(BOARD, book(1), at(5))
    flushPlaces()
    expect(JSON.parse(localStorage.getItem(placesKey(BOARD)) ?? 'null')).toEqual({
      [BOOK]: at(4),
      [book(1)]: at(5),
    })

    // At most maxBooks places a board: the one saved longest ago goes first.
    for (let i = 2; i <= LIMITS.maxBooks + 1; i++) rememberPlace(BOARD, book(i), at(i))
    flushPlaces()
    const kept = JSON.parse(localStorage.getItem(placesKey(BOARD)) ?? '{}') as object
    expect(Object.keys(kept)).toHaveLength(LIMITS.maxBooks)
    expect(recallPlace(BOARD, BOOK)).toBeNull()
    expect(recallPlace(BOARD, book(1))).toBeNull()
    expect(recallPlace(BOARD, book(2))).toEqual(at(2))
    expect(recallPlace(BOARD, book(LIMITS.maxBooks + 1))).toEqual(at(LIMITS.maxBooks + 1))
    // Saved again, a place is the newest.
    rememberPlace(BOARD, book(2), at(9))
    rememberPlace(BOARD, book(1), at(1))
    flushPlaces()
    expect(recallPlace(BOARD, book(2))).toEqual(at(9))
    expect(recallPlace(BOARD, book(3))).toBeNull()

    // What cannot be used is read as no place, entry by entry.
    for (const raw of [
      'not json',
      'null',
      '[]',
      '7',
      `{"${BOOK}":null}`,
      `{"${BOOK}":{"blockId":"note_1","offset":0,"scrollTop":0}}`,
      `{"${BOOK}":{"blockId":"${BLOCK}","offset":-1,"scrollTop":0}}`,
      `{"${BOOK}":{"blockId":"${BLOCK}","offset":1.5,"scrollTop":0}}`,
      `{"${BOOK}":{"blockId":"${BLOCK}","offset":${LIMITS.maxBlockText + 1},"scrollTop":0}}`,
      `{"${BOOK}":{"blockId":"${BLOCK}","offset":0,"scrollTop":1e999}}`,
      `{"${BOOK}":{"blockId":"${BLOCK}","offset":0,"scrollTop":"9"}}`,
      `{"${BOOK}":{"blockId":"${BLOCK}","offset":0}}`,
    ]) {
      localStorage.setItem(placesKey(BOARD), raw)
      expect(recallPlace(BOARD, BOOK), raw).toBeNull()
    }
    localStorage.setItem(
      placesKey(BOARD),
      JSON.stringify({ '../x': at(1), [BOOK]: at(2), [book(1)]: { offset: 'x' } }),
    )
    expect(recallPlace(BOARD, BOOK)).toEqual(at(2))
    expect(recallPlace(BOARD, book(1))).toBeNull()
    // A new place is saved beside the usable ones; the unusable ones are dropped.
    rememberPlace(BOARD, book(3), at(3))
    flushPlaces()
    expect(JSON.parse(localStorage.getItem(placesKey(BOARD)) ?? 'null')).toEqual({
      [BOOK]: at(2),
      [book(3)]: at(3),
    })
    // A block that began lower on the page: scrolled past it by a negative amount.
    rememberPlace(BOARD, book(4), { blockId: BLOCK, offset: 2, scrollTop: -140.5 })
    flushPlaces()
    expect(recallPlace(BOARD, book(4))).toEqual({ blockId: BLOCK, offset: 2, scrollTop: -140.5 })
    // An unusable place is never saved.
    rememberPlace(BOARD, BOOK, { blockId: BLOCK, offset: Number.NaN, scrollTop: 0 })
    rememberPlace(BOARD, '../x', at(1))
    flushPlaces()
    expect(recallPlace(BOARD, BOOK)).toEqual(at(2))

    // Storage that throws: nothing kept, nothing thrown.
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    expect(recallPlace(BOARD, BOOK)).toBeNull()
    rememberPlace(BOARD, BOOK, at(6))
    expect(() => flushPlaces()).not.toThrow()
    get.mockRestore()
    set.mockRestore()

    // Forgotten on sign-out with the screens: every board's, and one waiting to be saved too.
    rememberScreen(BOARD, { screen: 'book', bookId: BOOK })
    rememberPlace(OTHER, BOOK, at(8))
    flushPlaces()
    rememberPlace(BOARD, book(4), at(4))
    forgetScreens()
    vi.advanceTimersByTime(CAMERA_SAVE_MS)
    flushPlaces()
    expect(localStorage.getItem(placesKey(BOARD))).toBeNull()
    expect(localStorage.getItem(placesKey(OTHER))).toBeNull()
    expect(recallPlace(BOARD, book(4))).toBeNull()
    expect(recallScreen(BOARD).last).toEqual({ screen: 'board' })
  })
})

describe('the split preference', () => {
  it('recallSplit ignores unusable values and clamps the ratio', () => {
    expect(SPLIT_KEY).toBe('papertie.split')
    expect(SPLIT_DEFAULT).toEqual({ ratio: 0.5, board: true })
    expect([SPLIT_MIN_WIDTH, BOARD_MIN_PX, BOOK_MIN_PX]).toEqual([1024, 360, 600])
    expect(splitFits(1024)).toBe(true)
    expect(splitFits(1023)).toBe(false)
    // Nothing kept: the default (clamped for the window it is read in).
    vi.stubGlobal('innerWidth', 1600)
    try {
      expect(recallSplit()).toEqual(SPLIT_DEFAULT)
      rememberSplit({ ratio: 0.55, board: false })
      expect(JSON.parse(localStorage.getItem(SPLIT_KEY) ?? 'null')).toEqual({
        ratio: 0.55,
        board: false,
      })
      expect(recallSplit()).toEqual({ ratio: 0.55, board: false })
      // Unusable values read as the default; a usable part is kept.
      for (const bad of ['{', '"x"', 'null', '[]', '{"ratio":"0.5","board":1}', '{"ratio":null}']) {
        localStorage.setItem(SPLIT_KEY, bad)
        expect(recallSplit()).toEqual(SPLIT_DEFAULT)
      }
      localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.6, board: 'yes' }))
      expect(recallSplit()).toEqual({ ratio: 0.6, board: true })
      // The ratio clamped so the board keeps 360 px and the book 600 px of this window.
      localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.99, board: true }))
      expect(recallSplit().ratio).toBeCloseTo(1 - 360 / 1600, 6)
      localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.01, board: true }))
      expect(recallSplit().ratio).toBeCloseTo(600 / 1600, 6)
      // Below the split's width, by its narrowest window's widths.
      vi.stubGlobal('innerWidth', 800)
      localStorage.setItem(SPLIT_KEY, JSON.stringify({ ratio: 0.99, board: true }))
      expect(recallSplit().ratio).toBeCloseTo(1 - 360 / 1024, 6)
      // The app's, not a board's: one key, and forgetting the screens keeps it.
      forgetScreens()
      expect(localStorage.getItem(SPLIT_KEY)).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
