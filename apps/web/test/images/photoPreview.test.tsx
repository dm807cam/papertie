import type { Note } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { NotePhoto } from '../../src/images/NotePhoto'
import { PhotoContext } from '../../src/images/PhotoContext'
import { PendingImages } from '../../src/images/pending'
import { photoSpaceFor } from '../../src/images/space'
import { addImages } from '../../src/images/upload'
import { file, harness, pendingOf, session } from '../helpers/photos'

const NOTE = 'note_01JBTEST0000000000000000A1'
const ASSET = 'asset_01JBTEST000000000000000A1'
const flush = () => new Promise((r) => setTimeout(r, 10))

afterEach(cleanup)

describe('the real image stays visible once its preview is released', () => {
  const decodes: Array<() => void> = []
  beforeEach(() => {
    decodes.length = 0
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: () => new Promise<void>((r) => decodes.push(r)),
    })
  })
  afterEach(() => {
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode
  })

  it('keeps data-loaded, and no preview, after a release that really removes the entry', async () => {
    const pending = new PendingImages()
    pending.set(NOTE, {
      url: 'blob:fake/1',
      state: 'uploading',
      committed: true,
      retry() {},
      remove() {},
      release: () => pending.delete(NOTE),
    })
    const { container } = render(
      <PhotoContext.Provider value={{ pending }}>
        <NotePhoto
          noteId={NOTE}
          image={{ assetId: ASSET, frame: 'print' }}
          style="print"
          lite={false}
          w={300}
          h={225}
        />
      </PhotoContext.Provider>,
    )
    await act(flush)
    await act(async () => {
      for (const d of decodes.splice(0)) d()
      await flush()
    })
    await act(flush)
    expect(pending.size).toBe(0)
    expect(container.querySelector('.photo-preview')).toBeNull()
    const real = container.querySelector('.photo-real') as HTMLElement
    expect(real.hasAttribute('data-loaded')).toBe(true)
  })

  it('shows a plain image when it has loaded, and not before', async () => {
    const pending = new PendingImages()
    const { container } = render(
      <PhotoContext.Provider value={{ pending }}>
        <NotePhoto
          noteId={NOTE}
          image={{ assetId: ASSET, frame: 'print' }}
          style="print"
          lite={false}
          w={300}
          h={225}
        />
      </PhotoContext.Provider>,
    )
    const real = container.querySelector('.photo-real') as HTMLElement
    expect(real.hasAttribute('data-loaded')).toBe(false)
    await act(async () => {
      real.dispatchEvent(new Event('load'))
    })
    expect(real.hasAttribute('data-loaded')).toBe(true)
  })
})

describe('a canvas that goes while photos are still being prepared', () => {
  it('creates no note, sends nothing and keeps no blob for a photo still being prepared', async () => {
    const s = session()
    const h = harness(s)
    const finishers: Array<(v: { width: number; height: number }) => void> = []
    h.deps.measure = () => new Promise((r) => void finishers.push(r))
    const done = addImages(s, [file('a.jpg'), file('b.jpg')], { x: 0, y: 0 }, h.deps)
    await flush()
    photoSpaceFor(s).dispose()
    for (const f of finishers) f({ width: 800, height: 600 })
    await done
    await flush()
    const notes: Note[] = [...s.store.getState().notes.values()]
    expect(notes).toHaveLength(0)
    expect(h.uploads).toEqual([])
    expect(pendingOf(s).size).toBe(0)
    // Every blob URL made was let go of.
    expect(h.created).toEqual(h.revoked)
  })

  it('does not wait on a HEIC conversion that outlives the canvas', async () => {
    const s = session()
    const h = harness(s)
    let convert: (f: File) => void = () => {}
    h.deps.heic = () =>
      new Promise((r) => {
        convert = r
      })
    const done = addImages(s, [file('IMG_1.heic', 'image/heic')], { x: 0, y: 0 }, h.deps)
    await flush()
    photoSpaceFor(s).dispose()
    convert(file('IMG_1.jpg'))
    await done
    expect(s.store.getState().notes.size).toBe(0)
    expect(h.uploads).toEqual([])
    expect(h.created).toEqual(h.revoked)
  })

  it('still takes photos on a session whose canvas was disposed earlier (StrictMode)', async () => {
    const s = session()
    const h = harness(s)
    photoSpaceFor(s).dispose()
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    await flush()
    expect(h.uploads).toEqual(['a.jpg'])
    expect(s.store.getState().notes.size).toBe(1)
  })
})
