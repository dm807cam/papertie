// @vitest-environment jsdom
import { paneOf, slipSpan } from '../../src/app/slipPlace'

describe('slipSpan', () => {
  const board = { left: 0, width: 720 }
  const book = { left: 720, width: 720 }

  it('centres on the pane worked in while the book is beside the board', () => {
    expect(slipSpan({ window: 1440, board, book, working: 'book' })).toEqual({
      centre: 1080,
      width: 720,
    })
    expect(slipSpan({ window: 1440, board, book, working: 'board' })).toEqual({
      centre: 360,
      width: 720,
    })
  })

  it('centres on the window with no split, or a pane not laid out', () => {
    expect(slipSpan({ window: 1440, board, book: null, working: 'book' })).toEqual({
      centre: 720,
      width: 1440,
    })
    expect(slipSpan({ window: 1440, board, book: { left: 0, width: 0 }, working: 'book' })).toEqual(
      { centre: 720, width: 1440 },
    )
  })
})

describe('paneOf', () => {
  it('names the pane of a press: the book, the board, or neither for the UI layer', () => {
    document.body.innerHTML = `
      <div class="board-split" data-layout="split">
        <main class="viewport"><div class="ui"><nav class="sidebar"><button id="tool"></button></nav></div>
          <canvas id="cork"></canvas></main>
        <section class="book-pane"><p id="text"></p></section>
      </div>`
    const at = (id: string) => document.getElementById(id)
    expect(paneOf(at('text'))).toBe('book')
    expect(paneOf(at('cork'))).toBe('board')
    expect(paneOf(at('tool'))).toBeNull()
    expect(paneOf(document.body)).toBeNull()
    expect(paneOf(null)).toBeNull()
  })
})
