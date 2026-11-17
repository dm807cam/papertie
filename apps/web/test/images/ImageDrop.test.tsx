import type { Note } from '@papertie/core'
import { cleanup } from '@testing-library/react'
import { ImageDrop, loadUpload } from '../../src/images/ImageDrop'
import { file, harness, pendingOf, session } from '../helpers/photos'

const flush = () => new Promise((r) => setTimeout(r, 10))

function setup() {
  const s = session()
  const h = harness(s)
  const root = document.createElement('main')
  document.body.append(root)
  const drop = new ImageDrop({
    root,
    session: s,
    // A fixed offset, so a world point is visibly not a client point.
    toWorld: (x, y) => ({ x: x + 1000, y: y + 2000 }),
    deps: h.deps,
  })
  const notes = (): Note[] => [...s.store.getState().notes.values()]
  return { s, h, root, drop, notes }
}

/** An event carrying what jsdom has no class for. */
const event = (type: string, extra: object) =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), extra)

const dragData = (files: File[]) => ({ types: ['Files'], files, dropEffect: 'none' })

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

// The upload code is a chunk of its own, in once the board is up: here, before any drop.
beforeAll(() => loadUpload())

describe('ImageDrop', () => {
  it('lets go of every preview when it goes with its canvas', async () => {
    const { s, h, drop } = setup()
    h.deps.upload = () => new Promise(() => {})
    const root = document.querySelector('main') as HTMLElement
    root.dispatchEvent(
      event('drop', { dataTransfer: dragData([file('a.jpg')]), clientX: 0, clientY: 0 }),
    )
    await flush()
    expect(pendingOf(s).size).toBe(1)
    drop.dispose()
    expect(pendingOf(s).size).toBe(0)
    expect(h.revoked).toEqual(['blob:fake/1'])
  })

  it('lights the cork while files hang over it and puts them where they are dropped', async () => {
    const { root, notes, h } = setup()
    const f = [file('a.jpg'), file('b.jpg')]
    const over = event('dragenter', { dataTransfer: dragData(f) })
    root.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(root.dataset.drop).toBe('')

    const drop = event('drop', { dataTransfer: dragData(f), clientX: 40, clientY: 60 })
    root.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(root.dataset.drop).toBeUndefined()
    await flush()
    expect(notes()).toHaveLength(2)
    expect(h.uploads.sort()).toEqual(['a.jpg', 'b.jpg'])
    const first = notes().find((n) => n.z === Math.min(...notes().map((m) => m.z))) as Note
    expect(Math.round(first.x + first.w / 2)).toBeGreaterThanOrEqual(1040)
  })

  it('clears the light when the drag leaves, and ignores drags that carry no files', () => {
    const { root } = setup()
    const text = event('dragenter', { dataTransfer: { types: ['text/plain'], files: [] } })
    root.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
    expect(root.dataset.drop).toBeUndefined()

    root.dispatchEvent(event('dragenter', { dataTransfer: dragData([file('a.jpg')]) }))
    root.dispatchEvent(event('dragenter', { dataTransfer: dragData([file('a.jpg')]) }))
    root.dispatchEvent(event('dragleave', { dataTransfer: dragData([]) }))
    expect(root.dataset.drop).toBe('')
    root.dispatchEvent(event('dragleave', { dataTransfer: dragData([]) }))
    expect(root.dataset.drop).toBeUndefined()
  })

  it("leaves the editor's own text drops alone, and a drop that is already handled", async () => {
    const { root, notes, h } = setup()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    root.append(editor)

    // jsdom's DataTransfer has no `types` here: the drop must not throw.
    const text = event('drop', { dataTransfer: {}, clientX: 5, clientY: 5 })
    expect(() => editor.dispatchEvent(text)).not.toThrow()
    const typed = event('drop', {
      dataTransfer: { types: ['text/plain'], files: [] },
      clientX: 5,
      clientY: 5,
    })
    expect(() => editor.dispatchEvent(typed)).not.toThrow()
    expect(typed.defaultPrevented).toBe(false)

    // Files over the board that something else already handled are not taken either.
    const handled = event('drop', {
      dataTransfer: dragData([file('a.jpg')]),
      clientX: 5,
      clientY: 5,
    })
    handled.preventDefault()
    root.dispatchEvent(handled)
    const over = event('dragover', { dataTransfer: dragData([file('a.jpg')]) })
    over.preventDefault()
    root.dispatchEvent(over)
    expect(root.dataset.drop).toBeUndefined()

    await flush()
    expect(notes()).toHaveLength(0)
    expect(h.uploads).toEqual([])
  })

  it('takes pasted files, but leaves a paste with text to the field it is in', async () => {
    const { root, notes, h } = setup()
    const field = document.createElement('textarea')
    root.append(field)

    const withText = event('paste', {
      clipboardData: { files: [file('a.jpg')], types: ['text/plain', 'Files'] },
    })
    field.dispatchEvent(withText)
    expect(withText.defaultPrevented).toBe(false)

    const shot = event('paste', {
      clipboardData: { files: [file('shot.png', 'image/png')], types: ['Files'] },
    })
    document.body.dispatchEvent(shot)
    expect(shot.defaultPrevented).toBe(true)
    await flush()
    expect(h.uploads).toEqual(['shot.png'])
    expect(notes()).toHaveLength(1)
  })

  it('opens the picker, and puts the chosen photos at the middle of the view', async () => {
    const { root, notes, h, drop } = setup()
    const input = root.querySelector('input[type=file]') as HTMLInputElement
    expect(input.accept).toContain('image/avif')
    expect(input.accept).toContain('.heic')
    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    drop.pick()
    expect(click).toHaveBeenCalled()
    expect(input.multiple).toBe(true)
    Object.defineProperty(input, 'files', { value: [file('a.jpg')], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flush()
    expect(h.uploads).toEqual(['a.jpg'])
    expect(notes()).toHaveLength(1)
  })

  it("picks a single photo to replace a note's image", async () => {
    const { root, notes, h, drop } = setup()
    // A note with a photo, to replace.
    root.dispatchEvent(
      event('drop', { dataTransfer: dragData([file('a.jpg')]), clientX: 0, clientY: 0 }),
    )
    await flush()
    const id = (notes()[0] as Note).id
    const input = root.querySelector('input[type=file]') as HTMLInputElement
    vi.spyOn(input, 'click').mockImplementation(() => {})
    drop.pick({ noteId: id })
    expect(input.multiple).toBe(false)
    Object.defineProperty(input, 'files', { value: [file('b.jpg')], configurable: true })
    input.dispatchEvent(new Event('change'))
    await flush()
    expect(h.uploads).toEqual(['a.jpg', 'b.jpg'])
    expect(notes()).toHaveLength(1)
  })

  it('lets a press on Retry through, and stops listening when disposed', () => {
    const { root, drop } = setup()
    const retry = document.createElement('button')
    retry.className = 'photo-retry'
    retry.dataset.photoAction = ''
    root.append(retry)
    const seen = vi.fn()
    root.addEventListener('pointerdown', seen)
    retry.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(seen).not.toHaveBeenCalled()

    drop.dispose()
    expect(root.querySelector('input')).toBeNull()
    const after = event('dragenter', { dataTransfer: dragData([file('a.jpg')]) })
    root.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
