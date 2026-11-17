import { ImageDrop, loadUpload } from '../../src/images/ImageDrop'
import { file, harness, session } from '../helpers/photos'

const flush = () => new Promise((r) => setTimeout(r, 10))

/** An event carrying what jsdom has no class for. */
const event = <T extends object>(type: string, extra: T) =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), extra)

const dragData = (files: File[]) => ({ types: ['Files'], files, dropEffect: 'copy' })

/** The board's viewport under Settings: `CanvasView` marks it `data-covered`, the sheet in its UI layer. */
function covered() {
  const s = session()
  const h = harness(s)
  const root = document.createElement('main')
  root.dataset.covered = ''
  const sheet = document.createElement('section')
  const field = document.createElement('input')
  sheet.append(field)
  root.append(sheet)
  document.body.append(root)
  const drop = new ImageDrop({ root, session: s, toWorld: (x, y) => ({ x, y }), deps: h.deps })
  const committed = () => s.store.getState().notes.size
  return { root, sheet, field, h, drop, committed }
}

afterEach(() => document.body.replaceChildren())

// The upload code is a chunk of its own, in once the board is up: here, before any drop.
beforeAll(() => loadUpload())

describe('photos under Settings (a covered board)', () => {
  it('takes no dropped file: no highlight, no note, no upload, and the tab does not open it', async () => {
    const { root, sheet, h, committed, drop } = covered()
    const f = [file('a.jpg')]
    for (const target of [root, sheet]) {
      const over = event('dragover', { dataTransfer: dragData(f) })
      target.dispatchEvent(over)
      expect(over.defaultPrevented).toBe(true) // or the browser opens the file in the tab
      expect(over.dataTransfer.dropEffect).toBe('none')
      expect(root.dataset.drop).toBeUndefined()

      const dropped = event('drop', { dataTransfer: dragData(f), clientX: 40, clientY: 60 })
      target.dispatchEvent(dropped)
      expect(dropped.defaultPrevented).toBe(true)
    }
    await flush()
    expect(committed()).toBe(0)
    expect(h.uploads).toEqual([])

    // Once the sheet is gone the board takes photos again.
    delete root.dataset.covered
    root.dispatchEvent(event('drop', { dataTransfer: dragData(f), clientX: 0, clientY: 0 }))
    await flush()
    expect(h.uploads).toEqual(['a.jpg'])
    drop.dispose()
  })

  it('takes no pasted image, and leaves a paste into a sheet field to the field', async () => {
    const { root, sheet, field, h, committed, drop } = covered()
    const shot = () =>
      event('paste', {
        clipboardData: { files: [file('shot.png', 'image/png')], types: ['Files'] },
      })
    for (const target of [document.body, root, sheet]) {
      const e = shot()
      target.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
    const text = event('paste', { clipboardData: { files: [], types: ['text/plain'] } })
    field.dispatchEvent(text)
    expect(text.defaultPrevented).toBe(false)
    await flush()
    expect(committed()).toBe(0)
    expect(h.uploads).toEqual([])
    drop.dispose()
  })
})
