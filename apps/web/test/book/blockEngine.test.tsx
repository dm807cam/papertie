/**
 * The writer's engine (ADR-0007) on its own, in a DOM
 * (a reset under a composition, a selection across blocks kept through a remote edit, a block
 * held while gone, a composition at a split's point, a composed word's marks, a dead key
 * cancelled), and a structural change at `maxBlocksPerBook` costing the model's chunks only.
 */
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import {
  applyBatch,
  type Block,
  type BoardState,
  bookBlocks,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  numberFootnotes,
  posKeysBetween,
} from '@papertie/core'
import { act, cleanup } from '@testing-library/react'
import { vi } from 'vitest'
import type { EditorBlock, EditorChange } from '../../src/book/editor/BookEditor'
import { type BlockEngine, createEngine } from '../../src/book/editor/blockEngine'
import { BookModel, estimate, FIGURE_MEASURE } from '../../src/book/editor/model'
import { bookDiff, changesToOps, opsToChanges } from '../../src/book/editorOps'
import { footnoteStats } from '../../src/book/footnotes/numbers'
import { UndoStack } from '../../src/history/UndoStack'
import { loadBookSync } from '../../src/sync/books/bookOps'
import { book as boardBook } from '../helpers/books'
import { BOARD_ID, idOf, T0 } from '../helpers/fakeServer'
import { blockEl, caret, caretOffset, deadKey, press, startDeadKey, type } from './writerKit'

const id = (n: number) => `block_${String(n).padStart(26, '0')}`
const para = (n: number, text: string, kind: EditorBlock['kind'] = 'p'): EditorBlock => ({
  id: id(n),
  kind,
  text,
  marks: [],
})

interface Mounted {
  engine: BlockEngine
  root: HTMLElement
  changes: EditorChange[]
}

function mount(blocks: EditorBlock[], o: { windowed?: boolean } = {}): Mounted {
  const host = document.createElement('div')
  document.body.append(host)
  const engine = createEngine({ windowed: o.windowed ?? false })
  const changes: EditorChange[] = []
  let n = 1000
  engine.mount(host, blocks, {
    newBlockId: () => id(n++),
    onChange: (cs) => changes.push(...cs),
    onHistory: () => {},
  })
  return { engine, root: host, changes }
}

afterEach(() => {
  cleanup()
  document.body.textContent = ''
})

describe('the engine under a composition', () => {
  it('a reset during a dead key waits for the composition to end, and the composed text is kept', () => {
    const m = mount([para(1, 'cafe'), para(2, 'two')])
    caret(blockEl(m.root, id(1)), 3)
    deadKey('´', 'é', () => {
      act(() => m.engine.reset([para(1, 'Restored cafe'), para(3, 'new')]))
      // Nothing is replaced under the pending mark.
      expect(blockEl(m.root, id(1)).textContent).toBe('caf´e')
      expect(m.root.querySelector(`[data-id="${id(3)}"]`)).toBeNull()
    })
    expect([...m.root.querySelectorAll('[data-id]')].map((e) => e.textContent)).toEqual([
      'Resétored cafe',
      'new',
    ])
    // The composed é went in at its place in the block the new book has.
    expect(m.engine.block(id(1))?.text).toBe('Resétored cafe')
    expect(m.changes.at(-1)).toEqual({
      t: 'edit',
      id: id(1),
      splices: [{ at: 3, del: 0, ins: 'é' }],
    })
  })

  it('a remote delete of the composing block, then a window change before the end: the page keeps its height', () => {
    const blocks = Array.from({ length: 400 }, (_, i) => para(i + 1, `paragraph ${i + 1}`))
    const m = mount(blocks, { windowed: true })
    // The first window whole (it goes up a screenful a task).
    act(() => m.engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    const el = blockEl(m.root, id(50))
    caret(el, 3)
    const height = () =>
      [...m.root.querySelectorAll<HTMLElement>('.bk-spacer')].reduce(
        (h, s) => h + Number.parseFloat(s.style.height),
        0,
      )
    deadKey('´', 'é', () => {
      act(() => {
        m.engine.apply([{ t: 'delete', id: id(50) }])
        // A scroll's window (or any other change) lays the page out while the gone block waits.
        m.engine.window({ fromBlockId: id(200), toBlockId: id(320) })
      })
      // No spacer stands for the whole book above the held block: only the blocks not shown.
      const shown = m.root.querySelectorAll('[data-id]').length
      expect(height()).toBeLessThan(400 * 60)
      const est = new BookModel(blocks.filter((b) => b.id !== id(50)))
      expect(Math.round(height())).toBe(
        // Before the window and after it, the held block not counted.
        Math.round(est.heightOf(0, 197) + est.heightOf(319, 398)),
      )
      expect(shown).toBeGreaterThan(0)
    })
    // The composed text went out against the gone block (the consumer offers it as text).
    expect(m.changes.at(-1)).toMatchObject({ t: 'edit', id: id(50) })
  })

  it('a composition exactly at a remote split’s point stays with the head, where it is typed', () => {
    const m = mount([para(1, 'Hello world')])
    caret(blockEl(m.root, id(1)), 5)
    deadKey('´', 'é', () => {
      act(() => m.engine.apply([{ t: 'split', id: id(1), at: 5, newId: id(9), kind: 'p' }]))
    })
    expect(m.engine.block(id(1))?.text).toBe('Helloé')
    expect(m.engine.block(id(9))?.text).toBe(' world')
    expect(m.changes.at(-1)).toEqual({
      t: 'edit',
      id: id(1),
      splices: [{ at: 5, del: 0, ins: 'é' }],
    })
  })

  it('a composition over a selection straddling a remote split goes where the selection began', () => {
    const m = mount([para(1, 'abcdefgh')])
    const el = blockEl(m.root, id(1))
    // "cdef" selected, then a dead key replaces it; meanwhile the board splits it at 4.
    caret(el, 2, 6)
    deadKey('´', 'é', () => {
      act(() => m.engine.apply([{ t: 'split', id: id(1), at: 4, newId: id(9), kind: 'p' }]))
    })
    // Head "ab" + é (its "cd" replaced); the tail keeps the "ef" the split moved there, "efgh".
    expect(m.engine.block(id(1))?.text).toBe('abé')
    expect(m.engine.block(id(9))?.text).toBe('efgh')
  })

  it('a word composed inside bold after a held change keeps its bold', () => {
    const m = mount([
      { id: id(1), kind: 'p', text: 'a cafe b', marks: [{ t: 'b', from: 2, to: 6 }] },
    ])
    const el = blockEl(m.root, id(1))
    caret(el, 5)
    deadKey('´', 'é', () => {
      act(() => m.engine.apply([{ t: 'edit', id: id(1), splices: [{ at: 0, del: 0, ins: 'R ' }] }]))
    })
    const b = m.engine.block(id(1))
    expect(b?.text).toBe('R a cafée b')
    expect(b?.marks).toEqual([{ t: 'b', from: 4, to: 9 }])
  })

  it('a dead key cancelled with Esc lets the engine go back to one host per block', () => {
    const m = mount([para(1, 'one'), para(2, 'two'), para(3, 'three')])
    // A drag across blocks (the one host), its selection deleted for a dead key…
    act(() => {
      m.root
        .querySelector('.bk-book')
        ?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    })
    caret(blockEl(m.root, id(1)), 1, 2, blockEl(m.root, id(3)))
    act(() => document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
    act(() => {
      blockEl(m.root, id(1)).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Dead', keyCode: 229, bubbles: true }),
      )
    })
    expect(m.engine.block(id(1))?.text).toBe('oree')
    expect(m.root.querySelector('.bk-book')?.getAttribute('contenteditable')).toBe('true')
    // …then cancelled: no composition comes, and the blocks are their own hosts again.
    press('Escape')
    expect(m.engine.composing()).toBe(false)
    expect(m.root.querySelector('.bk-book')?.hasAttribute('contenteditable')).toBe(false)
    expect(blockEl(m.root, id(1)).getAttribute('contenteditable')).toBe('true')
  })
})

describe('the first window', () => {
  it('goes up a screenful a task, to the window, and then rests', async () => {
    const m = mount(
      Array.from({ length: 400 }, (_, i) => para(i + 1, `paragraph ${i + 1}`)),
      { windowed: true },
    )
    const count = () => m.root.querySelectorAll('[data-id]').length
    expect(count()).toBe(30)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(count()).toBe(120)
    // At rest: the page is laid out no more (each layout makes its spacers anew).
    const spacer = m.root.querySelector('.bk-spacer')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(m.root.querySelector('.bk-spacer')).toBe(spacer)
  })
})

describe('a selection across blocks', () => {
  it('a remote edit inside it keeps the selection, its ends as offsets', () => {
    const m = mount([para(1, 'first line'), para(2, 'second line')])
    act(() => {
      m.root
        .querySelector('.bk-book')
        ?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    })
    caret(blockEl(m.root, id(1)), 6, 6, blockEl(m.root, id(2)))
    act(() => m.engine.apply([{ t: 'edit', id: id(1), splices: [{ at: 0, del: 0, ins: 'The ' }] }]))
    const r = m.engine.range()
    expect(r).toEqual({ a: { blockId: id(1), offset: 10 }, b: { blockId: id(2), offset: 6 } })
    expect(document.getSelection()?.toString()).toBe('linesecond')
  })
})

describe('a selection dragged across the window', () => {
  const book = () => Array.from({ length: 400 }, (_, i) => para(i + 1, `paragraph ${i + 1}`))
  const bookEl = (m: Mounted) => m.root.querySelector('.bk-book') as HTMLElement
  /** A press in block `n` (the engine goes to one host for the drag), the selection from it. */
  const press = (m: Mounted, n: number) =>
    act(() => {
      blockEl(m.root, id(n)).dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, bubbles: true }),
      )
    })
  /** A press in block `n` and the pointer on over the next: a drag across blocks, one host. */
  const drag = (m: Mounted, n: number) => {
    press(m, n)
    act(() => {
      blockEl(m.root, id(n + 1)).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    })
  }

  it('the window moving on with the drag keeps both ends of the selection on the page', () => {
    const m = mount(book(), { windowed: true })
    act(() => m.engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    drag(m, 10)
    caret(blockEl(m.root, id(10)), 2, 1, blockEl(m.root, id(100)))
    // The drag goes on far below: the window follows it, as the scroll's middle moves.
    act(() => m.engine.window({ fromBlockId: id(250), toBlockId: id(370) }))
    const s = document.getSelection() as Selection
    s.extend(blockEl(m.root, id(300)).firstChild as Text, 1)
    act(() => m.engine.window({ fromBlockId: id(280), toBlockId: id(390) }))
    // The anchor's block is still there, alone, and the selection reads as both its ends.
    expect(m.root.querySelector(`[data-id="${id(10)}"]`)).not.toBeNull()
    expect(m.engine.range()).toEqual({
      a: { blockId: id(10), offset: 2 },
      b: { blockId: id(300), offset: 1 },
    })
    // Delete takes every paragraph between, through the model.
    act(() => {
      blockEl(m.root, id(300)).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
      )
    })
    expect(m.engine.block(id(10))?.text).toBe('paaragraph 300')
    expect(m.engine.block(id(11))).toBeUndefined()
    expect(m.engine.block(id(301))?.text).toBe('paragraph 301')
  })

  it('in the one host, an input the engine cannot place is never left to the browser', () => {
    const m = mount(book(), { windowed: true })
    act(() => m.engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    drag(m, 10)
    // A selection whose end is in a spacer (no block of the book there): no range the engine
    // can read; the browser would edit across the spacer.
    const spacer = bookEl(m).querySelector('.bk-spacer') as HTMLElement
    const t = blockEl(m.root, id(10)).firstChild as Text
    document.getSelection()?.setBaseAndExtent(t, 1, spacer, 0)
    expect(m.engine.range()).toBeNull()
    const e = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      blockEl(m.root, id(10)).dispatchEvent(e)
    })
    expect(e.defaultPrevented).toBe(true)
    expect(m.changes).toEqual([])
  })

  it('a drag across blocks ends with the one host focused, the selection kept (Firefox drops the focus as the book turns editable)', () => {
    const m = mount(book(), { windowed: true })
    act(() => m.engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    blockEl(m.root, id(10)).focus()
    drag(m, 10)
    caret(blockEl(m.root, id(10)), 2, 1, blockEl(m.root, id(12)))
    // As Firefox does once the book's element turns editable under a focused block.
    ;(document.activeElement as HTMLElement).blur()
    expect(document.activeElement).toBe(document.body)
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }))
    })
    expect(document.activeElement).toBe(bookEl(m))
    expect(m.engine.range()).toEqual({
      a: { blockId: id(10), offset: 2 },
      b: { blockId: id(12), offset: 1 },
    })
  })

  it('a plain click writes nothing; a drag out of its block makes the window one host, one attribute', () => {
    const m = mount(book(), { windowed: true })
    act(() => m.engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    const writes: MutationRecord[] = []
    const watch = new MutationObserver((r) => writes.push(...r))
    watch.observe(bookEl(m), { attributes: true, subtree: true })
    const up = () =>
      act(() => {
        document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }))
      })
    // A click in a block: nothing on the page changes (the first key after it pays nothing).
    press(m, 10)
    up()
    writes.push(...watch.takeRecords())
    expect(writes.filter((w) => w.attributeName === 'contenteditable')).toEqual([])
    // A press, then the pointer over the next block: one host, and back as it is let go.
    press(m, 10)
    act(() => {
      blockEl(m.root, id(11)).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    })
    up()
    writes.push(...watch.takeRecords())
    watch.disconnect()
    expect(
      writes.filter((w) => w.attributeName === 'contenteditable').map((w) => w.target),
    ).toEqual([bookEl(m), bookEl(m)])
  })
})

describe('the whole book (minor 9)', () => {
  const book = () => Array.from({ length: 400 }, (_, i) => para(i + 1, `paragraph ${i + 1}`))

  it('⌘A selects the whole book, the blocks the window does not show too; a cut takes all of it in one change', () => {
    const m = mount(book(), { windowed: true })
    let calls = 0
    // Counted as the consumer hears them: one call is one commit, one undo step.
    m.engine.destroy()
    m.root.textContent = ''
    const engine = createEngine({ windowed: true })
    const changes: EditorChange[] = []
    let n = 1000
    engine.mount(m.root, book(), {
      newBlockId: () => id(n++),
      onChange: (cs) => {
        calls++
        changes.push(...cs)
      },
      onHistory: () => {},
    })
    act(() => engine.window({ fromBlockId: id(100), toBlockId: id(220) }))
    caret(blockEl(m.root, id(150)), 3)
    const all = new KeyboardEvent('keydown', {
      key: 'a',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    act(() => {
      blockEl(m.root, id(150)).dispatchEvent(all)
    })
    expect(all.defaultPrevented).toBe(true)
    expect(engine.range()).toEqual({
      a: { blockId: id(1), offset: 0 },
      b: { blockId: id(400), offset: 'paragraph 400'.length },
    })
    let copied = ''
    const cut = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(cut, 'clipboardData', {
      value: {
        setData: (t: string, v: string) => {
          if (t === 'text/plain') copied = v
        },
      },
    })
    act(() => {
      ;(m.root.querySelector('.bk-book') as HTMLElement).dispatchEvent(cut)
    })
    expect(copied).toBe(
      book()
        .map((b) => b.text)
        .join('\n'),
    )
    expect(calls).toBe(1)
    expect(engine.block(id(1))?.text).toBe('')
    expect(engine.block(id(2))).toBeUndefined()
    expect(engine.block(id(400))).toBeUndefined()
    engine.destroy()
  })

  it('heights measured at one page width are estimated again when the width changes', () => {
    const observers: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = []
    const RO = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
        observers.push(cb)
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver
    try {
      const host = document.createElement('div')
      const scroller = document.createElement('div')
      scroller.append(host)
      document.body.append(scroller)
      const engine = createEngine({ windowed: true, scroller })
      const blocks = book()
      const model = new BookModel(blocks)
      engine.mountModel(host, model, {
        newBlockId: () => 'x',
        onChange: () => {},
        onHistory: () => {},
      })
      const est = new BookModel(blocks).heightOf(0, 399)
      model.measure(id(300), 999)
      expect(model.heightOf(0, 399)).not.toBe(est)
      act(() => {
        for (const cb of observers) cb([{ contentRect: { width: 600 } }])
      })
      act(() => {
        for (const cb of observers) cb([{ contentRect: { width: 400 } }])
      })
      expect(model.heightOf(0, 399)).toBe(est)
      expect(model.measured(id(300))).toBe(false)
      engine.destroy()
    } finally {
      globalThis.ResizeObserver = RO
    }
  })
})

describe('fonts loaded under the window (minor 3)', () => {
  const book = () => Array.from({ length: 400 }, (_, i) => para(i + 1, `paragraph ${i + 1}`))
  /** A windowed engine on a scroller, in the book's font, with `document.fonts` to fire. */
  function mountWithFonts() {
    const fonts = new EventTarget()
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
    const host = document.createElement('div')
    host.style.fontFamily = '"Instrument Sans", sans-serif'
    const scroller = document.createElement('div')
    scroller.append(host)
    document.body.append(scroller)
    const engine = createEngine({ windowed: true, scroller })
    const model = new BookModel(book())
    engine.mountModel(host, model, {
      newBlockId: () => 'x',
      onChange: () => {},
      onHistory: () => {},
    })
    /** A face of `family` in; what it changes, a microtask on (faces that come in together, once). */
    const loaded = async (family: string) => {
      act(() => {
        const e = new Event('loadingdone') as Event & { fontfaces: Array<{ family: string }> }
        e.fontfaces = [{ family }]
        fonts.dispatchEvent(e)
      })
      await act(async () => {})
    }
    return { engine, model, host, loaded }
  }
  afterEach(() => {
    Reflect.deleteProperty(document, 'fonts')
  })

  it('a font the book does not use leaves its heights; one it uses estimates them again', async () => {
    const { engine, model, loaded } = mountWithFonts()
    model.measure(id(300), 999)
    await loaded('Board Hand')
    expect(model.measured(id(300))).toBe(true)
    await loaded('Instrument Sans')
    expect(model.measured(id(300))).toBe(false)
    engine.destroy()
  })

  it('during a composition in the one host, a font load waits for its end (the spacers stay)', async () => {
    const { engine, model, host, loaded } = mountWithFonts()
    act(() => engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    const el = (n: number) => host.querySelector(`[data-id="${id(n)}"]`) as HTMLElement
    act(() => {
      el(10).dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
      el(11).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    })
    // The pointer still down: the one host stays for a composition at a caret in it.
    caret(el(10), 2)
    model.measure(id(300), 999)
    await act(async () => {}) // the window's own settling first
    const finish = startDeadKey('´')
    await act(async () => {})
    const spacers = [...host.querySelectorAll('.bk-spacer')]
    await loaded('Instrument Sans')
    expect(model.measured(id(300))).toBe(true)
    expect([...host.querySelectorAll('.bk-spacer')]).toEqual(spacers)
    finish('é')
    expect(model.measured(id(300))).toBe(false)
    engine.destroy()
  })

  it('a book closed leaves nothing of its model on a face of its family that never loads', async () => {
    // A face of the book's family that never settles: a unicode-range subset no text asks for (a
    // Greek range of the body font in an English book), of which the page has hundreds. Each
    // one's `loaded` is held by the font set for the page's lifetime, and with it whatever its
    // handlers hold.
    const faces = [
      { family: 'Instrument Sans', status: 'unloaded', loaded: new Promise<void>(() => {}) },
    ]
    const fonts = Object.assign(new EventTarget(), {
      forEach: (fn: (f: (typeof faces)[number]) => void) => faces.forEach(fn),
    })
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
    const host = document.createElement('div')
    host.style.fontFamily = '"Instrument Sans", sans-serif'
    const scroller = document.createElement('div')
    scroller.append(host)
    document.body.append(scroller)
    let engine: BlockEngine | null = createEngine({ windowed: true, scroller })
    let model: BookModel | null = new BookModel(book())
    const gone = new WeakRef(model)
    engine.mountModel(host, model, {
      newBlockId: () => 'x',
      onChange: () => {},
      onHistory: () => {},
    })
    await tasks(3) // the first window's growth, a part a task, runs out
    engine.destroy()
    scroller.remove()
    engine = null
    model = null
    await tasks(3)
    fullGc()
    await tasks(1)
    expect(gone.deref()).toBeUndefined()
  })
})

describe('the first window’s growth', () => {
  it('goes on a part a task in tasks queued behind what waits, never ahead of it as a scheduler continuation', async () => {
    // A continuation of `scheduler.yield()` runs ahead of every task already queued: the board's
    // opening beside the book (its kept tiles' answers) waited behind the whole growth (the final
    // perf pass: 70 ms of a warm open). Its parts are plain tasks, behind what was queued first.
    const continued = vi.fn(
      () =>
        new Promise<void>((r) => {
          const { port1, port2 } = new MessageChannel()
          port1.onmessage = () => {
            port1.close()
            r()
          }
          port2.postMessage(null)
        }),
    )
    vi.stubGlobal('scheduler', { yield: continued })
    // A visible page: the growth is paced (a hidden one takes it at once).
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    try {
      const blocks = Array.from({ length: 400 }, (_, i) => para(i + 1, `paragraph ${i + 1}`))
      const m = mount(blocks, { windowed: true })
      await tasks(6)
      // The growth ran out (the first window whole) without one scheduler continuation.
      expect(m.root.querySelector(`[data-id="${id(120)}"]`)).not.toBeNull()
      expect(continued).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      delete (document as { hidden?: boolean }).hidden
    }
  })
})

/** `n` tasks (macrotasks) later: what was queued for the next task has run. */
const tasks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * A full collection, as `node --expose-gc`'s `gc()`: the flag set for this process, and the
 * function taken from a context made under it.
 */
function fullGc(): void {
  setFlagsFromString('--expose-gc')
  ;(runInNewContext('gc') as () => void)()
}

describe('⌘A then Delete in a book at the limit (item 5)', () => {
  it(`deleting ${LIMITS.maxBlocksPerBook.toLocaleString('en')} paragraphs lays the spacers out once, not once per paragraph`, () => {
    const n = LIMITS.maxBlocksPerBook
    const host = document.createElement('div')
    document.body.append(host)
    const engine = createEngine({ windowed: true })
    const changes: EditorChange[] = []
    const model = new BookModel(
      Array.from({ length: n }, (_, i) => para(i + 1, `paragraph ${i + 1}`)),
    )
    engine.mountModel(host, model, {
      newBlockId: () => 'x',
      onChange: (cs) => changes.push(...cs),
      onHistory: () => {},
    })
    act(() => engine.window({ fromBlockId: id(1), toBlockId: id(120) }))
    caret(blockEl(host, id(50)), 3)
    act(() => {
      blockEl(host, id(50)).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(engine.range()?.b.blockId).toBe(id(n))
    // Elements made as the Delete is handled: the spacers of a layout, and nothing per paragraph.
    const made = vi.spyOn(document, 'createElement')
    act(() => {
      ;(host.querySelector('.bk-book') as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
      )
    })
    const count = made.mock.calls.length
    made.mockRestore()
    expect(model.length).toBe(1)
    expect(changes.filter((c) => c.t === 'delete')).toHaveLength(n - 2)
    expect(count).toBeLessThan(10)
    engine.destroy()
  })
})

describe('the model’s heights', () => {
  it('heights are estimated, then measured: kept through edits and chunk splits, estimated again for a new kind, a split or a merge', () => {
    const blocks = Array.from({ length: 300 }, (_, i) =>
      para(i + 1, `paragraph ${i + 1}`, i % 100 === 0 ? 'h1' : 'p'),
    )
    const m = new BookModel(blocks)
    const est = new BookModel(blocks)
    const all = () => m.heightOf(0, m.length - 1)
    const whole = est.heightOf(0, est.length - 1)
    expect(all()).toBe(whole)
    const one = est.heightOf(4, 4)
    m.measure(id(5), 200)
    expect(m.measured(id(5))).toBe(true)
    expect(m.heightOf(4, 4)).toBe(200)
    expect(all()).toBe(whole - one + 200)
    // Nothing that is not a height, nor a block it does not hold.
    m.measure(id(5), 0)
    m.measure(id(5), Number.NaN)
    m.measure('block_none', 50)
    expect(all()).toBe(whole - one + 200)
    // An edit keeps it (the page measures the block again as it draws it).
    m.apply({ t: 'edit', id: id(5), splices: [{ at: 0, del: 0, ins: 'More ' }] })
    expect(m.heightOf(4, 4)).toBe(200)
    // Paragraphs put in before it until its chunk splits: it is still counted at 200.
    for (let k = 0; k < 300; k++)
      m.apply({
        t: 'create',
        id: `block_x${String(k).padStart(24, '0')}`,
        after: id(2),
        kind: 'p',
        text: '',
      })
    expect(m.heightOf(m.indexOf(id(5)), m.indexOf(id(5)))).toBe(200)
    const added = 300 * 42 // an empty paragraph's estimate
    expect(all()).toBe(whole - one + 200 + added)
    // A new kind is estimated until it is drawn again.
    m.apply({ t: 'kind', id: id(5), kind: 'quote' })
    expect(m.measured(id(5))).toBe(false)
    // So are a split's head and a merge's block.
    m.measure(id(6), 300)
    m.apply({ t: 'split', id: id(6), at: 3, newId: id(900), kind: 'p' })
    expect(m.measured(id(6))).toBe(false)
    m.measure(id(7), 300)
    m.apply({ t: 'merge', from: id(8), into: id(7) })
    expect(m.measured(id(7))).toBe(false)
    // A block gone takes its height with it.
    m.measure(id(9), 500)
    const before = all()
    m.apply({ t: 'delete', id: id(9) })
    expect(all()).toBe(before - 500)
  })
})

describe('the model at maxBlocksPerBook', () => {
  it('an Enter costs the chunks, not the book: places, heights and chapters stay right', () => {
    // The cost per Enter is the timing row's (`blockEngine.timing.test.tsx`).
    const n = LIMITS.maxBlocksPerBook
    const blocks = Array.from({ length: n }, (_, i) =>
      para(i + 1, `p${i}`, i % 1000 === 0 ? 'h1' : 'p'),
    )
    const m = new BookModel(blocks)
    for (let k = 0; k < 200; k++) {
      const at = 30_000 + k
      m.apply({
        t: 'split',
        id: id(at),
        at: 1,
        newId: `block_new${String(k).padStart(22, '0')}`,
        kind: 'p',
      })
      m.indexOf(id(n))
      m.heightOf(0, m.length - 1)
    }
    expect(m.length).toBe(n + 200)
    expect(m.indexOf(id(n))).toBe(n + 199)
    expect(m.at(29_999)?.id).toBe(id(30_000))
    expect(m.at(30_000)?.id).toBe('block_new0000000000000000000000')
    expect(m.chaptersBefore(m.length)).toBe(60)
    expect(m.chaptersBefore(m.indexOf(id(30_001)))).toBe(30)
  })
})

// --- Card marks kept, prompts in the margin, figures on the page ----------------

const NOTE = `note_${'0'.repeat(25)}1`
const CARD = `c:${NOTE}` as const
const ASSET = `asset_${'0'.repeat(25)}1`
const pinned = (n: number, text: string): EditorBlock => ({
  id: id(n),
  kind: 'p',
  text,
  marks: [{ t: CARD, from: 0, to: text.length }],
})
const figure = (n: number, caption: string, aspect = 1.5): EditorBlock => ({
  id: id(n),
  kind: 'figure',
  text: caption,
  marks: [],
  image: { assetId: ASSET, card: NOTE, aspect },
})
/** Every `edit` the engine emitted, and none removes (or adds) a card mark. */
const cardSafe = (changes: readonly EditorChange[]) => {
  const edits = changes.filter((c) => c.t === 'edit')
  for (const c of edits) {
    expect((c.removeMarks ?? []).filter((m) => m.t.startsWith('c:'))).toEqual([])
    expect((c.addMarks ?? []).filter((m) => m.t.startsWith('c:'))).toEqual([])
  }
  return edits.length
}

describe('card marks in the writer', () => {
  it('card marks survive typing, accelerators, smart typography and a dead-key composition in pinned text', () => {
    const m = mount([pinned(1, 'a card said this')])
    const el = blockEl(m.root, id(1))
    caret(el, 6)
    type(' "so"')
    // An emphasis accelerator inside the pinned text.
    type(' *now*')
    caret(blockEl(m.root, id(1)), 2)
    deadKey('´', 'é')
    expect(cardSafe(m.changes)).toBeGreaterThan(5)
    const b = m.engine.block(id(1))
    expect(b?.text).toBe('a écard “so” now said this')
    // The card's mark still covers its passage, the typing inside it included.
    expect(b?.marks.filter((x) => x.t === CARD)).toEqual([{ t: CARD, from: 0, to: b?.text.length }])
    expect(b?.marks.some((x) => x.t === 'i')).toBe(true)
  })

  it('the DOM never shows a card mark (no element added for it)', () => {
    const m = mount([
      pinned(1, 'only a card'),
      {
        id: id(2),
        kind: 'p',
        text: 'bold and card',
        marks: [
          { t: 'b', from: 0, to: 4 },
          { t: CARD, from: 2, to: 13 },
        ],
      },
    ])
    expect(blockEl(m.root, id(1)).children.length).toBe(0)
    expect(blockEl(m.root, id(1)).childNodes.length).toBe(1)
    const two = blockEl(m.root, id(2))
    expect([...two.querySelectorAll('*')].map((e) => e.tagName)).toEqual(['STRONG'])
    // Typing there reads only bold and italic back: the card mark is the model's.
    caret(two, 13)
    type('!')
    expect(cardSafe(m.changes)).toBe(1)
    expect(m.engine.block(id(2))?.marks).toEqual([
      { t: 'b', from: 0, to: 4 },
      { t: CARD, from: 2, to: 14 },
    ])
  })
})

/** Elements' layout as jsdom cannot give it: each element's top and height from its data. */
function fakeLayout(): () => void {
  const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.top ?? Number.parseFloat(this.style.top || '0'))
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.height ?? 0)
    },
  })
  return () => {
    if (top) Object.defineProperty(HTMLElement.prototype, 'offsetTop', top)
    if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
  }
}

const frame = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })

function mountIn(blocks: EditorBlock[], width: number, windowed = false): Mounted {
  const sc = document.createElement('div')
  Object.defineProperty(sc, 'clientWidth', { configurable: true, value: width })
  const host = document.createElement('div')
  sc.append(host)
  document.body.append(sc)
  const engine = createEngine({ windowed, scroller: sc })
  const changes: EditorChange[] = []
  let n = 1000
  engine.mount(host, blocks, {
    newBlockId: () => id(n++),
    onChange: (cs) => changes.push(...cs),
    onHistory: () => {},
  })
  return { engine, root: host, changes }
}

describe('prompts', () => {
  it('a prompt is drawn in the margin beside the paragraph before it and takes no height; below 200 px of margin it is inline', async () => {
    const restore = fakeLayout()
    try {
      const blocks = [
        para(1, 'The first paragraph.'),
        para(2, 'A note to myself.', 'prompt'),
        para(3, 'And another one, long.', 'prompt'),
        para(4, 'The second paragraph.'),
        para(5, 'A note beside the second.', 'prompt'),
      ]
      const wide = mountIn(blocks, 1100)
      const book = wide.root.querySelector('.bk-book') as HTMLElement
      expect(book.dataset.asides).toBe('margin')
      blockEl(wide.root, id(1)).dataset.top = '40'
      blockEl(wide.root, id(2)).dataset.height = '50'
      blockEl(wide.root, id(3)).dataset.height = '30'
      blockEl(wide.root, id(4)).dataset.top = '70'
      blockEl(wide.root, id(5)).dataset.height = '20'
      const laid = vi.fn()
      wide.engine.onLayout(laid)
      act(() =>
        wide.engine.apply([{ t: 'edit', id: id(4), splices: [{ at: 0, del: 0, ins: 'x' }] }]),
      )
      await frame()
      // Beside its paragraph's top; the next one below it where they would meet; then beside
      // the second paragraph unless the one above still reaches it.
      expect(blockEl(wide.root, id(2)).style.top).toBe('40px')
      expect(blockEl(wide.root, id(3)).style.top).toBe('98px')
      expect(blockEl(wide.root, id(5)).style.top).toBe('136px')
      expect(laid).toHaveBeenCalledTimes(1)
      const live = wide.engine.liveBlocks()
      expect(live.map((b) => [b.kind, b.top])).toEqual([
        ['p', 40],
        ['prompt', 40],
        ['prompt', 98],
        ['p', 70],
        ['prompt', 136],
      ])
      // No height in the text column: a margin prompt is estimated (and laid out) at 0 px.
      expect(estimate(blocks[1] as EditorBlock, true)).toBe(0)
      expect(estimate(blocks[1] as EditorBlock, false)).toBeGreaterThan(0)

      const narrow = mountIn(blocks, 860)
      const inline = narrow.root.querySelector('.bk-book') as HTMLElement
      expect(inline.dataset.asides).toBe('inline')
      await frame()
      expect(blockEl(narrow.root, id(2)).style.top).toBe('')
    } finally {
      restore()
    }
  })

  it('a footnote is drawn in the margin beside the line its number is on, takes no height, and stacks with the notes around it; narrow, it is under its paragraph', async () => {
    const restore = fakeLayout()
    try {
      const blocks: EditorBlock[] = [
        {
          id: id(1),
          kind: 'p',
          text: 'One two three.',
          marks: [{ t: `n:${id(2)}`, from: 4, to: 7 }],
        },
        { id: id(2), kind: 'footnote', text: 'About two.', marks: [] },
        para(3, 'A note to myself.', 'prompt'),
        { id: id(4), kind: 'p', text: 'Four five.', marks: [{ t: `n:${id(5)}`, from: 0, to: 4 }] },
        { id: id(5), kind: 'footnote', text: 'About four.', marks: [] },
        { id: id(6), kind: 'footnote', text: 'Nothing anchors this one.', marks: [] },
      ]
      const wide = mountIn(blocks, 1100)
      const book = wide.root.querySelector('.bk-book') as HTMLElement
      expect(book.dataset.asides).toBe('margin')
      blockEl(wide.root, id(1)).dataset.top = '40'
      blockEl(wide.root, id(2)).dataset.height = '30'
      blockEl(wide.root, id(3)).dataset.height = '20'
      blockEl(wide.root, id(4)).dataset.top = '160'
      blockEl(wide.root, id(5)).dataset.height = '20'
      blockEl(wide.root, id(6)).dataset.height = '20'
      // The first number is on its paragraph's third line (27 px lines), the second on the first.
      const lineOf = (footnote: string, top: number) => {
        const a = book.querySelector(`.bk-anchor[data-note="${footnote}"]`) as HTMLElement
        a.getClientRects = () => [{ top }] as unknown as DOMRectList
      }
      lineOf(id(2), 94)
      lineOf(id(5), 160)
      act(() =>
        wide.engine.apply([{ t: 'edit', id: id(3), splices: [{ at: 0, del: 0, ins: 'x' }] }]),
      )
      await frame()
      // The prompt beside its paragraph's top; the footnote beside its number's line, 4 px down;
      // the next paragraph's beside its own line; the orphan below it, as a prompt would be.
      expect(blockEl(wide.root, id(3)).style.top).toBe('40px')
      expect(blockEl(wide.root, id(2)).style.top).toBe('98px')
      expect(blockEl(wide.root, id(5)).style.top).toBe('164px')
      expect(blockEl(wide.root, id(6)).style.top).toBe('192px')
      expect(estimate(blocks[1] as EditorBlock, true)).toBe(0)
      expect(estimate(blocks[1] as EditorBlock, false)).toBeGreaterThan(0)
      // A long note runs past the next number's line: the next goes below it.
      blockEl(wide.root, id(2)).dataset.height = '90'
      act(() =>
        wide.engine.apply([{ t: 'edit', id: id(3), splices: [{ at: 0, del: 0, ins: 'y' }] }]),
      )
      await frame()
      expect(blockEl(wide.root, id(5)).style.top).toBe('196px')

      const narrow = mountIn(blocks, 860)
      expect((narrow.root.querySelector('.bk-book') as HTMLElement).dataset.asides).toBe('inline')
      await frame()
      expect(blockEl(narrow.root, id(2)).style.top).toBe('')
    } finally {
      restore()
    }
  })

  it('the margin and the inline prompt switch with the scroller’s width, and the estimates follow', async () => {
    const observed: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private fn: () => void) {}
        observe() {
          observed.push(() => this.fn())
        }
        disconnect() {}
      },
    )
    try {
      const blocks = Array.from({ length: 400 }, (_, i) =>
        para(i + 1, `paragraph ${i + 1}`, i % 2 === 1 ? 'prompt' : 'p'),
      )
      const m = mountIn(blocks, 1100, true)
      act(() => m.engine.window({ fromBlockId: id(1), toBlockId: id(60) }))
      const book = m.root.querySelector('.bk-book') as HTMLElement
      const spacers = () =>
        [...m.root.querySelectorAll<HTMLElement>('.bk-spacer')].reduce(
          (h, s) => h + Number.parseFloat(s.style.height),
          0,
        )
      const margin = spacers()
      expect(book.dataset.asides).toBe('margin')
      const sc = book.parentElement?.parentElement as HTMLElement
      Object.defineProperty(sc, 'clientWidth', { configurable: true, value: 700 })
      act(() => {
        for (const f of observed) f()
      })
      expect(book.dataset.asides).toBe('inline')
      // The prompts off the page now count in the spacers.
      expect(spacers()).toBeGreaterThan(margin + 100 * 20)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('figures', () => {
  it('a figure shows its image at page width with its caption; Enter at the caption’s end makes a paragraph after it', () => {
    const m = mount([para(1, 'Before'), figure(2, 'A caption'), para(3, 'After')])
    const fig = blockEl(m.root, id(2))
    expect(fig.tagName).toBe('FIGURE')
    const img = fig.querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toContain(ASSET)
    expect(img.alt).toBe('')
    expect(img.closest('[contenteditable="false"]')).not.toBeNull()
    const cap = fig.querySelector('figcaption') as HTMLElement
    expect(cap.textContent).toBe('A caption')
    expect(cap.getAttribute('contenteditable')).toBe('true')
    // Enter inside the caption does nothing (a figure is never split)…
    caret(fig, 3)
    press('Enter')
    expect(m.changes).toEqual([])
    // …and at its end makes a paragraph after it.
    caret(blockEl(m.root, id(2)), 9)
    expect(press('Enter')).toBe(true)
    expect(m.changes).toEqual([{ t: 'create', id: id(1000), after: id(2), kind: 'p', text: '' }])
    expect(m.engine.block(id(2))?.text).toBe('A caption')
    expect([...m.root.querySelectorAll('[data-id]')].map((e) => e.getAttribute('data-id'))).toEqual(
      [id(1), id(2), id(1000), id(3)],
    )
  })

  it('Backspace after a figure goes to its caption’s end; a click on its image selects it, and Delete removes it', () => {
    const m = mount([para(1, 'Before'), figure(2, 'A caption'), para(3, 'After')])
    caret(blockEl(m.root, id(3)), 0)
    expect(press('Backspace')).toBe(true)
    expect(m.changes).toEqual([])
    const s = document.getSelection() as Selection
    expect(blockEl(m.root, id(2)).contains(s.focusNode)).toBe(true)
    expect(caretOffset(blockEl(m.root, id(2)))).toBe(9)
    // Backspace at the caption's start changes nothing (a figure stays a figure).
    caret(blockEl(m.root, id(2)), 0)
    press('Backspace')
    expect(m.changes).toEqual([])
    const img = blockEl(m.root, id(2)).querySelector('img') as HTMLElement
    act(() => {
      img.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
    })
    expect(blockEl(m.root, id(2)).dataset.selected).toBe('true')
    press('Delete')
    expect(m.changes).toEqual([{ t: 'delete', id: id(2) }])
    expect(m.root.querySelector(`[data-id="${id(2)}"]`)).toBeNull()
  })

  it('a delete across a figure removes it whole and never merges into or out of it', () => {
    const m = mount([
      para(1, 'one two'),
      figure(2, 'inside'),
      para(3, 'three four'),
      figure(4, 'end caption'),
    ])
    act(() => {
      m.root
        .querySelector('.bk-book')
        ?.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    })
    caret(blockEl(m.root, id(1)), 3, 4, blockEl(m.root, id(4)))
    act(() => document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
    press('Delete')
    expect(m.changes.map((c) => c.t)).not.toContain('merge')
    expect(m.changes).toContainEqual({ t: 'delete', id: id(2) })
    expect(m.changes).toContainEqual({ t: 'delete', id: id(3) })
    expect(m.engine.block(id(1))?.text).toBe('one')
    // The figure at the selection's end keeps its image; its caption is trimmed.
    expect(m.engine.block(id(4))?.text).toBe('caption')
    expect(m.engine.block(id(4))?.image?.assetId).toBe(ASSET)
  })

  it('a figure’s estimate uses its asset’s aspect', () => {
    const wide = estimate(figure(1, 'x', 2))
    const square = estimate(figure(1, 'x', 1))
    expect(square - wide).toBe(FIGURE_MEASURE / 1 - FIGURE_MEASURE / 2)
    // A figure given without its aspect (core's block) takes it from its asset.
    const core = {
      id: id(1),
      kind: 'figure' as const,
      text: 'x',
      marks: [],
      image: { assetId: ASSET },
    }
    const m = new BookModel([core as EditorBlock], { aspectOf: () => 1 })
    expect(m.heightOf(0, 0)).toBe(square)
  })
})

describe('footnotes on the page', () => {
  it('numbering reads only the window’s blocks', async () => {
    // 1,500 paragraphs, each with a footnote after it anchored over its first word.
    const blocks: EditorBlock[] = []
    for (let k = 0; k < 1500; k++) {
      blocks.push({
        id: id(3 * k + 1),
        kind: 'p',
        text: `word ${k}`,
        marks: [{ t: `n:${id(3 * k + 2)}`, from: 0, to: 4 }],
      })
      blocks.push({ id: id(3 * k + 2), kind: 'footnote', text: `note ${k}`, marks: [] })
      blocks.push(para(3 * k + 3, 'plain'))
    }
    const m = mount(blocks, { windowed: true })
    // The frames the tests before left pending (their engines' pages) out of the count.
    await frame()
    // The window around a footnote far into the book (the first window's growth ends there).
    act(() => m.engine.reveal(id(3002)))
    footnoteStats.reads = 0
    await frame()
    const live = m.engine.liveBlocks()
    // The window's blocks (and the paragraph its first footnote hangs from), never the book.
    expect(footnoteStats.reads).toBeGreaterThan(0)
    expect(footnoteStats.reads).toBeLessThanOrEqual(live.length + 8)
    // Numbered through the book, as core numbers the whole of it.
    const all = numberFootnotes(blocks as unknown as Block[])
    const fn = blockEl(m.root, id(3002))
    expect(fn.dataset.n).toBe(String(all.get(id(3002))))
    expect(fn.dataset.n).toBe('1001')
    expect(blockEl(m.root, id(3001)).querySelector('.bk-anchor')?.getAttribute('data-n')).toBe(
      '1001',
    )
  })

  it('a footnote anchored in two blocks (a paragraph split inside its anchor) is counted once, at its first, by the window alone', async () => {
    // As above, but the first 40 paragraphs were split inside their anchor: each footnote is
    // anchored at the head's end and the tail's start, and counts once for the numbers after it.
    const blocks: EditorBlock[] = []
    for (let k = 0; k < 1500; k++) {
      const fn = id(4 * k + 3)
      if (k < 40) {
        blocks.push({
          id: id(4 * k + 1),
          kind: 'p',
          text: 'wo',
          marks: [{ t: `n:${fn}`, from: 0, to: 2 }],
        })
        blocks.push({
          id: id(4 * k + 2),
          kind: 'p',
          text: `rd ${k}`,
          marks: [{ t: `n:${fn}`, from: 0, to: 2 }],
        })
      } else
        blocks.push({
          id: id(4 * k + 1),
          kind: 'p',
          text: `word ${k}`,
          marks: [{ t: `n:${fn}`, from: 0, to: 4 }],
        })
      blocks.push({ id: fn, kind: 'footnote', text: `note ${k}`, marks: [] })
      blocks.push(para(4 * k + 4, 'plain'))
    }
    const m = mount(blocks, { windowed: true })
    await frame()
    // A footnote far into the book, and one whose two anchors are both in the window.
    const far = id(4 * 1000 + 3)
    act(() => m.engine.reveal(far))
    footnoteStats.reads = 0
    await frame()
    const live = m.engine.liveBlocks()
    expect(footnoteStats.reads).toBeGreaterThan(0)
    expect(footnoteStats.reads).toBeLessThanOrEqual(live.length + 8)
    const all = numberFootnotes(blocks as unknown as Block[])
    expect(blockEl(m.root, far).dataset.n).toBe(String(all.get(far)))
    expect(blockEl(m.root, far).dataset.n).toBe('1001')
    const near = id(4 * 20 + 3)
    act(() => m.engine.reveal(near))
    await frame()
    expect(blockEl(m.root, near).dataset.n).toBe(String(all.get(near)))
    expect(blockEl(m.root, near).dataset.n).toBe('21')
    // The next footnote after a split one is one more, not two.
    const next = id(4 * 21 + 3)
    expect(blockEl(m.root, next).dataset.n).toBe('22')
    // The tail's anchor carries no number of its own: the note is referenced at its first.
    expect(
      blockEl(m.root, id(4 * 20 + 1))
        .querySelector('.bk-anchor')
        ?.getAttribute('data-n'),
    ).toBe('21')
  })
})

describe('a join past the notes beside a paragraph, undone and redone', () => {
  const BOOK = idOf('book', 7)

  beforeAll(async () => {
    await loadBookSync()
  })

  /**
   * The writer over a board's book of `rows` (`[kind, text]`, blocks `id(1…)`): the engine's
   * changes go to the board as ops and onto the undo stack; an undo or redo changes the board,
   * and the page follows it by what changed in the book, as the writer does it (`follow`).
   */
  function written(rows: readonly [EditorBlock['kind'], string][]) {
    const keys = posKeysBetween(null, null, rows.length)
    let state: BoardState = applyBatch(
      emptyBoardState(BOARD_ID, 'Test board', T0),
      [
        { op: 'book.create', book: { ...boardBook(BOOK), trashedAt: null } },
        ...rows.map(
          ([kind, text], i): ClientOp => ({
            op: 'block.create',
            block: {
              type: 'block',
              id: id(i + 1),
              bookId: BOOK,
              pos: keys[i] as string,
              kind,
              text,
              marks: [],
            },
          }),
        ),
      ],
      { now: T0 },
    )
    const stack = new UndoStack()
    const host = document.createElement('div')
    document.body.append(host)
    const engine = createEngine({ windowed: false })
    let n = 1000
    engine.mount(host, bookBlocks(state.blocks, BOOK).chunks.flat(), {
      newBlockId: () => id(n++),
      onChange: (cs) => {
        const ops = changesToOps(state, BOOK, cs)
        const before = state
        state = applyBatch(state, ops, { now: T0 })
        stack.record(before, ops, 'Writing')
      },
      onHistory: () => {},
    })
    const step = (dir: 'undo' | 'redo') => {
      const r = dir === 'undo' ? stack.undo(state) : stack.redo(state)
      if (r === null) throw new Error(`nothing to ${dir}`)
      expect(r.skipped).toBe(0)
      const shown = bookBlocks(state.blocks, BOOK)
      state = applyBatch(state, r.ops, { now: T0 })
      const diff = bookDiff(BOOK, shown, bookBlocks(state.blocks, BOOK))
      act(() => engine.apply(opsToChanges(diff, state)))
    }
    return {
      root: host,
      undo: () => step('undo'),
      redo: () => step('redo'),
      /** The book's `kind:text` in order, on the board and (the same) on the page. */
      book() {
        const board = bookBlocks(state.blocks, BOOK).chunks.flat()
        const page = [...host.querySelectorAll<HTMLElement>('[data-id]')].map((el) => {
          const b = engine.block(el.dataset.id as string)
          return `${b?.kind}:${b?.text}`
        })
        const rowsNow = board.map((b) => `${b.kind}:${b.text}`)
        expect(page).toEqual(rowsNow)
        expect(new Set(board.map((b) => b.pos)).size).toBe(board.length)
        return rowsNow
      },
      keys: () =>
        bookBlocks(state.blocks, BOOK)
          .chunks.flat()
          .map((b) => `${b.id}@${b.pos}`),
    }
  }

  const cases: [string, EditorBlock['kind'][], 'Backspace' | 'Delete'][] = [
    ['Backspace past a prompt', ['prompt'], 'Backspace'],
    ['Backspace past a footnote', ['footnote'], 'Backspace'],
    ['Backspace past a footnote and a prompt', ['footnote', 'prompt'], 'Backspace'],
    ['Delete past a prompt', ['prompt'], 'Delete'],
    ['Delete past a footnote', ['footnote'], 'Delete'],
  ]
  for (const [name, asides, key] of cases) {
    it(`${name}: undo puts the paragraph back after the notes, and again after a redo`, () => {
      const rows: [EditorBlock['kind'], string][] = [
        ['p', 'One.'],
        ...asides.map((k, i): [EditorBlock['kind'], string] => [k, `note ${i}`]),
        ['p', 'Two.'],
        ['p', 'Three.'],
      ]
      const w = written(rows)
      const start = w.book()
      const keys = w.keys()
      const joined = ['p:One.Two.', ...asides.map((k, i) => `${k}:note ${i}`), 'p:Three.']
      if (key === 'Backspace') caret(blockEl(w.root, id(asides.length + 2)), 0)
      else caret(blockEl(w.root, id(1)), 4)
      expect(press(key)).toBe(true)
      expect(w.book()).toEqual(joined)
      for (let round = 0; round < 3; round++) {
        w.undo()
        expect(w.book()).toEqual(start)
        expect(w.keys()).toEqual(keys)
        w.redo()
        expect(w.book()).toEqual(joined)
      }
    })
  }

  it('a paragraph with notes of its own joins the one before, past that one’s notes, and comes back between them', () => {
    const w = written([
      ['p', 'One.'],
      ['prompt', 'beside one'],
      ['p', 'Two.'],
      ['footnote', 'under two'],
      ['p', 'Three.'],
    ])
    const start = w.book()
    const keys = w.keys()
    caret(blockEl(w.root, id(3)), 0)
    expect(press('Backspace')).toBe(true)
    const joined = ['p:One.Two.', 'prompt:beside one', 'footnote:under two', 'p:Three.']
    expect(w.book()).toEqual(joined)
    w.undo()
    expect(w.book()).toEqual(start)
    expect(w.keys()).toEqual(keys)
    w.redo()
    expect(w.book()).toEqual(joined)
    w.undo()
    expect(w.book()).toEqual(start)
  })

  it('Enter at the end of a paragraph with notes makes the new one after them; undone and redone it is there again', () => {
    const w = written([
      ['p', 'One.'],
      ['footnote', 'under one'],
      ['prompt', 'beside one'],
      ['p', 'Two.'],
    ])
    const start = w.book()
    caret(blockEl(w.root, id(1)), 4)
    expect(press('Enter')).toBe(true)
    const made = ['p:One.', 'footnote:under one', 'prompt:beside one', 'p:', 'p:Two.']
    expect(w.book()).toEqual(made)
    const keys = w.keys()
    w.undo()
    expect(w.book()).toEqual(start)
    w.redo()
    expect(w.book()).toEqual(made)
    expect(w.keys()).toEqual(keys)
    w.undo()
    expect(w.book()).toEqual(start)
  })
})
