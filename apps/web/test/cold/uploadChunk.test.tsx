import type { Note } from '@papertie/core'
import { reloadMessage } from '../../src/sync/notices'
import { file, harness, session } from '../helpers/photos'

/**
 * The upload code (`images/upload.ts`, with HEIC and the image analysis) is a chunk of its own
 * (room in the initial JS), loaded at idle once the board is up. Here it is not
 * in yet: a photo dropped meanwhile waits for it, and goes on the board once it is.
 */

const event = (type: string, extra: object) =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), extra)
const dragData = (files: File[]) => ({ types: ['Files'], files, dropEffect: 'none' })

afterEach(() => {
  document.body.replaceChildren()
  vi.doUnmock('../../src/images/upload')
  vi.resetModules()
})

async function setup() {
  const { ImageDrop, uploadLoaded } = await import('../../src/images/ImageDrop')
  const s = session()
  const h = harness(s)
  const root = document.createElement('main')
  document.body.append(root)
  const drop = new ImageDrop({ root, session: s, toWorld: (x, y) => ({ x, y }), deps: h.deps })
  const notes = (): Note[] => [...s.store.getState().notes.values()]
  const notices = () => s.feed.getState().notices.map((n) => n.message)
  return { s, h, root, drop, notes, notices, uploadLoaded }
}

describe('the upload chunk', () => {
  it('a photo dropped before the chunk is in goes on the board once it is', async () => {
    const { root, notes, h, uploadLoaded } = await setup()
    expect(uploadLoaded()).toBe(false)
    root.dispatchEvent(
      event('drop', { dataTransfer: dragData([file('a.jpg')]), clientX: 0, clientY: 0 }),
    )
    await vi.waitFor(() => expect(notes()).toHaveLength(1))
    expect(h.uploads).toEqual(['a.jpg'])
    expect(uploadLoaded()).toBe(true)
  })

  it('a canvas that goes while the chunk comes adds nothing', async () => {
    const { root, drop, notes, h, uploadLoaded } = await setup()
    root.dispatchEvent(
      event('drop', { dataTransfer: dragData([file('a.jpg')]), clientX: 0, clientY: 0 }),
    )
    drop.dispose()
    await vi.waitFor(() => expect(uploadLoaded()).toBe(true))
    await new Promise((r) => setTimeout(r, 20))
    expect(notes()).toHaveLength(0)
    expect(h.uploads).toEqual([])
  })

  // A chunk that cannot be fetched (a failed fetch the module map keeps) needs a reload, which the photo's notice alone never said.
  it('a chunk that does not come says the photo could not be added, and that a reload is needed', async () => {
    vi.doMock('../../src/images/upload', () => {
      throw new Error('offline')
    })
    const { s, root, notes, notices } = await setup()
    root.dispatchEvent(
      event('drop', {
        dataTransfer: dragData([file('a.jpg')]),
        clientX: 0,
        clientY: 0,
      }),
    )
    await vi.waitFor(() => expect(notices()).toEqual(['Couldn’t add a.jpg to the board.']))
    expect(notes()).toHaveLength(0)
    expect(s.feed.getState().updated).toBe(true)
    expect(s.feed.getState().updatedCopy).toBe(reloadMessage())
    expect(root.dataset.drop).toBeUndefined()
  })

  // A photo that came before the chunk showed nothing until it was in.
  it('a photo dropped before the chunk is in keeps the board taking it until its note is made', async () => {
    const { root, notes } = await setup()
    root.dispatchEvent(event('dragenter', { dataTransfer: dragData([file('a.jpg')]) }))
    root.dispatchEvent(
      event('drop', { dataTransfer: dragData([file('a.jpg')]), clientX: 0, clientY: 0 }),
    )
    // At once: the board's frame for files stays, and says it is busy.
    expect(root.dataset.drop).toBe('')
    expect(root.getAttribute('aria-busy')).toBe('true')
    await vi.waitFor(() => expect(notes()).toHaveLength(1))
    expect(root.dataset.drop).toBeUndefined()
    expect(root.hasAttribute('aria-busy')).toBe(false)
  })

  it('files dragged over the board, or the picker opened, bring the chunk in', async () => {
    const a = await setup()
    a.root.dispatchEvent(event('dragenter', { dataTransfer: dragData([file('a.jpg')]) }))
    await vi.waitFor(() => expect(a.uploadLoaded()).toBe(true))
    a.drop.dispose()
    document.body.replaceChildren()
    vi.resetModules()
    const b = await setup()
    expect(b.uploadLoaded()).toBe(false)
    b.drop.pick()
    await vi.waitFor(() => expect(b.uploadLoaded()).toBe(true))
  })
})
